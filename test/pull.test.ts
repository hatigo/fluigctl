import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pullDataset, pullProcess } from '../src/commands/pull.js';
import type { WorkflowEngineClient } from '../src/fluig/workflow-service.js';
import type { Server } from '../src/config.js';
import { ErroFluigctl } from '../src/errors.js';

const SERVER: Server = {
  host: 'fluig.local', port: 8080, ssl: false, username: 'integracao',
  companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
};

const DEFINICAO = Buffer.from(
  `<?xml version="1.0" encoding="ISO-8859-1"?><list><ProcessDefinition>
  <WorkflowProcessEvent><workflowProcessEventPK><eventId>servicetask13</eventId></workflowProcessEventPK><eventDescription>function servicetask13() { if (a &lt; b) log("Aprovação"); }</eventDescription></WorkflowProcessEvent>
  <WorkflowProcessEvent><workflowProcessEventPK><eventId>beforeTaskSave</eventId></workflowProcessEventPK><eventDescription>function beforeTaskSave() {}</eventDescription></WorkflowProcessEvent>
</ProcessDefinition></list>`, 'latin1');

function fakeWorkflow(): { cliente: WorkflowEngineClient; chamadas: string[] } {
  const chamadas: string[] = [];
  const nao = async () => { throw new Error('pull não pode escrever no servidor'); };
  return {
    chamadas,
    cliente: {
      async listProcessIds() { chamadas.push('list'); return ['reembolso']; },
      async exportProcess() { chamadas.push('export'); return DEFINICAO; },
      createVersion: nao, importProcess: nao, releaseProcess: nao,
    },
  };
}

function pastaWorkflow(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-pull-'));
  mkdirSync(join(dir, 'scripts'));
  return dir;
}

const ler = (caminho: string) => readFileSync(caminho, 'utf8');
const codigoDe = (erro: unknown) => (erro as ErroFluigctl).codigo;

test('pull process grava os scripts do servidor, decodificados, e só lê do servidor', async () => {
  const dir = pastaWorkflow();
  const f = fakeWorkflow();
  const r = await pullProcess({ server: SERVER, senha: 's', processId: 'reembolso', pastaWorkflow: dir, cliente: f.cliente });

  assert.deepEqual(r.novos, [join(dir, 'scripts/reembolso.beforeTaskSave.js'), join(dir, 'scripts/reembolso.servicetask13.js')]);
  assert.equal(ler(join(dir, 'scripts/reembolso.servicetask13.js')), 'function servicetask13() { if (a < b) log("Aprovação"); }\n');
  assert.deepEqual(f.chamadas, ['list', 'export']);
});

test('pull process usa o nome do .process que tem o id, como o push', async () => {
  const dir = pastaWorkflow();
  mkdirSync(join(dir, 'diagrams'));
  writeFileSync(join(dir, 'diagrams', 'Reembolso Antigo.process'), '<bpmn2:BpmnProcess id="reembolso" name="x">');
  const r = await pullProcess({ server: SERVER, senha: 's', processId: 'reembolso', pastaWorkflow: dir, cliente: fakeWorkflow().cliente });

  assert.equal(r.prefixo, 'Reembolso Antigo');
  assert.ok(existsSync(join(dir, 'scripts/Reembolso Antigo.servicetask13.js')));
});

test('pull process: igual fica, diferente não é tocado sem --overwrite e nada é gravado', async () => {
  const dir = pastaWorkflow();
  writeFileSync(join(dir, 'scripts/reembolso.beforeTaskSave.js'), 'function beforeTaskSave() {}\r\n');
  writeFileSync(join(dir, 'scripts/reembolso.servicetask13.js'), 'function servicetask13() { local(); }\n');
  const opcoes = { server: SERVER, senha: 's', processId: 'reembolso', pastaWorkflow: dir, cliente: fakeWorkflow().cliente };

  const previa = await pullProcess({ ...opcoes, dryRun: true });
  assert.deepEqual(previa.iguais, [join(dir, 'scripts/reembolso.beforeTaskSave.js')]);
  assert.deepEqual(previa.diferentes, [join(dir, 'scripts/reembolso.servicetask13.js')]);
  assert.deepEqual(previa.gravados, []);

  await assert.rejects(pullProcess(opcoes), (e) => codigoDe(e) === 6);
  assert.equal(ler(join(dir, 'scripts/reembolso.servicetask13.js')), 'function servicetask13() { local(); }\n');

  const r = await pullProcess({ ...opcoes, sobrescrever: true });
  assert.deepEqual(r.gravados, [join(dir, 'scripts/reembolso.servicetask13.js')]);
  assert.match(ler(join(dir, 'scripts/reembolso.servicetask13.js')), /Aprovação/);
  assert.equal(ler(join(dir, 'scripts/reembolso.beforeTaskSave.js')), 'function beforeTaskSave() {}\r\n');
});

test('pull process de um processo que não existe no servidor: código 3', async () => {
  await assert.rejects(
    pullProcess({ server: SERVER, senha: 's', processId: 'naoExiste', pastaWorkflow: pastaWorkflow(), cliente: fakeWorkflow().cliente }),
    (e) => codigoDe(e) === 3,
  );
});

test('pull dataset grava no arquivo que o repositório já tem, em qualquer subpasta', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-ds-'));
  mkdirSync(join(raiz, 'datasets/rh'), { recursive: true });
  writeFileSync(join(raiz, 'datasets/rh/dsFoo.js'), 'function createDataset() { antigo(); }\n');
  const carregar = async () => ({ impl: 'function createDataset() { novo(); }' });

  const previa = await pullDataset({ server: SERVER, senha: 's', nome: 'dsFoo', raiz, dryRun: true, carregar });
  assert.equal(previa.arquivo, join('datasets/rh/dsFoo.js'));
  assert.deepEqual(previa.diferentes, [join('datasets/rh/dsFoo.js')]);

  await pullDataset({ server: SERVER, senha: 's', nome: 'dsFoo', raiz, sobrescrever: true, carregar });
  assert.equal(ler(join(raiz, 'datasets/rh/dsFoo.js')), 'function createDataset() { novo(); }\n');
});

test('pull dataset sem arquivo local grava em datasets/<nome>.js', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-ds-'));
  const r = await pullDataset({ server: SERVER, senha: 's', nome: 'dsNovo', raiz, carregar: async () => ({ impl: 'x' }) });
  assert.deepEqual(r.gravados, [join('datasets/dsNovo.js')]);
  assert.equal(ler(join(raiz, 'datasets/dsNovo.js')), 'x\n');
});

test('pull dataset: dois arquivos com o nome é ambíguo (6), sem código no servidor é 3', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-ds-'));
  mkdirSync(join(raiz, 'datasets/a'), { recursive: true });
  mkdirSync(join(raiz, 'datasets/b'), { recursive: true });
  writeFileSync(join(raiz, 'datasets/a/dsFoo.js'), '');
  writeFileSync(join(raiz, 'datasets/b/dsFoo.js'), '');
  let chamou = false;
  await assert.rejects(
    pullDataset({ server: SERVER, senha: 's', nome: 'dsFoo', raiz, carregar: async () => { chamou = true; return { impl: 'x' }; } }),
    (e) => codigoDe(e) === 6,
  );
  assert.equal(chamou, false);

  await assert.rejects(
    pullDataset({ server: SERVER, senha: 's', nome: 'dsNada', raiz, carregar: async () => ({}) }),
    (e) => codigoDe(e) === 3,
  );
});

test('pull dataset de fábrica (BUILTIN) é recusado: o impl são classes Java', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-ds-'));
  await assert.rejects(
    pullDataset({ server: SERVER, senha: 's', nome: 'colleague', raiz, carregar: async () => ({ impl: 'com.datasul.X,com.datasul.XBI', tipo: 'BUILTIN' }) }),
    (e) => codigoDe(e) === 6,
  );
  assert.equal(existsSync(join(raiz, 'datasets')), false);
});
