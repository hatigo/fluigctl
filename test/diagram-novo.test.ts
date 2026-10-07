import test from 'node:test';
import assert from 'node:assert/strict';

import { adicionarNoXml } from '../src/diagram/add.js';
import { checarDiagrama } from '../src/diagram/check.js';
import { compararComStudio } from '../src/diagram/fidelidade.js';
import { novoProcesso } from '../src/diagram/novo.js';
import { ajustarAoNome } from '../src/diagram/tamanho.js';
import { formasSemEstilo, garantirVisual } from '../src/diagram/visual.js';
import { gerarEcm30 } from '../src/push/diagram/ecm30.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

const novo = () => novoProcesso({ id: 'teste_novo', nome: 'Teste novo', raias: ['Solicitante', 'Aprovação'], formulario: '16', servidor: 'fluig-localdev' });

test('diagram new: pool, raias, início ligado ao fim, e passa no diagram check sem aviso', () => {
  const xml = novo();
  assert.deepEqual(checarDiagrama(xml), []);
  const d = lerDiagrama(xml);
  const tipos = d.objetos.map((o) => o.tipo).sort();
  assert.deepEqual(tipos, ['BpmnEndEvent', 'BpmnPool', 'BpmnProcess', 'BpmnStartEvent', 'BpmnSwimLane', 'BpmnSwimLane', 'SequenceFlow']);
  const p = d.objetos.find((o) => o.tipo === 'BpmnProcess')!.attrs;
  assert.equal(p['id'], 'teste_novo');
  assert.equal(p['cardIndex'], '16');
  assert.equal(p['serverId'], 'fluig-localdev');
  assert.equal(p['volume'], 'Default');
  assert.deepEqual(d.objetos.filter((o) => o.tipo === 'BpmnSwimLane').map((o) => o.attrs['name']), ['Solicitante', 'Aprovação']);
});

test('diagram new: já sai como o Studio grava, e o Studio não teria o que mudar', () => {
  const xml = novo();
  assert.equal(formasSemEstilo(xml), 0);
  assert.equal(garantirVisual(xml), xml);
  const ids = lerDiagrama(xml).objetos.map((o) => o.attrs['id']!).filter(Boolean);
  assert.equal(ajustarAoNome(xml, ids), xml, 'tamanhos e rótulos já são os do Studio');
  assert.ok(compararComStudio(xml).every((c) => c.situacao === 'igual'), 'tirar o visual e redesenhar dá o mesmo');
});

test('diagram new: o servidor converte, e o visualizador acrescenta elementos nele', () => {
  const xml = novo();
  assert.doesNotThrow(() => gerarEcm30(lerDiagrama(xml), { companyId: 1 }));
  const { xml: comTarefa } = adicionarNoXml(xml, { tipo: 'recuperacao', x: 500, y: 90, nome: 'Integrar' });
  assert.deepEqual(checarDiagrama(comTarefa).filter((a) => a.grupo === 'estrutura'), []);
});

test('diagram new: recusa processId, nome e raias inválidos', () => {
  assert.throws(() => novoProcesso({ id: '1abc', nome: 'x', raias: ['a'] }), /processId inválido/);
  assert.throws(() => novoProcesso({ id: 'com espaco', nome: 'x', raias: ['a'] }), /processId inválido/);
  assert.throws(() => novoProcesso({ id: 'ok', nome: ' ', raias: ['a'] }), /precisa de um nome/);
  assert.throws(() => novoProcesso({ id: 'ok', nome: 'x', raias: [] }), /pelo menos uma raia/);
  assert.throws(() => novoProcesso({ id: 'ok', nome: 'x', raias: ['a', 'a'] }), /mesmo nome/);
});
