import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pushProcess } from '../src/commands/push-process.js';
import { eventosDoProcesso } from '../src/push/process-events.js';
import type { WorkflowEngineClient } from '../src/fluig/workflow-service.js';
import type { Server } from '../src/config.js';

const SERVER: Server = {
  host: 'fluig.local', port: 8080, ssl: false, username: 'integracao',
  companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
};

const definicao = (codigo13: string) => Buffer.from(
  `<?xml version="1.0" encoding="ISO-8859-1"?><list><ProcessDefinition>
  <ConditionProcessAutomaticRules><id>9</id><field>f</field></ConditionProcessAutomaticRules>
  <WorkflowProcessEvent><workflowProcessEventPK><eventId>servicetask13</eventId></workflowProcessEventPK><eventDescription>${codigo13}</eventDescription></WorkflowProcessEvent>
  <WorkflowProcessEvent><workflowProcessEventPK><eventId>servicetask27</eventId></workflowProcessEventPK><eventDescription>function servicetask27() {}</eventDescription></WorkflowProcessEvent>
  <stateName>Aprovação</stateName>
</ProcessDefinition></list>`, 'latin1');

function workflow(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-proc-'));
  mkdirSync(join(dir, 'scripts'));
  for (const [nome, codigo] of Object.entries(scripts)) writeFileSync(join(dir, 'scripts', nome), codigo);
  writeFileSync(join(dir, 'scripts', 'outroProcesso.servicetask13.js'), 'nao e deste processo');
  return dir;
}

/** Fluig em memória: o export devolve o que o último import gravou. */
function fakeWorkflow(opcoes: { liberacao?: string; respostaImport?: string; processos?: string[] } = {}) {
  let atual: Buffer = definicao('function servicetask13() { antigo(); }');
  const chamadas: string[] = [];
  const importados: Buffer[] = [];
  const cliente: WorkflowEngineClient = {
    async listProcessIds() { chamadas.push('list'); return opcoes.processos ?? ['reembolso', 'aprovacao_movimento']; },
    async exportProcess() { chamadas.push('export'); return atual; },
    async createVersion() { chamadas.push('createVersion'); },
    async importProcess(_id, xml) {
      chamadas.push('import');
      importados.push(xml);
      atual = xml;
      return opcoes.respostaImport ?? 'Processo importado com sucesso!';
    },
    async releaseProcess() { chamadas.push('release'); return { ok: /ok=true/.test(opcoes.liberacao ?? 'ok=true'), mensagem: opcoes.liberacao ?? 'ok=true' }; },
  };
  return { cliente, chamadas, importados };
}

const NOVO = 'function servicetask13() { novo("nº"); }\n';

test('dry-run lista o que mudaria e não escreve nada', async () => {
  const f = fakeWorkflow();
  const r = await pushProcess({
    server: SERVER, senha: 's', processId: 'reembolso', dryRun: true, prompt: async () => '',
    pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO, 'reembolso.servicetask27.js': 'function servicetask27() {}' }),
    cliente: f.cliente,
  });

  assert.deepEqual(r.alterados, ['servicetask13']);
  assert.deepEqual(r.iguais, ['servicetask27']);
  assert.equal(r.publicado, false);
  assert.deepEqual(f.chamadas, ['list', 'export']);
});

test('publica: nova versão, import com o script novo, liberação e conferência', async () => {
  const f = fakeWorkflow();
  const r = await pushProcess({
    server: SERVER, senha: 's', processId: 'reembolso', prompt: async () => '',
    pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }),
    cliente: f.cliente,
  });

  assert.equal(r.publicado, true);
  assert.equal(r.liberado, true);
  assert.deepEqual(f.chamadas, ['list', 'export', 'createVersion', 'import', 'release']);

  const enviado = f.importados[0]!.toString('utf8');
  assert.ok(enviado.startsWith('<list>'), 'sem a declaração <?xml?>');
  assert.doesNotMatch(enviado, /<id>9<\/id>/, 'sem o id da entidade filha');
  assert.match(enviado, /<stateName>Aprovação<\/stateName>/, 'acentos enviados em UTF-8, como o Studio');
  assert.ok(f.importados[0]!.includes(Buffer.from('Aprovação', 'utf8')), 'bytes UTF-8 no anexo');
  assert.equal(eventosDoProcesso(enviado)[0]?.codigo, NOVO);
});

test('nada a publicar quando os scripts já são os do servidor', async () => {
  const f = fakeWorkflow();
  const r = await pushProcess({
    server: SERVER, senha: 's', processId: 'reembolso', prompt: async () => '',
    pastaWorkflow: workflow({ 'reembolso.servicetask13.js': 'function servicetask13() { antigo(); }' }),
    cliente: f.cliente,
  });

  assert.equal(r.publicado, false);
  assert.ok(!f.chamadas.includes('import'));
});

test('--no-release importa e deixa a versão em edição', async () => {
  const f = fakeWorkflow();
  const r = await pushProcess({
    server: SERVER, senha: 's', processId: 'reembolso', liberar: false, prompt: async () => '',
    pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }), cliente: f.cliente,
  });

  assert.equal(r.liberado, null);
  assert.ok(!f.chamadas.includes('release'));
});

test('liberação recusada vira erro, avisando que a versão ficou em edição', async () => {
  const f = fakeWorkflow({ liberacao: 'ok=false; erro de validação' });
  await assert.rejects(
    () => pushProcess({
      server: SERVER, senha: 's', processId: 'reembolso', prompt: async () => '',
      pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }), cliente: f.cliente,
    }),
    /não liberou a versão.*em edição/s,
  );
});

test('import sem confirmação de sucesso é erro, e não libera', async () => {
  const f = fakeWorkflow({ respostaImport: 'Erro ao importar: arquivo inválido' });
  await assert.rejects(
    () => pushProcess({
      server: SERVER, senha: 's', processId: 'reembolso', prompt: async () => '',
      pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }), cliente: f.cliente,
    }),
    /não confirmou o import.*arquivo inválido/s,
  );
  assert.ok(!f.chamadas.includes('release'));
});

test('processo que não existe no servidor é recusado antes de qualquer escrita', async () => {
  const f = fakeWorkflow({ processos: ['outro'] });
  await assert.rejects(
    () => pushProcess({
      server: SERVER, senha: 's', processId: 'reembolso', prompt: async () => '',
      pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }), cliente: f.cliente,
    }),
    /não existe.*Fluig Studio/s,
  );
  assert.deepEqual(f.chamadas, ['list']);
});

test('em produção não escreve quando a senha digitada não confere', async () => {
  const f = fakeWorkflow();
  await assert.rejects(
    () => pushProcess({
      server: { ...SERVER, prod: true }, senha: 'senha-certa', processId: 'reembolso', prompt: async () => 'errada',
      pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }), cliente: f.cliente,
    }),
    /não confere/,
  );
  assert.ok(!f.chamadas.includes('createVersion') && !f.chamadas.includes('import'));
});

test('--save-export grava a definição que o servidor devolveu', async () => {
  const f = fakeWorkflow();
  const destino = join(mkdtempSync(join(tmpdir(), 'fluigctl-exp-')), 'reembolso.xml');
  await pushProcess({
    server: SERVER, senha: 's', processId: 'reembolso', dryRun: true, salvarExport: destino, prompt: async () => '',
    pastaWorkflow: workflow({ 'reembolso.servicetask13.js': NOVO }), cliente: f.cliente,
  });
  assert.deepEqual(readFileSync(destino), definicao('function servicetask13() { antigo(); }'));
});

test('pasta sem scripts do processo é erro de arquivo', async () => {
  const f = fakeWorkflow();
  await assert.rejects(
    () => pushProcess({
      server: SERVER, senha: 's', processId: 'reembolso', prompt: async () => '',
      pastaWorkflow: workflow({}), cliente: f.cliente,
    }),
    /nenhum script "reembolso\.\*\.js"/,
  );
});

test('--base publica a partir de um export salvo, mesmo sem script alterado', async () => {
  const f = fakeWorkflow();
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-base-'));
  const base = join(dir, 'reembolso.v6.xml');
  writeFileSync(base, definicao('function servicetask13() { antigo(); }'));
  const r = await pushProcess({
    server: SERVER, senha: 's', processId: 'reembolso', base, prompt: async () => '',
    pastaWorkflow: workflow({ 'reembolso.servicetask13.js': 'function servicetask13() { antigo(); }' }), cliente: f.cliente,
  });
  assert.equal(r.publicado, true);
  assert.deepEqual(f.chamadas, ['list', 'createVersion', 'import', 'release']);
});
