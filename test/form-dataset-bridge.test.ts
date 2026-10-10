import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { CONTEXTO_PADRAO, scriptDaApi } from '../src/form/frame-api.js';
import { startPreviewCore, type ConsultaDatasetPreview } from '../src/form/preview-core.js';
import { consultaDoServidor, servirPreview } from '../src/form/preview-session.js';
import { fakeFluig } from './helpers/fake-fluig.js';

function formulario(): { raiz: string; html: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'dataset-bridge-'));
  const html = join(raiz, 'f.html');
  writeFileSync(html, '<!doctype html><html><head></head><body>ok</body></html>');
  return { raiz, html, limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

async function postDataset(port: number, token: string, corpo: unknown | string): Promise<{ status: number; json: any }> {
  const body = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  const resposta = await fetch(`http://127.0.0.1:${port}/dataset/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  let json: any;
  try { json = await resposta.json(); } catch { json = undefined; }
  return { status: resposta.status, json };
}

const tick = () => new Promise<void>((ok) => setTimeout(ok, 0));

// --- Rota Node POST /dataset/<token> ---

test('POST /dataset entrega columns/values do backend injetado e mapeia restrições/ordem', async () => {
  const f = formulario();
  let capturado: ConsultaDatasetPreview | undefined;
  const core = await startPreviewCore(f.html, {
    dataset: async (consulta) => { capturado = consulta; return { columns: ['A', 'B'], values: [{ A: 1, B: 2 }] }; },
  });
  try {
    const r = await postDataset(core.port, core.token, {
      v: 1,
      type: 'dataset',
      id: 'ds-1',
      nome: 'dsTeste',
      campos: ['A'],
      restricoes: [{ campo: 'X', inicial: '1', final: '9', tipo: 1, like: true }],
      ordem: ['A'],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { columns: ['A', 'B'], values: [{ A: 1, B: 2 }] });
    assert.deepEqual(capturado, {
      nome: 'dsTeste',
      campos: ['A'],
      restricoes: [{ campo: 'X', inicial: '1', final: '9', tipo: 1, like: true }],
      ordem: ['A'],
    });
  } finally {
    await core.close();
    f.limpar();
  }
});

test('sem backend injetado o route responde erro nomeando --server', async () => {
  const f = formulario();
  const core = await startPreviewCore(f.html);
  try {
    const r = await postDataset(core.port, core.token, { nome: 'ds', campos: [], restricoes: [], ordem: [] });
    assert.equal(r.status, 200);
    assert.match(r.json.error, /--server/);
  } finally {
    await core.close();
    f.limpar();
  }
});

test('backend que estoura vira {error: mensagem}; backend undefined vira erro de colunas', async () => {
  const f = formulario();
  const quebrado = await startPreviewCore(f.html, { dataset: async () => { throw new Error('backend quebrou'); } });
  try {
    const r = await postDataset(quebrado.port, quebrado.token, { nome: 'ds' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { error: 'backend quebrou' });
  } finally {
    await quebrado.close();
  }
  const vazio = await startPreviewCore(f.html, { dataset: async () => undefined });
  try {
    const r = await postDataset(vazio.port, vazio.token, { nome: 'dsSemColunas' });
    assert.equal(r.status, 200);
    assert.match(r.json.error, /dsSemColunas/);
    assert.match(r.json.error, /não devolveu colunas/);
  } finally {
    await vazio.close();
    f.limpar();
  }
});

test('payload inválido devolve 400 com a mensagem fixa', async () => {
  const f = formulario();
  const core = await startPreviewCore(f.html, { dataset: async () => ({ columns: [], values: [] }) });
  try {
    const casos: unknown[] = [
      {},
      { nome: '' },
      { nome: 'x'.repeat(129) },
      { nome: 'ds', restricoes: [{ campo: 'x', inicial: '1', final: '2', tipo: 4 }] },
      { nome: 'ds', restricoes: Array.from({ length: 33 }, () => ({ campo: 'x', inicial: '1', final: '2', tipo: 1 })) },
      { nome: 'ds', campos: Array.from({ length: 65 }, (_, i) => `c${i}`) },
      { nome: 'ds', ordem: Array.from({ length: 33 }, (_, i) => `c${i}`) },
    ];
    for (const caso of casos) {
      const r = await postDataset(core.port, core.token, caso);
      assert.equal(r.status, 400, JSON.stringify(caso));
      assert.deepEqual(r.json, { error: 'pedido de dataset inválido' });
    }
  } finally {
    await core.close();
    f.limpar();
  }
});

test('corpo acima de 64 KiB devolve 400; corpo normal cabe no limite', async () => {
  const f = formulario();
  const core = await startPreviewCore(f.html, { dataset: async () => ({ columns: [], values: [] }) });
  try {
    const normal = await postDataset(core.port, core.token, { nome: 'ds' });
    assert.equal(normal.status, 200, 'corpo pequeno não é recusado pelo limite');
    const grande = `{"nome":"ds","padding":"${'a'.repeat(70 * 1024)}"}`;
    const r = await postDataset(core.port, core.token, grande);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: 'pedido de dataset inválido' });
  } finally {
    await core.close();
    f.limpar();
  }
});

test('token errado devolve 404 e método não-POST devolve 405', async () => {
  const f = formulario();
  const core = await startPreviewCore(f.html, { dataset: async () => ({ columns: [], values: [] }) });
  try {
    const errado = await fetch(`http://127.0.0.1:${core.port}/dataset/errado`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nome: 'ds' }),
    });
    assert.equal(errado.status, 404);
    const get = await fetch(`http://127.0.0.1:${core.port}/dataset/${core.token}`);
    assert.equal(get.status, 405);
  } finally {
    await core.close();
    f.limpar();
  }
});

// --- Shim do frame (node:vm) ---

class PorteFalso {
  onmessage: ((evento: { data: unknown }) => void) | null = null;
  enviadas: unknown[] = [];
  fechado = false;
  postMessage(mensagem: unknown): void { this.enviadas.push(mensagem); }
  close(): void { this.fechado = true; this.onmessage = null; }
}

function shimHarness(): any {
  const document = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: () => ({ value: '' }),
    body: { appendChild() {} },
  };
  const sandbox: any = { document, console: { warn() {}, log() {}, error() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptDaApi(CONTEXTO_PADRAO), sandbox);
  return sandbox;
}

test('DatasetFactory enfileira antes de conectar, envia depois e resolve ok/erro', () => {
  const sandbox = shimHarness();
  const porta = new PorteFalso();
  const eventos: unknown[][] = [];
  assert.deepEqual({ ...sandbox.ConstraintType }, { MUST: 1, SHOULD: 2, MUST_NOT: 3 });
  const constraint = sandbox.DatasetFactory.createConstraint('X', '1', '9', sandbox.ConstraintType.MUST, true);
  assert.deepEqual(JSON.parse(JSON.stringify(constraint)), { campo: 'X', inicial: '1', final: '9', tipo: 1, like: true });

  sandbox.DatasetFactory.getDataset('ds', ['A'], [constraint], ['A'], {
    success: (r: unknown) => eventos.push(['ok', r]),
    error: (e: Error) => eventos.push(['erro', e.message]),
  });
  assert.equal(porta.enviadas.length, 0, 'sem canal ainda não envia');

  sandbox.__fluigPreview.conectar(porta);
  assert.equal(typeof porta.onmessage, 'function', 'conectar ativa a porta (onmessage ligado)');
  assert.equal(porta.enviadas.length, 1, 'flush ao conectar');
  assert.deepEqual(JSON.parse(JSON.stringify(porta.enviadas[0])), {
    v: 1, type: 'dataset', id: 'ds-1', nome: 'ds', campos: ['A'],
    restricoes: [{ campo: 'X', inicial: '1', final: '9', tipo: 1, like: true }], ordem: ['A'],
  });

  porta.onmessage!({ data: { v: 1, type: 'dataset:ok', id: 'ds-1', columns: ['A'], values: [{ A: 1 }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(eventos[0])), ['ok', { columns: ['A'], values: [{ A: 1 }] }]);

  sandbox.DatasetFactory.getDataset('ds2', [], [], [], { error: (e: Error) => eventos.push(['erro', e.message]) });
  assert.equal(porta.enviadas.length, 2, 'já conectado envia na hora');
  porta.onmessage!({ data: { v: 1, type: 'dataset:error', id: 'ds-2', message: 'quebrou' } });
  assert.deepEqual(JSON.parse(JSON.stringify(eventos[1])), ['erro', 'quebrou']);

  assert.doesNotThrow(() => porta.onmessage!({ data: { v: 1, type: 'dataset:ok', id: 'ds-999', columns: [], values: [] } }));
});

// --- Script de controle (node:vm) ---

interface CanalFalso { port1: PorteFalso; port2: PorteFalso }

async function controlHarness(resposta: () => Promise<{ json: () => Promise<unknown> }>): Promise<{
  core: Awaited<ReturnType<typeof startPreviewCore>>;
  f: ReturnType<typeof formulario>;
  port: PorteFalso;
  fetchChamadas: { url: string; opcoes: any }[];
  sse: { onmessage: (() => void) | null };
}> {
  const f = formulario();
  const core = await startPreviewCore(f.html);
  const control = await (await fetch(core.url)).text();
  const script = control.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const nonce = control.match(/n=([a-f0-9]+)/)![1]!;
  const listeners: Record<string, (e: any) => void> = {};
  const canais: CanalFalso[] = [];
  const fetchChamadas: { url: string; opcoes: any }[] = [];
  let sseRef: { onmessage: (() => void) | null } | null = null;
  class MessageChannelFalso {
    port1 = new PorteFalso();
    port2 = new PorteFalso();
    constructor() { canais.push(this); }
  }
  const frameWindow: any = { postMessage() {} };
  const frame: any = { contentWindow: frameWindow, addEventListener() {} };
  const contexto: any = {
    document: { querySelector: () => frame },
    addEventListener: (nome: string, fn: (e: any) => void) => { listeners[nome] = fn; },
    console: { warn() {}, log() {}, error() {} },
    EventSource: class { onmessage: (() => void) | null = null; constructor(readonly url: string) { sseRef = this; } },
    MessageChannel: MessageChannelFalso,
    fetch: async (url: string, opcoes: any) => { fetchChamadas.push({ url, opcoes }); return resposta(); },
  };
  vm.runInNewContext(script, contexto);
  listeners['message']!({ source: frameWindow, data: { v: 1, type: 'hello', nonce } });
  return { core, f, port: canais[0]!.port1, fetchChamadas, sse: sseRef! };
}

test('script de controle leva o pedido ao route e devolve dataset:ok', async () => {
  const h = await controlHarness(async () => ({ json: async () => ({ columns: ['A'], values: [{ A: 1 }] }) }));
  try {
    h.port.onmessage!({ data: { v: 1, type: 'dataset', id: 'ds-7', nome: 'ds', campos: ['A'], restricoes: [], ordem: ['A'] } });
    await tick();
    assert.equal(h.fetchChamadas.length, 1);
    assert.equal(h.fetchChamadas[0]!.url, `/dataset/${h.core.token}`);
    assert.equal(h.fetchChamadas[0]!.opcoes.method, 'POST');
    assert.deepEqual(JSON.parse(h.fetchChamadas[0]!.opcoes.body), {
      v: 1, type: 'dataset', id: 'ds-7', nome: 'ds', campos: ['A'], restricoes: [], ordem: ['A'],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(h.port.enviadas)), [
      { v: 1, type: 'dataset:ok', id: 'ds-7', columns: ['A'], values: [{ A: 1 }] },
    ]);
  } finally {
    await h.core.close();
    h.f.limpar();
  }
});

test('script de controle devolve dataset:error quando o route responde erro', async () => {
  const h = await controlHarness(async () => ({ json: async () => ({ error: 'sem servidor: rode form open --server <alias>' }) }));
  try {
    h.port.onmessage!({ data: { v: 1, type: 'dataset', id: 'ds-1', nome: 'ds' } });
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.port.enviadas)), [
      { v: 1, type: 'dataset:error', id: 'ds-1', message: 'sem servidor: rode form open --server <alias>' },
    ]);
  } finally {
    await h.core.close();
    h.f.limpar();
  }
});

test('script de controle devolve dataset:error genérico quando o fetch falha', async () => {
  const h = await controlHarness(async () => { throw new Error('rede fora'); });
  try {
    h.port.onmessage!({ data: { v: 1, type: 'dataset', id: 'ds-5', nome: 'ds' } });
    await tick();
    const enviadas = JSON.parse(JSON.stringify(h.port.enviadas)) as { type: string; message: string }[];
    assert.equal(enviadas.length, 1);
    assert.equal(enviadas[0]!.type, 'dataset:error');
    assert.match(enviadas[0]!.message, /falha ao consultar o dataset no preview/);
  } finally {
    await h.core.close();
    h.f.limpar();
  }
});

// --- consultaDoServidor (CLI helpers) + servirPreview com backend ---

test('consultaDoServidor resolve o servidor, faz login e mapeia o dataset enviado', async () => {
  const s = await fakeFluig({
    '/portal/api/servlet/login.do': { headers: { 'set-cookie': 'JSESSIONID=segredo; Path=/' }, body: '' },
    '/api/public/ecm/dataset/datasets': {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: { columns: ['login', 'name'], values: [{ login: 'a', name: 'A' }] } }),
    },
  });
  const xdg = mkdtempSync(join(tmpdir(), 'fluigctl-cfg-'));
  mkdirSync(join(xdg, 'fluigctl'), { recursive: true });
  const porta = Number(new URL(s.url).port);
  writeFileSync(join(xdg, 'fluigctl', 'servers.json'), JSON.stringify({
    version: 1,
    servers: { teste: { host: '127.0.0.1', port: porta, ssl: false, username: 'admin', companyId: 1, userCode: 'admin', passwordEnv: 'FLUIG_TESTE_PASSWORD' } },
  }));
  const antes = {
    xdg: process.env['XDG_CONFIG_HOME'],
    senha: process.env['FLUIG_TESTE_PASSWORD'],
    vscode: process.env['FLUIGCTL_NO_VSCODE'],
  };
  process.env['XDG_CONFIG_HOME'] = xdg;
  process.env['FLUIG_TESTE_PASSWORD'] = 'segredo-nao-impresso';
  process.env['FLUIGCTL_NO_VSCODE'] = '1';
  const escritos: string[] = [];
  const logOriginal = console.log;
  const writeOriginal = process.stdout.write;
  console.log = (...a: unknown[]) => { escritos.push(a.map(String).join(' ')); };
  process.stdout.write = ((chunk: unknown) => { escritos.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    const dataset = await consultaDoServidor('teste');
    const resultado = await dataset({
      nome: 'colleague',
      campos: ['login', 'name'],
      restricoes: [{ campo: 'login', inicial: 'a', final: 'a', tipo: 1, like: false }],
      ordem: ['login'],
    });
    assert.deepEqual(resultado, { columns: ['login', 'name'], values: [{ login: 'a', name: 'A' }] });
    const pedido = s.requests.find((r) => r.url === '/api/public/ecm/dataset/datasets')!;
    const corpo = JSON.parse(pedido.body) as Record<string, unknown>;
    assert.equal(corpo['name'], 'colleague');
    assert.deepEqual(corpo['fields'], ['login', 'name']);
    assert.deepEqual(corpo['constraints'], [{ _field: 'login', _initialValue: 'a', _finalValue: 'a', _type: 1, _likeSearch: false }]);
    assert.deepEqual(corpo['order'], ['login']);
    assert.equal(pedido.headers['cookie'], 'JSESSIONID=segredo');
    assert.ok(!escritos.some((e) => e.includes('segredo') || e.includes('JSESSIONID')), 'nenhum cookie impresso');
  } finally {
    console.log = logOriginal;
    process.stdout.write = writeOriginal;
    if (antes.xdg === undefined) delete process.env['XDG_CONFIG_HOME']; else process.env['XDG_CONFIG_HOME'] = antes.xdg;
    if (antes.senha === undefined) delete process.env['FLUIG_TESTE_PASSWORD']; else process.env['FLUIG_TESTE_PASSWORD'] = antes.senha;
    if (antes.vscode === undefined) delete process.env['FLUIGCTL_NO_VSCODE']; else process.env['FLUIGCTL_NO_VSCODE'] = antes.vscode;
    await s.close();
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('servirPreview encaminha o backend de dataset ao route', async () => {
  const f = formulario();
  const core = await servirPreview({
    arquivo: f.html,
    registroDir: join(f.raiz, 'estado'),
    dataset: async () => ({ columns: ['A'], values: [{ A: 1 }] }),
  });
  try {
    const r = await postDataset(core.registro.port, core.registro.token, { nome: 'ds' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { columns: ['A'], values: [{ A: 1 }] });
  } finally {
    await core.fechar();
    f.limpar();
  }
});

test('pedidos concorrentes correlacionam ids distintos e não vazam', async () => {
  const h = await controlHarness(async () => ({ json: async () => ({ columns: ['A'], values: [{ A: 1 }] }) }));
  try {
    h.port.onmessage!({ data: { v: 1, type: 'dataset', id: 'ds-1', nome: 'a' } });
    h.port.onmessage!({ data: { v: 1, type: 'dataset', id: 'ds-2', nome: 'b' } });
    await tick();
    assert.equal(h.fetchChamadas.length, 2, 'um fetch por pedido');
    const corpos = h.fetchChamadas.map((c) => JSON.parse(c.opcoes.body) as { id: string });
    assert.deepEqual(corpos.map((c) => c.id).sort(), ['ds-1', 'ds-2']);
    const respostas = JSON.parse(JSON.stringify(h.port.enviadas)) as { type: string; id: string }[];
    assert.deepEqual(respostas.map((r) => r.id).sort(), ['ds-1', 'ds-2']);
    assert.deepEqual([...new Set(respostas.map((r) => r.type))], ['dataset:ok']);
  } finally {
    await h.core.close();
    h.f.limpar();
  }
});

test('reload (SSE) fecha a porta antiga antes de trocar o src: resposta tardia é ignorada', async () => {
  const h = await controlHarness(async () => ({ json: async () => ({ columns: [], values: [] }) }));
  try {
    assert.ok(h.sse, 'EventSource assinado');
    assert.equal(h.port.fechado, false, 'porta ativa antes do reload');
    h.sse!.onmessage!();
    assert.equal(h.port.fechado, true, 'a porta antiga é fechada no reload');
    assert.equal(h.port.onmessage, null, 'o handler removido descarta a resposta tardia');
  } finally {
    await h.core.close();
    h.f.limpar();
  }
});
