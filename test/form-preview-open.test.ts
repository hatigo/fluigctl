import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

import { ErroFluigctl } from '../src/errors.js';
import { startPreviewCore } from '../src/form/preview-core.js';
import {
  abrirPreview,
  arquivoDoRegistro,
  fecharPreview,
  servirPreview,
} from '../src/form/preview-session.js';
import { diretorioDoCache } from '../src/form/style-guide.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const CSS_PATH = '/style-guide/css/fluig-style-guide.min.css';
const CSS_BODY = '.a{color:red}';

function formulario(): { raiz: string; html: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'preview-form-'));
  const html = join(raiz, 'formTeste.html');
  writeFileSync(html, '<!doctype html><html><head></head><body><h1>ok</h1><script>window.ok=true</script></body></html>');
  writeFileSync(join(raiz, 'main.js'), 'console.log("local")');
  return { raiz, html, registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

function escreverCache(cache: string): void {
  mkdirSync(join(cache, 'style-guide', 'css'), { recursive: true });
  writeFileSync(join(cache, 'style-guide', 'css', 'fluig-style-guide.min.css'), CSS_BODY);
  const sha = createHash('sha256').update(Buffer.from(CSS_BODY)).digest('hex');
  writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({
    versao: 1,
    origem: 'http://x',
    criadoEm: new Date().toISOString(),
    arquivos: { [CSS_PATH]: { tamanho: Buffer.byteLength(CSS_BODY), sha256: sha } },
    fontes: { [CSS_PATH]: CSS_PATH },
    ignorados: [],
  }));
}

function cacheStyleGuide(): { base: string; cache: string; limpar(): void } {
  const base = mkdtempSync(join(tmpdir(), 'preview-cache-'));
  escreverCache(join(base, 'styleguide'));
  return { base, cache: join(base, 'styleguide'), limpar: () => rmSync(base, { recursive: true, force: true }) };
}

async function esperar(condicao: () => boolean, ms = 5000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((ok) => setTimeout(ok, 30));
  }
  assert.fail('a condição não foi satisfeita dentro do prazo');
}

test('abrirPreview sem cache lança ErroFluigctl código 3 e não cria registro', async () => {
  const p = formulario();
  const vazio = mkdtempSync(join(tmpdir(), 'preview-vazio-'));
  try {
    await assert.rejects(
      abrirPreview({ arquivo: p.html, cacheDir: vazio, registroDir: p.registro, abrirNavegador: false }),
      (erro: unknown) => {
        assert.ok(erro instanceof ErroFluigctl);
        assert.equal(erro.codigo, 3);
        assert.match(erro.message, /form bootstrap/);
        return true;
      },
    );
    assert.ok(!existsSync(arquivoDoRegistro(p.html, p.registro)), 'nenhum registro criado');
  } finally {
    rmSync(vazio, { recursive: true, force: true });
    p.limpar();
  }
});

test('servirPreview serve controle, frame, asset do cache e estado; fechar limpa o registro', async () => {
  const p = formulario();
  const c = cacheStyleGuide();
  const v = await servirPreview({ arquivo: p.html, cacheDir: c.cache, registroDir: p.registro });
  const caminho = arquivoDoRegistro(p.html, p.registro);
  try {
    assert.ok(existsSync(caminho));
    assert.equal(statSync(caminho).mode & 0o777, 0o600);

    const controlResp = await fetch(v.url);
    assert.match(controlResp.headers.get('content-security-policy') ?? '', /connect-src 'self'/, 'CSP do controle libera o SSE same-origin');
    const control = await controlResp.text();
    assert.match(control, /sandbox="allow-scripts allow-forms allow-modals"/);
    assert.match(control, /EventSource/);
    const nonce = control.match(/n=([a-f0-9]+)/)![1]!;

    const frameResp = await fetch(`http://127.0.0.1:${v.registro.port}/frame?n=${nonce}`);
    assert.match(frameResp.headers.get('content-security-policy') ?? '', /connect-src 'none'/);
    const frame = await frameResp.text();
    assert.match(frame, /window\.ok=true/);

    const css = await fetch(`http://127.0.0.1:${v.registro.port}${CSS_PATH}`);
    assert.equal(css.status, 200);
    assert.equal(await css.text(), CSS_BODY);

    const estado = await (await fetch(`http://127.0.0.1:${v.registro.port}/state/${v.registro.token}`)).json() as { arquivo: string; raiz: string };
    assert.equal(estado.arquivo, realpathSync(p.html));
    assert.equal(estado.raiz, realpathSync(p.raiz));

    assert.equal((await fetch(`http://127.0.0.1:${v.registro.port}/state/errado`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${v.registro.port}/events/errado`)).status, 404);
  } finally {
    await v.fechar();
    c.limpar();
    p.limpar();
  }
  assert.ok(!existsSync(caminho), 'registro removido ao fechar');
});

test('recarregar e salvar o formulário entregam data: reload no SSE', async () => {
  const p = formulario();
  const c = cacheStyleGuide();
  const core = await startPreviewCore(p.html, { cacheDir: c.cache });
  const reader = (await fetch(`http://127.0.0.1:${core.port}/events/${core.token}`)).body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const lerAte = async (vezes: number): Promise<void> => {
    const fim = Date.now() + 4000;
    while (Date.now() < fim) {
      if ((buffer.match(/data: reload/g) ?? []).length >= vezes) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    assert.fail(`não recebeu ${vezes} reload(s); buffer=${JSON.stringify(buffer)}`);
  };
  try {
    while (!buffer.includes('conectado')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    assert.match(buffer, /conectado/);
    core.recarregar();
    await lerAte(1);
    writeFileSync(p.html, '<!doctype html><html><body>mudou</body></html>');
    await lerAte(2);
  } finally {
    await reader.cancel();
    await core.close();
    c.limpar();
    p.limpar();
  }
});

test('script de controle assina o SSE e recarrega o iframe na mensagem', async () => {
  const p = formulario();
  const c = cacheStyleGuide();
  const core = await startPreviewCore(p.html, { cacheDir: c.cache });
  try {
    const html = await (await fetch(core.url)).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const instancias: { url: string; onmessage: (() => void) | null }[] = [];
    class EventSourceFalso {
      onmessage: (() => void) | null = null;
      constructor(readonly url: string) { instancias.push(this); }
    }
    const iframe: { _src: string; atribuicoes: number; src: string; addEventListener(): void; contentWindow: object } = {
      _src: 'http://x/frame',
      atribuicoes: 0,
      get src() { return this._src; },
      set src(valor: string) { this._src = valor; this.atribuicoes += 1; },
      addEventListener() {},
      contentWindow: {},
    };
    const contexto: Record<string, unknown> = {
      document: { querySelector: () => iframe },
      addEventListener() {},
      console: { warn() {}, log() {}, error() {} },
      MessageChannel: globalThis.MessageChannel,
      EventSource: EventSourceFalso,
    };
    vm.runInNewContext(script, contexto);
    assert.equal(instancias.length, 1);
    assert.equal(instancias[0]!.url, `/events/${core.token}`);
    assert.equal(typeof instancias[0]!.onmessage, 'function');
    const antes = iframe.atribuicoes;
    instancias[0]!.onmessage!();
    assert.equal(iframe.atribuicoes, antes + 1, 'onmessage reatribui iframe.src');
  } finally {
    await core.close();
    c.limpar();
    p.limpar();
  }
});

test('abrirPreview sem cacheDir usa o cache padrão e o filho serve o Style Guide', async () => {
  const p = formulario();
  const base = mkdtempSync(join(tmpdir(), 'preview-xdg-'));
  escreverCache(diretorioDoCache(base));
  const anterior = process.env['XDG_STATE_HOME'];
  process.env['XDG_STATE_HOME'] = base;
  let pid: number | undefined;
  try {
    const instancia = await abrirPreview({ arquivo: p.html, abrirNavegador: false, registroDir: p.registro, cli: CLI });
    pid = instancia.registro.pid;
    const css = await fetch(`http://127.0.0.1:${instancia.registro.port}${CSS_PATH}`);
    assert.equal(css.status, 200, 'o filho recebeu o cacheDir padrão');
    assert.equal(await css.text(), CSS_BODY);
    await fecharPreview(p.html, p.registro);
    pid = undefined;
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* já saiu */ }
    }
    if (anterior === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = anterior;
    rmSync(base, { recursive: true, force: true });
    p.limpar();
  }
});

test('abrirPreview em segundo plano reutiliza a sessão e fecharPreview encerra', async () => {
  const p = formulario();
  const c = cacheStyleGuide();
  let pid: number | undefined;
  try {
    const primeira = await abrirPreview({
      arquivo: p.html,
      abrirNavegador: false,
      registroDir: p.registro,
      cacheDir: c.cache,
      cli: CLI,
    });
    pid = primeira.registro.pid;
    assert.equal(primeira.reutilizada, false);
    assert.notEqual(pid, process.pid, 'o preview roda em outro processo');
    assert.ok(existsSync(arquivoDoRegistro(p.html, p.registro)));
    assert.match(await (await fetch(primeira.url)).text(), /EventSource/);

    const segunda = await abrirPreview({
      arquivo: p.html,
      abrirNavegador: false,
      registroDir: p.registro,
      cacheDir: c.cache,
      cli: CLI,
    });
    assert.equal(segunda.reutilizada, true);
    assert.equal(segunda.registro.pid, pid);

    const fechado = await fecharPreview(p.html, p.registro);
    assert.equal(fechado?.pid, pid);
    await esperar(() => {
      try { process.kill(pid!, 0); return false; } catch { return true; }
    });
    assert.ok(!existsSync(arquivoDoRegistro(p.html, p.registro)));
    pid = undefined;
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* já saiu */ }
    }
    c.limpar();
    p.limpar();
  }
});
