import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import { encaixarErros, errosForaDoCanto } from '../src/diagram/erros.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * O Studio redimensiona as tarefas ao abrir o diagrama e não leva junto os
 * eventos de erro presos a elas. encaixarErros devolve a bolinha solta ao canto
 * inferior direito; a que encosta no card (escolha de quem desenhou) fica.
 */

const CONTRATACAO = readFileSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), 'latin1');
const BOLINHA = 'width="30" height="30" x="576" y="279">';
const avisosDeCanto = (xml: string) => checarDiagrama(xml).filter((a) => /canto inferior direito/.test(a.mensagem));

test('bolinha que ficou para trás volta ao canto da tarefa, e só ela muda', () => {
  // Como o Studio deixa: a tarefa encolhe e a bolinha fica onde estava, solta do card.
  const solta = CONTRATACAO.replace(BOLINHA, 'width="30" height="30" x="610" y="300">');
  assert.notEqual(solta, CONTRATACAO);
  assert.equal(errosForaDoCanto(solta), 1);
  assert.match(avisosDeCanto(solta)[0]!.mensagem, /--fix a devolve ao canto/);

  const pronto = encaixarErros(solta);
  // Centro exato no canto (450+140, 226+67); nada além do x/y da bolinha muda.
  assert.equal(pronto, CONTRATACAO.replace(BOLINHA, 'width="30" height="30" x="575" y="278">'));
  assert.deepEqual(avisosDeCanto(pronto), []);
  assert.equal(encaixarErros(pronto), pronto, 'sem nada a fazer, não mexe');
  const c = lerDiagrama(pronto).caixas.get('intermediateerror12')!;
  assert.deepEqual([c.absX, c.absY], [575, 278]);
});

test('bolinha que encosta no card fora do canto é escolha do desenho: avisa, mas não move', () => {
  // No canto de cima, como várias do acervo.
  const emCima = CONTRATACAO.replace(BOLINHA, 'width="30" height="30" x="576" y="211">');
  assert.equal(avisosDeCanto(emCima).length, 1);
  assert.doesNotMatch(avisosDeCanto(emCima)[0]!.mensagem, /--fix/);
  assert.equal(errosForaDoCanto(emCima), 0);
  assert.equal(encaixarErros(emCima), emCima);
});
