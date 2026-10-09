import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ErroFluigctl } from '../src/errors.js';
import {
  ASSETS_STYLE_GUIDE,
  CANDIDATOS_STYLE_GUIDE,
  baixarStyleGuide,
  compatibilizarFluigc,
  diretorioDoCache,
  lerManifesto,
  mensagemCacheAusente,
  resolverAssetDoCache,
  urlsDoCss,
} from '../src/form/style-guide.js';
import { fakeFluig, type FakeFluig, type RotaResposta } from './helpers/fake-fluig.js';

const CSS = '/style-guide/css/fluig-style-guide.min.css';
const CSS_FLAT = '/style-guide/css/fluig-style-guide-flat.min.css';
const JQUERY = '/portal/resources/js/jquery/jquery.js';
const JS = '/style-guide/js/fluig-style-guide.min.js';
const SELECT = '/style-guide/js/fluig-style-guide-select.min.js';
const WOFF = '/style-guide/fonts/x.woff';

const CORPO_CSS = "@font-face{src:url(../fonts/x.woff)} .bg{background:url(data:image/png;base64,AAAA)} .remote{background:url(https://cdn.example.com/y.png)} .proto{background:url(//cdn.example.com/z.png)} .frag{background:url(#grad)}";
const sha256de = (texto: string): string => createHash('sha256').update(Buffer.from(texto)).digest('hex');
const CORPO_JQUERY = 'jquery-fonte-ç-€';
const CORPO_JS = 'fluig-style-guide-js';
const CORPO_WOFF = 'woff-fonte';
const CORPO_SELECT = 'window.FLUIGC=window.FLUIGC||{};window.top.WCMAPI;';

function servidor(overrides: Record<string, RotaResposta> = {}): Promise<FakeFluig> {
  const rotas: Record<string, RotaResposta> = {
    [CSS_FLAT]: { headers: { 'content-type': 'text/css' }, body: CORPO_CSS },
    [CSS]: { status: 404, body: 'sem css plano' },
    [JQUERY]: { body: CORPO_JQUERY },
    [JS]: { body: CORPO_JS },
    [SELECT]: { body: CORPO_SELECT },
    [WOFF]: { body: CORPO_WOFF },
    ...overrides,
  };
  return fakeFluig(rotas);
}

function tempCache(): { base: string; cache: string } {
  const base = mkdtempSync(join(tmpdir(), 'styleguide-'));
  return { base, cache: diretorioDoCache(base) };
}

function escreverManifesto(cache: string, arquivos: Record<string, { tamanho: number; sha256: string }>): void {
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 1, origem: 'http://x', criadoEm: new Date().toISOString(), arquivos, fontes: {}, ignorados: [] }));
}

test('ASSETS_STYLE_GUIDE traz os três caminhos exatos', () => {
  assert.deepEqual([...ASSETS_STYLE_GUIDE], [
    '/style-guide/css/fluig-style-guide.min.css',
    '/portal/resources/js/jquery/jquery.js',
    '/style-guide/js/fluig-style-guide.min.js',
  ]);
});

test('diretorioDoCache respeita estadoDir e XDG_STATE_HOME', () => {
  assert.equal(diretorioDoCache('/tmp/estado'), join('/tmp/estado', 'fluigctl', 'form', 'styleguide'));
  const antes = process.env['XDG_STATE_HOME'];
  try {
    process.env['XDG_STATE_HOME'] = '/tmp/xdg';
    assert.equal(diretorioDoCache(), join('/tmp/xdg', 'fluigctl', 'form', 'styleguide'));
  } finally {
    if (antes === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = antes;
  }
});

test('mensagemCacheAusente aponta o comando de bootstrap e o alias', () => {
  const m = mensagemCacheAusente('homolog');
  assert.match(m, /form bootstrap/);
  assert.match(m, /--server homolog/);
  assert.match(mensagemCacheAusente(), /--server <alias>/);
});

test('CANDIDATOS_STYLE_GUIDE põe o CSS flat antes do caminho emitido', () => {
  assert.deepEqual([...(CANDIDATOS_STYLE_GUIDE[CSS] ?? [])], [CSS_FLAT, CSS]);
  assert.deepEqual([...(CANDIDATOS_STYLE_GUIDE[JQUERY] ?? [])], [JQUERY]);
  assert.deepEqual([...(CANDIDATOS_STYLE_GUIDE[JS] ?? [])], [JS]);
});

test('baixa os três assets e as referências do CSS, com bytes, hashes e fontes no manifesto', async () => {
  const s = await servidor();
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'JSESSIONID=abc', cacheDir: cache });
    assert.deepEqual(Object.keys(m.arquivos).sort(), [CSS, JQUERY, JS, SELECT, WOFF].sort());
    assert.equal(m.versao, 1);
    assert.equal(m.origem, s.url);
    assert.match(m.criadoEm, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(m.fontes, { [CSS]: CSS_FLAT, [JQUERY]: JQUERY, [JS]: JS, [SELECT]: SELECT, [WOFF]: WOFF });
    assert.equal(m.ignorados.length, 0);
    const esperados: [string, string][] = [
      [CSS, CORPO_CSS],
      [JQUERY, CORPO_JQUERY],
      [JS, CORPO_JS],
      [SELECT, CORPO_SELECT],
      [WOFF, CORPO_WOFF],
    ];
    for (const [caminho, esperado] of esperados) {
      const buf = readFileSync(join(cache, caminho.slice(1)));
      assert.equal(buf.toString('utf8'), esperado);
      assert.equal(m.arquivos[caminho]!.tamanho, Buffer.byteLength(esperado));
      assert.equal(m.arquivos[caminho]!.sha256, createHash('sha256').update(Buffer.from(esperado)).digest('hex'));
    }
    const lido = lerManifesto(cache);
    assert.deepEqual(lido, m);
    assert.equal(lido!.fontes[CSS], CSS_FLAT, 'lerManifesto devolve as fontes');
    assert.ok(s.requests.some((r) => r.url === CSS_FLAT));
    assert.ok(!s.requests.some((r) => r.url === CSS), 'primeiro candidato vence: o caminho emitido não é pedido');
    assert.ok(s.requests.every((r) => r.headers['cookie'] === 'JSESSIONID=abc'));
    assert.ok(!s.requests.some((r) => r.url.includes('cdn.example.com')));
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('candidato: primeiro 404, segundo 200 -> usa o segundo e registra em fontes', async () => {
  const s = await fakeFluig({
    [CSS_FLAT]: { status: 404, body: 'sem flat' },
    [SELECT]: { body: CORPO_SELECT },
    [CSS]: { headers: { 'content-type': 'text/css' }, body: CORPO_CSS },
    [JQUERY]: { body: CORPO_JQUERY },
    [JS]: { body: CORPO_JS },
    [WOFF]: { body: CORPO_WOFF },
  });
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache });
    assert.equal(m.fontes[CSS], CSS);
    assert.equal(readFileSync(join(cache, CSS.slice(1)), 'utf8'), CORPO_CSS);
    assert.ok(s.requests.some((r) => r.url === CSS_FLAT));
    assert.ok(s.requests.some((r) => r.url === CSS));
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('referência url() do CSS que falta é ignorada e o bootstrap conclui', async () => {
  const CSS_COM_FALTA = "@font-face{src:url(../fonts/x.woff)} .g{background:url(../images/missing.png)}";
  const FALTA = '/style-guide/images/missing.png';
  const s = await fakeFluig({
    [CSS_FLAT]: { headers: { 'content-type': 'text/css' }, body: CSS_COM_FALTA },
    [SELECT]: { body: CORPO_SELECT },
    [CSS]: { status: 404, body: 'sem css emitido' },
    [JQUERY]: { body: CORPO_JQUERY },
    [JS]: { body: CORPO_JS },
    [WOFF]: { body: CORPO_WOFF },
  });
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache });
    assert.equal(FALTA in m.arquivos, false, 'a imagem que falta não entra em arquivos');
    assert.deepEqual([...m.ignorados], [FALTA]);
    assert.equal(m.fontes[FALTA], undefined);
    assert.ok(m.arquivos[WOFF] !== undefined, 'referências que existem continuam baixadas');
    assert.ok(s.requests.some((r) => r.url === FALTA));
    assert.deepEqual(lerManifesto(cache), m);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('sem candidato disponível lança código 3 listando os tentados e não grava manifesto', async () => {
  const s = await fakeFluig({
    [CSS_FLAT]: { status: 404, body: 'nao' },
    [CSS]: { status: 404, body: 'nao' },
    [JQUERY]: { body: CORPO_JQUERY },
    [JS]: { body: CORPO_JS },
  });
  const { base, cache } = tempCache();
  try {
    await assert.rejects(
      baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache }),
      (erro: unknown) => {
        assert.ok(erro instanceof ErroFluigctl);
        assert.equal(erro.codigo, 3);
        assert.ok(erro.message.includes('não consegui baixar'));
        assert.ok(erro.message.includes('tentei:'));
        assert.ok(erro.message.includes(CSS));
        assert.ok(erro.message.includes(CSS_FLAT));
        assert.ok(erro.message.includes('HTTP 404'));
        return true;
      },
    );
    assert.equal(lerManifesto(cache), undefined);
    assert.equal(existsSync(join(cache, 'manifesto.json')), false);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('urlsDoCss resolve same-origin e ignora data:/http(s):/protocol-relative/fragmento', () => {
  const css = "a{background:url(../fonts/x.woff)} b{background:url(data:font/woff;base64,AA)} c{background:url(https://cdn.example.com/y.png)} d{background:url(//cdn.example.com/z.png)} e{background:url(#grad)} f{background:url('/portal/resources/img/logo.svg')} g{background:url(\"sem-aspas.png\")}";
  assert.deepEqual(
    urlsDoCss(css, CSS).sort(),
    ['/portal/resources/img/logo.svg', '/style-guide/css/sem-aspas.png', '/style-guide/fonts/x.woff'].sort(),
  );
});

test('404 em um asset lança ErroFluigctl com o caminho e não deixa manifesto', async () => {
  const s = await fakeFluig({
    [CSS]: { body: CORPO_CSS },
    [JQUERY]: { status: 404, body: 'not found' },
    [JS]: { body: CORPO_JS },
    [WOFF]: { body: CORPO_WOFF },
  });
  const { base, cache } = tempCache();
  try {
    await assert.rejects(
      baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache }),
      (erro: unknown) => {
        assert.ok(erro instanceof ErroFluigctl);
        assert.equal(erro.codigo, 3);
        assert.match(erro.message, /jquery/);
        return true;
      },
    );
    assert.equal(lerManifesto(cache), undefined);
    assert.equal(existsSync(join(cache, 'manifesto.json')), false);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('erro de rede lança ErroFluigctl código 3', async () => {
  const { base, cache } = tempCache();
  try {
    const semRede = (() => Promise.reject(new Error('sem rede'))) as unknown as typeof fetch;
    await assert.rejects(
      baixarStyleGuide({ baseUrl: 'http://127.0.0.1:1', cookie: 'c', cacheDir: cache, fetchImpl: semRede }),
      (erro: unknown) => {
        assert.ok(erro instanceof ErroFluigctl);
        assert.equal(erro.codigo, 3);
        return true;
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolverAssetDoCache resolve conhecido e devolve undefined para desconhecido/removido', async () => {
  const s = await servidor();
  const { base, cache } = tempCache();
  try {
    await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache });
    const alvo = resolverAssetDoCache(CSS, cache);
    assert.ok(alvo !== undefined && alvo.endsWith('fluig-style-guide.min.css') && existsSync(alvo));
    assert.equal(resolverAssetDoCache('/style-guide/inexistente.css', cache), undefined);
    rmSync(join(cache, CSS.slice(1)));
    assert.equal(resolverAssetDoCache(CSS, cache), undefined);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolverAssetDoCache recusa traversal literal/codificado, dupla barra e symlink fora da raiz', () => {
  const { base, cache } = tempCache();
  try {
    const hash = 'a'.repeat(64);
    mkdirSync(join(cache, 'style-guide'), { recursive: true });
    writeFileSync(join(cache, 'style-guide', 'ok.css'), 'x');
    const fora = join(base, 'fora.txt');
    writeFileSync(fora, 'segredo');
    symlinkSync(fora, join(cache, 'escape'));
    escreverManifesto(cache, {
      '/style-guide/ok.css': { tamanho: 1, sha256: hash },
      '/../fora.txt': { tamanho: 1, sha256: hash },
      '/style-guide/%2e%2e/fora.txt': { tamanho: 1, sha256: hash },
      '/style-guide//etc/passwd': { tamanho: 1, sha256: hash },
      '/escape': { tamanho: 1, sha256: hash },
    });
    assert.ok(resolverAssetDoCache('/style-guide/ok.css', cache) !== undefined);
    assert.equal(resolverAssetDoCache('/../fora.txt', cache), undefined);
    assert.equal(resolverAssetDoCache('/style-guide/%2e%2e/fora.txt', cache), undefined);
    assert.equal(resolverAssetDoCache('/style-guide//etc/passwd', cache), undefined);
    assert.equal(resolverAssetDoCache('/escape', cache), undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lerManifesto retorna undefined quando ausente ou inválido', () => {
  const { base, cache } = tempCache();
  try {
    assert.equal(lerManifesto(cache), undefined);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'manifesto.json'), '{ não é json');
    assert.equal(lerManifesto(cache), undefined);
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 2, origem: 'x', criadoEm: 'y', arquivos: {}, fontes: {} }));
    assert.equal(lerManifesto(cache), undefined);
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 1, origem: 'x', criadoEm: 'y', arquivos: {} }));
    assert.equal(lerManifesto(cache), undefined, 'sem fontes é inválido');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 1, origem: 'x', criadoEm: 'y', arquivos: {}, fontes: { '/a': 1 } }));
    assert.equal(lerManifesto(cache), undefined, 'fontes com valor não-string é inválido');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 1, origem: 'x', criadoEm: 'y', arquivos: {}, fontes: {}, ignorados: {} }));
    assert.equal(lerManifesto(cache), undefined, 'ignorados precisa ser array');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 1, origem: 'x', criadoEm: 'y', arquivos: {}, fontes: {}, ignorados: [] }));
    assert.ok(lerManifesto(cache) !== undefined, 'as 6 chaves válidas são aceitas');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('compatibilizarFluigc: hash conhecido aplica o token exato e é idempotente; desconhecido recusa', () => {
  const original = Buffer.from('a;window.top.WCMAPI;b;window.top.WCMAPI;c', 'utf8');
  const hashOriginal = sha256de(original.toString('utf8'));
  const r = compatibilizarFluigc(original, hashOriginal, [hashOriginal]);
  assert.ok(r, 'hash conhecido deve patchá-lo');
  assert.equal(r!.patch.versao, 1);
  assert.equal(r!.patch.ocorrencias, 2);
  assert.equal(r!.patch.hashOriginal, hashOriginal);
  assert.equal(r!.conteudo.toString('utf8'), 'a;window.__fluigPreviewWCMAPI;b;window.__fluigPreviewWCMAPI;c');
  assert.ok(!r!.conteudo.toString('utf8').includes('window.top.WCMAPI'));
  assert.equal(r!.patch.hashDerivado, sha256de(r!.conteudo.toString('utf8')));
  // idempotência: o hash derivado não está no conjunto de origens conhecidas -> nada a reaplicar
  assert.equal(compatibilizarFluigc(r!.conteudo, r!.patch.hashDerivado, [hashOriginal]), undefined);
  // fail-closed: hash fora do conjunto
  assert.equal(compatibilizarFluigc(original, sha256de('outro'), [hashOriginal]), undefined);
});

test('baixarStyleGuide patcha o bundle FLUIGC de hash conhecido e preserva o original em .orig', async () => {
  const CORPO_BUNDLE = ['var x=1;', ...Array.from({ length: 8 }, () => 'window.top.WCMAPI;'), 'window.FLUIGC={};'].join('');
  const s = await fakeFluig({
    [CSS_FLAT]: { headers: { 'content-type': 'text/css' }, body: CORPO_CSS },
    [CSS]: { status: 404, body: 'sem css plano' },
    [JQUERY]: { body: CORPO_JQUERY },
    [JS]: { body: CORPO_BUNDLE },
    [WOFF]: { body: CORPO_WOFF },
  });
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache, assets: [JS], hashesFluigc: [sha256de(CORPO_BUNDLE)] });
    const patchado = readFileSync(join(cache, JS.slice(1)), 'utf8');
    assert.ok(patchado.includes('window.__fluigPreviewWCMAPI'), 'bytes patchados no caminho de navegador');
    assert.ok(!patchado.includes('window.top.WCMAPI'), 'token original não resta');
    assert.equal(readFileSync(join(cache, `${JS.slice(1)}.orig`), 'utf8'), CORPO_BUNDLE, 'original preservado em .orig');
    const compat = m.compatibilidade![JS]!;
    assert.equal(compat.versao, 1);
    assert.equal(compat.asset, JS);
    assert.equal(compat.ocorrencias, 8, '8 ocorrências do token, como no bundle oficial');
    assert.equal(compat.hashOriginal, sha256de(CORPO_BUNDLE));
    assert.equal(compat.hashDerivado, sha256de(patchado));
    assert.equal(m.arquivos[JS]!.sha256, compat.hashDerivado, 'o manifesto aponta o hash da variante servida');
    assert.deepEqual(lerManifesto(cache), m);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('baixarStyleGuide recusa patch de hash desconhecido e guarda o original, sem sidecar', async () => {
  const CORPO_BUNDLE = 'var y=2;window.top.WCMAPI;';
  const s = await fakeFluig({
    [CSS_FLAT]: { headers: { 'content-type': 'text/css' }, body: CORPO_CSS },
    [CSS]: { status: 404, body: 'sem css plano' },
    [JQUERY]: { body: CORPO_JQUERY },
    [JS]: { body: CORPO_BUNDLE },
    [WOFF]: { body: CORPO_WOFF },
  });
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache, assets: [JS], hashesFluigc: [] });
    assert.equal(readFileSync(join(cache, JS.slice(1)), 'utf8'), CORPO_BUNDLE, 'original intacto');
    assert.equal(existsSync(join(cache, `${JS.slice(1)}.orig`)), false, 'sem sidecar quando recusado');
    const compat = m.compatibilidade![JS]!;
    assert.equal(compat.recusado, true);
    assert.equal(compat.hashDerivado, undefined);
    assert.equal(m.arquivos[JS]!.sha256, sha256de(CORPO_BUNDLE));
    assert.deepEqual(lerManifesto(cache), m);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('lerManifesto aceita compatibilidade opcional válida e rejeita formato inválido', () => {
  const { base, cache } = tempCache();
  try {
    mkdirSync(cache, { recursive: true });
    const base6 = { versao: 1, origem: 'x', criadoEm: 'y', arquivos: {}, fontes: {}, ignorados: [] };
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, compatibilidade: { [JS]: { versao: 1, asset: JS, hashOriginal: 'a'.repeat(64), recusado: true } } }));
    const lido = lerManifesto(cache);
    assert.ok(lido && lido.compatibilidade, 'compatibilidade opcional aceita');
    assert.equal(lido!.compatibilidade![JS]!.recusado, true);
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, compatibilidade: { [JS]: { versao: 1, asset: JS, hashOriginal: 'a'.repeat(64), hashDerivado: 'zz', ocorrencias: 1 } } }));
    assert.equal(lerManifesto(cache), undefined, 'hashDerivado não-hex é inválido');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, compatibilidade: 3 }));
    assert.equal(lerManifesto(cache), undefined, 'compatibilidade não-objeto é inválida');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, extraDesconhecido: 1 }));
    assert.equal(lerManifesto(cache), undefined, 'chave extra desconhecida é inválida');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('baixarStyleGuide patcha o bundle de select (hash conhecido) e preserva o original em .orig', async () => {
  const CORPO_SELECT_BUNDLE = 'var s=1;window.top.WCMAPI;window.FLUIGC=window.FLUIGC||{};';
  const s = await servidor({ [SELECT]: { body: CORPO_SELECT_BUNDLE } });
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache, hashesFluigc: [sha256de(CORPO_SELECT_BUNDLE)] });
    const patchado = readFileSync(join(cache, SELECT.slice(1)), 'utf8');
    assert.ok(patchado.includes('window.__fluigPreviewWCMAPI'), 'select patchado no caminho de navegador');
    assert.ok(!patchado.includes('window.top.WCMAPI'), 'token original não resta no select');
    assert.equal(readFileSync(join(cache, `${SELECT.slice(1)}.orig`), 'utf8'), CORPO_SELECT_BUNDLE, 'original do select preservado em .orig');
    const compat = m.compatibilidade![SELECT]!;
    assert.equal(compat.versao, 1);
    assert.equal(compat.asset, SELECT);
    assert.equal(compat.ocorrencias, 1, 'o bundle de select tem 1 ocorrência do token');
    assert.equal(compat.hashOriginal, sha256de(CORPO_SELECT_BUNDLE));
    assert.equal(compat.hashDerivado, sha256de(patchado));
    assert.equal(m.arquivos[SELECT]!.sha256, compat.hashDerivado);
    assert.equal(m.compatibilidade![JS]!.recusado, true, 'o bundle base de hash desconhecido fica recusado');
    assert.deepEqual(lerManifesto(cache), m);
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('baixarStyleGuide recusa o patch do select de hash desconhecido e guarda o original', async () => {
  const CORPO_SELECT_BUNDLE = 'var s=2;window.top.WCMAPI;';
  const s = await servidor({ [SELECT]: { body: CORPO_SELECT_BUNDLE } });
  const { base, cache } = tempCache();
  try {
    const m = await baixarStyleGuide({ baseUrl: s.url, cookie: 'c', cacheDir: cache, assets: [SELECT], hashesFluigc: [] });
    assert.equal(readFileSync(join(cache, SELECT.slice(1)), 'utf8'), CORPO_SELECT_BUNDLE, 'select original intacto');
    assert.equal(existsSync(join(cache, `${SELECT.slice(1)}.orig`)), false, 'sem sidecar quando recusado');
    assert.equal(m.compatibilidade![SELECT]!.recusado, true);
    assert.equal(m.compatibilidade![SELECT]!.hashDerivado, undefined);
    assert.equal(m.arquivos[SELECT]!.sha256, sha256de(CORPO_SELECT_BUNDLE));
  } finally {
    await s.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('manifestoValido exige asset e rejeita chave extra na compatibilidade', () => {
  const { base, cache } = tempCache();
  try {
    mkdirSync(cache, { recursive: true });
    const base6 = { versao: 1, origem: 'x', criadoEm: 'y', arquivos: {}, fontes: {}, ignorados: [] };
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, compatibilidade: { [JS]: { versao: 1, hashOriginal: 'a'.repeat(64), recusado: true } } }));
    assert.equal(lerManifesto(cache), undefined, 'entrada sem asset é inválida');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, compatibilidade: { [JS]: { versao: 1, asset: JS, hashOriginal: 'a'.repeat(64), recusado: true, chaveExtra: 1 } } }));
    assert.equal(lerManifesto(cache), undefined, 'chave extra na entrada é inválida');
    writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ ...base6, compatibilidade: { [JS]: { versao: 1, asset: JS, hashOriginal: 'a'.repeat(64), recusado: true } } }));
    assert.ok(lerManifesto(cache) !== undefined, 'forma válida com asset continua aceita');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
