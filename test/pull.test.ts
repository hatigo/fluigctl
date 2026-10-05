import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pullDataset, pullForm, pullProcess } from '../src/commands/pull.js';
import type { CardIndexClient } from '../src/fluig/cardindex-service.js';
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

/** Formulário 902 "formFoo" na versão 3000; a versão errada é recusada como no servidor. */
function fakeCardIndex(): { cliente: CardIndexClient; versoes: number[] } {
  const versoes: number[] = [];
  const anexos: Record<string, Buffer> = {
    'formFoo.html': Buffer.from('<form><input name="a"></form>\n'),
    'select2.min.js': Buffer.from('/* lib */\n'),
    'logo.png': PNG,
  };
  const nao = async () => { throw new Error('pull não pode escrever no servidor'); };
  return {
    versoes,
    cliente: {
      async listForms() { return [{ documentId: 902, documentDescription: 'formFoo', datasetName: 'dsformFoo' }]; },
      async listAttachments() { return Object.keys(anexos); },
      async attachmentContent(_id, versao, nome) {
        versoes.push(versao);
        if (versao !== 3000) throw new ErroFluigctl('a versão do documento é inválida', 7);
        return anexos[nome]!;
      },
      async events() { return [{ eventId: 'validateForm', eventDescription: 'function validateForm(form) {}' }]; },
      updateForm: nao, createForm: nao,
    },
  };
}

test('pull form grava anexos (binário intacto) e eventos, na versão ativa', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-pull-form-'));
  const pasta = join(dir, 'formFoo');
  const f = fakeCardIndex();
  const r = await pullForm({ server: SERVER, senha: 's', pasta, cliente: f.cliente, versao: async () => 3000 });

  assert.equal(r.documentId, 902);
  assert.equal(r.versao, 3000);
  assert.deepEqual(new Set(f.versoes), new Set([3000]));
  assert.ok(readFileSync(join(pasta, 'logo.png')).equals(PNG));
  assert.equal(ler(join(pasta, 'events/validateForm.js')), 'function validateForm(form) {}\n');
  assert.equal(r.gravados.length, 4);
});

test('pull form põe o anexo no arquivo de mesmo nome em subpasta e lista o que só existe no local', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-pull-form-'));
  const pasta = join(dir, 'formFoo');
  mkdirSync(join(pasta, 'libs'), { recursive: true });
  writeFileSync(join(pasta, 'libs/select2.min.js'), '/* lib */\n');
  writeFileSync(join(pasta, 'formFoo.html'), '<form><input name="b"></form>\n');
  writeFileSync(join(pasta, 'rascunho.txt'), 'local');
  const opcoes = { server: SERVER, senha: 's', pasta, cliente: fakeCardIndex().cliente, versao: async () => 3000 };

  const previa = await pullForm({ ...opcoes, dryRun: true });
  assert.deepEqual(previa.iguais, [join(pasta, 'libs/select2.min.js')]);
  assert.deepEqual(previa.diferentes, [join(pasta, 'formFoo.html')]);
  assert.deepEqual(previa.soLocais, ['rascunho.txt']);
  assert.equal(existsSync(join(pasta, 'select2.min.js')), false);

  await assert.rejects(pullForm(opcoes), (e) => codigoDe(e) === 6);
  assert.equal(existsSync(join(pasta, 'logo.png')), false);
});

test('pull form: dois arquivos locais com o nome de um anexo é ambíguo (6); formulário que não existe é 3', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-pull-form-'));
  const pasta = join(dir, 'formFoo');
  mkdirSync(join(pasta, 'a'), { recursive: true });
  mkdirSync(join(pasta, 'b'));
  writeFileSync(join(pasta, 'a/select2.min.js'), '');
  writeFileSync(join(pasta, 'b/select2.min.js'), '');
  const cliente = fakeCardIndex().cliente;
  await assert.rejects(pullForm({ server: SERVER, senha: 's', pasta, cliente, versao: async () => 3000 }), (e) => codigoDe(e) === 6);
  await assert.rejects(
    pullForm({ server: SERVER, senha: 's', pasta: join(dir, 'formOutro'), cliente, versao: async () => 3000 }),
    (e) => codigoDe(e) === 3,
  );
});
