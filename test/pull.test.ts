import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pullDataset, pullDiagram, pullForm, pullProcess } from '../src/commands/pull.js';
import { gerarProcess } from '../src/pull/process-diagram.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';
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

test('conversão inversa gera um .process estrutural com estados, raias, fluxos e bendpoints', () => {
  const xml = readFileSync(join(import.meta.dirname, 'fixtures/diagrams/processoTeste.ecm30.xml'), 'utf8');
  const convertido = gerarProcess(xml);
  const diagrama = lerDiagrama(convertido.process);

  assert.equal(convertido.processId, 'processoTeste');
  assert.equal(diagrama.objetos.filter((o) => o.tipo === 'BpmnTask').length, 2);
  assert.equal(diagrama.objetos.filter((o) => o.tipo === 'SequenceFlow').length, 3);
  assert.equal(diagrama.caixas.size, 7);
  assert.equal(diagrama.dobras.get('flow10')?.length, 2);
});

test('conversão inversa recusa estruturas ainda não cobertas, sem produzir um .process parcial', () => {
  const xml = readFileSync(join(import.meta.dirname, 'fixtures/diagrams/processoTeste.ecm30.xml'), 'utf8');
  const comComponente = xml.replace('<list/>', '<list><ProcessComponGraf><componType>9</componType></ProcessComponGraf></list>');
  assert.throws(() => gerarProcess(comComponente), (e) => codigoDe(e) === 6 && /componType 9/.test((e as Error).message));
});

test('conversão inversa recompõe condições e regras do gateway no blob XStream', () => {
  const xml = `<list>
    <ProcessDefinition><processDefinitionPK><processId>condicao</processId></processDefinitionPK><processDescription>Condição</processDescription></ProcessDefinition>
    <ProcessDefinitionVersion><processDefinitionVersionPK><version>1</version></processDefinitionVersionPK></ProcessDefinitionVersion>
    <list>
      <ProcessState><processStatePK><sequence>1</sequence></processStatePK><stateName>Decidir</stateName><positionX>10</positionX><positionY>10</positionY><bpmnType>120</bpmnType></ProcessState>
      <ProcessState><processStatePK><sequence>2</sequence></processStatePK><stateName>Destino</stateName><positionX>200</positionX><positionY>10</positionY><bpmnType>80</bpmnType></ProcessState>
    </list>
    <list><ConditionProcessState><conditionProcessStatePK><expressionOrder>1</expressionOrder><sequence>1</sequence></conditionProcessStatePK><condition>x</condition><destinationSequenceId>2</destinationSequenceId><conditionType>1</conditionType></ConditionProcessState></list>
    <list><ProcessLink><processLinkPK><linkSequence>3</linkSequence></processLinkPK><initialStateSequence>1</initialStateSequence><finalStateSequence>2</finalStateSequence></ProcessLink></list>
    <list><ConditionProcessAutomaticRules><sequence>1</sequence><expressionOrder>1</expressionOrder><ruleOrder>1</ruleOrder><field>valor</field><value>sim</value><operator>0</operator><valueType>0</valueType></ConditionProcessAutomaticRules></list>
  </list>`;
  const diagrama = lerDiagrama(gerarProcess(xml).process);
  const gateway = diagrama.objetos.find((o) => o.tipo === 'BpmnGateway')!;
  assert.match(gateway.attrs.condition!, /<targetTask>task2<\/targetTask>/);
  assert.match(gateway.attrs.condition!, /<field>valor<\/field>/);
});

test('conversão inversa preserva o mecanismo customizado, cuja configuração vem vazia do servidor', () => {
  /*
   * O servidor guarda o id do mecanismo e a configuração VAZIA — medido no
   * fluig-localdev com MEC_ALCADAS na atividade "Aprovar". O `if (!xml)` no topo
   * do conversor de atribuição acontecia antes do caso custom, que exige
   * exatamente a configuração vazia: o ramo era inalcançável e o pull devolvia a
   * tarefa sem atribuição. Republicar aquele arquivo apagava o mecanismo do
   * processo, e a aprovação deixava de ter responsável — sem erro nenhum.
   */
  const estado = (alocacao: string) =>
    lerDiagrama(gerarProcess(definicao({
      estados:
        '<ProcessState><processStatePK><sequence>5</sequence></processStatePK><stateName>Aprovar</stateName>' +
        '<positionX>10</positionX><positionY>10</positionY><bpmnType>80</bpmnType>' +
        `<engineAllocationId>${alocacao}</engineAllocationId><engineAllocationConfiguration></engineAllocationConfiguration>` +
        '</ProcessState>',
    })).process).objetos.find((o) => o.attrs['id'] === 'task5')!;

  const custom = estado('MEC_ALCADAS');
  assert.equal(custom.attrs['managerMechanism'], 'MEC_ALCADAS');
  assert.match(custom.attrs['managerAssignmentControllerString']!, /AssignmentControllerCustom/);
  assert.match(custom.attrs['managerAssignmentControllerString']!, /<mechanismName>MEC_ALCADAS<\/mechanismName>/);

  // Sem mecanismo nenhum o servidor devolve id vazio: nada deve ser inventado.
  assert.equal(estado('').attrs['managerMechanism'], undefined);
});

/** Definição ECM 3.0 mínima, com os filhos na ordem que o Studio usa. */
function definicao(filhos: Record<string, string>): string {
  const corpo = (nome: string) => `<list>${filhos[nome] ?? ''}</list>`;
  return `<list>
    <ProcessDefinition><processDefinitionPK><companyId>1</companyId><processId>p</processId></processDefinitionPK><processDescription>P</processDescription></ProcessDefinition>
    <ProcessDefinitionVersion><processDefinitionVersionPK><version>2</version></processDefinitionVersionPK></ProcessDefinitionVersion>
    ${corpo('estados')}
    ${corpo('condicoes')}
    ${corpo('links')}
    ${corpo('seguranca')}
    ${corpo('eventos')}
    ${corpo('avancadas')}
    ${corpo('raias')}
    ${corpo('graficos')}
    ${corpo('associacoes')}
    ${corpo('bends')}
    ${corpo('gatilhos')}
    ${corpo('estendidas')}
    ${corpo('descritores')}
    ${corpo('servicos')}
    ${corpo('relacoes')}
    ${corpo('apps')}
    ${corpo('regrasAnexo')}
    ${corpo('regrasCondicao')}
  </list>`;
}

const estado = (seq: number, tipo: number, extra = '') =>
  `<ProcessState><processStatePK><sequence>${seq}</sequence></processStatePK><stateName>E${seq}</stateName><positionX>${10 * seq}</positionX><positionY>20</positionY><bpmnType>${tipo}</bpmnType>${extra}</ProcessState>`;
const link = (seq: number, de: number, para: number, extra = '') =>
  `<ProcessLink><processLinkPK><linkSequence>${seq}</linkSequence></processLinkPK><initialStateSequence>${de}</initialStateSequence><finalStateSequence>${para}</finalStateSequence>${extra}</ProcessLink>`;

/** Devolve o objeto do `.process` com o id dado. */
function objeto(texto: string, id: string) {
  const achado = lerDiagrama(texto).objetos.find((o) => o.attrs['id'] === id);
  assert.ok(achado, `esperava ${id} no .process gerado`);
  return achado;
}

test('subprocesso volta com process, os booleanos e o formMaps do relacionamento', () => {
  const xml = definicao({
    estados: estado(1, 100, '<transferAttachments>true</transferAttachments><subProcessId>outro</subProcessId><sendToNextTaskInSubProcess>true</sendToNextTaskInSubProcess>'),
    relacoes: '<SubProcessFieldRelationship><processCode>p</processCode><stateSequence>1</stateSequence><processField>a</processField><subProcessField>b</subProcessField><mapFlow>1</mapFlow></SubProcessFieldRelationship>',
  });
  const sub = objeto(gerarProcess(xml).process, 'subprocess1');
  assert.equal(sub.attrs['process'], 'outro');
  assert.equal(sub.attrs['transferAttachments'], 'true');
  assert.equal(sub.attrs['sendToNextTaskInSubProcess'], 'true');
  assert.match(sub.attrs['formMaps']!, /<processField>a<\/processField>/);
  assert.match(sub.attrs['formMaps']!, /<mapFlow>1<\/mapFlow>/);
});

test('segurança de anexos volta como o blob ECMProcessAttachmentSecurityImpl', () => {
  const xml = definicao({
    estados: estado(1, 80),
    seguranca: '<ProcessAttachmentSecurity><processAttachmentSecurityPK><sequence>1</sequence></processAttachmentSecurityPK>' +
      '<engineAllocationId>Grupo</engineAllocationId><engineAllocationConfiguration>&lt;AssignmentController&gt;&lt;Group&gt;G&lt;/Group&gt;&lt;/AssignmentController&gt;</engineAllocationConfiguration>' +
      '<accessLevel>PR</accessLevel><editionMode>false</editionMode></ProcessAttachmentSecurity>',
  });
  const proc = objeto(gerarProcess(xml).process, 'p');
  assert.match(proc.attrs['processAttachmentSecurity']!, /<sequence>1<\/sequence>/);
  assert.match(proc.attrs['processAttachmentSecurity']!, /<accessLevel>PR<\/accessLevel>/);
  assert.match(proc.attrs['processAttachmentSecurity']!, /<groupId>G<\/groupId>/);
});

test('campos descritores voltam na ordem do slotId e o texto vira id e label', () => {
  const xml = definicao({
    estados: estado(1, 80),
    descritores: '<ProcessFormField><processFormFieldPK><fieldId>nome</fieldId></processFormFieldPK><fieldDescription>Nome</fieldDescription><slotId>1</slotId></ProcessFormField>' +
      '<ProcessFormField><processFormFieldPK><fieldId>cpf</fieldId></processFormFieldPK><fieldDescription>CPF</fieldDescription><slotId>2</slotId></ProcessFormField>',
  });
  const campos = objeto(gerarProcess(xml).process, 'p').attrs['descriptorFields']!;
  assert.match(campos, /<id>nome<\/id><label>Nome<\/label>/);
  assert.ok(campos.indexOf('<id>nome') < campos.indexOf('<id>cpf'));
});

test('evento de link: o 36 aponta para o 42 pelo linkId e o ProcessLink sintético não vira fluxo', () => {
  const xml = definicao({
    estados: estado(1, 80) + estado(2, 36) + estado(3, 42) + estado(4, 60),
    links: link(5, 1, 2) + link(6, 2, 3) + link(7, 3, 4),
  });
  const gerado = gerarProcess(xml).process;
  assert.equal(objeto(gerado, 'intermediatelink2').attrs['linkId'], 'intermediatelinkcatch3');
  // O link 6 é o sintético do evento: só os fluxos reais viram SequenceFlow.
  assert.deepEqual(lerDiagrama(gerado).objetos.filter((o) => o.tipo === 'SequenceFlow').map((o) => o.attrs['id']), ['flow5', 'flow7']);
});

test('anotação volta como BpmnAnnotation e o fluxo dela como SequenceFlow comum', () => {
  const xml = definicao({
    estados: estado(1, 80),
    graficos: '<ProcessComponGraf><componType>1</componType><positionX>5</positionX><positionY>6</positionY><processComponGrafPK><componGrafSequence>9</componGrafSequence></processComponGrafPK><stateName>nota</stateName></ProcessComponGraf>',
    associacoes: '<ProcessLinkAssoc><processLinkAssocPK><linkSequence>10</linkSequence></processLinkAssocPK><initialStateSequence>9</initialStateSequence><finalStateSequence>1</finalStateSequence></ProcessLinkAssoc>',
  });
  const diagrama = lerDiagrama(gerarProcess(xml).process);
  assert.equal(diagrama.objetos.find((o) => o.tipo === 'BpmnAnnotation')!.attrs['name'], 'nota');
  assert.equal(diagrama.objetos.find((o) => o.attrs['id'] === 'flow10')!.attrs['targetRef'], 'task1');
  assert.equal(diagrama.caixas.size, 2);
});

test('tarefa de e-mail volta com o messageData montado do gatilho tipo 0', () => {
  const valor = '&lt;BpmnMessageData&gt;&lt;Type&gt;1&lt;/Type&gt;&lt;Receiver&gt;a@b&lt;/Receiver&gt;&lt;Subject&gt;Oi&lt;/Subject&gt;&lt;Content&gt;Corpo&lt;/Content&gt;&lt;/BpmnMessageData&gt;';
  const xml = definicao({
    estados: estado(1, 84),
    gatilhos: `<ProcessStateTrigger><processStateTriggerPK><stateSequence>1</stateSequence><triggerSequence>0</triggerSequence></processStateTriggerPK><runType>1</runType><type>0</type><value>${valor}</value><frequencia>01</frequencia></ProcessStateTrigger>`,
  });
  const dados = objeto(gerarProcess(xml).process, 'task1').attrs['messageData']!;
  assert.match(dados, /<receiver>a@b<\/receiver>/);
  assert.match(dados, /<subject>Oi<\/subject>/);
  assert.match(dados, /<content>Corpo<\/content>/);
});

test('o mesmo export sempre gera o mesmo .process', () => {
  const xml = readFileSync(join(import.meta.dirname, 'fixtures/diagrams/processoTeste.ecm30.xml'), 'utf8');
  assert.equal(gerarProcess(xml).process, gerarProcess(xml).process);
});

test('evento de erro anexado a estado inexistente recusa: o Studio descartaria o evento', () => {
  const xml = definicao({ estados: estado(7, 43, '<parentSequence>6</parentSequence>') });
  assert.throws(
    () => gerarProcess(xml),
    (e) => codigoDe(e) === 6 && /anexado ao estado 6, que não existe/.test((e as Error).message),
  );
});

test('fim terminal (68) com notifyAuthorityDelay=true recusa: o Studio grava false sempre', () => {
  const xml = definicao({ estados: estado(11, 68, '<notifyAuthorityDelay>true</notifyAuthorityDelay>') });
  assert.throws(
    () => gerarProcess(xml),
    (e) => codigoDe(e) === 6 && /não tem campo para isso/.test((e as Error).message),
  );
  // O mesmo fim com o valor que o Studio grava passa.
  assert.doesNotThrow(() => gerarProcess(definicao({ estados: estado(11, 68) })));
});

test('pull diagram baixa somente a definição e grava workflow/diagrams/<id>.process', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-diagram-'));
  const workflow = join(raiz, 'workflow');
  const xml = readFileSync(join(import.meta.dirname, 'fixtures/diagrams/processoTeste.ecm30.xml'));
  const f = fakeWorkflow();
  f.cliente.exportProcess = async () => { f.chamadas.push('export'); return xml; };

  const r = await pullDiagram({ server: SERVER, senha: 's', processId: 'reembolso', pastaWorkflow: workflow, cliente: f.cliente });
  const arquivo = join(workflow, 'diagrams/reembolso.process');
  assert.equal(r.arquivo, arquivo);
  assert.equal(lerDiagrama(ler(arquivo)).objetos.some((o) => o.tipo === 'BpmnProcess'), true);
  assert.deepEqual(f.chamadas, ['list', 'export']);
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
