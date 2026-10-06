import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import {
  ConflitoEdicao,
  EdicaoInvalida,
  aplicarEdicao,
  desfazerUltimaEdicao,
  formasDeTopo,
  hash,
  moverElemento,
  moverNoXml,
  refazerEdicao,
  renomearElemento,
} from '../src/diagram/edit.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * Modo de edição, passos 0 e 1: toda edição passa pelo mesmo caminho (conflito
 * por hash, releitura, diagram check sem erro novo de estrutura, escrita
 * atômica, histórico de vários níveis), e mover troca só o x/y de uma forma.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url));
const ORIGINAL = readFileSync(FIXTURE, 'utf8');

function projeto(): { arquivo: string; undo: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-move-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  cpSync(FIXTURE, arquivo);
  return { arquivo, undo: join(raiz, 'undo'), registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

const caixa = (texto: string, id: string) => lerDiagrama(texto).caixas.get(id)!;

test('mover troca só o x/y da forma e dos eventos de erro presos a ela', () => {
  const { xml, movidos } = moverNoXml(ORIGINAL, 'servicetask3', 20, -10);
  assert.deepEqual(movidos, ['servicetask3', 'intermediateerror12']);
  for (const id of movidos) {
    assert.equal(caixa(xml, id).absX, caixa(ORIGINAL, id).absX + 20);
    assert.equal(caixa(xml, id).absY, caixa(ORIGINAL, id).absY - 10);
  }
  assert.deepEqual(caixa(xml, 'task13'), caixa(ORIGINAL, 'task13'), 'o tratamento não anda junto');
  const linhasDiferentes = xml.split('\n').filter((l, i) => l !== ORIGINAL.split('\n')[i]);
  assert.equal(linhasDiferentes.length, 2, 'uma linha por forma movida');
  assert.ok(linhasDiferentes.every((l) => /<graphicsAlgorithm /.test(l)));
  assert.equal(moverNoXml(xml, 'servicetask3', -20, 10).xml, ORIGINAL, 'ida e volta é byte a byte');
});

test('as formas de topo são achadas pelo link, e as raias aninhadas ficam de fora', () => {
  const formas = formasDeTopo(ORIGINAL);
  assert.ok(formas.has('task2') && formas.has('exclusivegateway6') && formas.has('bpmnpool1'));
  assert.ok(!formas.has('bpmnswimlane2'), 'a raia mora dentro da pool, com coordenadas relativas');
});

test('coordenada omitida (o Studio não grava 0) é inserida no lugar certo', () => {
  const semY = ORIGINAL.replace('width="140" height="67" x="450" y="326"/>\n      <link businessObjects="task13"/>', 'width="140" height="67" x="450"/>\n      <link businessObjects="task13"/>');
  assert.notEqual(semY, ORIGINAL);
  const { xml } = moverNoXml(semY, 'task13', 0, 330);
  assert.match(xml, /width="140" height="67" x="450" y="330"\/>\n {6}<link businessObjects="task13"\/>/);
  // Voltar a 0 levaria a tarefa para fora da pool (que começa em y=10): recusado.
  assert.throws(() => moverNoXml(xml, 'task13', 0, -330), /sairia da pool/);
});

test('mover recusa pool, raia, id desconhecido, deslocamento não inteiro e saída da pool', () => {
  assert.throws(() => moverNoXml(ORIGINAL, 'bpmnpool1', 10, 0), EdicaoInvalida);
  assert.throws(() => moverNoXml(ORIGINAL, 'bpmnswimlane3', 10, 0), EdicaoInvalida);
  assert.throws(() => moverNoXml(ORIGINAL, 'naoexiste', 10, 0), ConflitoEdicao);
  assert.throws(() => moverNoXml(ORIGINAL, 'task2', 1.5, 0), /inteiro/);
  assert.throws(() => moverNoXml(ORIGINAL, 'task2', 0, -10000), /sairia/);
  assert.throws(() => moverNoXml(ORIGINAL, 'endevent11', 5000, 0), /sairia da pool/);
});

test('mover pelo pipeline grava, avisa a troca de raia e o que o padrão passou a acusar', () => {
  const p = projeto();
  try {
    // O tratamento de servicetask3 sobe para a raia Solicitante.
    const r = moverElemento({ arquivo: p.arquivo, id: 'task13', dx: 0, dy: -260, hashBase: hash(ORIGINAL), undoDir: p.undo });
    assert.equal(r.raiaAntes, 'Aprovação');
    assert.equal(r.raiaDepois, 'Solicitante');
    assert.ok(r.avisos.some((a) => /mesma raia/.test(a.mensagem)));
    assert.equal(caixa(readFileSync(p.arquivo, 'utf8'), 'task13').absY, caixa(ORIGINAL, 'task13').absY - 260);
  } finally {
    p.limpar();
  }
});

test('edição sobre uma tela velha é conflito, e o arquivo não muda', () => {
  const p = projeto();
  try {
    writeFileSync(p.arquivo, ORIGINAL.replace('name="Aprovar"', 'name="Aprovar (agente)"'));
    const antes = readFileSync(p.arquivo, 'utf8');
    assert.throws(
      () => moverElemento({ arquivo: p.arquivo, id: 'task2', dx: 10, dy: 0, hashBase: hash(ORIGINAL), undoDir: p.undo }),
      (e: unknown) => e instanceof ConflitoEdicao && e.motivo === 'arquivo-alterado',
    );
    assert.equal(readFileSync(p.arquivo, 'utf8'), antes);
  } finally {
    p.limpar();
  }
});

test('edição que não muda nada é recusada, sem passo vazio no desfazer', () => {
  const p = projeto();
  try {
    assert.throws(() => aplicarEdicao(p.arquivo, p.undo, (t) => t), /nada mudou/);
    assert.throws(() => desfazerUltimaEdicao(p.arquivo, p.undo), /não há edição/);
  } finally {
    p.limpar();
  }
});

test('edição que quebraria a estrutura é recusada sem gravar nada', () => {
  const p = projeto();
  try {
    assert.throws(
      () => aplicarEdicao(p.arquivo, p.undo, (t) => t.replace('end="/0/@children.2/@anchors.0"', 'end="/0/@children.99/@anchors.0"')),
      /inconsistente, e nada foi gravado/,
    );
    assert.equal(readFileSync(p.arquivo, 'utf8'), ORIGINAL);
    assert.throws(() => desfazerUltimaEdicao(p.arquivo, p.undo), /não há edição/, 'nem histórico ficou');
  } finally {
    p.limpar();
  }
});

test('desfazer e refazer em vários níveis, e edição nova esvazia o refazer', () => {
  const p = projeto();
  try {
    const ler = () => readFileSync(p.arquivo, 'utf8');
    moverElemento({ arquivo: p.arquivo, id: 'task2', dx: 10, dy: 0, hashBase: hash(ler()), undoDir: p.undo });
    const passo1 = ler();
    renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Aprovar', nomeNovo: 'Aprovar contratação', undoDir: p.undo });
    const passo2 = ler();
    moverElemento({ arquivo: p.arquivo, id: 'task5', dx: 0, dy: 10, hashBase: hash(ler()), undoDir: p.undo });
    const passo3 = ler();

    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(ler(), passo2);
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(ler(), passo1);
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(ler(), ORIGINAL);
    assert.throws(() => desfazerUltimaEdicao(p.arquivo, p.undo), /não há edição/);

    refazerEdicao(p.arquivo, p.undo);
    refazerEdicao(p.arquivo, p.undo);
    assert.equal(ler(), passo2);
    refazerEdicao(p.arquivo, p.undo);
    assert.equal(ler(), passo3);
    assert.throws(() => refazerEdicao(p.arquivo, p.undo), (e: unknown) => e instanceof ConflitoEdicao && e.motivo === 'sem-refazer');

    desfazerUltimaEdicao(p.arquivo, p.undo);
    moverElemento({ arquivo: p.arquivo, id: 'task2', dx: 10, dy: 0, hashBase: hash(ler()), undoDir: p.undo });
    assert.throws(() => refazerEdicao(p.arquivo, p.undo), /não há edição desfeita/, 'o ramo desfeito não volta mais');
  } finally {
    p.limpar();
  }
});

test('refazer recusa se o arquivo mudou depois do desfazer', () => {
  const p = projeto();
  try {
    moverElemento({ arquivo: p.arquivo, id: 'task2', dx: 10, dy: 0, hashBase: hash(ORIGINAL), undoDir: p.undo });
    desfazerUltimaEdicao(p.arquivo, p.undo);
    writeFileSync(p.arquivo, ORIGINAL.replace('name="Aprovar"', 'name="Aprovar (agente)"'));
    assert.throws(() => refazerEdicao(p.arquivo, p.undo), /refazer apagaria/);
    assert.match(readFileSync(p.arquivo, 'utf8'), /Aprovar \(agente\)/);
  } finally {
    p.limpar();
  }
});

test('o diagrama movido continua passando no diagram check', () => {
  let xml = ORIGINAL;
  for (const id of formasDeTopo(ORIGINAL).keys()) {
    if (id === 'bpmnpool1') continue;
    try {
      xml = moverNoXml(xml, id, 10, 10).xml;
    } catch (e) {
      assert.match((e as Error).message, /sairia/);
    }
  }
  assert.deepEqual(checarDiagrama(xml).filter((a) => a.grupo === 'estrutura'), []);
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

test('o visualizador move pelo endpoint, com o hash da tela, e refaz', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const estado = v.estado();
    assert.equal(estado.hash, hash(ORIGINAL));
    const st = estado.elementos.find((x) => x.id === 'servicetask3')!;
    assert.equal(st.podeMover, true);
    assert.deepEqual(st.anexados, ['intermediateerror12']);
    assert.equal(estado.elementos.find((x) => x.id === 'bpmnswimlane2')!.podeMover, false);
    assert.equal(estado.elementos.find((x) => x.id === 'flow16')!.podeMover, false);

    const r = await postar(v.url, 'move', { id: 'servicetask3', dx: 30, dy: 0, hash: estado.hash });
    assert.equal(r.status, 200);
    assert.deepEqual(r.dados['movidos'], ['servicetask3', 'intermediateerror12']);
    await esperar(() => v.estado().hash !== estado.hash);

    const velho = await postar(v.url, 'move', { id: 'servicetask3', dx: 30, dy: 0, hash: estado.hash });
    assert.equal(velho.status, 409, 'a tela velha não grava por cima');
    assert.equal(velho.dados['motivo'], 'arquivo-alterado');

    assert.equal((await postar(v.url, 'undo', {})).status, 200);
    await esperar(() => v.estado().hash === hash(ORIGINAL));
    assert.equal((await postar(v.url, 'redo', {})).status, 200);
    await esperar(() => v.estado().hash !== hash(ORIGINAL));
    assert.equal(caixa(readFileSync(p.arquivo, 'utf8'), 'servicetask3').absX, caixa(ORIGINAL, 'servicetask3').absX + 30);

    const invalido = await postar(v.url, 'move', { id: 'servicetask3', dx: '30', dy: 0, hash: v.estado().hash });
    assert.equal(invalido.status, 400);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('a interface tem o modo de edição: ligar, desfazer, refazer e mover', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const html = await (await fetch(v.url)).text();
    assert.match(html, /id="edit-toggle"[^>]*aria-pressed="false"/);
    assert.match(html, /Modo de edição/);
    assert.match(html, /id="redo"/);
    assert.match(html, /pedir\('move'/);
    assert.match(html, /Arraste no diagrama para mover/);
    // Salva sozinho: o selo da barra diz se gravou, se está gravando ou se falhou.
    assert.match(html, /id="save-state"[^>]*role="status"/);
    assert.match(html, /Salvando…/);
    assert.match(html, /Alterações não salvas/);
    assert.match(html, /beforeunload/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});
