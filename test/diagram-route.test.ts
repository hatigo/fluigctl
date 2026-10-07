import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import {
  conexoesNoTexto,
  desfazerUltimaEdicao,
  endireitar,
  hash,
  moverNoXml,
  trocarDobras,
  trocarDobrasNoXml,
} from '../src/diagram/edit.js';
import { rotaOrtogonal } from '../src/diagram/route.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * Modo de edição, passo 2: traçar os fluxos. Trocar as dobras de um fluxo só
 * mexe nas linhas <bendpoints> da conexão dele; endireitar segue a receita de
 * layout (pontas retas, degrau no vão, retorno pelo corredor de cima).
 */

const fixture = (nome: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diagrams/${nome}`, import.meta.url)), 'utf8');
const ORIGINAL = fixture('contratacao.process');
const dobras = (texto: string, id: string) => lerDiagrama(texto).dobras.get(id);

function projeto(): { arquivo: string; undo: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-route-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  cpSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), arquivo);
  return { arquivo, undo: join(raiz, 'undo'), registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

test('regravar as dobras que já estão lá devolve o arquivo byte a byte', () => {
  for (const nome of ['contratacao.process', 'processoTeste.process', 'subprocessoTeste.process']) {
    const texto = fixture(nome);
    let novo = texto;
    for (const id of conexoesNoTexto(texto).keys()) novo = trocarDobrasNoXml(novo, id, lerDiagrama(texto).dobras.get(id) ?? []);
    assert.equal(novo, texto, nome);
  }
});

test('trocar as dobras mexe só nas linhas <bendpoints> daquele fluxo', () => {
  const novo = trocarDobrasNoXml(ORIGINAL, 'flow19', [{ x: 860, y: 300 }, { x: 900, y: 300 }]);
  assert.deepEqual(dobras(novo, 'flow19'), [{ x: 860, y: 300 }, { x: 900, y: 300 }]);
  const linhasNovas = novo.split('\n').filter((l) => !ORIGINAL.split('\n').includes(l));
  assert.deepEqual(linhasNovas, ['      <bendpoints x="860" y="300"/>', '      <bendpoints x="900" y="300"/>']);
  assert.equal(trocarDobrasNoXml(novo, 'flow19', []), ORIGINAL, 'tirar as dobras volta ao original');
  assert.deepEqual(dobras(trocarDobrasNoXml(ORIGINAL, 'flow17', []), 'flow17'), [], 'remove as que havia');
});

test('dobra com coordenada 0 sai sem o atributo, como o Studio grava', () => {
  const novo = trocarDobrasNoXml(ORIGINAL, 'flow19', [{ x: 0, y: 300 }]);
  assert.match(novo, /\n {6}<bendpoints y="300"\/>\n/);
  assert.deepEqual(dobras(novo, 'flow19'), [{ x: 0, y: 300 }]);
});

test('dobras inválidas e alvo que não é fluxo são recusados', () => {
  assert.throws(() => trocarDobrasNoXml(ORIGINAL, 'flow19', [{ x: 1.5, y: 2 }]), /inteiros/);
  assert.throws(() => trocarDobrasNoXml(ORIGINAL, 'flow19', [{ x: -10, y: 2 }]), /não negativos/);
  assert.throws(() => trocarDobrasNoXml(ORIGINAL, 'flow19', Array.from({ length: 51 }, () => ({ x: 1, y: 1 }))), /0 a 50/);
  assert.throws(() => trocarDobrasNoXml(ORIGINAL, 'task5', []), /não é um fluxo/);
  assert.throws(() => trocarDobrasNoXml(ORIGINAL, 'flow999', []), /não existe/);
});

test('a rota ortogonal segue a receita', () => {
  const d = lerDiagrama(ORIGINAL);
  // Para outra raia, alvo à direita: degrau no meio do vão, entrando pela esquerda.
  assert.deepEqual(rotaOrtogonal(d, 'flow17'), [{ x: 390, y: 100 }, { x: 390, y: 260 }]);
  // Retorno: sobe da origem, corre 20 px acima das formas e desce no alvo pelo centro.
  assert.deepEqual(rotaOrtogonal(d, 'flow24'), [{ x: 1260, y: 206 }, { x: 720, y: 206 }]);
  // Alinhados: reto, inclusive com o meio pixel de uma tarefa de altura ímpar (259,5 contra 260).
  assert.deepEqual(rotaOrtogonal(d, 'flow19'), []);
  assert.deepEqual(rotaOrtogonal(d, 'flow20'), []);
  assert.deepEqual(rotaOrtogonal(d, 'flow25'), []);
  // A saída do evento de erro é a diagonal curta do padrão.
  assert.deepEqual(rotaOrtogonal(d, 'flow27'), []);
  // Mesma coluna, desalinhados: degrau vertical no meio do vão.
  const torto = lerDiagrama(moverNoXml(ORIGINAL, 'servicetask7', 40, 0).xml);
  const r = rotaOrtogonal(torto, 'flow21');
  assert.equal(r.length, 2);
  assert.equal(r[0]!.y, r[1]!.y);
  assert.equal(r[0]!.x, 1090, 'sai do centro do gateway');
  assert.equal(r[1]!.x, 1130, 'entra no centro da tarefa');
});

test('a rota desvia de um card no caminho, pelo corredor de cima', async () => {
  const { criarNoXml, ligarNoXml } = await import('../src/diagram/add.js');
  // Na linha da raia Solicitante (centro y=100): um card no meio e um destino depois dele.
  const { medidorDoStudio } = await import('../src/diagram/medida.js');
  const topo = (nome: string) => 100 - medidorDoStudio().tarefa(nome).altura / 2;
  const meio = criarNoXml(ORIGINAL, { tipo: 'humana', nome: 'No caminho', x: 500, y: topo('No caminho') });
  const fim = criarNoXml(meio.xml, { tipo: 'humana', nome: 'Destino', x: 800, y: topo('Destino') });
  const f = ligarNoXml(fim.xml, 'task2', fim.id);
  const d = lerDiagrama(f.xml);
  const r = rotaOrtogonal(d, f.id);
  const caminho = d.caixas.get(meio.id)!;
  assert.equal(r.length, 2);
  assert.equal(r[0]!.y, r[1]!.y, 'corredor horizontal');
  assert.ok(r[0]!.y < caminho.absY, 'passa por cima do card do meio');
  assert.equal(r[0]!.x, 250, 'sobe do centro da origem');
});

test('endireitar um elemento traça todas as ligações dele, e passa no diagram check', () => {
  const p = projeto();
  try {
    // Aprovar desce 60 px: as duas ligações dele ficam tortas.
    const movido = moverNoXml(ORIGINAL, 'task5', 0, 60).xml;
    writeFileSync(p.arquivo, movido);
    const r = endireitar({ arquivo: p.arquivo, id: 'task5', hashBase: hash(movido), undoDir: p.undo });
    assert.deepEqual(r.fluxos.sort(), ['flow19', 'flow20']);
    const depois = readFileSync(p.arquivo, 'utf8');
    for (const f of r.fluxos) {
      const pts = dobras(depois, f)!;
      assert.equal(pts.length, 2, `${f} ganhou um degrau`);
      assert.equal(pts[0]!.x, pts[1]!.x, `${f}: o degrau é vertical`);
    }
    assert.deepEqual(checarDiagrama(depois).filter((a) => a.nivel === 'erro'), []);
    assert.throws(() => endireitar({ arquivo: p.arquivo, id: 'task5', hashBase: hash(depois), undoDir: p.undo }), /já estão retas/);
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(readFileSync(p.arquivo, 'utf8'), movido);
  } finally {
    p.limpar();
  }
});

test('endireitar tudo traça só as ligações tortas, numa edição só', () => {
  const p = projeto();
  try {
    const torto = moverNoXml(moverNoXml(ORIGINAL, 'task5', 0, 60).xml, 'servicetask10', 0, -40).xml;
    writeFileSync(p.arquivo, torto);
    const r = endireitar({ arquivo: p.arquivo, hashBase: hash(torto), undoDir: p.undo });
    // flow24: o corredor vai de 207 (relayout.py) para 206, 20 px acima da tarefa.
    assert.deepEqual(r.fluxos.sort(), ['flow19', 'flow20', 'flow24', 'flow25', 'flow26']);
    const depois = readFileSync(p.arquivo, 'utf8');
    assert.deepEqual(checarDiagrama(depois).filter((a) => a.nivel === 'erro'), []);
    assert.deepEqual(dobras(depois, 'flow27'), [], 'a diagonal do evento de erro fica');
    assert.throws(() => endireitar({ arquivo: p.arquivo, hashBase: hash(depois), undoDir: p.undo }), /já estão retas/);
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(readFileSync(p.arquivo, 'utf8'), torto, 'um desfazer volta tudo');
  } finally {
    p.limpar();
  }
});

test('trocar dobras sobre uma tela velha é conflito', () => {
  const p = projeto();
  try {
    trocarDobras({ arquivo: p.arquivo, id: 'flow19', pontos: [{ x: 860, y: 300 }], hashBase: hash(ORIGINAL), undoDir: p.undo });
    assert.throws(() => trocarDobras({ arquivo: p.arquivo, id: 'flow19', pontos: [], hashBase: hash(ORIGINAL), undoDir: p.undo }), /mudou desde que a tela/);
  } finally {
    p.limpar();
  }
});

async function postar(url: string, rota: string, corpo: unknown): Promise<{ status: number; dados: Record<string, unknown> }> {
  const r = await fetch(`${url}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  return { status: r.status, dados: (await r.json()) as Record<string, unknown> };
}

async function esperar(condicao: () => boolean, ms = 5000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((ok) => setTimeout(ok, 30));
  }
  assert.fail('a mudança não apareceu dentro do prazo');
}

test('o visualizador entrega as dobras, troca e endireita pelos endpoints', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const estado = v.estado();
    const f24 = estado.elementos.find((x) => x.id === 'flow24')!;
    assert.deepEqual(f24.dobras, [{ x: 1260, y: 207 }, { x: 720, y: 207 }]);
    assert.equal(estado.elementos.find((x) => x.id === 'task5')!.ligacoes, 2);
    assert.equal(estado.elementos.find((x) => x.id === 'task5')!.dobras, undefined);

    const r = await postar(v.url, 'bends', { id: 'flow24', pontos: [{ x: 1260, y: 180 }, { x: 720, y: 180 }], hash: estado.hash });
    assert.equal(r.status, 200);
    await esperar(() => v.estado().hash !== estado.hash);
    assert.deepEqual(dobras(readFileSync(p.arquivo, 'utf8'), 'flow24'), [{ x: 1260, y: 180 }, { x: 720, y: 180 }]);

    const e = await postar(v.url, 'straighten', { id: 'flow24', hash: v.estado().hash });
    assert.equal(e.status, 200);
    assert.deepEqual(e.dados['fluxos'], ['flow24']);
    await esperar(() => v.estado().elementos.find((x) => x.id === 'flow24')?.dobras?.[0]?.y === 206);

    assert.equal((await postar(v.url, 'bends', { id: 'flow24', pontos: 'x', hash: v.estado().hash })).status, 400);
    const html = await (await fetch(v.url)).text();
    assert.match(html, /pedir\('bends'/);
    assert.match(html, /Endireitar ligações/);
    assert.match(html, /id="straighten-all"/);
    assert.equal((await postar(v.url, 'straighten-all', { hash: v.estado().hash })).status, 400, 'tudo já reto');
    assert.match(html, /Clique duplo na linha cria uma dobra/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('a ligação nova já sai em ângulo reto, e a que fica reta sai sem dobra', async () => {
  const { criarNoXml, ligarNoXml } = await import('../src/diagram/add.js');
  // Em outra raia e mais à direita: degrau no meio do vão.
  const t = criarNoXml(ORIGINAL, { tipo: 'humana', nome: 'Destino', x: 700, y: 440 });
  const f = ligarNoXml(t.xml, 'task2', t.id);
  const pts = dobras(f.xml, f.id)!;
  assert.equal(pts.length, 2);
  assert.equal(pts[0]!.x, pts[1]!.x, 'o degrau é vertical');
  assert.deepEqual(pts, rotaOrtogonal(lerDiagrama(f.xml), f.id), 'a mesma rota do endireitar');
  assert.deepEqual(checarDiagrama(f.xml).filter((a) => a.grupo === 'estrutura'), []);
  // Alinhada com a origem: reta, sem dobra.
  const { medidorDoStudio } = await import('../src/diagram/medida.js');
  const alinhada = criarNoXml(ORIGINAL, { tipo: 'humana', nome: 'Ao lado', x: 1500, y: 99.5 - medidorDoStudio().tarefa('Ao lado').altura / 2 });
  const reta = ligarNoXml(alinhada.xml, 'task2', alinhada.id);
  assert.deepEqual(dobras(reta.xml, reta.id) ?? [], []);
});

test('endireitar não deixa seta chegando pelo mesmo ponto de onde outra sai', async () => {
  const { novoProcesso } = await import('../src/diagram/novo.js');
  const { adicionarNoXml, ligarNoXml } = await import('../src/diagram/add.js');
  const { medirLayout } = await import('../src/diagram/layout-medida.js');
  // A → B → C, e dois retornos: C → B e B → A. Pelo corredor de cima, os dois
  // usam o topo de B: um chega e o outro sai pelo mesmo ponto (o caso mais comum no acervo).
  let xml = novoProcesso({ id: 'retornos', nome: 'Retornos', raias: ['Raia'] });
  const ids: string[] = [];
  for (const [x, nome] of [[300, 'A'], [550, 'B'], [800, 'C']] as const) {
    const r = adicionarNoXml(xml, { tipo: 'humana', x, y: 140, nome });
    xml = r.xml;
    ids.push(r.criados[0]!);
  }
  const [a, b, c] = ids as [string, string, string];
  const fluxos: string[] = [];
  for (const [o, t] of [[a, b], [b, c], [c, b], [b, a]] as const) {
    const r = ligarNoXml(xml, o, t);
    xml = r.xml;
    fluxos.push(r.id);
  }
  // Como o Endireitar antigo deixava: cada ligação pela rota sozinha.
  const d = lerDiagrama(xml);
  for (const f of fluxos) xml = trocarDobrasNoXml(xml, f, rotaOrtogonal(d, f));
  assert.ok(medirLayout(xml).mistos > 0, 'o caso de partida tem o topo de B misturado');

  const p = projeto();
  try {
    writeFileSync(p.arquivo, xml);
    endireitar({ arquivo: p.arquivo, hashBase: hash(xml), undoDir: p.undo });
    const m = medirLayout(readFileSync(p.arquivo, 'utf8'));
    assert.equal(m.mistos, 0, 'nenhum lado com seta chegando e saindo');
    assert.equal(m.sobrepostas, 0);
    assert.equal(m.cards, 0);
  } finally {
    p.limpar();
  }
});
