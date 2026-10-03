import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeFluig } from './helpers/fake-fluig.js';
import { bpmnVersionDe, pushDiagram, resolverFormId } from '../src/commands/push-diagram.js';
import type { WorkflowEngineClient } from '../src/fluig/workflow-service.js';
import type { FormNoServidor } from '../src/fluig/cardindex-service.js';
import type { Server } from '../src/config.js';
import { ErroFluigctl } from '../src/errors.js';
import { converterDiagrama } from '../src/push/diagram/ecm30.js';
import { lerXml, type No } from '../src/push/diagram/xml.js';
import { gerarSvg, sequenciasDoSvg } from '../src/push/diagram/svg.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/diagrams/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PROCESSO = readFileSync(join(FIXTURES, 'processoTeste.process'), 'latin1');

const SERVER: Server = {
  host: 'fluig.local', port: 8080, ssl: false, username: 'integracao',
  companyId: 7, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_DIAGRAMA_TESTE_PASSWORD',
};

async function codigoDe(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
    return undefined;
  } catch (erro) {
    return erro instanceof ErroFluigctl ? erro.codigo : -1;
  }
}

function erroDe(fn: () => unknown): ErroFluigctl {
  try {
    fn();
  } catch (erro) {
    if (erro instanceof ErroFluigctl) return erro;
    throw erro;
  }
  assert.fail('esperava ErroFluigctl');
}

/** Os 20 filhos da raiz do XML gerado. */
function filhosDaRaiz(xml: string): No[] {
  return lerXml(xml).filhos[0]!.filhos;
}

const texto = (no: No, ...caminho: string[]): string =>
  caminho.reduce<No | undefined>((n, nome) => n?.filhos.find((f) => f.nome === nome), no)?.texto ?? '<ausente>';

test('o tokenizer não encerra a tag num ">" dentro de atributo e decodifica as entidades', () => {
  const raiz = lerXml('<?xml version="1.0"?><a v="x > y &amp; &#xe7;&#227; &lt;b/>" w="2"><b/></a>');
  const a = raiz.filhos[0]!;
  assert.equal(a.nome, 'a');
  assert.deepEqual(a.attrs, { v: 'x > y & çã <b/>', w: '2' });
  assert.deepEqual(a.filhos.map((f) => f.nome), ['b']);
});

test('XML malformado é recusado com código 6, sem árvore parcial', () => {
  assert.equal(erroDe(() => lerXml('<a><b></a>')).codigo, 6);
  // Atributo repetido é XML inválido; aceitar ficaria com o último valor em silêncio.
  const repetido = erroDe(() => lerXml('<a v="1" v="2"/>'));
  assert.equal(repetido.codigo, 6);
  assert.match(repetido.message, /atributo v repetido/);
  assert.equal(erroDe(() => converterDiagrama('<<<<<<< HEAD\n<xmi:XMI/>', { companyId: 1 })).codigo, 6);
});

test('início → tarefas → fim numa pool com lanes sai no formato do Studio', () => {
  const r = converterDiagrama(PROCESSO, { companyId: 1 });
  assert.equal(r.xml, readFileSync(join(FIXTURES, 'processoTeste.ecm30.xml'), 'utf8'));

  const filhos = filhosDaRaiz(r.xml);
  assert.equal(filhos.length, 20);
  assert.deepEqual(
    filhos.map((f, i) => (f.filhos.length === 0 ? `${i}:vazio` : `${i}:${f.nome === 'list' ? f.filhos[0]!.nome : f.nome}`)),
    [
      '0:ProcessDefinition', '1:ProcessDefinitionVersion', '2:ProcessState', '3:vazio', '4:ProcessLink',
      '5:vazio', '6:vazio', '7:vazio', '8:SwimLane', '9:vazio', '10:vazio', '11:ProcessLinkBend',
      '12:vazio', '13:vazio', '14:vazio', '15:vazio', '16:vazio', '17:vazio', '18:vazio', '19:vazio',
    ],
  );
  assert.deepEqual(r.contagens, { estados: 4, links: 3, raias: 3, dobras: 2, condicoes: 0, eventos: 0, anotacoes: 0 });
  assert.equal(r.processId, 'processoTeste');
});

test('sequence da lane é a posição entre pools e lanes, não o sufixo do id', () => {
  const raias = filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 1 }).xml)[8]!.filhos;
  const porNome = new Map(raias.map((r) => [texto(r, 'stateName'), r]));

  const aprovacao = porNome.get('Aprovação')!; // id bpmnswimlane9
  assert.equal(texto(aprovacao, 'swimLanePK', 'sequence'), '3');
  assert.equal(texto(aprovacao, 'parentSequence'), '1');
  assert.equal(texto(aprovacao, 'type'), '2');
  // Posição da lane é absoluta: pool (10,10) + lane (30,150).
  assert.equal(texto(aprovacao, 'positionX'), '40');
  assert.equal(texto(aprovacao, 'positionY'), '160');
  assert.equal(texto(aprovacao, 'color'), 'FFFFFF', 'lane sem cores fica branca');
});

test('PK de estado, link e lane usa version 1; a PDV e os bends usam a versão do .process', () => {
  const filhos = filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 1 }).xml);
  const pdv = filhos[1]!;
  assert.equal(texto(pdv, 'processDefinitionVersionPK', 'version'), '3');
  assert.equal(texto(pdv, 'processDefinitionVersionPK', 'processId'), 'Processo de Teste');

  for (const estado of filhos[2]!.filhos) assert.equal(texto(estado, 'processStatePK', 'version'), '1');
  for (const link of filhos[4]!.filhos) assert.equal(texto(link, 'processLinkPK', 'version'), '1');
  for (const raia of filhos[8]!.filhos) assert.equal(texto(raia, 'swimLanePK', 'version'), '1');
  for (const bend of filhos[11]!.filhos) assert.equal(texto(bend, 'processLinkBendPK', 'version'), '3');
});

test('companyId vem de quem chama, não do arquivo', () => {
  const pd = filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 42 }).xml)[0]!;
  assert.equal(texto(pd, 'processDefinitionPK', 'companyId'), '42');
});

test('atribuição: Pool Grupo vira <Group> e Executor Atividade vira BaseActivity + Returns', () => {
  const estados = filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 1 }).xml)[2]!.filhos;
  const porSequencia = new Map(estados.map((e) => [texto(e, 'processStatePK', 'sequence'), e]));

  const grupo = porSequencia.get('5')!;
  assert.equal(texto(grupo, 'engineAllocationId'), 'Pool Grupo');
  assert.equal(
    texto(grupo, 'engineAllocationConfiguration'),
    '<AssignmentController><Group>APROVADORES</Group></AssignmentController>',
  );

  const executor = porSequencia.get('7')!;
  assert.equal(texto(executor, 'engineAllocationId'), 'Executor Atividade');
  assert.equal(
    texto(executor, 'engineAllocationConfiguration'),
    '<AssignmentController><BaseActivity>4</BaseActivity><Returns>Last</Returns></AssignmentController>',
  );
});

test('tarefa sem managerMechanism não leva os campos de atribuição', () => {
  const semMecanismo = PROCESSO.replace(
    / managerMechanism="Executor Atividade" managerAssignmentControllerString="[^"]*"/,
    '',
  );
  const estados = filhosDaRaiz(converterDiagrama(semMecanismo, { companyId: 1 }).xml)[2]!.filhos;
  const tarefa = estados.find((e) => texto(e, 'processStatePK', 'sequence') === '7')!;
  assert.ok(!tarefa.filhos.some((f) => f.nome.startsWith('engineAllocation')));
});

test('elemento não suportado é recusado com código 6, listando o tipo', () => {
  // O subprocesso ad hoc (101) não aparece em nenhum ecm30: segue recusado pelo tipo.
  const adHoc = PROCESSO.replace(
    '<bpmn2:BpmnEndEvent',
    '<bpmn2:BpmnSubProcess id="subprocess12" name="Filho" type="101"/>\n  <bpmn2:BpmnEndEvent',
  );
  const erro = erroDe(() => converterDiagrama(adHoc, { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /BpmnSubProcess \(type 101\)/);
});

test('subprocesso (100) sem process é recusado; booleano fora de true/false também', () => {
  const incompleto = PROCESSO.replace(
    '<bpmn2:BpmnEndEvent',
    '<bpmn2:BpmnSubProcess id="subprocess12" name="Filho" type="100" transferAttachments="sim"/>\n  <bpmn2:BpmnEndEvent',
  );
  const erro = erroDe(() => converterDiagrama(incompleto, { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /subprocess12 sem process/);
  assert.match(erro.message, /transferAttachments="sim" em subprocess12/);
});

const comRetorno = (n: string) => PROCESSO.replace(
  'AssignmentControllerExecutorMechanism>&#xA;  &lt;idNode>startevent4&lt;/idNode>&#xA;  &lt;returns>1',
  `AssignmentControllerExecutorMechanism>&#xA;  &lt;idNode>startevent4&lt;/idNode>&#xA;  &lt;returns>${n}`,
);

test('Executor Atividade com returns 2 vira All', () => {
  assert.notEqual(comRetorno('2'), PROCESSO);
  const xml = converterDiagrama(comRetorno('2'), { companyId: 1 }).xml;
  assert.match(xml, /&lt;BaseActivity&gt;4&lt;\/BaseActivity&gt;&lt;Returns&gt;All&lt;\/Returns&gt;/);
});

test('atribuição que não foi conferida contra o Studio é recusada com código 6', () => {
  const erro = erroDe(() => converterDiagrama(comRetorno('3'), { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /AssignmentControllerExecutorMechanism em task7/);
});

test('esforço previsto no início e na tarefa 80: tipo = esforcoCalculo, esforço em segundos', () => {
  const comEsforco = PROCESSO.replace(/(<bpmn2:BpmnTask id="task5"[^\n]*?)esforcoCalculo="0"/, '$1esforcoCalculo="3" esforcoPrevisto="1920.0"');
  assert.notEqual(comEsforco, PROCESSO);
  const estados = filhosDaRaiz(converterDiagrama(comEsforco, { companyId: 1 }).xml)[2]!.filhos;
  const t5 = estados.find((e) => texto(e, 'processStatePK', 'sequence') === '5')!;
  assert.equal(texto(t5, 'forecastedEffortType'), '3');
  assert.equal(texto(t5, 'forecastedEffort'), '115200');
  const erro = erroDe(() => converterDiagrama(comEsforco.replace('esforcoPrevisto="1920.0"', 'esforcoPrevisto="muito"'), { companyId: 1 }));
  assert.match(erro.message, /esforcoPrevisto="muito" em task5/);
});

test('cardIndex por nome: formId 0 e aviso de que será resolvido no destino', () => {
  const r = converterDiagrama(PROCESSO.replace('cardIndex="1234"', 'cardIndex="Formulario de Teste"'), { companyId: 1 });
  assert.equal(r.formId, 0);
  assert.equal(texto(filhosDaRaiz(r.xml)[1]!, 'formId'), '0');
  assert.match(r.avisos.join('\n'), /pelo nome \("Formulario de Teste"\).*resolvido pelo nome/);
});

test('push diagram sem --dry-run e sem senha é recusado com código 4', async () => {
  assert.equal(await codigoDe(pushDiagram({ server: SERVER, arquivo: join(FIXTURES, 'processoTeste.process') })), 4);
});

test('--save-xml grava o XML gerado', async () => {
  const destino = join(mkdtempSync(join(tmpdir(), 'fluigctl-diagrama-')), 'saida.xml');
  const r = await pushDiagram({ server: SERVER, arquivo: join(FIXTURES, 'processoTeste.process'), dryRun: true, salvarXml: destino });
  assert.equal(readFileSync(destino, 'utf8'), r.xml);
});

function rodarCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ codigo: number; saida: string }> {
  return new Promise((ok) => {
    execFile(process.execPath, [CLI, ...args], { env }, (erro, stdout, stderr) => {
      ok({ codigo: erro ? Number(erro.code) : 0, saida: stdout + stderr });
    });
  });
}

test('CLI: dry-run com cardIndex por nome avisa, não pede senha e não faz nenhuma requisição', async () => {
  const fluig = await fakeFluig({});
  try {
    const url = new URL(fluig.url);
    const config = mkdtempSync(join(tmpdir(), 'fluigctl-cfg-'));
    mkdirSync(join(config, 'fluigctl'));
    writeFileSync(
      join(config, 'fluigctl', 'servers.json'),
      JSON.stringify({
        version: 1,
        servers: {
          teste: { ...SERVER, host: url.hostname, port: Number(url.port) },
        },
      }),
    );
    const arquivo = join(config, 'processoTeste.process');
    writeFileSync(arquivo, PROCESSO.replace('cardIndex="1234"', 'cardIndex="Formulario de Teste"'), 'latin1');

    const env = { PATH: process.env['PATH'] ?? '', XDG_CONFIG_HOME: config };
    const r = await rodarCli(['push', 'diagram', arquivo, '--server', 'teste', '--dry-run'], env);

    assert.equal(r.codigo, 0, r.saida);
    assert.match(r.saida, /processoTeste versão 3/);
    assert.match(r.saida, /companyId 7/);
    assert.match(r.saida, /aviso: o formulário está referenciado pelo nome/);
    assert.match(r.saida, /\[dry-run\] Nada foi enviado/);
    assert.equal(fluig.requests.length, 0);

    // Sem --dry-run publica, e isso exige a senha: sem ela, código 4 e nenhuma requisição.
    const semDryRun = await rodarCli(['push', 'diagram', arquivo, '--server', 'teste'], { ...env, FLUIGCTL_NO_VSCODE: '1' });
    assert.equal(semDryRun.codigo, 4);
    assert.match(semDryRun.saida, /FLUIG_DIAGRAMA_TESTE_PASSWORD/);
    assert.equal(fluig.requests.length, 0);
  } finally {
    await fluig.close();
  }
});

test('atributo que a conversão não conhece é recusado com código 6, em vez de descartado', () => {
  const erro = erroDe(() =>
    converterDiagrama(PROCESSO.replace('<bpmn2:BpmnTask id="task7"', '<bpmn2:BpmnTask novoAtributo="x" id="task7"'), { companyId: 1 }),
  );
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /atributo novoAtributo em task7/);
});

test('atribuição do gestor do processo não suportada é recusada, e não vira campo vazio', () => {
  const gestorAssociado = PROCESSO.replace(
    /managerAssignmentController="&lt;org\.eclipse\.bpmn2\.impl\.AssignmentControllerGroup>[^"]*"/,
    'managerAssignmentController="&lt;org.eclipse.bpmn2.impl.AssignmentControllerAssociated>&#xA;  &lt;type>OR&lt;/type>&#xA;&lt;/org.eclipse.bpmn2.impl.AssignmentControllerAssociated>"',
  );
  assert.notEqual(gestorAssociado, PROCESSO);
  const erro = erroDe(() => converterDiagrama(gestorAssociado, { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /AssignmentControllerAssociated em processoTeste/);
});

test('filho dentro de objeto bpmn2 ou elemento desconhecido na raiz é recusado com código 6', () => {
  const comFilho = PROCESSO.replace(
    '<bpmn2:BpmnEndEvent id="endevent6" name="Fim" incoming="flow11" type="60" extendedFields="&lt;list/>" signalId="0"/>',
    '<bpmn2:BpmnEndEvent id="endevent6" name="Fim" incoming="flow11" type="60" signalId="0"><eventDefinitions/></bpmn2:BpmnEndEvent>',
  );
  assert.notEqual(comFilho, PROCESSO);
  const e1 = erroDe(() => converterDiagrama(comFilho, { companyId: 1 }));
  assert.equal(e1.codigo, 6);
  assert.match(e1.message, /elementos filhos \(<eventDefinitions>\)/);

  const naRaiz = PROCESSO.replace('</xmi:XMI>', '  <outro:Coisa id="x1"/>\n</xmi:XMI>');
  const erro = erroDe(() => converterDiagrama(naRaiz, { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /<outro:Coisa> na raiz/);
});

test('arquivo com byte fora do ASCII é recusado com código 6, dizendo onde', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-ascii-'));
  const arquivo = join(dir, 'acento.process');
  writeFileSync(arquivo, PROCESSO.replace('name="Fim"', 'name="Término"'), 'utf8');
  await assert.rejects(
    () => pushDiagram({ server: SERVER, arquivo, dryRun: true }),
    (erro: unknown) => erro instanceof ErroFluigctl && erro.codigo === 6 && /não é ASCII: byte 0xc3 na posição \d+ \(linha \d+\)/.test(erro.message),
  );
});

test('sequence de estado ou de link repetido pelo sufixo do id é recusado com código 6', () => {
  const estadoRepetido = PROCESSO.replaceAll('endevent6', 'endevent5');
  const e1 = erroDe(() => converterDiagrama(estadoRepetido, { companyId: 1 }));
  assert.equal(e1.codigo, 6);
  assert.match(e1.message, /estado com sequence 5 repetido \(task5, endevent5\)/);

  const linkRepetido = PROCESSO.replaceAll('flow11', 'fluxo8');
  const e2 = erroDe(() => converterDiagrama(linkRepetido, { companyId: 1 }));
  assert.equal(e2.codigo, 6);
  assert.match(e2.message, /fluxo com sequence 8 repetido \(flow8, fluxo8\)/);
});

test('CDATA, DOCTYPE e texto solto entre elementos são recusados com código 6', () => {
  for (const xml of [
    '<a><![CDATA[x]]></a>',
    '<!DOCTYPE a><a/>',
    '<a>solto<b/></a>',
    '<a><b/>solto</a>',
    '<a/>depois',
  ]) {
    assert.equal(erroDe(() => lerXml(xml)).codigo, 6, xml);
  }
  assert.equal(lerXml('<a>\n  <b>texto de folha</b>\n</a>').filhos[0]!.filhos[0]!.texto, 'texto de folha');
});

const FASE1 = readFileSync(join(FIXTURES, 'processoFase1.process'), 'latin1');

/** Entidades de um filho da raiz, indexadas por um campo (caminho separado por ponto). */
function porCampo(filho: No, ...caminho: string[]): Map<string, No> {
  return new Map(filho.filhos.map((e) => [texto(e, ...caminho), e]));
}

const nomes = (no: No): string[] => no.filhos.map((f) => f.nome);

test('gateway exclusivo: estado automático e condições por regra e por expressão', () => {
  const filhos = filhosDaRaiz(converterDiagrama(FASE1, { companyId: 1 }).xml);
  const gateway = porCampo(filhos[2]!, 'processStatePK', 'sequence').get('7')!;
  assert.deepEqual(nomes(gateway), [
    'processStatePK', 'stateName', 'stateDescription', 'joint', 'initialState', 'transferAttachments',
    'subProcessId', 'formFolder', 'automatic', 'positionX', 'positionY', 'inhibitTransfer', 'stateType',
    'bpmnType', 'signalId', 'openInstances', 'destinationStates', 'digitalSignature',
  ]);
  assert.equal(texto(gateway, 'stateType'), '1');
  assert.equal(texto(gateway, 'automatic'), 'true');

  const condicoes = porCampo(filhos[3]!, 'conditionProcessStatePK', 'expressionOrder');
  const porRegra = condicoes.get('1')!;
  assert.equal(texto(porRegra, 'conditionProcessStatePK', 'version'), '2', 'PK da condição leva a versão do .process');
  assert.equal(texto(porRegra, 'conditionProcessStatePK', 'sequence'), '7');
  assert.equal(texto(porRegra, 'condition'), 'false');
  assert.equal(texto(porRegra, 'destinationSequenceId'), '8');
  assert.equal(texto(porRegra, 'conditionType'), '1');

  const porExpressao = condicoes.get('2')!;
  assert.equal(texto(porExpressao, 'condition'), 'hAPI.getCardValue("aprovado") != "sim"');
  assert.equal(texto(porExpressao, 'destinationSequenceId'), '10');
  assert.equal(texto(porExpressao, 'conditionType'), '0');

  const regras = filhos[19]!.filhos;
  assert.equal(regras.length, 1, 'só a condição por regra tem regra');
  assert.deepEqual(
    regras[0]!.filhos.map((f) => `${f.nome}=${f.texto}`),
    ['sequence=7', 'expressionOrder=1', 'ruleOrder=1', 'field=aprovado', 'value=sim', 'operator=1', 'valueType=1'],
  );
});

test('o sequence da regra é o do gateway, não o que o blob guarda', () => {
  const blobVelho = FASE1.replace('&lt;sequence>7&lt;/sequence>', '&lt;sequence>0&lt;/sequence>');
  assert.notEqual(blobVelho, FASE1);
  const regra = filhosDaRaiz(converterDiagrama(blobVelho, { companyId: 1 }).xml)[19]!.filhos[0]!;
  assert.equal(texto(regra, 'sequence'), '7');
});

test('paralelo e join viram stateType 3 e 4, sem condição', () => {
  const filhos = filhosDaRaiz(converterDiagrama(FASE1, { companyId: 1 }).xml);
  const estados = porCampo(filhos[2]!, 'processStatePK', 'sequence');
  for (const [sequencia, tipo] of [['10', '3'], ['13', '4']] as const) {
    assert.equal(texto(estados.get(sequencia)!, 'stateType'), tipo);
    assert.equal(texto(estados.get(sequencia)!, 'automatic'), 'false');
  }
  assert.deepEqual([...porCampo(filhos[3]!, 'conditionProcessStatePK', 'sequence').keys()], ['7']);
});

test('temporizador: evento automático e gatilho com runType numérico', () => {
  const filhos = filhosDaRaiz(converterDiagrama(FASE1, { companyId: 1 }).xml);
  const timer = porCampo(filhos[2]!, 'processStatePK', 'sequence').get('14')!;
  assert.equal(texto(timer, 'stateType'), '0');
  assert.equal(texto(timer, 'automatic'), 'true');
  assert.equal(texto(timer, 'instruction'), 'Evento intermediário do processo');
  assert.equal(texto(timer, 'parentSequence'), '0');

  const gatilhos = filhos[12]!.filhos;
  assert.equal(gatilhos.length, 1);
  assert.deepEqual(
    gatilhos[0]!.filhos.slice(1).map((f) => `${f.nome}=${f.texto}`),
    ['runType=1', 'type=2', 'timeTrigger=8:30:0', 'frequencia=02'],
  );
  assert.equal(texto(gatilhos[0]!, 'processStateTriggerPK', 'version'), '2');
  assert.equal(texto(gatilhos[0]!, 'processStateTriggerPK', 'stateSequence'), '14');
  assert.equal(texto(gatilhos[0]!, 'processStateTriggerPK', 'triggerSequence'), '0');
});

test('tarefa de serviço: executionType e ProcessStateService; o erro anexado aponta para ela', () => {
  const filhos = filhosDaRaiz(converterDiagrama(FASE1, { companyId: 1 }).xml);
  const estados = porCampo(filhos[2]!, 'processStatePK', 'sequence');
  assert.equal(texto(estados.get('5')!, 'executionType'), '1');
  assert.equal(texto(estados.get('6')!, 'bpmnType'), '43');
  assert.equal(texto(estados.get('6')!, 'parentSequence'), '5');
  assert.equal(texto(estados.get('6')!, 'automatic'), 'false');

  const servicos = filhos[15]!.filhos;
  assert.equal(servicos.length, 1);
  assert.deepEqual(
    servicos[0]!.filhos.map((f) => `${f.nome}=${f.texto}`),
    [
      'companyId=1', 'processId=processoFase1', 'version=1', 'sequence=5', 'attempts=3',
      'sucessFullMessage=Integração executada com sucesso', 'serviceName=', 'frequency=1', 'frequencyType=0',
    ],
  );
});

test('evento de erro que não bate com a tarefa de serviço é recusado com código 6', () => {
  const erro = erroDe(() => converterDiagrama(FASE1.replace('sequenceAttached="5"', 'sequenceAttached="9"'), { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /evento de erro intermediateerror6 sem vínculo coerente/);
});

test('anotação vira ProcessComponGraf e o fluxo dela, ProcessLinkAssoc — não ProcessLink', () => {
  const filhos = filhosDaRaiz(converterDiagrama(FASE1, { companyId: 1 }).xml);
  const anotacao = filhos[9]!.filhos[0]!;
  assert.equal(texto(anotacao, 'componType'), '1');
  assert.equal(texto(anotacao, 'processComponGrafPK', 'componGrafSequence'), '16');
  assert.equal(texto(anotacao, 'stateName'), 'Confira antes');
  assert.equal(texto(anotacao, 'positionX'), '420');

  const associacao = filhos[10]!.filhos[0]!;
  assert.equal(texto(associacao, 'processLinkAssocPK', 'linkSequence'), '32');
  assert.equal(texto(associacao, 'initialStateSequence'), '16');
  assert.equal(texto(associacao, 'finalStateSequence'), '8');
  assert.ok(!porCampo(filhos[4]!, 'processLinkPK', 'linkSequence').has('32'));
});

test('movementTitle/Description/AccessLinkDescription saem no ProcessLink, vazios ou preenchidos', () => {
  const links = porCampo(filhosDaRaiz(converterDiagrama(FASE1, { companyId: 1 }).xml)[4]!, 'processLinkPK', 'linkSequence');
  assert.deepEqual(nomes(links.get('21')!).slice(-4), ['type', 'movementTitle', 'movementDescription', 'movementAccessLinkDescription']);
  assert.equal(texto(links.get('21')!, 'movementTitle'), '');
  assert.equal(nomes(links.get('22')!).at(-1), 'type', 'sem os atributos, o link não leva os campos');

  // Preenchido vai como está (9 pares do fluigproduza: "Solicitação @[request:id] movimentada.").
  const preenchido = FASE1.replace('movementTitle=""', 'movementTitle="Solicita&#xe7;&#xe3;o @[request:id] enviada"');
  const comTexto = porCampo(filhosDaRaiz(converterDiagrama(preenchido, { companyId: 1 }).xml)[4]!, 'processLinkPK', 'linkSequence');
  assert.equal(texto(comTexto.get('21')!, 'movementTitle'), 'Solicitação @[request:id] enviada');
});

test('consenso e atividadeConjunta no início viram agreementPercentage e joint, como na tarefa', () => {
  const comConsenso = PROCESSO.replace('<bpmn2:BpmnStartEvent id="startevent4"', '<bpmn2:BpmnStartEvent consenso="100" id="startevent4"');
  assert.notEqual(comConsenso, PROCESSO);
  const inicio = filhosDaRaiz(converterDiagrama(comConsenso, { companyId: 1 }).xml)[2]!.filhos
    .find((e) => texto(e, 'processStatePK', 'sequence') === '4')!;
  assert.equal(texto(inicio, 'agreementPercentage'), '100');
  assert.equal(texto(inicio, 'joint'), 'false');
});

test('bpmnVersion vem de quem chama (o processo no destino); sem ele, 2', () => {
  assert.equal(texto(filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 1 }).xml)[1]!, 'bpmnVersion'), '2');
  assert.equal(texto(filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 1, bpmnVersion: 1 }).xml)[1]!, 'bpmnVersion'), '1');
});

test('extendedFields do processo vira AdvancedProcessProperties (7) e ExtendedPropertyField (13)', () => {
  const blob = '<list>\n  <org.eclipse.bpmn2.impl.ExtendedPropertyImpl>\n    <propertyName>AutomaticTasks</propertyName>\n' +
    '    <propertyType>0</propertyType>\n    <propertyDescription>AutomaticTasks</propertyDescription>\n' +
    '    <propertyValue>4</propertyValue>\n    <isDefaultProperty>false</isDefaultProperty>\n  </org.eclipse.bpmn2.impl.ExtendedPropertyImpl>\n</list>';
  // O fixture já tem extendedFields="<list/>" no processo: troca o valor.
  const comExt = PROCESSO.replace(/(<bpmn2:BpmnProcess [^\n]*?)extendedFields="[^"]*"/, `$1extendedFields="${comoAtributo(blob)}"`);
  assert.notEqual(comExt, PROCESSO);
  const filhos = filhosDaRaiz(converterDiagrama(comExt, { companyId: 3 }).xml);

  const avancada = filhos[7]!.filhos[0]!;
  assert.equal(avancada.nome, 'AdvancedProcessProperties');
  assert.deepEqual(avancada.filhos[0]!.filhos.map((f) => [f.nome, f.texto]), [
    ['companyId', '3'], ['processId', 'processoTeste'], ['propertyId', 'AutomaticTasks'], ['version', '3'],
  ]);
  assert.equal(texto(avancada, 'propertieValue'), '4');

  const estendida = filhos[13]!.filhos[0]!;
  assert.deepEqual(estendida.filhos.map((f) => f.nome), [
    'extendedPropertyFieldPK', 'propertyType', 'propertyDescription', 'propertyValue', 'isDefaultProperty',
  ]);
  assert.deepEqual(estendida.filhos[0]!.filhos.map((f) => f.texto), ['3', 'processoTeste', '3', '0', 'AutomaticTasks']);

  // Duas propriedades, outro tipo, ou em outro objeto: nunca conferido, recusa.
  const duas = blob.replace('</list>', blob.slice(blob.indexOf('  <org'), blob.lastIndexOf('</list>')) + '</list>');
  for (const [x, motivo] of [
    [comExt.replace(comoAtributo(blob), comoAtributo(duas)), /2 propriedades/],
    [comExt.replace(comoAtributo(blob), comoAtributo(blob.replace('<propertyType>0', '<propertyType>1'))), /propertyType 1/],
    [PROCESSO.replace(/(<bpmn2:BpmnTask id="task5"[^\n]*?)extendedFields="[^"]*"/, `$1extendedFields="${comoAtributo(blob)}"`), /extendedFields\) em task5/],
  ] as [string, RegExp][]) {
    const erro = erroDe(() => converterDiagrama(x, { companyId: 1 }));
    assert.equal(erro.codigo, 6);
    assert.match(erro.message, motivo);
  }
});

test('valor sem mapeamento conferido continua recusado com código 6', () => {
  const casos: [string, RegExp][] = [
    [FASE1.replace('&lt;runType>HOUR', '&lt;runType>WEEK'), /gatilho não suportado em intermediatetimer14/],
    [FASE1.replace('type="126"', 'type="121"'), /BpmnGateway \(type 121\)/],
    [
      FASE1.replace('<bpmn2:BpmnEndEvent', '<bpmn2:BpmnIntermediateEvent id="intermediatelink40" name="L" type="44" sequenceAttached="0" signalId="0"/>\n  <bpmn2:BpmnEndEvent'),
      /BpmnIntermediateEvent \(type 44\)/,
    ],
    [
      FASE1.replace('&lt;targetTask>task8&lt;/targetTask>', '&lt;targetTask>task8&lt;/targetTask>&#xA;    &lt;mechanism>Usu&#xe1;rio&lt;/mechanism>'),
      /atribuição Usuário na condição 1 de exclusivegateway7/,
    ],
    [FASE1.replace('scriptFileName="processoFase1.servicetask5.js"', 'scriptFileName="outro.servicetask5.js"'), /scriptFileName "outro.servicetask5.js"/],
  ];
  for (const [diagrama, motivo] of casos) {
    assert.notEqual(diagrama, FASE1);
    const erro = erroDe(() => converterDiagrama(diagrama, { companyId: 1 }));
    assert.equal(erro.codigo, 6, String(motivo));
    assert.match(erro.message, motivo);
  }
});

test('scripts viram WorkflowProcessEvent por eventId, codificados como no aplicarScripts', () => {
  const scripts = new Map([
    ['servicetask5', 'function servicetask5() {\r\n  return "a" < "b — c";\r\n}\r\n'],
    ['afterProcessCreate', 'function afterProcessCreate() {}'],
  ]);
  const r = converterDiagrama(FASE1, { companyId: 3, scripts });
  const eventos = filhosDaRaiz(r.xml)[6]!.filhos;
  assert.deepEqual(eventos.map((e) => texto(e, 'workflowProcessEventPK', 'eventId')), ['afterProcessCreate', 'servicetask5']);
  assert.deepEqual(
    eventos[1]!.filhos[0]!.filhos.map((f) => `${f.nome}=${f.texto}`),
    ['companyId=3', 'eventId=servicetask5', 'processId=processoFase1', 'version=1'],
  );
  assert.equal(texto(eventos[1]!, 'eventDescription'), 'function servicetask5() {\n  return "a" < "b — c";\n}\n');
  assert.match(r.xml, /return &quot;a&quot; &lt; &quot;b &#8212; c&quot;;/, 'fora do latin1 vira referência numérica');
  assert.equal(r.contagens.eventos, 2);
  assert.deepEqual(r.avisos, []);

  const semServico = converterDiagrama(FASE1, { companyId: 3, scripts: new Map([['afterProcessCreate', 'x']]) });
  assert.match(semServico.avisos.join('\n'), /servicetask5 não tem script local/);
});

test('dry-run lê os scripts de workflow/scripts ao lado de workflow/diagrams; sem a pasta, avisa', async () => {
  const workflow = join(mkdtempSync(join(tmpdir(), 'fluigctl-fase1-')), 'workflow');
  mkdirSync(join(workflow, 'diagrams'), { recursive: true });
  const arquivo = join(workflow, 'diagrams', 'processoFase1.process');
  writeFileSync(arquivo, FASE1, 'latin1');

  const semPasta = await pushDiagram({ server: SERVER, arquivo, dryRun: true });
  assert.equal(filhosDaRaiz(semPasta.xml)[6]!.filhos.length, 0);
  assert.match(semPasta.avisos.join('\n'), /pasta de scripts não encontrada.*sai sem os scripts/);

  mkdirSync(join(workflow, 'scripts'));
  writeFileSync(join(workflow, 'scripts', 'processoFase1.servicetask5.js'), 'function servicetask5() {}\n');
  writeFileSync(join(workflow, 'scripts', 'outroProcesso.beforeStateEntry.js'), 'function beforeStateEntry() {}\n');
  const comPasta = await pushDiagram({ server: SERVER, arquivo, dryRun: true });
  assert.deepEqual(
    filhosDaRaiz(comPasta.xml)[6]!.filhos.map((e) => texto(e, 'workflowProcessEventPK', 'eventId')),
    ['servicetask5'],
  );
  // Sem o .processimage.svg do Studio ao lado, a imagem é gerada — o único aviso que sobra.
  assert.deepEqual(comPasta.avisos.filter((a) => !/processimage\.svg/.test(a)), []);
});

test('regra ou condição que geraria campo inválido ou PK repetida é recusada com código 6', () => {
  const regras = /&lt;rules>([\s\S]*?)&lt;\/rules>/.exec(FASE1)![1]!;
  const casos: [string, RegExp][] = [
    [FASE1.replace('&lt;operator>1&lt;/operator>', '&lt;operator>EQ&lt;/operator>'), /regra de condição não suportada em exclusivegateway7/],
    [FASE1.replace('&lt;valueType>1&lt;/valueType>', '&lt;valueType>&lt;/valueType>'), /regra de condição não suportada em exclusivegateway7/],
    [FASE1.replace(/&#xA;\s*&lt;field>aprovado&lt;\/field>/, ''), /regra de condição não suportada em exclusivegateway7/],
    [FASE1.replace('&lt;order>2&lt;/order>', '&lt;order>1&lt;/order>'), /condição com order 1 repetido em exclusivegateway7/],
    [FASE1.replace(regras, regras + regras), /regra com ruleOrder 1 repetido na condição 1 de exclusivegateway7/],
    [FASE1.replace('&lt;targetTask>task8&lt;', '&lt;targetTask>bpmnswimlane2&lt;'), /condição 1 de exclusivegateway7 incompleta ou para destino não suportado/],
    [FASE1.replace('&lt;targetTask>task8&lt;', '&lt;targetTask>task11&lt;'), /condição 1 de exclusivegateway7 aponta para task11, sem fluxo do gateway até lá/],
  ];
  for (const [diagrama, motivo] of casos) {
    assert.notEqual(diagrama, FASE1, String(motivo));
    const erro = erroDe(() => converterDiagrama(diagrama, { companyId: 1 }));
    assert.equal(erro.codigo, 6, String(motivo));
    assert.match(erro.message, motivo);
  }
});

test('fluxo ou associação com pool ou lane numa das pontas é recusado com código 6', () => {
  const casos: [string, RegExp][] = [
    [FASE1.replace('sourceRef="task8" targetRef="endevent15"', 'sourceRef="task8" targetRef="bpmnpool1"'), /fluxo flow30 ligado a elemento não suportado/],
    [FASE1.replace('sourceRef="startevent4" targetRef="servicetask5"', 'sourceRef="bpmnswimlane2" targetRef="servicetask5"'), /fluxo flow20 ligado a elemento não suportado/],
    [FASE1.replace('sourceRef="annotationtask16" targetRef="task8"', 'sourceRef="annotationtask16" targetRef="bpmnpool1"'), /fluxo flow32 ligado a elemento não suportado/],
    [FASE1.replace('sourceRef="annotationtask16" targetRef="task8"', 'sourceRef="task8" targetRef="annotationtask16"'), /fluxo flow32 ligado a elemento não suportado/],
  ];
  for (const [diagrama, motivo] of casos) {
    assert.notEqual(diagrama, FASE1, String(motivo));
    const erro = erroDe(() => converterDiagrama(diagrama, { companyId: 1 }));
    assert.equal(erro.codigo, 6, String(motivo));
    assert.match(erro.message, motivo);
  }
});

test('script com caractere de controle fora de tab, LF e CR é recusado com código 6', () => {
  const scripts = new Map([['servicetask5', 'var a = "\u0001";\n']]);
  const erro = erroDe(() => converterDiagrama(FASE1, { companyId: 1, scripts }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /script servicetask5 com caractere de controle U\+0001/);
  assert.doesNotThrow(() => converterDiagrama(FASE1, { companyId: 1, scripts: new Map([['servicetask5', 'a\tb\r\nc']]) }));
});

/** Diagrama sintético de eventos de link: pool, lane, nós com forma e fluxos. */
function diagramaDeLink(nos: [tipo: string, id: string, attrs: string][], fluxos: [id: string, de: string, para: string][]): string {
  const forma = (id: string, x: number, y: number, dentro = '') =>
    `    <children xsi:type="pi:ContainerShape" visible="true" active="true">\n` +
    `      <graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="40" height="40" x="${x}" y="${y}"/>\n` +
    `      <link businessObjects="${id}"/>\n${dentro}    </children>\n`;
  const extra = 'extendedFields="&lt;list/>"';
  return [
    FASE1.split('\n').slice(0, 2).join('\n'),
    '  <pi:Diagram visible="true" gridUnit="10" diagramTypeId="BPMNdiagram" name="processoLink" snapToGrid="true" version="0.16.0">',
    '    <graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="1000" height="1000"/>',
    forma('bpmnpool1', 10, 10, forma('bpmnswimlane2', 30, 0)).trimEnd(),
    ...nos.map(([, id], i) => forma(id, 100 + i * 50, 50).trimEnd()),
    '  </pi:Diagram>',
    '  <bpmn2:BpmnPool id="bpmnpool1" name="Link" cores="FFFFFF"/>',
    '  <bpmn2:BpmnSwimLane id="bpmnswimlane2" name="Todos"/>',
    ...nos.map(([tipo, id, attrs]) => `  <bpmn2:${tipo} id="${id}" name="${id}" ${extra} ${attrs}/>`),
    '  <bpmn2:BpmnProcess id="processoLink" name="Processo Link" version="1" cardIndex="99" extendedFields="&lt;list/>"/>',
    ...fluxos.map(([id, de, para]) => `  <bpmn2:SequenceFlow id="${id}" name="" sourceRef="${de}" targetRef="${para}" atividadeFluxo="" atividadeRetorno="" ${extra}/>`),
    '</xmi:XMI>',
  ].join('\n');
}

const INICIO: [string, string, string] = ['BpmnStartEvent', 'startevent1', 'type="10" signalId="0"'];
const TAREFA = (id: string): [string, string, string] => ['BpmnTask', id, 'type="80" loopType="0" authNotify="true" esforcoCalculo="0"'];
const FIM: [string, string, string] = ['BpmnEndEvent', 'endevent8', 'type="60" signalId="0"'];
const LANCA = (id: string, alvo: string): [string, string, string] =>
  ['BpmnIntermediateEvent', id, `type="36" sequenceAttached="0" signalId="0"${alvo ? ` linkId="${alvo}"` : ''}`];
const CAPTURA = (id: string): [string, string, string] =>
  ['BpmnIntermediateEvent', id, 'type="42" sequenceAttached="0" signalId="0"'];

/** Um lançamento (3) com um fluxo de entrada, um recebimento (4). */
const LINK_SIMPLES = diagramaDeLink(
  [INICIO, TAREFA('task2'), LANCA('intermediatelink3', 'intermediatelinkreceive4'), CAPTURA('intermediatelinkreceive4'), ['BpmnEndEvent', 'endevent5', 'type="60" signalId="0"']],
  [['flow10', 'startevent1', 'task2'], ['flow11', 'task2', 'intermediatelink3'], ['flow12', 'intermediatelinkreceive4', 'endevent5']],
);

/** Dois lançamentos (5 e 6) para o mesmo recebimento (7); o 5 tem dois fluxos de entrada. */
const LINK_VARIOS = diagramaDeLink(
  [
    INICIO, TAREFA('task2'), TAREFA('task3'), TAREFA('task4'),
    LANCA('intermediatelink5', 'intermediatelinkreceive7'), LANCA('intermediatelink6', 'intermediatelinkreceive7'),
    CAPTURA('intermediatelinkreceive7'), FIM,
  ],
  [
    ['flow20', 'startevent1', 'task2'], ['flow21', 'task2', 'task3'], ['flow22', 'task2', 'intermediatelink6'],
    ['flow23', 'task3', 'task4'], ['flow24', 'task3', 'intermediatelink5'], ['flow30', 'task4', 'intermediatelink5'],
    ['flow40', 'intermediatelinkreceive7', 'endevent8'],
  ],
);

const linksDe = (xml: string) =>
  filhosDaRaiz(xml)[4]!.filhos.map((l) => [
    texto(l, 'processLinkPK', 'linkSequence'), texto(l, 'initialStateSequence'), texto(l, 'finalStateSequence'),
  ].join(':'));

test('evento de link: o fluxo que chega no 36 vira um ProcessLink do 36 ao 42, sem name', () => {
  const r = converterDiagrama(LINK_SIMPLES, { companyId: 1 });
  assert.deepEqual(linksDe(r.xml), ['10:1:2', '11:2:3', '12:4:5', '13:3:4']);
  assert.equal(r.contagens.links, 4);
  const sintetico = filhosDaRaiz(r.xml)[4]!.filhos.find((l) => texto(l, 'processLinkPK', 'linkSequence') === '13')!;
  assert.deepEqual(
    sintetico.filhos.map((f) => f.nome),
    ['processLinkPK', 'actionLabel', 'returnPermited', 'initialStateSequence', 'finalStateSequence', 'returnLabel', 'automaticLink', 'defaultLink', 'type'],
  );
  assert.equal(texto(sintetico, 'processLinkPK', 'version'), '1');
  assert.equal(texto(sintetico, 'returnPermited'), 'false');
  assert.equal(texto(sintetico, 'type'), '0');
  const estados = porCampo(filhosDaRaiz(r.xml)[2]!, 'processStatePK', 'sequence');
  for (const [seq, tipo] of [['3', '36'], ['4', '42']] as const) {
    assert.equal(texto(estados.get(seq)!, 'bpmnType'), tipo);
    assert.equal(texto(estados.get(seq)!, 'stateType'), '0');
    assert.equal(texto(estados.get(seq)!, 'instruction'), 'Evento intermediário do processo');
    assert.equal(texto(estados.get(seq)!, 'signalId'), '0');
    assert.equal(texto(estados.get(seq)!, 'parentSequence'), '0');
    assert.equal(texto(estados.get(seq)!, 'initialState'), 'false');
  }
});

test('evento de link: um link por fluxo de entrada, em ordem do sufixo do fluxo, com sequence max+1, max+2...', () => {
  const links = linksDe(converterDiagrama(LINK_VARIOS, { companyId: 1 }).xml);
  // Maior sufixo do arquivo: flow40. A ordem é a do fluxo de entrada (22, 24, 30), não a do lançamento (6, 5, 5).
  assert.deepEqual(links.slice(-3), ['41:6:7', '42:5:7', '43:5:7']);
  assert.equal(links.length, 7 + 3);
});

test('evento de link recusado: sem linkId, linkId que não resolve, linkId fora de um 36, saída do 36, 42 órfão', () => {
  const casos: [string, RegExp][] = [
    [LINK_SIMPLES.replace(' linkId="intermediatelinkreceive4"', ''), /evento de link intermediatelink3 sem um único recebimento/],
    [LINK_SIMPLES.replace('linkId="intermediatelinkreceive4"', 'linkId="intermediatelinkreceive9"'), /evento de link intermediatelink3 sem um único recebimento/],
    [LINK_SIMPLES.replace('linkId="intermediatelinkreceive4"', 'linkId="task2"'), /evento de link intermediatelink3 sem um único recebimento/],
    [LINK_SIMPLES.replace('type="42" sequenceAttached="0"', 'type="42" linkId="task2" sequenceAttached="0"'), /intermediatelinkreceive4 anexado a outro elemento/],
    [
      LINK_SIMPLES.replace('</xmi:XMI>', '  <bpmn2:SequenceFlow id="flow13" name="" sourceRef="intermediatelink3" targetRef="endevent5" atividadeFluxo="" atividadeRetorno="" extendedFields="&lt;list/>"/>\n</xmi:XMI>'),
      /evento de link intermediatelink3 \(36\) com fluxo de saída/,
    ],
    [
      LINK_SIMPLES.replace('</xmi:XMI>', '  <bpmn2:SequenceFlow id="flow13" name="" sourceRef="task2" targetRef="intermediatelinkreceive4" atividadeFluxo="" atividadeRetorno="" extendedFields="&lt;list/>"/>\n</xmi:XMI>'),
      /evento de link intermediatelinkreceive4 \(42\) com fluxo de entrada/,
    ],
    [LINK_SIMPLES.replace('linkId="intermediatelinkreceive4"', 'linkId=""'), /sem um único recebimento/],
    [
      diagramaDeLink(
        [INICIO, CAPTURA('intermediatelinkreceive4'), ['BpmnEndEvent', 'endevent5', 'type="60" signalId="0"']],
        [['flow10', 'startevent1', 'endevent5'], ['flow12', 'intermediatelinkreceive4', 'endevent5']],
      ),
      /evento de link intermediatelinkreceive4 \(42\) sem nenhum 36 apontando/,
    ],
  ];
  for (const [diagrama, motivo] of casos) {
    assert.notEqual(diagrama, LINK_SIMPLES);
    const erro = erroDe(() => converterDiagrama(diagrama, { companyId: 1 }));
    assert.equal(erro.codigo, 6, String(motivo));
    assert.match(erro.message, motivo);
  }
});

/** Põe um blob XStream num atributo do `.process`. */
const comoAtributo = (blob: string) => blob.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xA;');

const CAMPO_FORM = (id: string, label: string, cardIndex = '') =>
  `  <org.eclipse.bpmn2.impl.BpmnProcessFormField>\n    <id>${id}</id>\n    <label>${label}</label>\n    <cardIndex>${cardIndex}</cardIndex>\n  </org.eclipse.bpmn2.impl.BpmnProcessFormField>`;
const DESCRITORES = (...campos: string[]) => `<list>\n${campos.join('\n')}\n</list>`;

const CAMPO_APP = (campo: string, descricao: string) =>
  `      <org.eclipse.bpmn2.documentacional.BpmnProcessAppConfiguration>\n        <appField>${campo}</appField>\n        <description>${descricao}</description>\n      </org.eclipse.bpmn2.documentacional.BpmnProcessAppConfiguration>`;
const APPS = (...campos: string[]) =>
  `<map>\n  <entry>\n    <string>approval</string>\n    <list>\n${campos.join('\n')}\n    </list>\n  </entry>\n</map>`;

const comDescritores = (blob: string) =>
  PROCESSO.replace('<bpmn2:BpmnProcess id="processoTeste"', `<bpmn2:BpmnProcess descriptorFields="${comoAtributo(blob)}" id="processoTeste"`);
const comApps = (tarefa: string, blob: string) =>
  PROCESSO.replace(`<bpmn2:BpmnTask id="${tarefa}"`, `<bpmn2:BpmnTask appsConfiguration="${comoAtributo(blob)}" id="${tarefa}"`);

test('descriptorFields: um ProcessFormField por campo, slotId de 1 na ordem do blob, sem versão na PK', () => {
  const blob = DESCRITORES(CAMPO_FORM('valor', 'Valor total'), CAMPO_FORM('periodo', 'Per&#xed;odo &amp; ano', '7 - formTeste'), CAMPO_FORM('contrato', 'Contrato'));
  const campos = filhosDaRaiz(converterDiagrama(comDescritores(blob), { companyId: 5 }).xml)[14]!.filhos;
  assert.deepEqual(campos.map((c) => c.nome), ['ProcessFormField', 'ProcessFormField', 'ProcessFormField']);
  assert.deepEqual(campos.map((c) => texto(c, 'processFormFieldPK', 'fieldId')), ['valor', 'periodo', 'contrato']);
  assert.deepEqual(campos.map((c) => texto(c, 'slotId')), ['1', '2', '3']);
  assert.equal(texto(campos[0]!, 'processFormFieldPK', 'companyId'), '5');
  assert.equal(texto(campos[0]!, 'processFormFieldPK', 'processId'), 'processoTeste');
  assert.equal(texto(campos[0]!, 'processFormFieldPK', 'version'), '<ausente>');
  assert.equal(texto(campos[1]!, 'fieldDescription'), 'Período & ano');
  assert.deepEqual(campos[0]!.filhos.map((f) => f.nome), ['processFormFieldPK', 'fieldDescription', 'slotId']);
  assert.deepEqual(campos[0]!.filhos[0]!.filhos.map((f) => f.nome), ['companyId', 'processId', 'fieldId']);
});

test('descriptorFields e appsConfiguration vazios ou ausentes deixam os filhos 14 e 17 vazios', () => {
  for (const xml of [
    converterDiagrama(PROCESSO, { companyId: 1 }).xml,
    converterDiagrama(PROCESSO.replace('<bpmn2:BpmnProcess id=', '<bpmn2:BpmnProcess descriptorFields="" id='), { companyId: 1 }).xml,
    converterDiagrama(PROCESSO.replace('<bpmn2:BpmnTask id="task5"', '<bpmn2:BpmnTask appsConfiguration="" id="task5"'), { companyId: 1 }).xml,
  ]) {
    const filhos = filhosDaRaiz(xml);
    assert.equal(filhos[14]!.filhos.length, 0);
    assert.equal(filhos[17]!.filhos.length, 0);
  }
});

test('appsConfiguration: uma linha por campo e por tarefa, com a versão do .process e o sequence da tarefa', () => {
  // approve/reject nomeiam estados do diagrama (185/185 nos .process medidos): aqui 7 e 6.
  // reject "null" literal: o Studio copia como está (conferido no HML).
  const blob = APPS(CAMPO_APP('title', ''), CAMPO_APP('description', '@[form:descr] &amp; mais'), CAMPO_APP('approve', '7'), CAMPO_APP('reject', 'null'));
  const outro = APPS(CAMPO_APP('highlight', '@[form:valor]'), CAMPO_APP('approve', '6'));
  const xml = comApps('task7', outro).replace('<bpmn2:BpmnTask id="task5"', `<bpmn2:BpmnTask appsConfiguration="${comoAtributo(blob)}" id="task5"`);
  const linhas = filhosDaRaiz(converterDiagrama(xml, { companyId: 1 }).xml)[17]!.filhos;
  assert.deepEqual(
    linhas.map((l) => [texto(l, 'stateSequence'), texto(l, 'appField'), texto(l, 'description')].join('|')),
    ['5|title|', '5|description|@[form:descr] & mais', '5|approve|7', '5|reject|null', '7|highlight|@[form:valor]', '7|approve|6'],
  );
  assert.deepEqual(linhas[0]!.filhos.map((f) => f.nome), [
    'id', 'tenantId', 'processId', 'processVersion', 'stateSequence', 'appKey', 'appField', 'description',
  ]);
  for (const l of linhas) {
    assert.equal(texto(l, 'id'), '0');
    assert.equal(texto(l, 'tenantId'), '0');
    assert.equal(texto(l, 'processId'), 'processoTeste');
    assert.equal(texto(l, 'processVersion'), '3');
    assert.equal(texto(l, 'appKey'), 'approval');
  }
});

test('descriptorFields fora da forma conferida é recusado com código 6, sem XML parcial', () => {
  const campo = CAMPO_FORM('valor', 'Valor');
  const casos: [string, RegExp][] = [
    [`<list>\n  <org.eclipse.bpmn2.impl.BpmnProcessOutraCoisa>\n    <id>a</id>\n  </org.eclipse.bpmn2.impl.BpmnProcessOutraCoisa>\n</list>`, /descriptorFields com org\.eclipse\.bpmn2\.impl\.BpmnProcessOutraCoisa/],
    [DESCRITORES(campo.replace('</cardIndex>', '</cardIndex>\n    <tipo>x</tipo>')), /descriptorFields com campo tipo/],
    [DESCRITORES(campo.replace(/<label>.*<\/label>\n/, '')), /sem id ou sem label/],
    [DESCRITORES(campo.replace('<label>Valor</label>', '<label><b>Valor</b></label>')), /descriptorFields com campo fora da forma/],
    [DESCRITORES(campo, CAMPO_FORM('valor', 'Outro')), /id valor repetido/],
    ['<list/>', /sem nenhum campo/],
    ['<map>\n</map>', /descriptorFields ilegível/],
    ['<list>\n  <org.eclipse.bpmn2.impl.BpmnProcessFormField>\n', /descriptorFields ilegível/],
  ];
  for (const [blob, motivo] of casos) {
    const erro = erroDe(() => converterDiagrama(comDescritores(blob), { companyId: 1 }));
    assert.equal(erro.codigo, 6, blob);
    assert.match(erro.message, motivo);
  }
  // Em outro objeto que não o processo, o atributo também não é aceito.
  const naTarefa = PROCESSO.replace('<bpmn2:BpmnTask id="task5"', `<bpmn2:BpmnTask descriptorFields="${comoAtributo(DESCRITORES(campo))}" id="task5"`);
  const erro = erroDe(() => converterDiagrama(naTarefa, { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /atributo descriptorFields em task5/);
});

test('appsConfiguration fora da forma conferida é recusado com código 6, sem XML parcial', () => {
  const ok = CAMPO_APP('approve', '7');
  const classe = 'org.eclipse.bpmn2.documentacional.BpmnProcessAppConfiguration';
  const casos: [string, RegExp][] = [
    [APPS(CAMPO_APP('outro', 'x')), /appField "outro"/],
    [APPS(ok.replace('</description>', '</description>\n        <extra>1</extra>')), /campo extra/],
    [APPS(ok).replace(classe + '>\n        <appField', 'com.exemplo.Outra>\n        <appField').replace(`</${classe}>`, '</com.exemplo.Outra>'), /appsConfiguration com com\.exemplo\.Outra/],
    [APPS(ok).replace('<string>approval</string>', '<string>outro</string>'), /appKey "outro"/],
    [APPS(CAMPO_APP('approve', 'abc')), /approve não numérico/],
    [APPS(ok, CAMPO_APP('approve', '6')), /appField approve repetido/],
    [APPS(CAMPO_APP('reject', '125')), /reject 125, que não é um estado do diagrama/],
    [APPS(ok.replace(/\s*<description>.*<\/description>/, '')), /sem description em approve/],
    [APPS(), /sem nenhum campo/],
    [APPS(ok).replace('</entry>', '</entry>\n  <entry>\n    <string>approval</string>\n    <list/>\n  </entry>'), /fora da forma/],
    [APPS(ok).replace('<map>', '<map versao="1">'), /fora da forma/],
    ['<map>\n  <entry>\n', /fora da forma/],
  ];
  for (const [blob, motivo] of casos) {
    const erro = erroDe(() => converterDiagrama(comApps('task5', blob), { companyId: 1 }));
    assert.equal(erro.codigo, 6, blob);
    assert.match(erro.message, motivo);
    assert.match(erro.message, /task5/);
  }
  // Só a tarefa de usuário 80 foi conferida contra o Studio.
  const naTarefa81 = comApps('task5', APPS(ok)).replace(/(<bpmn2:BpmnTask appsConfiguration="[^"]*" id="task5"[^>]*?)type="80"/, '$1type="81"');
  assert.notEqual(naTarefa81, comApps('task5', APPS(ok)));
  const erro = erroDe(() => converterDiagrama(naTarefa81, { companyId: 1 }));
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /appsConfiguration em task5 \(type 81\)/);
});

/** Troca a atribuição da task7 por um blob "Associado" com os controladores dados. */
function comAssociado(tipo: string, ...controladores: string[]): string {
  const blob = `<org.eclipse.bpmn2.impl.AssignmentControllerAssociated>\n  <type>${tipo}</type>\n  <controllers class="list">\n` +
    controladores.join('\n') + `\n  </controllers>\n  <mechanismName>Associado</mechanismName>\n</org.eclipse.bpmn2.impl.AssignmentControllerAssociated>`;
  return PROCESSO.replace(
    /managerMechanism="Executor Atividade" managerAssignmentControllerString="[^"]*"/,
    `managerMechanism="Associado" managerAssignmentControllerString="${comoAtributo(blob)}"`,
  );
}
const GRUPO = (g: string) => `    <org.eclipse.bpmn2.impl.AssignmentControllerGroup>\n      <groupId>${g}</groupId>\n      <mechanismName>Grupo</mechanismName>\n    </org.eclipse.bpmn2.impl.AssignmentControllerGroup>`;
const PAPEL = (r: string) => `    <org.eclipse.bpmn2.impl.AssignmentControllerRole>\n      <roleId>${r}</roleId>\n      <mechanismName>Papel</mechanismName>\n    </org.eclipse.bpmn2.impl.AssignmentControllerRole>`;
const EXECUTOR = `    <org.eclipse.bpmn2.impl.AssignmentControllerExecutorMechanism>\n      <idNode>startevent4</idNode>\n      <returns>0</returns>\n      <mechanismName>Executor Atividade</mechanismName>\n    </org.eclipse.bpmn2.impl.AssignmentControllerExecutorMechanism>`;

const atribuicaoDaTask7 = (xml: string) => {
  const estado = filhosDaRaiz(xml)[2]!.filhos.find((e) => texto(e, 'processStatePK', 'sequence') === '7')!;
  return [texto(estado, 'engineAllocationId'), texto(estado, 'engineAllocationConfiguration')];
};

test('atribuição "Associado" vira AssociatedController com um ControlXML por controlador, como no Studio', () => {
  const r = converterDiagrama(comAssociado('AND', GRUPO('Fabricação Planta 1'), GRUPO('Fabricação Planta 2'), PAPEL('Gestor')), { companyId: 1 });
  assert.deepEqual(atribuicaoDaTask7(r.xml), [
    'Associado',
    '<AssociatedController ConditionAssociated="AND"><ControlXML TypeAssociated="Grupo"><AssignmentController><Group>Fabricação Planta 1</Group></AssignmentController></ControlXML>' +
      '<ControlXML TypeAssociated="Grupo"><AssignmentController><Group>Fabricação Planta 2</Group></AssignmentController></ControlXML>' +
      '<ControlXML TypeAssociated="Papel"><AssignmentController><Role>Gestor</Role></AssignmentController></ControlXML></AssociatedController>',
  ]);
  assert.deepEqual(r.avisos.filter((a) => /Associado/.test(a)), []);

  const executor = converterDiagrama(comAssociado('AND', EXECUTOR), { companyId: 1 });
  assert.equal(
    atribuicaoDaTask7(executor.xml)[1],
    '<AssociatedController ConditionAssociated="AND"><ControlXML TypeAssociated="Executor Atividade"><AssignmentController><BaseActivity>4</BaseActivity><Returns>First</Returns></AssignmentController></ControlXML></AssociatedController>',
  );
});

test('"Associado" com OR é aceito, mas avisa que nenhum par o confere', () => {
  const r = converterDiagrama(comAssociado('OR', PAPEL('Gestor')), { companyId: 1 });
  assert.match(atribuicaoDaTask7(r.xml)[1]!, /^<AssociatedController ConditionAssociated="OR">/);
  assert.match(r.avisos.join('\n'), /Associado" com OR.*task7/);
});

const GRUPOS_DE = (colega: string, so = 'false') =>
  `    <org.eclipse.bpmn2.impl.AssignmentControllerColleagueGroup>\n      <colleagueId>${colega}</colleagueId>\n` +
  `      <onlyWorkGroup>${so}</onlyWorkGroup>\n      <includeCommunityGroups>false</includeCommunityGroups>\n` +
  '      <mechanismName>Grupos Colaborador</mechanismName>\n    </org.eclipse.bpmn2.impl.AssignmentControllerColleagueGroup>';

test('"Grupos Colaborador" vira GroupsOf com OnlyWorkGroup e IncludeCommunityGroups ON/OFF', () => {
  const r = converterDiagrama(comAssociado('AND', GRUPOS_DE('fulano', 'true'), PAPEL('Gestor')), { companyId: 1 });
  assert.equal(
    atribuicaoDaTask7(r.xml)[1],
    '<AssociatedController ConditionAssociated="AND"><ControlXML TypeAssociated="Grupos Colaborador"><AssignmentController>' +
      '<GroupsOf>fulano</GroupsOf><OnlyWorkGroup>ON</OnlyWorkGroup><IncludeCommunityGroups>OFF</IncludeCommunityGroups>' +
      '</AssignmentController></ControlXML><ControlXML TypeAssociated="Papel"><AssignmentController><Role>Gestor</Role>' +
      '</AssignmentController></ControlXML></AssociatedController>',
  );
  const erro = erroDe(() => converterDiagrama(comAssociado('AND', GRUPOS_DE('fulano', 'sim')), { companyId: 1 }));
  assert.match(erro.message, /atribuição AssignmentControllerAssociated em task7/);
});

test('"Associado" com controlador não conferido, aninhado ou tipo desconhecido é recusado', () => {
  const colegaGrupo = `    <org.eclipse.bpmn2.impl.AssignmentControllerColleagueGroup>\n      <groupId>X</groupId>\n      <mechanismName>Colaborador do Grupo</mechanismName>\n    </org.eclipse.bpmn2.impl.AssignmentControllerColleagueGroup>`;
  const aninhado = `    <org.eclipse.bpmn2.impl.AssignmentControllerAssociated>\n      <type>AND</type>\n      <mechanismName>Associado</mechanismName>\n    </org.eclipse.bpmn2.impl.AssignmentControllerAssociated>`;
  for (const diagrama of [comAssociado('AND', colegaGrupo), comAssociado('AND', aninhado), comAssociado('XOR', PAPEL('Gestor')), comAssociado('AND')]) {
    const erro = erroDe(() => converterDiagrama(diagrama, { companyId: 1 }));
    assert.equal(erro.codigo, 6);
    assert.match(erro.message, /atribuição AssignmentControllerAssociated em task7/);
  }
});


/* ============================ Fase 3: publicar ============================ */

/** Servidor em memória: registra cada chamada; o export devolve uma definição com bpmnVersion 1. */
function servidorDeTeste(opcoes: { processos?: string[]; respostaImport?: string; liberacao?: string } = {}) {
  const chamadas: string[] = [];
  const importados: { xml: string; novo: boolean }[] = [];
  const cliente: WorkflowEngineClient = {
    async listProcessIds() { chamadas.push('list'); return opcoes.processos ?? ['processoTeste']; },
    async exportProcess() {
      chamadas.push('export');
      return Buffer.from('<?xml version="1.0"?><list><ProcessDefinition/><ProcessDefinitionVersion><bpmnVersion>1</bpmnVersion></ProcessDefinitionVersion></list>', 'latin1');
    },
    async createVersion() { chamadas.push('createVersion'); },
    async importProcess(_id, xml, novo = false) {
      chamadas.push(novo ? 'import-novo' : 'import');
      importados.push({ xml: xml.toString('utf8'), novo });
      return opcoes.respostaImport ?? 'Processo importado com sucesso!';
    },
    async releaseProcess() {
      chamadas.push('release');
      const m = opcoes.liberacao ?? '{ok=true}';
      return { ok: /ok=true/.test(m), mensagem: m };
    },
  };
  const formularios = async (): Promise<FormNoServidor[]> => [
    { documentId: 1234, documentDescription: 'formTeste', datasetName: 'dsformTeste' },
  ];
  return { cliente, formularios, chamadas, importados };
}

const ARQUIVO = join(FIXTURES, 'processoTeste.process');
const publicar = (s: ReturnType<typeof servidorDeTeste>, extra: Record<string, unknown> = {}) =>
  pushDiagram({
    server: SERVER, arquivo: ARQUIVO, senha: 's', prompt: async () => '',
    cliente: s.cliente, formularios: s.formularios, ...extra,
  });

test('publica processo existente: nova versão, import sobrescrevendo, liberação; bpmnVersion do servidor', async () => {
  const s = servidorDeTeste();
  const r = await publicar(s);

  assert.deepEqual(s.chamadas, ['list', 'export', 'createVersion', 'import', 'release']);
  assert.equal(r.publicado, true);
  assert.equal(r.criado, false);
  assert.equal(r.liberado, true);
  assert.equal(r.formId, 1234);
  const enviado = s.importados[0]!.xml;
  assert.doesNotMatch(enviado, /^<\?xml/, 'vai sem declaração, como no push process');
  assert.equal(texto(filhosDaRaiz(enviado)[1]!, 'bpmnVersion'), '1');
});

test('processo que não existe: recusa sem --create, cria com ele (import novo, sem nova versão)', async () => {
  const sem = servidorDeTeste({ processos: [] });
  assert.equal(await codigoDe(publicar(sem)), 3);
  assert.deepEqual(sem.chamadas, ['list']);

  const com = servidorDeTeste({ processos: [] });
  const r = await publicar(com, { criar: true });
  assert.deepEqual(com.chamadas, ['list', 'import-novo', 'release']);
  assert.equal(r.criado, true);
  assert.equal(texto(filhosDaRaiz(com.importados[0]!.xml)[1]!, 'bpmnVersion'), '2');
});

test('--create com processo existente é recusado sem escrever', async () => {
  const s = servidorDeTeste();
  assert.equal(await codigoDe(publicar(s, { criar: true })), 6);
  assert.deepEqual(s.chamadas, ['list']);
});

test('formulário do cardIndex que não existe no destino recusa antes de escrever', async () => {
  const s = servidorDeTeste();
  s.formularios = async () => [{ documentId: 99, documentDescription: 'outro', datasetName: 'dsOutro' }];
  assert.equal(await codigoDe(publicar(s)), 6);
  assert.ok(!s.chamadas.some((c) => c.startsWith('import') || c === 'createVersion'));
});

test('resolverFormId: número tem de existir, nome tem de ser único, vazio é sem formulário', () => {
  const cat: FormNoServidor[] = [
    { documentId: 5, documentDescription: 'formA', datasetName: 'dsA' },
    { documentId: 6, documentDescription: 'formB', datasetName: 'dsB' },
    { documentId: 7, documentDescription: 'formB', datasetName: 'dsB2' },
  ];
  assert.throws(() => resolverFormId('', cat), /não está vinculado a um formulário/);
  assert.equal(resolverFormId('5', cat), 5);
  assert.equal(resolverFormId('formA', cat), 5);
  assert.throws(() => resolverFormId('8', cat), /8 \(cardIndex\), que não existe/);
  assert.throws(() => resolverFormId('formB', cat), /2 formulário.*6, 7/);
  assert.throws(() => resolverFormId('formC', cat), /nenhum formulário/);
});

test('import sem sucesso e liberação recusada viram código 7', async () => {
  assert.equal(await codigoDe(publicar(servidorDeTeste({ respostaImport: 'erro qualquer' }))), 7);
  const s = servidorDeTeste({ liberacao: '{ok=false, activityError=[x]}' });
  assert.equal(await codigoDe(publicar(s)), 7);
  assert.deepEqual(s.chamadas.slice(-1), ['release']);
});

test('--no-release importa e deixa a versão em edição', async () => {
  const s = servidorDeTeste();
  const r = await publicar(s, { liberar: false });
  assert.equal(r.liberado, null);
  assert.ok(!s.chamadas.includes('release'));
});

test('em produção, senha digitada errada não escreve nada', async () => {
  const s = servidorDeTeste();
  const r = pushDiagram({
    server: { ...SERVER, prod: true }, arquivo: ARQUIVO, senha: 'certa', prompt: async () => 'errada',
    cliente: s.cliente, formularios: s.formularios,
  });
  assert.equal(await codigoDe(r), 5);
  assert.ok(!s.chamadas.some((c) => c.startsWith('import') || c === 'createVersion'));
});

test('bpmnVersionDe lê a PDV do export; ilegível vira undefined', () => {
  assert.equal(bpmnVersionDe(Buffer.from('<list><a/><ProcessDefinitionVersion><bpmnVersion>2</bpmnVersion></ProcessDefinitionVersion></list>')), 2);
  assert.equal(bpmnVersionDe(Buffer.from('não é xml <')), undefined);
});


/* ============================ Imagem do diagrama ============================ */

test('gerarSvg desenha cada estado num <g sequence>, as raias e os fluxos com seta, e é XML válido', () => {
  const svg = gerarSvg(lerDiagrama(PROCESSO));
  assert.doesNotThrow(() => lerXml(svg));
  assert.deepEqual([...sequenciasDoSvg(svg)].sort((a, b) => a - b), [4, 5, 6, 7]);
  assert.match(svg, /<g componentSequence="3"><text[^>]*rotate\(270\)[^>]*><tspan[^>]*>Aprovação<\/tspan>/);
  assert.equal((svg.match(/<path style="fill:none; stroke:#000000/g) ?? []).length, 3, 'um path por fluxo');
  assert.equal((svg.match(/<polygon style="fill:#000000/g) ?? []).length, 3, 'uma seta por fluxo');
});

/** Monta workflow/diagrams + workflow/.resources numa pasta temporária. */
function projeto(svgDoStudio?: string): string {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-svg-'));
  mkdirSync(join(raiz, 'workflow', 'diagrams'), { recursive: true });
  mkdirSync(join(raiz, 'workflow', 'scripts'));
  writeFileSync(join(raiz, 'workflow', 'scripts', 'processoTeste.afterProcessCreate.js'), 'function afterProcessCreate() {}');
  const arquivo = join(raiz, 'workflow', 'diagrams', 'processoTeste.process');
  writeFileSync(arquivo, PROCESSO, 'latin1');
  if (svgDoStudio !== undefined) {
    mkdirSync(join(raiz, 'workflow', '.resources'));
    writeFileSync(join(raiz, 'workflow', '.resources', 'processoTeste.processimage.svg'), svgDoStudio);
  }
  return arquivo;
}

test('o .processimage.svg do Studio vai no import quando desenha os mesmos estados; senão, vai um gerado', async () => {
  const doStudio = '<?xml version="1.0"?>\r\n<svg><g sequence="4"/><g sequence="5"/><g sequence="6"/><g sequence="7"/><!-- studio --></svg>';
  const capturadas: { nome: string; svg: Buffer }[] = [];
  const s = servidorDeTeste();
  const importar = s.cliente.importProcess;
  s.cliente.importProcess = async (id, xml, novo, imagem) => { if (imagem) capturadas.push(imagem); return importar(id, xml, novo); };

  const r1 = await pushDiagram({ server: SERVER, arquivo: projeto(doStudio), senha: 's', prompt: async () => '', cliente: s.cliente, formularios: s.formularios });
  assert.equal(r1.imagem.origem, 'studio');
  assert.equal(capturadas[0]!.nome, 'processoTeste.processimage.svg');
  assert.equal(capturadas[0]!.svg.toString('utf8'), doStudio.replace('\r\n', '\n'), 'linhas com \\n, como o Studio manda');

  const deOutraVersao = doStudio.replace('<g sequence="7"/>', '');
  const r2 = await pushDiagram({ server: SERVER, arquivo: projeto(deOutraVersao), senha: 's', prompt: async () => '', cliente: s.cliente, formularios: s.formularios });
  assert.equal(r2.imagem.origem, 'gerada');
  assert.match(r2.avisos.join('\n'), /não desenha os mesmos estados/);
  assert.deepEqual([...sequenciasDoSvg(capturadas[1]!.svg.toString('utf8'))].sort((a, b) => a - b), [4, 5, 6, 7]);
});


test('diagrama sem formulário vinculado não é publicado, republicado nem simulado', async () => {
  for (const vazio of ['cardIndex=""', 'cardIndex="0"']) {
    const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-semform-'));
    const arquivo = join(raiz, 'processoTeste.process');
    writeFileSync(arquivo, PROCESSO.replace('cardIndex="1234"', vazio), 'latin1');

    for (const extra of [{ dryRun: true }, {}, { criar: true }]) {
      const s = servidorDeTeste(extra.criar ? { processos: [] } : {});
      const erro = await pushDiagram({
        server: SERVER, arquivo, senha: 's', prompt: async () => '', cliente: s.cliente, formularios: s.formularios, ...extra,
      }).then(() => undefined, (e: unknown) => e as ErroFluigctl);
      assert.equal(erro?.codigo, 6, `${vazio} ${JSON.stringify(extra)}`);
      assert.match(erro!.message, /não está vinculado a um formulário/);
      assert.deepEqual(s.chamadas, [], 'recusa antes de qualquer chamada ao servidor');
    }
  }
});

/** Um item de `processAttachmentSecurity`, como o Studio grava no `.process`. */
const SEGURANCA = (sequencia: number, mecanismo: string, nivel: string, config = '') =>
  `  <org.eclipse.bpmn2.ECMProcessAttachmentSecurityImpl>\n    <companyId>0</companyId>\n    <version>0</version>\n` +
  `    <sequence>${sequencia}</sequence>\n    <engineAllocationId>${mecanismo}</engineAllocationId>\n${config}` +
  `    <accessLevel>${nivel}</accessLevel>\n    <editionMode>false</editionMode>\n  </org.eclipse.bpmn2.ECMProcessAttachmentSecurityImpl>\n`;
const comSeguranca = (atributos: string) =>
  PROCESSO.replace('<bpmn2:BpmnProcess id="processoTeste"', `<bpmn2:BpmnProcess id="processoTeste" ${atributos}`);
const ascii = (s: string) => s.replace(/[^\x00-\x7f]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`);

test('segurança de anexos e notificação do gestor: filho 5, PDV e ProcessDefinition, como no HML', () => {
  const blob = '<list>\n' +
    SEGURANCA(1, 'Todos os Usuários', 'PR') +
    SEGURANCA(2, 'Grupo', 'PRMOED',
      '    <engineAllocationConfiguration class="org.eclipse.bpmn2.impl.AssignmentControllerGroup">\n' +
      '      <groupId>UTIC</groupId>\n      <mechanismName>Grupo</mechanismName>\n    </engineAllocationConfiguration>\n') +
    '</list>';
  const r = converterDiagrama(comSeguranca(
    `controlsAttachmentsSecurity="true" notifyManagerComplements="true" processAttachmentSecurity="${ascii(comoAtributo(blob))}"`,
  ), { companyId: 4 });
  const filhos = filhosDaRaiz(r.xml);

  assert.equal(texto(filhos[0]!, 'notifyManagerComplements'), 'true');
  assert.equal(texto(filhos[1]!, 'controlsAttachmentsSecurity'), 'true');
  const itens = filhos[5]!.filhos;
  assert.deepEqual(itens.map((i) => i.nome), ['ProcessAttachmentSecurity', 'ProcessAttachmentSecurity']);
  // A PK descarta companyId e version do blob, como o Studio: companyId de quem chama, version 1.
  assert.deepEqual(itens[0]!.filhos[0]!.filhos.map((f) => [f.nome, f.texto]), [
    ['companyId', '4'], ['processId', 'processoTeste'], ['version', '1'], ['sequence', '1'],
  ]);
  assert.deepEqual(itens[0]!.filhos.slice(1).map((f) => [f.nome, f.texto]), [
    ['engineAllocationId', 'Todos os Usuários'], ['accessLevel', 'PR'], ['editionMode', 'false'],
  ]);
  assert.deepEqual(itens[1]!.filhos.slice(1).map((f) => [f.nome, f.texto]), [
    ['engineAllocationId', 'Grupo'],
    ['engineAllocationConfiguration', '<AssignmentController><Group>UTIC</Group></AssignmentController>'],
    ['accessLevel', 'PRMOED'],
    ['editionMode', 'false'],
  ]);

  // Sem os atributos, como antes: false e filho 5 vazio.
  const sem = filhosDaRaiz(converterDiagrama(PROCESSO, { companyId: 4 }).xml);
  assert.equal(texto(sem[0]!, 'notifyManagerComplements'), 'false');
  assert.equal(texto(sem[1]!, 'controlsAttachmentsSecurity'), 'false');
  assert.equal(sem[5]!.filhos.length, 0);
});

test('segurança de anexos fora da forma vista nos .process é recusada com código 6', () => {
  const papel = '    <engineAllocationConfiguration class="org.eclipse.bpmn2.impl.AssignmentControllerRole">\n' +
    '      <roleId>admin</roleId>\n      <mechanismName>Papel</mechanismName>\n    </engineAllocationConfiguration>\n';
  const casos: [string, RegExp][] = [
    ['<list>\n' + SEGURANCA(1, 'Papel', 'PR', papel) + '</list>', /atribuição AssignmentControllerRole/],
    ['<list>\n' + SEGURANCA(1, 'Grupo', 'PR') + '</list>', /mecanismo "Grupo" sem configuração/],
    ['<list>\n' + SEGURANCA(1, 'Todos os Usuários', 'PX') + '</list>', /accessLevel "PX"/],
    ['<list>\n' + SEGURANCA(1, 'Todos os Usuários', 'PR') + SEGURANCA(1, 'Todos os Usuários', 'R') + '</list>', /sequence 1 repetido/],
    ['<list/>', /vazio/],
  ];
  for (const [blob, motivo] of casos) {
    const erro = erroDe(() => converterDiagrama(comSeguranca(`processAttachmentSecurity="${ascii(comoAtributo(blob))}"`), { companyId: 1 }));
    assert.equal(erro.codigo, 6, String(motivo));
    assert.match(erro.message, motivo);
  }
});

/*
 * O teste_fluigctl com um subprocesso (100) para teste_fluigctl_sub, publicado
 * como versão 7 no HML da Cetenco (03/10/2026). O subprocesso não traz
 * transferAttachments, sendToNextTaskInSubProcess nem cancelSubProcess: o
 * Studio só grava esses booleanos quando são true. Na solicitação 680 a filha
 * (681) nasceu parada no início — sendToNextTaskInSubProcess false — e, ao
 * terminar, devolveu o campo à mãe pelo formMaps com mapFlow 0 (IN).
 */
test('subprocesso sem os booleanos sai com false; formMaps vira SubProcessFieldRelationship', () => {
  const r = converterDiagrama(readFileSync(join(FIXTURES, 'subprocessoTeste.process'), 'latin1'), { companyId: 1 });
  const filhos = filhosDaRaiz(r.xml);
  const sub = filhos[2]!.filhos.find((e) => texto(e, 'stateType') === '2')!;
  assert.equal(texto(sub, 'processStatePK', 'sequence'), '12');
  assert.equal(texto(sub, 'subProcessId'), 'teste_fluigctl_sub');
  for (const campo of ['transferAttachments', 'sendToNextTaskInSubProcess', 'cancelSubProcess']) {
    assert.equal(texto(sub, campo), 'false', campo);
  }
  assert.deepEqual(filhos[16]!.filhos.map((e) => e.filhos.map((f) => f.texto)), [
    ['1', 'teste_fluigctl', '12', '1', 'teste_fluigctl_sub', 'descricao', 'descricao', '0'],
  ]);
});

test('caminho de gateway com mechanism vazio e sem configuração leva só engineAllocationId vazio', () => {
  const vazio = FASE1.replace('&lt;targetTask>task8&lt;/targetTask>', '&lt;targetTask>task8&lt;/targetTask>&#xA;    &lt;mechanism>&lt;/mechanism>');
  assert.notEqual(vazio, FASE1);
  const condicoes = filhosDaRaiz(converterDiagrama(vazio, { companyId: 1 }).xml)[3]!.filhos;
  const comVazio = condicoes.filter((c) => c.filhos.some((f) => f.nome === 'engineAllocationId'));
  assert.equal(comVazio.length, 1);
  assert.equal(texto(comVazio[0]!, 'engineAllocationId'), '');
  assert.equal(texto(comVazio[0]!, 'engineAllocationConfiguration'), '<ausente>');
});

/** `attachmentRules` com as regras dadas, como o Studio grava no `.process`. */
const REGRA = (id: number, operador: number, quantidade: string) =>
  `  <org.eclipse.bpmn2.documentacional.BpmnProcessAttachmentRules>\n    <id>${id}</id>\n    <message>Anexe</message>\n` +
  `    <operator>${operador}</operator>\n    <amount>${quantidade}</amount>\n    <name>Regra ${operador}</name>\n` +
  '  </org.eclipse.bpmn2.documentacional.BpmnProcessAttachmentRules>\n';
const comRegras = (...regras: string[]) =>
  PROCESSO.replace('<bpmn2:BpmnTask id="task5"', `<bpmn2:BpmnTask id="task5" attachmentRules="${comoAtributo(`<list>\n${regras.join('')}</list>`)}"`);

test('regras de anexo: uma linha por regra, qualquer operador do combo, amount como texto e id do blob ignorado', () => {
  const linhas = filhosDaRaiz(converterDiagrama(comRegras(REGRA(7, 1, '1'), REGRA(0, 6, '')), { companyId: 1 }).xml)[18]!.filhos;
  assert.deepEqual(linhas.map((l) => [texto(l, 'id'), texto(l, 'stateSequence'), texto(l, 'operator'), texto(l, 'amount')]), [
    ['0', '5', '1', '1'],
    ['0', '5', '6', ''],
  ]);
  for (const [regras, motivo] of [
    [[REGRA(0, 7, '1')], /operator "7"/],
    [[REGRA(0, 1, 'um')], /amount não numérico/],
    [[], /attachmentRules vazio/],
  ] as [string[], RegExp][]) {
    const erro = erroDe(() => converterDiagrama(comRegras(...regras), { companyId: 1 }));
    assert.equal(erro.codigo, 6, String(motivo));
    assert.match(erro.message, motivo);
  }
});

test('subprocesso cujo processo-alvo não existe no destino é recusado com código 6, antes de escrever', async () => {
  const comAlvo = (processos: string[]) => {
    const s = servidorDeTeste({ processos });
    const formularios = async (): Promise<FormNoServidor[]> => [
      { documentId: 1192, documentDescription: 'formTesteFluigctl', datasetName: 'dsformTesteFluigctl' },
    ];
    return { s, publicar: () => pushDiagram({
      server: SERVER, arquivo: join(FIXTURES, 'subprocessoTeste.process'), senha: 's', prompt: async () => '',
      cliente: s.cliente, formularios,
    }) };
  };
  const sem = comAlvo(['teste_fluigctl']);
  const erro = await sem.publicar().catch((e: unknown) => e);
  assert.ok(erro instanceof ErroFluigctl);
  assert.equal(erro.codigo, 6);
  assert.match(erro.message, /"teste_fluigctl_sub", que não existe/);
  assert.deepEqual(sem.s.chamadas, ['list']);

  const com = comAlvo(['teste_fluigctl', 'teste_fluigctl_sub']);
  const r = await com.publicar();
  assert.equal(r.publicado, true);
  assert.deepEqual(r.subprocessos, ['teste_fluigctl_sub']);
});

test('gerarSvg desenha as marcas de evento e de gateway com a geometria do Studio', () => {
  const svg = gerarSvg(lerDiagrama(FASE1));
  const grupo = (seq: number) => [...svg.matchAll(new RegExp(`<g sequence="${seq}">(.*?)</g>`, 'gs'))].map((m) => m[1]).join('');
  // Temporizador: relógio de raio 12 com ponteiros; erro anexado: o raio vazado.
  assert.match(grupo(14), /rx="12" ry="12" stroke-width="1" style="stroke:#000000; fill:none"/);
  assert.equal((grupo(14).match(/<path /g) ?? []).length, 14);
  assert.match(grupo(6), /<polygon points=" [\d ]+" style="stroke:#999900; fill:none" \/>/);
  // Sem o círculo interno que o Studio não desenha.
  assert.equal((grupo(6).match(/<ellipse /g) ?? []).length, 1);
  // Paralelo e join: o "+" de traço 6 fora do <g sequence>; o exclusivo, sem marca.
  assert.equal((svg.match(/stroke-width:6/g) ?? []).length, 4);
  assert.doesNotMatch(grupo(7), /<path /);
});

test('gerarSvg desenha o ícone da tarefa na posição do al:Image do .process', () => {
  const comIcone = FASE1.replace(
    '<link businessObjects="servicetask5"/>',
    '<link businessObjects="servicetask5"/>\n      <children visible="true"><graphicsAlgorithm xsi:type="al:Image" width="16" height="16" x="5" y="5" ' +
      'id="com.totvs.tds.ecm.designer.task.service"/></children>',
  );
  assert.notEqual(comIcone, FASE1);
  const d = lerDiagrama(comIcone);
  assert.deepEqual(d.icones.get('servicetask5'), [{ id: 'com.totvs.tds.ecm.designer.task.service', absX: 125, absY: 55 }]);
  const svg = gerarSvg(d);
  assert.match(svg, /<g sequence="5"><ellipse cx="133" cy="63" rx="5" ry="5"/);
  assert.ok(lerXml(svg.replace(/^<\?xml[^>]*>\n/, '')), 'segue XML válido');
  // Sem al:Image, nenhum ícone.
  assert.doesNotMatch(gerarSvg(lerDiagrama(FASE1)), /<g sequence="5"><ellipse cx="133"/);
});
