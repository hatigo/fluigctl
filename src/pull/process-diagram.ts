import { ErroFluigctl } from '../errors.js';
import { escaparTexto, filhos, lerXml, type No } from '../push/diagram/xml.js';

const texto = (no: No | undefined, nome: string, padrao = ''): string => filhos(no ?? VAZIO, nome)[0]?.texto ?? padrao;
const numero = (no: No | undefined, nome: string, padrao = 0): number => Number(texto(no, nome, String(padrao))) || 0;
const VAZIO: No = { nome: '', attrs: {}, filhos: [], texto: '' };
const attr = (valor: string): string => escaparTexto(valor).replace(/\n/g, '&#xA;');
const boolAttr = (no: No, nome: string, padrao = false): string | undefined => {
  const v = texto(no, nome, String(padrao));
  return v === String(padrao) ? undefined : v;
};

function idEstado(tipo: number, sequencia: number): string {
  const prefixo: Record<number, string> = {
    10: 'startevent', 60: 'endevent', 64: 'endevent', 65: 'endevent', 68: 'endevent',
    80: 'task', 81: 'task', 82: 'task', 84: 'task', 87: 'task', 100: 'subprocess', 101: 'subprocess',
    120: 'exclusivegateway', 121: 'inclusivegateway', 126: 'parallelgateway', 127: 'parallelgateway',
    32: 'intermediatetimer', 35: 'intermediateconditional', 36: 'intermediatelink', 37: 'intermediatesignal',
    41: 'intermediatesignalcatch', 42: 'intermediatelinkcatch', 43: 'intermediateerror',
  };
  const p = prefixo[tipo];
  if (!p) throw new ErroFluigctl(`o processo exportado tem bpmnType ${tipo}, que o pull do .process ainda não cobre`, 6);
  return `${p}${sequencia}`;
}

function tagEstado(tipo: number): string {
  if (tipo === 10) return 'BpmnStartEvent';
  if ([60, 64, 65, 68].includes(tipo)) return 'BpmnEndEvent';
  if ([80, 81, 82, 84, 87].includes(tipo)) return 'BpmnTask';
  if ([120, 121, 126, 127].includes(tipo)) return 'BpmnGateway';
  if ([100, 101].includes(tipo)) return 'BpmnSubProcess';
  return 'BpmnIntermediateEvent';
}

/** Converte a representação de atribuição do servidor para o blob usado pelo modelo BPMN do Studio. */
function atribuicao(mecanismo: string, xml: string): string | undefined {
  if (!xml) return undefined;
  const campo = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(xml)?.[1] ?? '';
  let classe = '';
  let corpo = '';
  if (/<Group>/.test(xml)) { classe = mecanismo === 'Pool Grupo' ? 'AssignmentControllerPoolGroup' : 'AssignmentControllerGroup'; corpo = `<groupId>${campo('Group')}</groupId>`; }
  else if (/<Role>/.test(xml)) { classe = 'AssignmentControllerRole'; corpo = `<roleId>${campo('Role')}</roleId>`; }
  else if (/<User>/.test(xml)) { classe = 'AssignmentControllerUser'; corpo = `<userId>${campo('User')}</userId>`; }
  else if (/<Field>/.test(xml)) { classe = 'AssignmentControllerFormField'; corpo = `<field>${campo('Field')}</field>`; }
  else if (/<BaseActivity>/.test(xml)) {
    classe = 'AssignmentControllerExecutorMechanism';
    corpo = `<idNode>task${campo('BaseActivity')}</idNode><returns>${campo('Returns') === 'All' ? '0' : '1'}</returns>`;
  } else return undefined;
  return `<org.eclipse.bpmn2.impl.${classe}>${corpo}<mechanismName>${mecanismo}</mechanismName></org.eclipse.bpmn2.impl.${classe}>`;
}

interface Estado { no: No; seq: number; tipo: number; id: string; tag: string; x: number; y: number; }

/**
 * Faz o caminho inverso do push diagram para a parte estrutural do formato do Studio.
 * O resultado é deliberadamente determinístico: ids derivam das sequences e o layout
 * usa as coordenadas publicadas pelo servidor.
 */
export function gerarProcess(definicao: string, nomeDoArquivo?: string): { processId: string; process: string } {
  const doc = lerXml(definicao);
  const raiz = doc.filhos[0];
  if (!raiz || raiz.nome !== 'list') throw new ErroFluigctl('a definição exportada não é um <list> ECM 3.0', 6);
  const pd = filhos(raiz, 'ProcessDefinition')[0];
  const pdv = filhos(raiz, 'ProcessDefinitionVersion')[0];
  if (!pd || !pdv) throw new ErroFluigctl('a definição exportada não contém ProcessDefinition e ProcessDefinitionVersion', 6);
  const processId = texto(filhos(pd, 'processDefinitionPK')[0], 'processId');
  const descricao = texto(pd, 'processDescription', processId);
  const versao = numero(filhos(pdv, 'processDefinitionVersionPK')[0], 'version', 1);
  if (!processId) throw new ErroFluigctl('a definição exportada não contém processId', 6);

  const lista = (nome: string): No[] => raiz.filhos.flatMap((n) => n.nome === 'list' ? filhos(n, nome) : []);
  // Nunca produza um diagrama parcial: estas estruturas precisam ser reconstruídas
  // como blobs XStream antes de poderem entrar no pull com segurança.
  const aindaNaoCobertos = [
    'ProcessAttachmentSecurity', 'AdvancedProcessProperties', 'ExtendedPropertyField',
    'ProcessFormField', 'SubProcessFieldRelationship', 'ProcessAppConfiguration',
    'ProcessAttachmentRules', 'ProcessComponGraf', 'ProcessLinkAssoc',
  ].filter((nome) => lista(nome).length > 0);
  if (aindaNaoCobertos.length > 0) {
    throw new ErroFluigctl(
      `o processo publicado usa estruturas que o pull do .process ainda não cobre: ${aindaNaoCobertos.join(', ')}. ` +
      'Nada foi gravado; use o Fluig Studio para este processo.',
      6,
    );
  }
  const estados: Estado[] = lista('ProcessState').map((no) => {
    const seq = numero(filhos(no, 'processStatePK')[0], 'sequence');
    const tipo = numero(no, 'bpmnType');
    return { no, seq, tipo, id: idEstado(tipo, seq), tag: tagEstado(tipo), x: numero(no, 'positionX'), y: numero(no, 'positionY') };
  });
  const porSeq = new Map(estados.map((e) => [e.seq, e]));

  const regras = lista('ConditionProcessAutomaticRules');
  const condicoesPorGateway = new Map<number, No[]>();
  for (const c of lista('ConditionProcessState')) {
    const pk = filhos(c, 'conditionProcessStatePK')[0];
    const seq = numero(pk, 'sequence');
    if (!porSeq.has(numero(c, 'destinationSequenceId'))) {
      throw new ErroFluigctl(`a condição ${numero(pk, 'expressionOrder')} do gateway ${seq} aponta para um estado inexistente`, 6);
    }
    if (texto(c, 'engineAllocationId') || texto(c, 'engineAllocationConfiguration')) {
      throw new ErroFluigctl(`a condição ${numero(pk, 'expressionOrder')} do gateway ${seq} tem atribuição por caminho, ainda não coberta pelo pull`, 6);
    }
    condicoesPorGateway.set(seq, [...(condicoesPorGateway.get(seq) ?? []), c]);
  }
  const blobCondicoes = (seq: number): string | undefined => {
    const cs = condicoesPorGateway.get(seq);
    if (!cs?.length) return undefined;
    const itens = cs.sort((a, b) => numero(filhos(a, 'conditionProcessStatePK')[0], 'expressionOrder') - numero(filhos(b, 'conditionProcessStatePK')[0], 'expressionOrder')).map((c) => {
      const pk = filhos(c, 'conditionProcessStatePK')[0];
      const ordem = numero(pk, 'expressionOrder');
      const tipo = numero(c, 'conditionType');
      const destino = porSeq.get(numero(c, 'destinationSequenceId'))!.id;
      const rs = regras.filter((r) => numero(r, 'sequence') === seq && numero(r, 'expressionOrder') === ordem)
        .sort((a, b) => numero(a, 'ruleOrder') - numero(b, 'ruleOrder'));
      if (tipo === 0 && rs.length) throw new ErroFluigctl(`a condição por expressão ${ordem} do gateway ${seq} também contém regras`, 6);
      const regrasXml = rs.length ? `<rules>${rs.map((r) => `<com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules><tenantId>0</tenantId><version>0</version><sequence>${seq}</sequence><expressionOrder>${ordem}</expressionOrder><ruleOrder>${numero(r, 'ruleOrder')}</ruleOrder><field>${attr(texto(r, 'field'))}</field><value>${attr(texto(r, 'value'))}</value><operator>${numero(r, 'operator')}</operator><valueType>${numero(r, 'valueType')}</valueType></com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules>`).join('')}</rules>` : '';
      const expressao = filhos(c, 'condition').length ? `<expression>${attr(texto(c, 'condition'))}</expression>` : '';
      return `<org.eclipse.bpmn2.impl.ConditionImpl><order>${ordem}</order>${expressao}<targetTask>${destino}</targetTask><conditionType>${tipo}</conditionType>${regrasXml}</org.eclipse.bpmn2.impl.ConditionImpl>`;
    });
    return `<list>${itens.join('')}</list>`;
  };

  const gatilhosPorEstado = new Map<number, No[]>();
  for (const g of lista('ProcessStateTrigger')) {
    const seq = numero(filhos(g, 'processStateTriggerPK')[0], 'stateSequence');
    const estado = porSeq.get(seq);
    if (!estado || ![32, 35].includes(estado.tipo)) {
      throw new ErroFluigctl(`o ProcessStateTrigger do estado ${seq} ainda não é coberto pelo pull`, 6);
    }
    gatilhosPorEstado.set(seq, [...(gatilhosPorEstado.get(seq) ?? []), g]);
  }
  const links = lista('ProcessLink').filter((l) => porSeq.has(numero(l, 'initialStateSequence')) && porSeq.has(numero(l, 'finalStateSequence')));
  const entrada = new Map<string, string[]>(), saida = new Map<string, string[]>();
  links.forEach((l) => {
    const id = `flow${numero(filhos(l, 'processLinkPK')[0], 'linkSequence')}`;
    const de = porSeq.get(numero(l, 'initialStateSequence'))!.id, para = porSeq.get(numero(l, 'finalStateSequence'))!.id;
    saida.set(de, [...(saida.get(de) ?? []), id]); entrada.set(para, [...(entrada.get(para) ?? []), id]);
  });

  const objetos: string[] = [];
  const raias = lista('SwimLane');
  raias.forEach((r, i) => {
    const tipo = numero(r, 'type');
    const tag = tipo === 1 ? 'BpmnPool' : tipo === 2 ? 'BpmnSwimLane' : 'BpmnGroup';
    const id = tipo === 1 ? `bpmnpool${i + 1}` : tipo === 2 ? `bpmnswimlane${i + 1}` : `bpmngroup${i + 1}`;
    objetos.push(`  <bpmn2:${tag} id="${id}" name="${attr(texto(r, 'stateName'))}" cores="${attr(texto(r, 'color'))}"/>`);
  });
  estados.forEach((e) => {
    const n = e.no; const a: string[] = [`id="${e.id}"`, `name="${attr(texto(n, 'stateName'))}"`];
    if (entrada.get(e.id)?.length) a.push(`incoming="${entrada.get(e.id)!.join(' ')}"`);
    if (saida.get(e.id)?.length) a.push(`outgoing="${saida.get(e.id)!.join(' ')}"`);
    a.push(`type="${e.tipo}"`, 'extendedFields="&lt;list/>"');
    const mecanismo = texto(n, 'engineAllocationId');
    const config = atribuicao(mecanismo, texto(n, 'engineAllocationConfiguration'));
    if (e.tipo === 10 && config) a.push(`initializerConfiguration="${attr(config)}"`);
    else if (config) a.push(`managerMechanism="${attr(mecanismo)}"`, `managerAssignmentControllerString="${attr(config)}"`);
    if ([120, 121].includes(e.tipo)) {
      const condition = blobCondicoes(e.seq);
      if (condition) a.push(`condition="${attr(condition)}"`);
    }
    if ([32, 35].includes(e.tipo)) {
      const gs = gatilhosPorEstado.get(e.seq) ?? [];
      if (gs.length !== 1) throw new ErroFluigctl(`o evento ${e.id} precisa ter exatamente um ProcessStateTrigger`, 6);
      const g = gs[0]!;
      const tipoGatilho = numero(g, 'type');
      if ((e.tipo === 32 && tipoGatilho !== 2) || (e.tipo === 35 && tipoGatilho !== 3)) {
        throw new ErroFluigctl(`o gatilho do evento ${e.id} tem type ${tipoGatilho} incompatível`, 6);
      }
      const runType = ['MINUTE', 'HOUR', 'DAY'][numero(g, 'runType')];
      if (!runType) throw new ErroFluigctl(`o gatilho do evento ${e.id} tem runType não suportado`, 6);
      let trigger = `<org.eclipse.bpmn2.documentacional.BpmnTriggerData><runType>${runType}</runType>`;
      if (filhos(g, 'timeTrigger').length) trigger += `<timeTrigger>${attr(texto(g, 'timeTrigger'))}</timeTrigger>`;
      trigger += `<frequencia>${attr(texto(g, 'frequencia'))}</frequencia><isCondition>false</isCondition>`;
      if (e.tipo === 35) trigger += `<scriptCondition>${attr(texto(g, 'value'))}</scriptCondition>`;
      trigger += '</org.eclipse.bpmn2.documentacional.BpmnTriggerData>';
      a.push(`trigger="${attr(trigger)}"`);
    }
    if ([80,81,82,84,87].includes(e.tipo)) {
      a.push('loopType="0"');
      const auth = boolAttr(n, 'notifyAuthorityFollowUp'); if (auth !== undefined) a.push(`authNotify="${auth}"`);
      a.push(`selecionaColaboradores="${numero(n, 'selectColleague')}"`);
      if (numero(n, 'deadlineTime')) a.push(`prazoConclusao="${numero(n, 'deadlineTime') / 60}"`);
      if (texto(n, 'deadlineFieldName')) a.push(`deadlineFieldName="${attr(texto(n, 'deadlineFieldName'))}"`);
      if (texto(n, 'instruction')) a.push(`instrucoes="${attr(texto(n, 'instruction'))}"`);
      const booleanos: [string, string][] = [
        ['notifyRequisitionerFollowUp', 'notificaRequisitante'], ['notifyManagerFollowUp', 'notificaGestor'],
        ['inhibitTransfer', 'inibeOpcaoTransferir'], ['digitalSignature', 'confirmarSenha'],
        ['joint', 'atividadeConjunta'], ['notifyRequisitionerDelay', 'emAtrasoNotificarRequisitante'],
        ['notifyManagerDelay', 'emAtrasoNotificarGestor'],
      ];
      for (const [campo, atributo] of booleanos) if (texto(n, campo) === 'true') a.push(`${atributo}="true"`);
      if (numero(n, 'agreementPercentage')) a.push(`consenso="${numero(n, 'agreementPercentage')}"`);
      if (texto(n, 'periodId')) a.push(`expediente="${attr(texto(n, 'periodId'))}"`);
      if (e.tipo === 82) {
        const servico = lista('ProcessStateService').find((s) => numero(s, 'sequence') === e.seq);
        a.push(`executionType="${numero(n, 'executionType')}"`);
        if (servico) {
          if (texto(servico, 'serviceName')) a.push(`serviceName="${attr(texto(servico, 'serviceName'))}"`);
          a.push(`executionAttempts="${numero(servico, 'attempts')}"`, `frequency="${numero(servico, 'frequency')}"`, `frequencyType="${numero(servico, 'frequencyType')}"`);
        }
      }
    }
    if (e.tipo === 100) a.push(`process="${attr(texto(n, 'subProcessId'))}"`);
    objetos.push(`  <bpmn2:${e.tag} ${a.join(' ')}/>`);
  });
  const procAttrs = [
    `id="${attr(processId)}"`, `name="${attr(descricao)}"`, `version="${versao}"`, 'author=""', 'extendedFields="&lt;list/>"',
    `cardIndex="${attr(texto(pdv, 'formId'))}"`, 'formSource="server"', `category="${attr(texto(pd, 'categoryId'))}"`,
    `volume="${attr(texto(pd, 'volumeId'))}"`, `expedient="${attr(texto(pd, 'periodId'))}"`, `instruction="${attr(texto(pd, 'instruction'))}"`,
  ];
  const gestorId = texto(pd, 'managerEngineAllocationId');
  const gestor = atribuicao(gestorId, texto(pd, 'managerEngineAllocationConfiguration'));
  if (gestor) procAttrs.push(`managerMechanism="${attr(gestorId)}"`, `managerAssignmentController="${attr(gestor)}"`);
  objetos.push(`  <bpmn2:BpmnProcess ${procAttrs.join(' ')}/>`);
  links.forEach((l) => {
    const seq = numero(filhos(l, 'processLinkPK')[0], 'linkSequence');
    const de = porSeq.get(numero(l, 'initialStateSequence'))!, para = porSeq.get(numero(l, 'finalStateSequence'))!;
    const a = [`id="flow${seq}"`, `name="${attr(texto(l, 'name'))}"`, `sourceRef="${de.id}"`, `targetRef="${para.id}"`,
      `atividadeFluxo="${attr(texto(l, 'actionLabel'))}"`, `atividadeRetorno="${attr(texto(l, 'returnLabel'))}"`, 'extendedFields="&lt;list/>"'];
    if (texto(l, 'returnPermited') === 'true') a.push('permiteRetorno="true"');
    if (texto(l, 'automaticLink') === 'true') a.push('fluxoAutomatico="true"');
    if (texto(l, 'defaultLink') === 'true') a.push('defaultLink="true"');
    objetos.push(`  <bpmn2:SequenceFlow ${a.join(' ')}/>`);
  });

  const shapes: string[] = [];
  const shapeIndex = new Map<string, number>();
  const addShape = (id: string, x: number, y: number, w: number, h: number, forma: 'Rectangle'|'Ellipse' = 'Rectangle') => {
    const i = shapes.length; shapeIndex.set(id, i);
    const inc = entrada.get(id)?.map((_, j) => `/0/@connections.${links.findIndex((l) => porSeq.get(numero(l,'finalStateSequence'))?.id === id) + j}`).join(' ');
    shapes.push(`    <children xsi:type="pi:ContainerShape" visible="true" active="true"><graphicsAlgorithm xsi:type="al:${forma}" lineWidth="1" width="${w}" height="${h}" x="${x}" y="${y}"/><link businessObjects="${id}"/><anchors xsi:type="pi:ChopboxAnchor"${inc ? ` incomingConnections="${inc}"` : ''}/></children>`);
  };
  raias.forEach((r, i) => addShape(numero(r,'type') === 1 ? `bpmnpool${i+1}` : `bpmnswimlane${i+1}`, numero(r,'positionX'), numero(r,'positionY'), numero(r,'width',900), numero(r,'height',150)));
  estados.forEach((e) => addShape(e.id, e.x, e.y, [10,32,35,36,37,41,42,43,60,64,65,68].includes(e.tipo) ? 35 : 106, [10,32,35,36,37,41,42,43,60,64,65,68].includes(e.tipo) ? 35 : 67, [10,32,35,36,37,41,42,43,60,64,65,68].includes(e.tipo) ? 'Ellipse' : 'Rectangle'));
  const connections = links.map((l) => {
    const seq = numero(filhos(l,'processLinkPK')[0], 'linkSequence'); const de = porSeq.get(numero(l,'initialStateSequence'))!, para = porSeq.get(numero(l,'finalStateSequence'))!;
    const bends = lista('ProcessLinkBend').filter((b) => numero(filhos(b,'processLinkBendPK')[0], 'linkSequence') === seq).map((b) => `<bendpoints x="${numero(b,'positionX')}" y="${numero(b,'positionY')}"/>`).join('');
    return `    <connections xsi:type="pi:FreeFormConnection" visible="true" active="true" start="/0/@children.${shapeIndex.get(de.id)}/@anchors.0" end="/0/@children.${shapeIndex.get(para.id)}/@anchors.0"><graphicsAlgorithm xsi:type="al:Polyline" lineWidth="1"/><link businessObjects="flow${seq}"/>${bends}</connections>`;
  });
  const nome = attr(nomeDoArquivo ?? processId);
  const process = `<?xml version="1.0" encoding="ASCII"?>\n<xmi:XMI xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:al="http://eclipse.org/graphiti/mm/algorithms" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL-XMI" xmlns:pi="http://eclipse.org/graphiti/mm/pictograms">\n  <pi:Diagram visible="true" gridUnit="10" diagramTypeId="BPMNdiagram" name="${nome}" snapToGrid="true" version="0.16.0"><graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="1200" height="1000"/>\n${shapes.join('\n')}\n${connections.join('\n')}\n  </pi:Diagram>\n${objetos.join('\n')}\n</xmi:XMI>\n`;
  return { processId, process };
}
