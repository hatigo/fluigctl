import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import { hash } from '../src/diagram/edit.js';
import { redimensionarPoolNoXml, redimensionarRaiaNoXml } from '../src/diagram/lanes.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';
import { converterDiagrama } from '../src/push/diagram/ecm30.js';

/**
 * Raias e pool: a raia mora dentro da pool (y relativo), os elementos e as
 * dobras são absolutos. Mudar a altura de uma raia empurra tudo o que está
 * abaixo dela, e a pool acompanha.
 */

const CONTRATACAO = readFileSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), 'utf8');
const caixa = (t: string, id: string) => lerDiagrama(t).caixas.get(id)!;

test('aumentar a raia de cima empurra a de baixo, os elementos e as dobras, e a pool cresce', () => {
  const novo = redimensionarRaiaNoXml(CONTRATACAO, 'bpmnswimlane2', 200);
  assert.equal(caixa(novo, 'bpmnswimlane2').altura, 200);
  assert.equal(caixa(novo, 'bpmnswimlane3').absY, caixa(CONTRATACAO, 'bpmnswimlane3').absY + 40);
  assert.equal(caixa(novo, 'bpmnpool1').altura, caixa(CONTRATACAO, 'bpmnpool1').altura + 40);
  assert.equal(caixa(novo, 'servicetask3').absY, caixa(CONTRATACAO, 'servicetask3').absY + 40, 'elemento da raia de baixo desce');
  assert.equal(caixa(novo, 'task2').absY, caixa(CONTRATACAO, 'task2').absY, 'elemento da própria raia fica');
  // flow17 desce da raia de cima para a de baixo: a dobra de cima fica, a de baixo desce.
  assert.deepEqual(lerDiagrama(novo).dobras.get('flow17'), [{ x: 390, y: 100 }, { x: 390, y: 300 }]);
  assert.match(novo, /al:Text"[^>]* height="200"[^>]* value="Solicitante"/, 'o rótulo acompanha');
  assert.deepEqual(checarDiagrama(novo), []);
  assert.doesNotThrow(() => converterDiagrama(novo, { companyId: 1, formId: 1 }));
  assert.equal(redimensionarRaiaNoXml(novo, 'bpmnswimlane2', 160), CONTRATACAO, 'ida e volta byte a byte');
});

test('encolher não corta o que cabe na raia, e os limites são conferidos', () => {
  assert.throws(() => redimensionarRaiaNoXml(CONTRATACAO, 'bpmnswimlane2', 100), /"(Início|Preencher requisição)" ficaria cortado/);
  assert.throws(() => redimensionarRaiaNoXml(CONTRATACAO, 'bpmnswimlane2', 30), /de 60 a 20000/);
  assert.throws(() => redimensionarRaiaNoXml(CONTRATACAO, 'bpmnswimlane2', 160), /nada mudou/);
  assert.throws(() => redimensionarRaiaNoXml(CONTRATACAO, 'task2', 200), /não é uma raia/);
});

test('largura da pool: as raias acompanham, e encolher não deixa nada de fora', () => {
  const novo = redimensionarPoolNoXml(CONTRATACAO, 'bpmnpool1', 1900);
  assert.equal(caixa(novo, 'bpmnpool1').largura, 1900);
  assert.equal(caixa(novo, 'bpmnswimlane2').largura, 1870);
  assert.equal(caixa(novo, 'bpmnswimlane3').largura, 1870);
  assert.equal(redimensionarPoolNoXml(novo, 'bpmnpool1', 1700), CONTRATACAO);
  assert.throws(() => redimensionarPoolNoXml(CONTRATACAO, 'bpmnpool1', 1200), /ficaria fora da pool/);
});

test('o visualizador redimensiona pelas rotas, e o painel mostra os tamanhos', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-lanes-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, CONTRATACAO);
  const v = await servirDiagrama({ arquivo, registroDir: join(raiz, 'r'), undoDir: join(raiz, 'u') });
  const postar = async (rota: string, corpo: unknown) =>
    (await fetch(`${v.url}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) })).status;
  try {
    const raia = v.estado().elementos.find((x) => x.id === 'bpmnswimlane3')!;
    assert.deepEqual(raia.propriedades!.raia, { altura: 400, pool: 'bpmnpool1', larguraPool: 1700 });
    assert.equal(await postar('lane-height', { id: 'bpmnswimlane3', valor: 420, hash: hash(CONTRATACAO) }), 200);
    assert.equal(caixa(readFileSync(arquivo, 'utf8'), 'bpmnswimlane3').altura, 420);
    assert.equal(await postar('pool-width', { id: 'bpmnpool1', valor: 'x', hash: hash(readFileSync(arquivo, 'utf8')) }), 400);
    assert.match(await (await fetch(v.url)).text(), /alca-raia/);
  } finally {
    await v.fechar();
    rmSync(raiz, { recursive: true, force: true });
  }
});
