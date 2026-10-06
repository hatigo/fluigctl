import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blocosDeTopo } from '../src/diagram/add.js';
import { checarDiagrama } from '../src/diagram/check.js';
import { desfazerUltimaEdicao, hash } from '../src/diagram/edit.js';
import { lerCondicoes } from '../src/diagram/props.js';
import { removerNoXml } from '../src/diagram/remove.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';
import { converterDiagrama } from '../src/push/diagram/ecm30.js';

/**
 * Modo de edição, passo 6: remover. O pictograma referencia por posição, então
 * tirar um bloco do meio desloca os de depois: toda referência é renumerada, e
 * o resultado precisa passar no diagram check e na conversão do push.
 */

const CONTRATACAO = readFileSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), 'utf8');
const objeto = (t: string, id: string) => lerDiagrama(t).objetos.find((o) => o.attrs['id'] === id);
const estrutura = (t: string) => checarDiagrama(t).filter((a) => a.grupo === 'estrutura');
const converte = (t: string) => converterDiagrama(t, { companyId: 1, formId: 1 });

test('remover um fluxo renumera as conexões de depois e limpa as pontas', () => {
  const r = removerNoXml(CONTRATACAO, 'flow19');
  assert.deepEqual(r.removidos, ['flow19']);
  assert.equal(objeto(r.xml, 'flow19'), undefined);
  assert.equal(objeto(r.xml, 'servicetask4')!.attrs['outgoing'], undefined, 'outgoing vazio sai');
  assert.equal(objeto(r.xml, 'task5')!.attrs['incoming'], undefined);
  const antes = blocosDeTopo(CONTRATACAO).blocos.filter((b) => b.tipo === 'connections').length;
  assert.equal(blocosDeTopo(r.xml).blocos.filter((b) => b.tipo === 'connections').length, antes - 1);
  assert.deepEqual(estrutura(r.xml), []);
  assert.doesNotThrow(() => converte(r.xml));
});

test('remover a service task leva o evento de erro e as ligações; o tratamento fica', () => {
  const r = removerNoXml(CONTRATACAO, 'servicetask7');
  assert.deepEqual(r.removidos.sort(), ['flow21', 'flow23', 'flow33', 'flow35', 'intermediateerror31', 'servicetask7'].sort());
  assert.deepEqual(r.scripts, ['contratacao.servicetask7.js']);
  assert.ok(objeto(r.xml, 'task35'), 'o tratamento continua; remova se quiser');
  // A condição do gateway para a service task removida também saiu.
  const g = lerCondicoes(objeto(r.xml, 'exclusivegateway6')!);
  assert.deepEqual(g.condicoes.map((c) => c.destino), ['exclusivegateway9']);
  assert.deepEqual(estrutura(r.xml), []);
  assert.doesNotThrow(() => converte(r.xml));
});

test('remover só o fluxo de um gateway tira a condição do destino que perdeu o fluxo', () => {
  const r = removerNoXml(CONTRATACAO, 'flow21');
  assert.ok(objeto(r.xml, 'servicetask7'), 'o destino continua');
  assert.deepEqual(lerCondicoes(objeto(r.xml, 'exclusivegateway6')!).condicoes.map((c) => c.destino), ['exclusivegateway9']);
  assert.doesNotThrow(() => converte(r.xml), 'o push não recusa condição para destino sem fluxo');
});

test('cada elemento e cada fluxo do diagrama se removem sem quebrar a estrutura', () => {
  for (const o of lerDiagrama(CONTRATACAO).objetos) {
    const id = o.attrs['id']!;
    if (!id || ['BpmnPool', 'BpmnSwimLane', 'BpmnProcess'].includes(o.tipo)) continue;
    let r;
    try {
      r = removerNoXml(CONTRATACAO, id);
    } catch (e) {
      assert.match((e as Error).message, /Executor Atividade/, `${id}: só a atribuição recusa aqui`);
      continue;
    }
    assert.deepEqual(estrutura(r.xml), [], id);
    assert.doesNotThrow(() => converte(r.xml), id);
  }
});

test('recusas: pool, raia, e o que outra tarefa usa na atribuição', () => {
  assert.throws(() => removerNoXml(CONTRATACAO, 'bpmnpool1'), /pool e raias/);
  assert.throws(() => removerNoXml(CONTRATACAO, 'bpmnswimlane2'), /pool e raias/);
  // task2 é atribuída pelo Executor Atividade do início.
  assert.throws(() => removerNoXml(CONTRATACAO, 'startevent1'), /Executor Atividade\) usa startevent1/);
  assert.throws(() => removerNoXml(CONTRATACAO, 'naoexiste'), /não existe mais/);
});

test('o par de link não fica órfão', () => {
  // Um "envia" (36) e um "recebe" (42) mínimos, ligados a tarefas que existem.
  const comLink = CONTRATACAO.replace(
    /(\n\s*<bpmn2:SequenceFlow id="flow16")/,
    '\n  <bpmn2:BpmnIntermediateEvent id="intermediatelink90" name="Vai" incoming="flow92" type="36" linkId="intermediatelinkreceive91"/>' +
      '\n  <bpmn2:BpmnIntermediateEvent id="intermediatelinkreceive91" name="Chega" outgoing="flow93" type="42"/>$1',
  );
  assert.notEqual(comLink, CONTRATACAO);
  // Sem desenho (o teste é do modelo): a regra olha os objetos, antes da renumeração.
  assert.throws(() => removerNoXml(comLink, 'intermediatelinkreceive91'), /envia para "Chega", que sairia/);
});

function projeto(): { arquivo: string; undo: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-remove-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, CONTRATACAO);
  return { arquivo, undo: join(raiz, 'undo'), registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

test('o visualizador remove pela rota remove, e um desfazer devolve o arquivo byte a byte', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const r = await fetch(`${v.url}remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'servicetask7', hash: hash(CONTRATACAO) }),
    });
    const dados = (await r.json()) as { removidos: string[]; scripts: string[] };
    assert.equal(r.status, 200);
    assert.equal(dados.removidos.length, 6);
    assert.deepEqual(dados.scripts, ['contratacao.servicetask7.js']);
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(readFileSync(p.arquivo, 'utf8'), CONTRATACAO);
    const html = await (await fetch(v.url)).text();
    assert.match(html, /pedir\('remove'/);
    assert.match(html, /'Delete'/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});
