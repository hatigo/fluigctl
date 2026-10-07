import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adicionarNoXml } from '../src/diagram/add.js';
import { checarDiagrama } from '../src/diagram/check.js';
import { compararComStudio } from '../src/diagram/fidelidade.js';
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

const blocoDe = (xml: string, id: string) => {
  const i = xml.indexOf(`<link businessObjects="${id}"/>`);
  return xml.slice(xml.lastIndexOf('\n    <', i), xml.indexOf('\n    </', i));
};
const idDoEstilo = (xml: string, ref: string) => [...xml.matchAll(/\n    <styles\b[^>]*/g)][Number(/@styles\.(\d+)/.exec(ref)![1])]![0];
const errosDeEstrutura = (xml: string) => checarDiagrama(xml).filter((a) => a.nivel === 'erro' && a.grupo === 'estrutura').map((a) => `${a.onde}: ${a.mensagem}`);

test('anotação, evento de tempo e subprocesso saem como o Studio desenha', () => {
  const cru = fixture('processoFase1.process');
  const fase1 = garantirVisual(cru);
  assert.equal(formasSemEstilo(fase1), 0);
  // O fixture não desenha as ligações; o reparo não pode acrescentar erro.
  assert.deepEqual(errosDeEstrutura(fase1), errosDeEstrutura(cru));
  // A nota: retângulo com o estilo ANNOTATION, o texto e o colchete do lado.
  const nota = blocoDe(fase1, 'annotationtask16');
  const ref = /al:RoundedRectangle[^>]*style="([^"]+)"/.exec(nota)![1]!;
  assert.match(idDoEstilo(fase1, ref), /id="ANNOTATION"/);
  assert.match(nota, /al:Polyline/);
  // O evento de tempo leva o relógio dentro.
  const tempo = /<bpmn2:BpmnIntermediateEvent id="([^"]+)"[^>]* type="32"/.exec(fase1)?.[1];
  assert.ok(tempo);
  assert.equal((blocoDe(fase1, tempo).match(/al:Polyline/g) ?? []).length, 14, "4 marcas, 2 ponteiros e 8 traços");

  const subCru = fixture('subprocessoTeste.process');
  const sub = garantirVisual(subCru);
  assert.equal(formasSemEstilo(sub), 0);
  assert.deepEqual(errosDeEstrutura(sub), errosDeEstrutura(subCru));
  assert.match(blocoDe(sub, 'subprocess12'), /lineWidth="3"[\s\S]*subprocess\.normal/);
});

/** O processoTeste com o flow8 saindo de uma anotação ou marcado como automático. */
const ligacao = (xml: string, id: string) => {
  const i = xml.indexOf(`<link businessObjects="${id}"/>`);
  return xml.slice(xml.lastIndexOf('<connections', i), xml.indexOf('</connections>', i));
};

test('ligação com anotação é associação: pontilhada e sem seta', () => {
  const cru = fixture('processoTeste.process')
    .replace('<bpmn2:SequenceFlow id="flow8" name="" sourceRef="startevent4"', '<bpmn2:BpmnAnnotation id="nota1" name="Nota" type="0"/>\n  <bpmn2:SequenceFlow id="flow8" name="" sourceRef="nota1"');
  assert.match(cru, /sourceRef="nota1"/);
  const lig = ligacao(garantirVisual(cru), 'flow8');
  assert.match(lig, /lineWidth="2" lineStyle="DOT"/);
  assert.match(lig, /<connectionDecorators visible="true" locationRelative="true" location="1\.0"\/>/);
  assert.doesNotMatch(lig, /al:Polygon/);
});

test('fluxo automático: verde, com o ícone no meio, e a ponta e o rótulo dividem o estilo verde', () => {
  const cru = fixture('processoTeste.process').replace('<bpmn2:SequenceFlow id="flow8" name=""', '<bpmn2:SequenceFlow id="flow8" name="" fluxoAutomatico="true"');
  assert.match(cru, /id="flow8" name="" fluxoAutomatico="true"/);
  const pronto = garantirVisual(cru);
  const lig = ligacao(pronto, 'flow8');
  assert.match(lig, /designer\.automaticFlow/);
  const estilos = [...lig.matchAll(/ style="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(estilos).size, 1, 'rótulo e ponta com o mesmo estilo');
  assert.match(idDoEstilo(pronto, estilos[0]!), /id="BPMN-POLYGON-ARROW-0-150-0"/);
});

/**
 * O acervo de diagramas salvos pelo Studio (~/fluig/workspaces), quando existe
 * nesta máquina: sem estilo e redesenhado pelo fluigctl, cada forma tem de sair
 * igual à do Studio. As poucas diferenças que restam são defeitos dos próprios
 * arquivos (seta duplicada, estilo que não existe) — npm run fidelidade-visual
 * mostra quais.
 */
const ACERVO = join(homedir(), 'fluig', 'workspaces');
test('fidelidade ao acervo do Studio', { skip: !existsSync(ACERVO) && 'sem acervo nesta máquina' }, () => {
  const arquivos: string[] = [];
  const visitar = (pasta: string) => {
    for (const nome of readdirSync(pasta)) {
      const caminho = join(pasta, nome);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (nome.endsWith('.process')) arquivos.push(caminho);
    }
  };
  visitar(ACERVO);
  let total = 0;
  const fora: string[] = [];
  for (const arquivo of arquivos) {
    let comparacoes;
    try {
      comparacoes = compararComStudio(readFileSync(arquivo, 'latin1'));
    } catch {
      continue;
    }
    for (const c of comparacoes) {
      total++;
      if (c.situacao !== 'igual') fora.push(`${arquivo} ${c.id} ${c.situacao}`);
    }
  }
  assert.ok(total > 0);
  assert.ok(fora.length <= Math.ceil(total * 0.003), `${fora.length} de ${total} formas diferentes do Studio:\n${fora.slice(0, 20).join('\n')}`);
  assert.ok(!fora.some((f) => f.endsWith('nao-redesenhado')), fora.filter((f) => f.endsWith('nao-redesenhado')).join('\n'));
});
