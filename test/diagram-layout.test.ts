import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import { desfazerUltimaEdicao, hash, moverNoXml } from '../src/diagram/edit.js';
import { organizarNoXml } from '../src/diagram/layout.js';
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
