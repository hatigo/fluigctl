import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConflitoEdicao,
  EdicaoInvalida,
  desfazerUltimaEdicao,
  renomearElemento,
  trocarNomeNoXml,
  validarNome,
} from '../src/diagram/edit.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/diagrams/processoTeste.process', import.meta.url));

function projeto(): { raiz: string; arquivo: string; undo: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-edit-'));
  const arquivo = join(raiz, 'workflow/diagrams/processo.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  cpSync(FIXTURE, arquivo);
  return { raiz, arquivo, undo: join(raiz, 'estado-fora-do-workspace'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

test('troca só o atributo name do objeto pelo id, escapando XML', () => {
  const antes = readFileSync(FIXTURE, 'utf8');
  const depois = trocarNomeNoXml(antes, 'task5', 'Preencher > revisar', 'Novo "nome" & revisão');
  assert.equal(depois.split('\n').length, antes.split('\n').length);
  assert.match(depois, /id="task5" name="Novo &quot;nome&quot; &amp; revis&#xe3;o"/);
  assert.equal(lerDiagrama(depois).objetos.find((o) => o.attrs['id'] === 'task5')?.attrs['name'], 'Novo "nome" & revisão');
  const removendoMudanca = depois.replace('Novo &quot;nome&quot; &amp; revis&#xe3;o', 'Preencher &gt; revisar');
  assert.equal(removendoMudanca, antes, 'todo o resto fica byte a byte igual');
});

test('nome vazio é válido; controle inválido é recusado', () => {
  const xml = readFileSync(FIXTURE, 'utf8');
  const vazio = trocarNomeNoXml(xml, 'flow10', 'Enviar', '');
  assert.equal(lerDiagrama(vazio).objetos.find((o) => o.attrs['id'] === 'flow10')?.attrs['name'], '');
  assert.doesNotThrow(() => validarNome('Ação 😀'));
  assert.throws(() => validarNome('ruim\u0001'), (e: unknown) => e instanceof EdicaoInvalida && /U\+0001/.test(e.message));
});

test('salvar preserva uma mudança do agente em outro campo e grava atomicamente', () => {
  const p = projeto();
  try {
    const texto = readFileSync(p.arquivo, 'utf8').replace('name="Processo de Teste"', 'name="Processo alterado pelo agente"');
    writeFileSync(p.arquivo, texto);
    renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Preencher e revisar', undoDir: p.undo });
    const d = lerDiagrama(readFileSync(p.arquivo, 'utf8'));
    assert.equal(d.objetos.find((o) => o.attrs['id'] === 'task5')?.attrs['name'], 'Preencher e revisar');
    assert.equal(d.objetos.find((o) => o.attrs['id'] === 'bpmnpool1')?.attrs['name'], 'Processo alterado pelo agente');
    assert.equal(readFileSync(p.arquivo, 'utf8').includes('.tmp'), false);
  } finally { p.limpar(); }
});

test('nome que o agente também alterou é conflito com os três valores disponíveis ao chamador', () => {
  const p = projeto();
  try {
    writeFileSync(p.arquivo, readFileSync(p.arquivo, 'utf8').replace(
      '<bpmn2:BpmnTask id="task5" name="Preencher &gt; revisar"',
      '<bpmn2:BpmnTask id="task5" name="Nome do agente"',
    ));
    assert.throws(
      () => renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Nome da pessoa', undoDir: p.undo }),
      (e: unknown) => e instanceof ConflitoEdicao && e.motivo === 'nome-alterado' && e.atual === 'Nome do agente',
    );
    assert.match(readFileSync(p.arquivo, 'utf8'), /Nome do agente/);
  } finally { p.limpar(); }
});

test('elemento removido não é recriado nem gravado', () => {
  const p = projeto();
  try {
    const linhas = readFileSync(p.arquivo, 'utf8').split('\n').filter((x) => !x.includes('<bpmn2:BpmnTask id="task5"'));
    writeFileSync(p.arquivo, linhas.join('\n'));
    const antes = readFileSync(p.arquivo, 'utf8');
    assert.throws(
      () => renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Voltou', undoDir: p.undo }),
      (e: unknown) => e instanceof ConflitoEdicao && e.motivo === 'elemento-removido',
    );
    assert.equal(readFileSync(p.arquivo, 'utf8'), antes);
  } finally { p.limpar(); }
});

test('desfazer restaura byte a byte enquanto ninguém mudou o arquivo', () => {
  const p = projeto();
  try {
    const original = readFileSync(p.arquivo, 'utf8');
    renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Editado', undoDir: p.undo });
    assert.notEqual(readFileSync(p.arquivo, 'utf8'), original);
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(readFileSync(p.arquivo, 'utf8'), original);
    assert.throws(
      () => desfazerUltimaEdicao(p.arquivo, p.undo),
      (e: unknown) => e instanceof ConflitoEdicao && e.motivo === 'sem-desfazer',
    );
  } finally { p.limpar(); }
});

test('desfazer recusa se o agente alterou qualquer coisa depois', () => {
  const p = projeto();
  try {
    renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Editado', undoDir: p.undo });
    writeFileSync(p.arquivo, readFileSync(p.arquivo, 'utf8').replace('name="Revisar"', 'name="Mudança posterior"'));
    const comMudanca = readFileSync(p.arquivo, 'utf8');
    assert.throws(
      () => desfazerUltimaEdicao(p.arquivo, p.undo),
      (e: unknown) => e instanceof ConflitoEdicao && e.motivo === 'arquivo-alterado',
    );
    assert.equal(readFileSync(p.arquivo, 'utf8'), comMudanca, 'nada do agente foi apagado');
  } finally { p.limpar(); }
});

test('troca recusa id desconhecido e objeto sem name', () => {
  const xml = readFileSync(FIXTURE, 'utf8');
  assert.throws(() => trocarNomeNoXml(xml, 'sumiu', '', 'x'), (e: unknown) => e instanceof ConflitoEdicao);
  const semNome = xml.replace('<bpmn2:BpmnTask id="task5" name="Preencher &gt; revisar"', '<bpmn2:BpmnTask id="task5"');
  assert.throws(() => trocarNomeNoXml(semNome, 'task5', '', 'x'), (e: unknown) => e instanceof EdicaoInvalida && /não possui/.test(e.message));
});

test('gravar através de link simbólico não troca o link por um arquivo comum', () => {
  const p = projeto();
  try {
    const real = join(p.raiz, 'compartilhado/processo.process');
    mkdirSync(dirname(real), { recursive: true });
    cpSync(p.arquivo, real);
    rmSync(p.arquivo);
    symlinkSync(real, p.arquivo);

    renomearElemento({ arquivo: p.arquivo, id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Pelo link', undoDir: p.undo });
    assert.ok(lstatSync(p.arquivo).isSymbolicLink(), 'o link continua sendo link');
    assert.equal(nomeNoArquivo(real, 'task5'), 'Pelo link', 'quem compartilha o arquivo vê a mudança');

    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.ok(lstatSync(p.arquivo).isSymbolicLink());
    assert.equal(nomeNoArquivo(real, 'task5'), 'Preencher > revisar');
  } finally { p.limpar(); }
});

function nomeNoArquivo(arquivo: string, id: string): string | undefined {
  return lerDiagrama(readFileSync(arquivo, 'utf8')).objetos.find((o) => o.attrs['id'] === id)?.attrs['name'];
}
