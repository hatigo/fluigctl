import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import { desfazerUltimaEdicao, hash, moverNoXml } from '../src/diagram/edit.js';
import { organizarNoXml } from '../src/diagram/layout.js';
import { medirLayout } from '../src/diagram/layout-medida.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';
import { converterDiagrama } from '../src/push/diagram/ecm30.js';

/**
 * Organizar: o diagrama inteiro pela receita, sem spec. O que se protege aqui:
 * nada sai da raia em que estava, os pares de recuperação seguem a receita,
 * ninguém se sobrepõe, e organizar de novo não muda nada.
 */

const fixture = (nome: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diagrams/${nome}`, import.meta.url)), 'utf8');
const CONTRATACAO = fixture('contratacao.process');

function raiaDe(texto: string, id: string): string | undefined {
  const d = lerDiagrama(texto);
  const c = d.caixas.get(id)!;
  const cy = c.absY + c.altura / 2;
  return d.objetos.filter((o) => o.tipo === 'BpmnSwimLane').find((r) => {
    const l = d.caixas.get(r.attrs['id']!)!;
    return cy >= l.absY && cy < l.absY + l.altura;
  })?.attrs['id'];
}

test('bagunçado e organizado: cada um na sua raia, ordem cronológica, pares pela receita, sem erro', () => {
  // Bagunça: tarefas trocadas de coluna dentro da raia Aprovação.
  let baguncado = moverNoXml(CONTRATACAO, 'task5', -500, 0).xml;
  baguncado = moverNoXml(baguncado, 'servicetask10', -900, 0).xml;
  const r = organizarNoXml(baguncado);
  const d = lerDiagrama(r.xml);
  const cx = (id: string) => { const c = d.caixas.get(id)!; return c.absX + c.largura / 2; };
  for (const id of ['task2', 'servicetask3', 'servicetask4', 'task5', 'exclusivegateway6', 'servicetask10', 'task13']) {
    assert.equal(raiaDe(r.xml, id), raiaDe(CONTRATACAO, id), `${id} continua na raia`);
  }
  // Cronológico: cada passo à direita do anterior.
  const ordem = ['startevent1', 'task2', 'servicetask3', 'servicetask4', 'task5', 'exclusivegateway6', 'exclusivegateway9', 'servicetask10', 'endevent11'];
  for (let i = 1; i < ordem.length; i++) assert.ok(cx(ordem[i]!) > cx(ordem[i - 1]!), `${ordem[i]} depois de ${ordem[i - 1]}`);
  // "Reprovada" ganha a própria linha, abaixo da principal.
  assert.ok(d.caixas.get('servicetask7')!.absY > d.caixas.get('task15')!.absY);
  assert.deepEqual(checarDiagrama(r.xml, { grupo: 'suporte_processos' }).filter((a) => a.nivel === 'erro'), []);
  assert.deepEqual(checarDiagrama(r.xml).filter((a) => /canto|logo abaixo/.test(a.mensagem)), [], 'pares pela receita');
  assert.doesNotThrow(() => converterDiagrama(r.xml, { companyId: 1, formId: 1 }));
});

test('organizar de novo não muda nada', () => {
  const uma = organizarNoXml(CONTRATACAO).xml;
  assert.equal(organizarNoXml(uma).xml, uma);
});

test('o diagrama do Studio também se organiza sem erro de estrutura', () => {
  const r = organizarNoXml(fixture('studioTeste.process'));
  assert.deepEqual(checarDiagrama(r.xml).filter((a) => a.grupo === 'estrutura'), []);
});

test('o visualizador organiza pela rota layout, e um desfazer volta tudo', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-layout-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  const baguncado = moverNoXml(CONTRATACAO, 'task5', -500, 0).xml;
  writeFileSync(arquivo, baguncado);
  const v = await servirDiagrama({ arquivo, registroDir: join(raiz, 'r'), undoDir: join(raiz, 'u') });
  try {
    const r = await fetch(`${v.url}layout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: hash(baguncado) }) });
    assert.equal(r.status, 200);
    assert.notEqual(readFileSync(arquivo, 'utf8'), baguncado);
    desfazerUltimaEdicao(arquivo, join(raiz, 'u'));
    assert.equal(readFileSync(arquivo, 'utf8'), baguncado);
    assert.match(await (await fetch(v.url)).text(), /id="organize"/);
  } finally {
    await v.fechar();
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('a contratação organizada: nenhuma ligação por cima de forma, sobreposta ou cruzada', () => {
  assert.deepEqual(medirLayout(organizarNoXml(CONTRATACAO).xml), { ligacoes: 19, cards: 0, sobrepostas: 0, cruzamentos: 0, mistos: 0 });
});

test('o tratamento compartilhado fica depois das service tasks, e a volta dele é retorno', async () => {
  const { novoProcesso } = await import('../src/diagram/novo.js');
  const { adicionarNoXml, ligarNoXml } = await import('../src/diagram/add.js');
  const { removerNoXml } = await import('../src/diagram/remove.js');
  // Início → s1 → s2 → fim; o erro das duas vai para o mesmo tratamento, que volta para as duas.
  let xml = novoProcesso({ id: 'compartilhado', nome: 'Compartilhado', raias: ['Sistema', 'Suporte'] });
  const d0 = lerDiagrama(xml);
  const inicio = d0.objetos.find((o) => o.tipo === 'BpmnStartEvent')!.attrs['id']!;
  const fim = d0.objetos.find((o) => o.tipo === 'BpmnEndEvent')!.attrs['id']!;
  xml = removerNoXml(xml, d0.objetos.find((o) => o.tipo === 'SequenceFlow')!.attrs['id']!).xml;
  const r1 = adicionarNoXml(xml, { tipo: 'recuperacao', x: 400, y: 120, nome: 'Um' });
  const [s1, , tratamento] = r1.criados;
  const r2 = adicionarNoXml(r1.xml, { tipo: 'recuperacao', x: 700, y: 120, nome: 'Dois' });
  const [s2, e2, t2] = r2.criados;
  xml = removerNoXml(r2.xml, t2!).xml;
  for (const [a, b] of [[inicio, s1], [s1, s2], [s2, fim], [e2, tratamento], [tratamento, s2]] as const) xml = ligarNoXml(xml, a!, b!).xml;
  // Bagunça: o tratamento vai para o começo do diagrama.
  const c = lerDiagrama(xml).caixas.get(tratamento!)!;
  xml = moverNoXml(xml, tratamento!, 60 - c.absX, 0).xml;

  const d = lerDiagrama(organizarNoXml(xml).xml);
  const x = (id: string) => d.caixas.get(id)!.absX;
  assert.ok(x(tratamento!) > x(s2!), 'o tratamento fica depois das duas service tasks, não na coluna 0');
  assert.ok(x(s2!) > x(s1!), 'a volta do tratamento para s2 não empurra s2 para depois dele');
  assert.ok(x(fim) > x(s2!));
});

/**
 * O acervo de diagramas do Studio (~/fluig/workspaces), quando existe nesta
 * máquina: o Organizar não pode piorar. npm run medir-organizar mostra os números.
 */
const ACERVO = join(homedir(), 'fluig', 'workspaces');
test('o Organizar no acervo: quase nenhuma ligação por cima de forma, poucas sobrepostas e cruzadas', { skip: !existsSync(ACERVO) && 'sem acervo nesta máquina' }, () => {
  const arquivos: string[] = [];
  const visitar = (pasta: string) => {
    for (const nome of readdirSync(pasta)) {
      const caminho = join(pasta, nome);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (nome.endsWith('.process')) arquivos.push(caminho);
    }
  };
  visitar(ACERVO);
  const total = { diagramas: 0, cards: 0, sobrepostas: 0, cruzamentos: 0 };
  for (const arquivo of arquivos) {
    let xml: string;
    try {
      xml = readFileSync(arquivo, 'latin1');
      lerDiagrama(xml);
    } catch {
      continue;
    }
    const m = medirLayout(organizarNoXml(xml).xml);
    total.diagramas++;
    total.cards += m.cards;
    total.sobrepostas += m.sobrepostas;
    total.cruzamentos += m.cruzamentos;
  }
  assert.ok(total.diagramas > 50);
  // 2026-10-07: 1, 0 e 142 (o desenho à mão: 204, 1 e 43; o Organizar antes: 18, 41 e 442).
  assert.ok(total.cards <= 3, `por cima de forma: ${total.cards}`);
  assert.ok(total.sobrepostas <= 10, `sobrepostas: ${total.sobrepostas}`);
  assert.ok(total.cruzamentos <= 170, `cruzamentos: ${total.cruzamentos}`);
});
