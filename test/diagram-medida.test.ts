import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FONTE_ARIAL, lerFonte, medidor, quebrar } from '../src/diagram/medida.js';
import { ajustarAoNome } from '../src/diagram/tamanho.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * O tamanho que o Studio dá às formas ao abrir (veja medida.ts). As medidas do
 * fixture vieram do Studio de verdade: diagramas de calibração criados pelo
 * fluigctl, abertos e salvos por ele.
 */

const fixture = (nome: string) => fileURLToPath(new URL(`./fixtures/${nome}`, import.meta.url));

test('a quebra: por palavra, depois do hífen e, na palavra que não cabe, por letra', () => {
  const cabe = (n: number) => (l: string) => l.length <= n;
  assert.deepEqual(quebrar('Tem mais?', cabe(5)), ['Tem', 'mais?']);
  assert.deepEqual(quebrar('de ar-condicionado', cabe(6)), ['de ar-', 'condic', 'ionado']);
  assert.deepEqual(quebrar('Aprovado?', cabe(7)), ['Aprovad', 'o?']);
  assert.deepEqual(quebrar('Todos os documentos', cabe(8)), ['Todos os', 'document', 'os']);
});

test('com a Arial (Studio no Windows): linha de 13 px, como o passo do acervo', () => {
  const m = medidor(FONTE_ARIAL);
  assert.equal(m.linha, 13);
  assert.deepEqual(m.tarefa('Aprovar'), { largura: 106, altura: 54 });
  // O rótulo do gateway vai quebrado, e a 3ª linha perde 3 letras para o "...".
  assert.deepEqual(m.rotuloDoGateway('Aprovado?'), { valor: 'Aprovad\no?\n', altura: 39 });
  assert.match(m.rotuloDoGateway('Todos os documentos obrigatórios foram enviados?').valor, /^Todos os\n[^\n]+\n[^\n]*\.\.\.\n$/);
});

const NOTO = '/usr/share/fonts/noto/NotoSans-Bold.ttf';
test('com a Noto Sans, cada medida do Studio sai igual', { skip: !existsSync(NOTO) && 'Noto Sans Bold não instalada' }, () => {
  const m = medidor(lerFonte(NOTO));
  assert.equal(m.linha, 16);
  const { medidas } = JSON.parse(readFileSync(fixture('studio-noto-sans.json'), 'utf8')) as {
    medidas: { tipo: string; nome: string; largura?: number; altura: number; rotulo?: string }[];
  };
  const erradas: string[] = [];
  for (const md of medidas) {
    if (md.tipo === 'tarefa') {
      const t = m.tarefa(md.nome);
      if (t.largura !== md.largura || t.altura !== md.altura) erradas.push(`${md.nome}: ${t.altura} em vez de ${md.altura}`);
    } else {
      const r = m.rotuloDoGateway(md.nome);
      if (r.valor !== md.rotulo || 60 + r.altura !== md.altura) erradas.push(`${md.nome}: ${JSON.stringify(r.valor)} em vez de ${JSON.stringify(md.rotulo)}`);
    }
  }
  assert.ok(medidas.length > 100);
  assert.deepEqual(erradas, []);
});

test('renomear ajusta o rótulo e a altura, e a bolinha de erro acompanha o canto', () => {
  const xml = readFileSync(fixture('diagrams/contratacao.process'), 'latin1');
  const m = medidor(FONTE_ARIAL);
  const longo = 'Obter as alçadas de aprovação do departamento solicitante no RM';
  const renomeado = xml.replace(/(<bpmn2:BpmnTask id="servicetask3" name=")[^"]*"/, `$1${longo.replace('ç', '&#xe7;').replace('ç', '&#xe7;').replace('ã', '&#xe3;')}"`);
  assert.notEqual(renomeado, xml);
  const antes = lerDiagrama(renomeado);
  const pronto = ajustarAoNome(renomeado, ['servicetask3'], m);
  const depois = lerDiagrama(pronto);
  const t = depois.caixas.get('servicetask3')!;
  assert.deepEqual([t.largura, t.altura], [106, m.tarefa(longo).altura]);
  assert.match(pronto, /value="Obter as al&#xe7;adas de aprova&#xe7;&#xe3;o do departamento solicitante no RM"/);
  const [a, b] = [antes.caixas.get('intermediateerror12')!, depois.caixas.get('intermediateerror12')!];
  const ta = antes.caixas.get('servicetask3')!;
  assert.deepEqual([b.absX - a.absX, b.absY - a.absY], [t.largura - ta.largura, t.altura - ta.altura]);
  assert.equal(ajustarAoNome(pronto, ['servicetask3'], m), pronto, 'sem nada a fazer, não mexe');
});
