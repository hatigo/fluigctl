import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { CONTEXTO_PADRAO, baseSemSufixo, indicesDeFilho, proximoIndice, scriptDaApi, type ContextoPreview } from '../src/form/frame-api.js';
import { startPreviewCore } from '../src/form/preview-core.js';

interface ElementoMock {
  name?: string;
  type?: string;
  value: string;
  appendChild?: (elemento: ElementoMock) => void;
}

function criarDocumento(): { document: unknown; campos: Map<string, ElementoMock> } {
  const campos = new Map<string, ElementoMock>();
  const formEl: ElementoMock = {
    value: '',
    appendChild: (elemento) => { if (elemento.name) campos.set(elemento.name, elemento); },
  };
  const bodyEl: ElementoMock = {
    value: '',
    appendChild: (elemento) => { if (elemento.name) campos.set(elemento.name, elemento); },
  };
  const document = {
    querySelector: (seletor: string): ElementoMock | null => {
      const campo = /^\[name="(.+)"\]$/.exec(seletor);
      if (campo) return campos.get(campo[1]!) ?? null;
      if (seletor === 'form[name="form"]') return formEl;
      return null;
    },
    createElement: (_tag: string): ElementoMock => ({ value: '' }),
    body: bodyEl,
  };
  return { document, campos };
}

function rodar(contexto: ContextoPreview): { sandbox: any; campos: Map<string, ElementoMock>; avisos: string[] } {
  const { document, campos } = criarDocumento();
  const avisos: string[] = [];
  const sandbox: any = { document, console: { warn: (m: string) => avisos.push(m), log() {}, error() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptDaApi(contexto), sandbox);
  return { sandbox, campos, avisos };
}

test('define os globais de contexto, o snapshot congelado e os getters', () => {
  const { sandbox } = rodar({ modo: 'MOD', atividade: 7, usuario: 'ana', processo: 42, empresa: 1 });
  assert.equal(sandbox.WKNumState, '7');
  assert.equal(sandbox.WKUser, 'ana');
  assert.equal(sandbox.WKMode, 'MOD');
  assert.equal(sandbox.WKNumProces, '42');
  assert.equal(sandbox.WKCompany, '1');
  assert.equal(sandbox.getAtividade(), 7);
  assert.equal(sandbox.getMode(), 'MOD');
  assert.equal(sandbox.getUser(), 'ana');
  assert.deepEqual({ ...sandbox.__fluigPreviewContexto }, { modo: 'MOD', atividade: 7, usuario: 'ana', processo: 42, empresa: 1 });
  assert.equal(Object.isFrozen(sandbox.__fluigPreviewContexto), true);
  assert.equal(sandbox.__fluigPreview.contexto, sandbox.__fluigPreviewContexto);
});

test('omite WKNumProces/WKCompany quando não informados e getValue devolve vazio', () => {
  const { sandbox } = rodar(CONTEXTO_PADRAO);
  assert.equal(sandbox.WKNumProces, undefined);
  assert.equal(sandbox.WKCompany, undefined);
  assert.equal(sandbox.getValue('WKNumProces'), '');
  assert.equal(sandbox.getValue('WKCompany'), '');
});

test('getValue/setValue em campo existente (roundtrip)', () => {
  const { sandbox, campos } = rodar(CONTEXTO_PADRAO);
  campos.set('nome', { name: 'nome', value: 'inicial' });
  assert.equal(sandbox.getValue('nome'), 'inicial');
  sandbox.setValue('nome', 'novo');
  assert.equal(sandbox.getValue('nome'), 'novo');
});

test('setValue cria input hidden quando o campo não existe e getValue lê de volta', () => {
  const { sandbox, campos } = rodar(CONTEXTO_PADRAO);
  sandbox.setValue('extra', 'x');
  const criado = campos.get('extra');
  assert.ok(criado, 'o campo foi criado');
  assert.equal(criado!.type, 'hidden');
  assert.equal(sandbox.getValue('extra'), 'x');
});

test('WK* não é gravável por setValue', () => {
  const { sandbox, campos } = rodar(CONTEXTO_PADRAO);
  sandbox.setValue('WKUser', 'invasor');
  assert.equal(sandbox.WKUser, 'preview');
  assert.equal(campos.has('WKUser'), false);
});

test('window.form expõe getValue/setValue/getFormMode/getChildrenIndexes', () => {
  const { sandbox, campos } = rodar({ modo: 'VIEW', atividade: 3, usuario: 'preview' });
  campos.set('x', { name: 'x', value: '1' });
  assert.equal(sandbox.form.getValue('x'), '1');
  sandbox.form.setValue('y', '2');
  assert.equal(sandbox.form.getValue('y'), '2');
  assert.equal(sandbox.form.getFormMode(), 'VIEW');
  assert.equal(sandbox.form.getChildrenIndexes('tabela').length, 0);
});

test('registra diagnóstico de contexto simulado e de eventos/datasets ausentes', () => {
  const { sandbox, avisos } = rodar(CONTEXTO_PADRAO);
  const mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.some((m) => /SIMULADO/.test(m) && /displayFields/.test(m) && /validateForm/.test(m)));
  assert.ok(mensagens.some((m) => /datasets no preview só funcionam com --server/.test(m)));
  for (const d of sandbox.__fluigPreview.diagnosticos) assert.equal(typeof d.em, 'string');
  assert.ok(avisos.some((m) => m.startsWith('preview: ')));
});

test('diagnosticar empilha e chama console.warn', () => {
  const { sandbox, avisos } = rodar(CONTEXTO_PADRAO);
  const antes = sandbox.__fluigPreview.diagnosticos.length;
  sandbox.__fluigPreview.diagnosticar('oi');
  assert.equal(sandbox.__fluigPreview.diagnosticos.length, antes + 1);
  assert.ok(avisos.includes('preview: oi'));
});

test('usuario com </script> é escapado no literal e não quebra o script', () => {
  const texto = scriptDaApi({ modo: 'ADD', atividade: 0, usuario: '</script><img src=x onerror=alert(1)>' });
  assert.ok(!texto.includes('</script>'), 'nada de </script> cru');
  assert.ok(!texto.includes('<img'), 'nada de tag crua');
  assert.ok(texto.includes('\\u003c'), 'usa escape \\u003c');
  const { sandbox } = rodar({ modo: 'ADD', atividade: 0, usuario: '</script>' });
  assert.equal(sandbox.WKUser, '</script>');
});

test('U+2028 e U+2029 no contexto não vazam crus', () => {
  const texto = scriptDaApi({ modo: 'ADD', atividade: 0, usuario: 'a\u2028b\u2029c' });
  assert.ok(!texto.includes('\u2028'));
  assert.ok(!texto.includes('\u2029'));
  assert.ok(texto.includes('\\u2028'));
  assert.ok(texto.includes('\\u2029'));
});

// --- Pai-filho: helpers puros e mock de DOM mínimo ---

test('proximoIndice/indicesDeFilho/baseSemSufixo (puros)', () => {
  assert.equal(proximoIndice(['a', 'b___1', 'b___3']), 4);
  assert.equal(proximoIndice([]), 1);
  assert.equal(proximoIndice(['a', 'b']), 1);
  assert.deepEqual(indicesDeFilho(['b___2', 'b___1', 'b___1']), [1, 2]);
  assert.deepEqual(indicesDeFilho([]), []);
  assert.deepEqual(indicesDeFilho(['a', 'b']), []);
  assert.equal(baseSemSufixo('b___3'), 'b');
  assert.equal(baseSemSufixo('b'), 'b');
});

function casa(el: Elemento, sel: string): boolean {
  if (sel === 'tbody') return el.tag === 'TBODY';
  if (sel === 'tr') return el.tag === 'TR';
  if (sel === '[name]') return el.atributos.has('name');
  const campo = /^\[name="(.+)"\]$/.exec(sel);
  if (campo) return el.atributos.get('name') === campo[1];
  const tabela = /^table\[tablename="(.+)"\]$/.exec(sel);
  if (tabela) return el.tag === 'TABLE' && el.atributos.get('tablename') === tabela[1];
  return false;
}

class Elemento {
  readonly atributos = new Map<string, string>();
  readonly filhos: Elemento[] = [];
  readonly style: Record<string, string> = {};
  pai: Elemento | null = null;
  value = '';
  checked = false;
  type = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag.toUpperCase(); }
  get nodeName(): string { return this.tag; }
  getAttribute(nome: string): string | null { return this.atributos.get(nome) ?? null; }
  setAttribute(nome: string, valor: string): void { this.atributos.set(nome, String(valor)); }
  appendChild(el: Elemento): Elemento { el.pai = this; this.filhos.push(el); return el; }
  remove(): void { if (this.pai) { const i = this.pai.filhos.indexOf(this); if (i >= 0) this.pai.filhos.splice(i, 1); this.pai = null; } }
  closest(sel: string): Elemento | null { let no: Elemento | null = this; while (no) { if (casa(no, sel)) return no; no = no.pai; } return null; }
  querySelector(sel: string): Elemento | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): Elemento[] { const out: Elemento[] = []; for (const f of this.filhos) { if (casa(f, sel)) out.push(f); out.push(...f.querySelectorAll(sel)); } return out; }
  cloneNode(deep?: boolean): Elemento {
    const c = new Elemento(this.tag);
    for (const [k, v] of this.atributos) c.atributos.set(k, v);
    c.value = this.value;
    c.checked = this.checked;
    c.type = this.type;
    for (const k of Object.keys(this.style)) c.style[k] = this.style[k]!;
    if (deep) for (const f of this.filhos) c.appendChild(f.cloneNode(true));
    return c;
  }
}

function criarDocumentoComTabela(opcoes: { produto?: string; ativo?: string; sufixada?: boolean } = {}): { document: unknown; raiz: Elemento; formEl: Elemento; tabela: Elemento; tbody: Elemento; modelo: Elemento; produtoModelo: Elemento; ativoModelo: Elemento } {
  const raiz = new Elemento('body');
  const formEl = new Elemento('form');
  formEl.setAttribute('name', 'form');
  raiz.appendChild(formEl);
  const tabela = new Elemento('table');
  tabela.setAttribute('tablename', 'itens');
  raiz.appendChild(tabela);
  const thead = new Elemento('thead');
  tabela.appendChild(thead);
  thead.appendChild(new Elemento('tr'));
  const tbody = new Elemento('tbody');
  tabela.appendChild(tbody);
  // Linha modelo VISÍVEL: é o produto que deve escondê-la ao adicionar.
  const modelo = new Elemento('tr');
  const tdProduto = new Elemento('td');
  const produtoModelo = new Elemento('input');
  produtoModelo.setAttribute('name', opcoes.produto ?? 'itemProduto');
  produtoModelo.type = 'text';
  produtoModelo.value = 'modelo';
  tdProduto.appendChild(produtoModelo);
  const tdAtivo = new Elemento('td');
  const ativoModelo = new Elemento('input');
  ativoModelo.setAttribute('name', opcoes.ativo ?? 'itemAtivo');
  ativoModelo.type = 'checkbox';
  ativoModelo.checked = true;
  tdAtivo.appendChild(ativoModelo);
  modelo.appendChild(tdProduto);
  modelo.appendChild(tdAtivo);
  tbody.appendChild(modelo);
  if (opcoes.sufixada) {
    const linha = new Elemento('tr');
    const td = new Elemento('td');
    const campo = new Elemento('input');
    campo.setAttribute('name', 'itemProduto___9');
    campo.value = 'real';
    td.appendChild(campo);
    linha.appendChild(td);
    tbody.appendChild(linha);
  }
  const document = {
    querySelector: (sel: string): Elemento | null => raiz.querySelector(sel),
    createElement: (tag: string): Elemento => new Elemento(tag),
    body: raiz,
  };
  return { document, raiz, formEl, tabela, tbody, modelo, produtoModelo, ativoModelo };
}

function executar(document: unknown, contexto: ContextoPreview): { sandbox: any; avisos: string[] } {
  const avisos: string[] = [];
  const sandbox: any = { document, console: { warn: (m: string) => avisos.push(m), log() {}, error() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptDaApi(contexto), sandbox);
  return { sandbox, avisos };
}

test('wdkAddChild clona a linha modelo, renomeia, limpa e retorna o índice', () => {
  const { document, tabela, tbody, modelo, produtoModelo } = criarDocumentoComTabela();
  const { sandbox } = executar(document, CONTEXTO_PADRAO);

  assert.equal(modelo.style['display'], undefined, 'o fixture começa com a modelo visível');
  assert.equal(sandbox.wdkAddChild('itens'), 1);
  assert.equal(modelo.style['display'], 'none', 'é o produto que esconde a linha modelo');
  assert.equal(produtoModelo.value, 'modelo', 'o modelo não é limpo');

  const linhas = tbody.querySelectorAll('tr');
  assert.equal(linhas.length, 2, 'modelo + 1 clone');
  const linha1 = linhas[1]!;
  assert.equal(linha1.style['display'], '', 'o clone fica visível');
  const produto1 = tabela.querySelector('[name="itemProduto___1"]');
  const ativo1 = tabela.querySelector('[name="itemAtivo___1"]');
  assert.ok(produto1, 'input renomeado para itemProduto___1');
  assert.equal(produto1!.value, '', 'valor do clone limpo');
  assert.ok(ativo1, 'checkbox renomeado também');
  assert.equal(ativo1!.checked, false, 'checkbox desmarcado no clone');
  assert.equal(ativo1!.value, '', 'valor do checkbox limpo');

  assert.equal(sandbox.wdkAddChild('itens'), 2);
  assert.ok(tabela.querySelector('[name="itemProduto___2"]'));
  assert.deepEqual([...sandbox.form.getChildrenIndexes('itens')], [1, 2]);
});

test('wdkAddChild escolhe a linha modelo sem sufixo, não a última linha', () => {
  const { document, tabela, modelo } = criarDocumentoComTabela({ sufixada: true });
  const { sandbox } = executar(document, CONTEXTO_PADRAO);
  assert.equal(modelo.style['display'], undefined, 'a modelo começa visível');
  assert.equal(sandbox.wdkAddChild('itens'), 10, 'maior sufixo existente (9) + 1');
  assert.equal(modelo.style['display'], 'none', 'a modelo (primeira) é escondida');
  const criado = tabela.querySelector('[name="itemProduto___10"]');
  assert.ok(criado, 'o clone usa a base sem sufixo da modelo');
  assert.equal(criado!.value, '');
  assert.equal(tabela.querySelector('[name="itemProduto___9"]')!.value, 'real', 'a linha sufixada fica intacta');
  assert.equal(tabela.querySelectorAll('[name="itemProduto___9"]').length, 1, 'a linha sufixada não foi clonada');
  const linhaSufixada = tabela.querySelector('[name="itemProduto___9"]')!.closest('tr');
  assert.equal(linhaSufixada!.style['display'], undefined, 'a linha sufixada não é escondida');
});

test('fnWdkRemoveChild remove a linha e getChildrenIndexes reflete', () => {
  const { document, tabela } = criarDocumentoComTabela();
  const { sandbox } = executar(document, CONTEXTO_PADRAO);
  sandbox.wdkAddChild('itens');
  sandbox.wdkAddChild('itens');
  const produto1 = tabela.querySelector('[name="itemProduto___1"]');
  assert.ok(produto1);
  sandbox.fnWdkRemoveChild(produto1);
  assert.equal(tabela.querySelector('[name="itemProduto___1"]'), null);
  assert.equal(tabela.querySelector('[name="itemAtivo___1"]'), null);
  assert.deepEqual([...sandbox.form.getChildrenIndexes('itens')], [2]);
});

test('fnWdkRemoveChild cai no parentNode quando não há closest', () => {
  const { document } = criarDocumentoComTabela();
  const { sandbox } = executar(document, CONTEXTO_PADRAO);
  let removida = false;
  const tr: any = { nodeName: 'TR', remove: () => { removida = true; } };
  const input: any = { parentNode: tr };
  sandbox.fnWdkRemoveChild(input);
  assert.equal(removida, true);
});

test('wdkAddChild de tabela inexistente devolve null e diagnostica', () => {
  const { document } = criarDocumentoComTabela();
  const { sandbox, avisos } = executar(document, CONTEXTO_PADRAO);
  assert.equal(sandbox.wdkAddChild('naoExiste'), null);
  const mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.includes('tabela pai-filho não encontrada: naoExiste'));
  assert.ok(avisos.includes('preview: tabela pai-filho não encontrada: naoExiste'));
});

test('wdkAddChild sem linha modelo (só linhas sufixadas) devolve null e não esconde nem clona', () => {
  const { document, tbody, modelo } = criarDocumentoComTabela({ produto: 'itemProduto___1', ativo: 'itemAtivo___1' });
  const { sandbox, avisos } = executar(document, CONTEXTO_PADRAO);
  const linhasAntes = tbody.querySelectorAll('tr').length;
  assert.equal(sandbox.wdkAddChild('itens'), null);
  assert.equal(modelo.style['display'], undefined, 'nenhuma linha foi escondida');
  assert.equal(tbody.querySelectorAll('tr').length, linhasAntes, 'nenhuma linha foi adicionada');
  assert.equal(tbody.querySelector('[name="itemProduto___2"]'), null, 'nenhum clone criado');
  const mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.includes('linha modelo pai-filho não encontrada: itens'));
  assert.ok(avisos.includes('preview: linha modelo pai-filho não encontrada: itens'));
});

// --- Ponte FLUIGC (só usa o objeto real quando presente) ---

test('__fluigPreview.calendar/select chamam o FLUIGC real quando presente', () => {
  const { sandbox } = rodar(CONTEXTO_PADRAO);
  const chamadas: unknown[][] = [];
  const alvo = {};
  sandbox.FLUIGC = {
    calendar: (a: unknown, o: unknown) => { chamadas.push(['calendar', a, o]); return { widget: 'calendario' }; },
    select: (a: unknown, o: unknown) => { chamadas.push(['select', a, o]); return { widget: 'selecao' }; },
  };
  assert.deepEqual({ ...sandbox.__fluigPreview.calendar(alvo, { a: 1 }) }, { widget: 'calendario' });
  assert.deepEqual({ ...sandbox.__fluigPreview.select(alvo, { b: 2 }) }, { widget: 'selecao' });
  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[0]![0], 'calendar');
  assert.equal(chamadas[0]![1], alvo);
  assert.deepEqual(chamadas[0]![2], { a: 1 });
  assert.equal(chamadas[1]![0], 'select');
  assert.equal(chamadas[1]![1], alvo);
  assert.deepEqual(chamadas[1]![2], { b: 2 });
});

test('__fluigPreview.calendar sem FLUIGC devolve null, não lança e diagnostica', () => {
  const { sandbox } = rodar(CONTEXTO_PADRAO);
  let resultado: unknown = 'sentinela';
  assert.doesNotThrow(() => { resultado = sandbox.__fluigPreview.calendar({}, {}); });
  assert.equal(resultado, null);
  const mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.some((m) => /FLUIGC não está disponível/.test(m) && /calendar/.test(m)));
});

test('componente FLUIGC sem função diagnostica e devolve null', () => {
  const { sandbox } = rodar(CONTEXTO_PADRAO);
  sandbox.FLUIGC = {};
  assert.equal(sandbox.__fluigPreview.select({}, {}), null);
  const mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.some((m) => m.includes('FLUIGC.select não existe')));
});

test('erro ao instanciar o componente é diagnosticado e devolve null sem lançar', () => {
  const { sandbox } = rodar(CONTEXTO_PADRAO);
  sandbox.FLUIGC = { calendar: () => { throw new Error('boom'); } };
  let resultado: unknown = 'sentinela';
  assert.doesNotThrow(() => { resultado = sandbox.__fluigPreview.calendar({}, {}); });
  assert.equal(resultado, null);
  const mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.some((m) => m.includes('falha ao instanciar FLUIGC.calendar: boom')));
});

test('DOMContentLoaded diagnostica o FLUIGC ausente ou carregado do cache', () => {
  const listeners: Record<string, () => void> = {};
  const document = {
    readyState: 'loading',
    addEventListener: (nome: string, fn: () => void) => { listeners[nome] = fn; },
    querySelector: () => null,
    createElement: () => ({ value: '' }),
    body: { appendChild() {} },
  };
  const { sandbox } = executar(document, CONTEXTO_PADRAO);
  assert.equal(typeof listeners['DOMContentLoaded'], 'function', 'registra o listener antes do DOM carregar');
  listeners['DOMContentLoaded']!();
  let mensagens: string[] = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.some((m) => m.includes('componentes FLUIGC do cache não carregaram')));
  sandbox.FLUIGC = { calendar: () => ({}) };
  listeners['DOMContentLoaded']!();
  mensagens = sandbox.__fluigPreview.diagnosticos.map((d: { mensagem: string }) => d.mensagem);
  assert.ok(mensagens.some((m) => m.includes('FLUIGC carregado do cache local')));
});

// --- Frame servido: referências do Style Guide e CSP ---

test('frame servido referencia jQuery e o style-guide do cache e mantém connect-src none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frame-api-'));
  writeFileSync(join(dir, 'form.html'), '<!doctype html><html><head><link rel="stylesheet" href="/style-guide/css/fluig-style-guide.min.css"><script src="/portal/resources/js/jquery/jquery.js"></script><script src="/style-guide/js/fluig-style-guide.min.js"></script></head><body>ok</body></html>');
  const cache = join(dir, 'cache');
  const conteudos: Record<string, string> = {
    '/portal/resources/js/jquery/jquery.js': '/* jquery */',
    '/style-guide/js/fluig-style-guide.min.js': 'window.FLUIGC = window.FLUIGC || {};',
  };
  const arquivos: Record<string, { tamanho: number; sha256: string }> = {};
  const fontes: Record<string, string> = {};
  for (const [caminho, conteudo] of Object.entries(conteudos)) {
    const alvo = join(cache, caminho.slice(1));
    mkdirSync(dirname(alvo), { recursive: true });
    writeFileSync(alvo, conteudo);
    arquivos[caminho] = { tamanho: Buffer.byteLength(conteudo), sha256: createHash('sha256').update(Buffer.from(conteudo)).digest('hex') };
    fontes[caminho] = caminho;
  }
  writeFileSync(join(cache, 'manifesto.json'), JSON.stringify({ versao: 1, origem: 'http://x', criadoEm: new Date().toISOString(), arquivos, fontes, ignorados: [] }));
  const core = await startPreviewCore(join(dir, 'form.html'), { cacheDir: cache, watch: false });
  try {
    const control = await (await fetch(core.url)).text();
    const nonce = control.match(/n=([a-f0-9]+)/)![1]!;
    const resp = await fetch(`http://127.0.0.1:${core.port}/frame?n=${nonce}`);
    const frame = await resp.text();
    assert.ok(frame.includes('/portal/resources/js/jquery/jquery.js'));
    assert.ok(frame.includes('/style-guide/js/fluig-style-guide.min.js'));
    assert.match(resp.headers.get('content-security-policy') ?? '', /connect-src 'none'/);
    assert.equal((await fetch(`http://127.0.0.1:${core.port}/style-guide/js/fluig-style-guide.min.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${core.port}/portal/resources/js/jquery/jquery.js`)).status, 200);
  } finally {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DatasetFactory/ConstraintType do shim enfileiram até conectar e resolvem ok/erro', () => {
  const { sandbox } = rodar(CONTEXTO_PADRAO);
  assert.deepEqual({ ...sandbox.ConstraintType }, { MUST: 1, SHOULD: 2, MUST_NOT: 3 });
  const constraint = sandbox.DatasetFactory.createConstraint('x', '1', '1', sandbox.ConstraintType.MUST, true);
  assert.deepEqual(JSON.parse(JSON.stringify(constraint)), { campo: 'x', inicial: '1', final: '1', tipo: 1, like: true });
  const enviadas: unknown[] = [];
  const porta: any = { onmessage: null, postMessage: (m: unknown) => enviadas.push(m) };
  let sucesso: unknown;
  let erro: string | undefined;
  sandbox.DatasetFactory.getDataset('ds', ['a'], [constraint], ['a'], {
    success: (r: unknown) => { sucesso = r; },
    error: (e: Error) => { erro = e.message; },
  });
  assert.equal(enviadas.length, 0, 'sem canal ainda não envia');
  sandbox.__fluigPreview.conectar(porta);
  assert.equal(enviadas.length, 1, 'flush ao conectar');
  assert.deepEqual(JSON.parse(JSON.stringify(enviadas[0])), {
    v: 1, type: 'dataset', id: 'ds-1', nome: 'ds', campos: ['a'],
    restricoes: [{ campo: 'x', inicial: '1', final: '1', tipo: 1, like: true }], ordem: ['a'],
  });
  porta.onmessage({ data: { v: 1, type: 'dataset:ok', id: 'ds-1', columns: ['A'], values: [] } });
  assert.deepEqual(JSON.parse(JSON.stringify(sucesso)), { columns: ['A'], values: [] });
  assert.equal(erro, undefined);
});
