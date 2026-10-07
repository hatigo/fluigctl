import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { adicionarNoXml } from '../src/diagram/add.js';
import { checarDiagrama } from '../src/diagram/check.js';
import { formasSemEstilo, garantirVisual } from '../src/diagram/visual.js';
import { gerarProcess } from '../src/pull/process-diagram.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * Sem estilos e cores o Studio abre o diagrama, mas pinta as formas sem cor
 * sobre o fundo cinza: só os ícones aparecem. garantirVisual redesenha o que
 * não tem estilo como o Studio grava.
 */

const fixture = (nome: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diagrams/${nome}`, import.meta.url)), 'latin1');
const CONTRATACAO = fixture('contratacao.process');

const semEstilo = (xml: string) => checarDiagrama(xml).filter((a) => /sem estilo/.test(a.mensagem)).map((a) => a.onde);
/** O modelo BPMN e a geometria que o servidor e o visualizador leem: o reparo não pode mexer neles. */
const modelo = (xml: string) => {
  const d = lerDiagrama(xml);
  return { objetos: d.objetos, dobras: [...d.dobras] };
};

test('diagrama montado fora do Studio: forma sem estilo é aviso, e o reparo deixa tudo como o Studio grava', () => {
  const cru = fixture('processoTeste.process');
  assert.deepEqual(semEstilo(cru).sort(), ['bpmnpool1', 'endevent6', 'flow10', 'flow11', 'flow8', 'startevent4', 'task5', 'task7']);
  const pronto = garantirVisual(cru);
  assert.equal(formasSemEstilo(pronto), 0);
  assert.deepEqual(checarDiagrama(pronto).filter((a) => a.nivel === 'erro'), []);
  assert.deepEqual(semEstilo(pronto), []);
  assert.equal(garantirVisual(pronto), pronto, 'sem nada a fazer, não mexe');
  assert.deepEqual(modelo(pronto), modelo(cru), 'o modelo e as dobras ficam iguais');
  // A tarefa é a caixa invisível com o retângulo arredondado e o texto dentro; a ligação ganha a seta.
  assert.match(pronto, /<link businessObjects="task5"\/>[\s\S]*?al:RoundedRectangle[^>]*style="\/0\/@styles\.\d+" cornerHeight="5" cornerWidth="5"/);
  assert.match(pronto, /<link businessObjects="flow8"\/>[\s\S]*?location="1\.0">\s*<graphicsAlgorithm xsi:type="al:Polygon"[^>]*style=/);
  // Os estilos entram antes das ligações, e as cores antes das fontes, como o Studio ordena.
  assert.ok(pronto.lastIndexOf('<styles') < pronto.indexOf('<connections'));
  assert.ok(pronto.lastIndexOf('<colors') < pronto.indexOf('<fonts'));
});

test('o que já tem estilo não muda: o diagrama do Studio passa igual', () => {
  const studio = fixture('studioTeste.process');
  assert.equal(formasSemEstilo(studio), 0);
  assert.equal(garantirVisual(studio), studio);
  assert.equal(garantirVisual(CONTRATACAO), CONTRATACAO);
});

test('cada forma ganha os seus estilos, como o Studio; a ponta da seta é uma só', () => {
  const pronto = garantirVisual(fixture('processoTeste.process'));
  const usos = [...pronto.matchAll(/ style="(\/0\/@styles\.\d+)"/g)].map((m) => m[1]!);
  const seta = [...pronto.matchAll(/location="1\.0">\s*<graphicsAlgorithm[^>]*style="([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(new Set(seta).size, 1);
  const repetidos = usos.filter((u, i) => usos.indexOf(u) !== i && u !== seta[0]);
  assert.deepEqual(repetidos, []);
});

test('o evento de erro fica com 30x30, no mesmo centro', () => {
  const cru = CONTRATACAO.replace(
    /<graphicsAlgorithm xsi:type="al:Ellipse" lineWidth="1" filled="false" lineVisible="false" transparency="0.0" width="30" height="30" x="576" y="279">\n(\s*)<graphicsAlgorithmChildren xsi:type="al:Ellipse" lineWidth="1" transparency="0.0" width="30" height="30" style="[^"]*"\/>/,
    '<graphicsAlgorithm xsi:type="al:Ellipse" lineWidth="1" width="35" height="35" x="573" y="276">\n$1<graphicsAlgorithmChildren xsi:type="al:Ellipse" lineWidth="1" width="35" height="35"/>',
  );
  assert.notEqual(cru, CONTRATACAO);
  const caixa = lerDiagrama(garantirVisual(cru)).caixas.get('intermediateerror12')!;
  assert.deepEqual([caixa.x, caixa.y, caixa.largura, caixa.altura], [576, 279, 30, 30]);
});

test('elemento novo sai com estilo próprio, mesmo quando é cópia de um que já existe', () => {
  const { xml } = adicionarNoXml(CONTRATACAO, { tipo: 'humana', x: 400, y: 500, nome: 'Conferir' });
  assert.deepEqual(semEstilo(xml), []);
  const estiloDe = (id: string) => new RegExp(`<link businessObjects="${id}"/>[\\s\\S]*?al:RoundedRectangle[^>]*style="([^"]+)"`).exec(xml)?.[1];
  assert.notEqual(estiloDe('task37'), undefined);
  assert.notEqual(estiloDe('task37'), estiloDe('task2'));
});

test('o diagram pull já sai com o visual do Studio e com as âncoras dos dois lados', () => {
  const { process } = gerarProcess(fixture('processoTeste.ecm30.xml'));
  assert.deepEqual(checarDiagrama(process), []);
});
