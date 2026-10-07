import { garantirVisual } from '../diagram/visual.js';
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
const elemento = (nome: string, valor: string | number | boolean): string => `<${nome}>${attr(String(valor))}</${nome}>`;
const blobLista = (classe: string, itens: Record<string, string | number | boolean>[]): string =>
  `<list>${itens.map((item) => `<${classe}>${Object.entries(item).map(([k, v]) => elemento(k, v)).join('')}</${classe}>`).join('')}</list>`;

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
  /*
   * Mecanismo de atribuicao customizado: o servidor guarda o id e a
   * configuracao VAZIA - medido no fluig-localdev com MEC_ALCADAS ("Aprovar",
   * config ""). Este caso tem de vir ANTES do `if (!xml)`: com ele depois, o
   * retorno por configuracao vazia acontecia primeiro, o ramo nunca era
   * alcancado, e o pull devolvia a tarefa sem atribuicao nenhuma. Republicar
   * aquele arquivo apagava o mecanismo do processo, em silencio - a aprovacao
   * deixava de ter responsavel.
   */
  if (!xml) {
    return mecanismo
      ? `<org.eclipse.bpmn2.impl.AssignmentControllerCustom><mechanismName>${mecanismo}</mechanismName></org.eclipse.bpmn2.impl.AssignmentControllerCustom>`
      : undefined;
  }
  const campo = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(xml)?.[1] ?? '';
  if (/<AssociatedController\b/.test(xml)) {
    const tipo = /ConditionAssociated="([^"]+)"/.exec(xml)?.[1];
    if (!tipo || !['AND', 'OR'].includes(tipo)) return undefined;
    const controladores = [...xml.matchAll(/<ControlXML\s+TypeAssociated="([^"]+)">([\s\S]*?)<\/ControlXML>/g)];
    if (!controladores.length) return undefined;
    const blobs = controladores.map((m) => atribuicao(m[1]!, m[2]!));
    if (blobs.some((b) => !b)) return undefined;
    return `<org.eclipse.bpmn2.impl.AssignmentControllerAssociated><controllers class="list">${blobs.join('')}</controllers><type>${tipo}</type><mechanismName>${mecanismo}</mechanismName></org.eclipse.bpmn2.impl.AssignmentControllerAssociated>`;
  }
  let classe = '';
  let corpo = '';
  if (/<Group>/.test(xml)) { classe = mecanismo === 'Pool Grupo' ? 'AssignmentControllerPoolGroup' : 'AssignmentControllerGroup'; corpo = `<groupId>${campo('Group')}</groupId>`; }
  else if (/<Role>/.test(xml)) { classe = 'AssignmentControllerRole'; corpo = `<roleId>${campo('Role')}</roleId>`; }
  else if (/<User>/.test(xml)) { classe = 'AssignmentControllerColleague'; corpo = `<colleagueId>${campo('User')}</colleagueId>`; }
  else if (/<FormField>/.test(xml) || /<Field>/.test(xml)) { classe = 'AssignmentControllerFormField'; corpo = `<formField>${campo('FormField') || campo('Field')}</formField>`; }
  else if (/<GroupsOf>/.test(xml)) {
    classe = 'AssignmentControllerColleagueGroup';
    corpo = `<colleagueId>${campo('GroupsOf')}</colleagueId><onlyWorkGroup>${campo('OnlyWorkGroup') === 'ON'}</onlyWorkGroup><includeCommunityGroups>${campo('IncludeCommunityGroups') === 'ON'}</includeCommunityGroups>`;
  }
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
  const aindaNaoCobertos: string[] = [];
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
  const graficos = lista('ProcessComponGraf').map((no) => {
    const seq = numero(filhos(no, 'processComponGrafPK')[0], 'componGrafSequence');
    const tipo = numero(no, 'componType');
    const info = tipo === 1
      ? { tag: 'BpmnAnnotation', prefixo: 'annotation', nome: texto(no, 'stateName') }
      : tipo === 2
        ? { tag: 'BpmnDocument', prefixo: 'document', nome: '' }
        : tipo === 3
          ? { tag: 'BpmnDatabase', prefixo: 'database', nome: texto(no, 'stateName') }
          : undefined;
    if (!info) throw new ErroFluigctl(`o componente gráfico ${seq} tem componType ${tipo} não suportado`, 6);
    return { no, seq, tipo, id: `${info.prefixo}${seq}`, ...info, x: numero(no, 'positionX'), y: numero(no, 'positionY') };
  });
  const graficoPorSeq = new Map(graficos.map((g) => [g.seq, g]));
  const errosPorTarefa = new Map<number, Estado[]>();
  for (const e of estados.filter((x) => x.tipo === 43)) {
    const pai = numero(e.no, 'parentSequence');
    if (!porSeq.has(pai)) {
      // O importador do Studio (`populateIntermediateEventLink`, decompilado) faz
      // `mapParentIds.get(parentSequence) == null` e dá `continue`: descarta o
      // evento em silêncio. Publicar sem ele mudaria o processo, então paramos.
      throw new ErroFluigctl(
        `o evento de erro do estado ${e.seq} está anexado ao estado ${pai}, que não existe nesta definição. ` +
          'O Fluig Studio descartaria o evento ao abrir; publicar sem ele mudaria o processo. ' +
          'Corrija o vínculo no servidor antes de baixar.',
        6,
      );
    }
    errosPorTarefa.set(pai, [...(errosPorTarefa.get(pai) ?? []), e]);
  }

  const regras = lista('ConditionProcessAutomaticRules');
  const condicoesPorGateway = new Map<number, No[]>();
  for (const c of lista('ConditionProcessState')) {
    const pk = filhos(c, 'conditionProcessStatePK')[0];
    const seq = numero(pk, 'sequence');
    if (!porSeq.has(numero(c, 'destinationSequenceId'))) {
      throw new ErroFluigctl(`a condição ${numero(pk, 'expressionOrder')} do gateway ${seq} aponta para um estado inexistente`, 6);
    }
    const mecanismo = texto(c, 'engineAllocationId');
    const configuracao = texto(c, 'engineAllocationConfiguration');
    if ((mecanismo || configuracao) && !atribuicao(mecanismo, configuracao)) {
      throw new ErroFluigctl(`a condição ${numero(pk, 'expressionOrder')} do gateway ${seq} tem atribuição por caminho não suportada`, 6);
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
      const mecanismo = texto(c, 'engineAllocationId');
      const config = atribuicao(mecanismo, texto(c, 'engineAllocationConfiguration'));
      let atribuicaoXml = mecanismo || config ? `<mechanism>${attr(mecanismo)}</mechanism>` : '';
      if (config) {
        const abertura = /^<org\.eclipse\.bpmn2\.impl\.([^>]+)>/.exec(config);
        atribuicaoXml += `<mecanismoAtribuicaoConfiguracao class="org.eclipse.bpmn2.impl.${abertura?.[1] ?? ''}">${config.replace(/^<[^>]+>|<\/[^>]+>$/g, '')}</mecanismoAtribuicaoConfiguracao>`;
      }
      return `<org.eclipse.bpmn2.impl.ConditionImpl><order>${ordem}</order>${expressao}<targetTask>${destino}</targetTask><conditionType>${tipo}</conditionType>${atribuicaoXml}${regrasXml}</org.eclipse.bpmn2.impl.ConditionImpl>`;
    });
    return `<list>${itens.join('')}</list>`;
  };

  const gatilhosPorEstado = new Map<number, No[]>();
  for (const g of lista('ProcessStateTrigger')) {
    const seq = numero(filhos(g, 'processStateTriggerPK')[0], 'stateSequence');
    const estado = porSeq.get(seq);
    const tipo = numero(g, 'type');
    if (!estado || (!([32, 35].includes(estado.tipo)) && !(estado.tipo === 84 && tipo === 0))) {
      throw new ErroFluigctl(`o ProcessStateTrigger do estado ${seq} ainda não é coberto pelo pull`, 6);
    }
    gatilhosPorEstado.set(seq, [...(gatilhosPorEstado.get(seq) ?? []), g]);
  }
  const todosLinks = lista('ProcessLink').filter((l) => porSeq.has(numero(l, 'initialStateSequence')) && porSeq.has(numero(l, 'finalStateSequence')));
  const linksDeEvento = todosLinks.filter((l) => porSeq.get(numero(l, 'initialStateSequence'))?.tipo === 36 && porSeq.get(numero(l, 'finalStateSequence'))?.tipo === 42);
  const capturaPorLancamento = new Map<number, Estado>();
  for (const l of linksDeEvento) {
    const de = numero(l, 'initialStateSequence');
    const para = porSeq.get(numero(l, 'finalStateSequence'))!;
    const anterior = capturaPorLancamento.get(de);
    if (anterior && anterior.id !== para.id) throw new ErroFluigctl(`o evento de link ${de} aponta para mais de um recebimento`, 6);
    capturaPorLancamento.set(de, para);
  }
  // O Studio sintetiza estes links ao exportar; eles não existem como SequenceFlow no `.process`.
  const links = todosLinks.filter((l) => !linksDeEvento.includes(l));
  const associacoes = lista('ProcessLinkAssoc');
  const entrada = new Map<string, string[]>(), saida = new Map<string, string[]>();
  links.forEach((l) => {
    const id = `flow${numero(filhos(l, 'processLinkPK')[0], 'linkSequence')}`;
    const de = porSeq.get(numero(l, 'initialStateSequence'))!.id, para = porSeq.get(numero(l, 'finalStateSequence'))!.id;
    saida.set(de, [...(saida.get(de) ?? []), id]); entrada.set(para, [...(entrada.get(para) ?? []), id]);
  });
  associacoes.forEach((l) => {
    const id = `flow${numero(filhos(l, 'processLinkAssocPK')[0], 'linkSequence')}`;
    const de = graficoPorSeq.get(numero(l, 'initialStateSequence'))?.id;
    const para = porSeq.get(numero(l, 'finalStateSequence'))?.id;
    if (!de || !para) throw new ErroFluigctl(`a associação ${id} aponta para componente ou estado inexistente`, 6);
    saida.set(de, [...(saida.get(de) ?? []), id]); entrada.set(para, [...(entrada.get(para) ?? []), id]);
  });

  const porEstado = (nome: string, campo = 'stateSequence'): Map<number, No[]> => {
    const m = new Map<number, No[]>();
    for (const n of lista(nome)) {
      const seq = numero(n, campo);
      m.set(seq, [...(m.get(seq) ?? []), n]);
    }
    return m;
  };
  const apps = porEstado('ProcessAppConfiguration');
  const regrasAnexo = porEstado('ProcessAttachmentRules');
  const relacoesSub = porEstado('SubProcessFieldRelationship');

  const objetos: string[] = [];
  const raias = lista('SwimLane');
  const raiaIds = new Map<number, string>();
  raias.forEach((r, i) => {
    const tipo = numero(r, 'type');
    const id = tipo === 1 ? `bpmnpool${i + 1}` : tipo === 2 ? `bpmnswimlane${i + 1}` : `bpmngroup${i + 1}`;
    raiaIds.set(numero(filhos(r, 'swimLanePK')[0], 'sequence', i + 1), id);
    const tag = tipo === 1 ? 'BpmnPool' : tipo === 2 ? 'BpmnSwimLane' : 'BpmnGroup';
    objetos.push(`  <bpmn2:${tag} id="${id}" name="${attr(texto(r, 'stateName'))}" cores="${attr(texto(r, 'color'))}"/>`);
  });
  graficos.forEach((g) => {
    const a = [`id="${g.id}"`, `name="${attr(g.nome)}"`, 'type="0"'];
    if (g.tipo === 2) a.push(`documentId="${attr(texto(g.no, 'stateName'))}"`);
    if (saida.get(g.id)?.length) a.push(`outgoing="${saida.get(g.id)!.join(' ')}"`);
    objetos.push(`  <bpmn2:${g.tag} ${a.join(' ')}/>`);
  });
  estados.forEach((e) => {
    const n = e.no; const a: string[] = [`id="${e.id}"`, `name="${attr(texto(n, 'stateName'))}"`];
    if (entrada.get(e.id)?.length) a.push(`incoming="${entrada.get(e.id)!.join(' ')}"`);
    if (saida.get(e.id)?.length) a.push(`outgoing="${saida.get(e.id)!.join(' ')}"`);
    a.push(`type="${e.tipo}"`);
    if (![100, 101].includes(e.tipo)) a.push('extendedFields="&lt;list/>"');
    const mecanismo = texto(n, 'engineAllocationId');
    const config = atribuicao(mecanismo, texto(n, 'engineAllocationConfiguration'));
    if (e.tipo === 10 && config) a.push(`initializerConfiguration="${attr(config)}"`);
    else if (e.tipo === 101 && config) a.push(`managerMechanism="${attr(mecanismo)}"`, `managerAssignmentController="${attr(config)}"`);
    else if (config) a.push(`managerMechanism="${attr(mecanismo)}"`, `managerAssignmentControllerString="${attr(config)}"`);
    if ([120, 121].includes(e.tipo)) {
      const condition = blobCondicoes(e.seq);
      if (condition) a.push(`condition="${attr(condition)}"`);
    }
    if ([10, 80, 81, 82, 84, 87].includes(e.tipo)) {
      const camposBooleanos: [string, string, boolean][] = [
        ['notifyAuthorityDelay', 'emAtrasoNotificarResponsavel', e.tipo === 68 ? false : true],
        ['notifyRequisitionerDelay', 'emAtrasoNotificarRequisitante', false],
        ['notifyManagerDelay', 'emAtrasoNotificarGestor', false],
        ['notifyRequisitionerFollowUp', 'notificaRequisitante', false],
        ['notifyManagerFollowUp', 'notificaGestor', false],
        ['inhibitTransfer', 'inibeOpcaoTransferir', false], ['digitalSignature', 'confirmarSenha', false],
      ];
      if (![80,81,82,84,87].includes(e.tipo)) camposBooleanos.push(['notifyAuthorityFollowUp', 'notificaResponsavel', false]);
      for (const [campo, atributo, padrao] of camposBooleanos) if (texto(n, campo, String(padrao)) !== String(padrao)) a.push(`${atributo}="${texto(n, campo)}"`);
      const tempos: [string, string, number][] = [
        ['allowanceAuthorityTime', 'emAtrasoNotificarResponsavelTolerancia', e.tipo === 60 || e.tipo === 64 || e.tipo === 65 || e.tipo === 68 ? 0 : 3600],
        ['frequenceAuthorityTime', 'emAtrasoNotificarResponsavelFrequencia', e.tipo === 60 || e.tipo === 64 || e.tipo === 65 || e.tipo === 68 ? 1 : 3600],
        ['allowanceRequisitionerTime', 'emAtrasoNotificarRequisitanteTolerancia', 0], ['frequenceRequisitionerTime', 'emAtrasoNotificarRequisitanteFrequencia', 0],
        ['allowanceManagerTime', 'emAtrasoNotificarGestorTolerancia', 0], ['frequenceManagerTime', 'emAtrasoNotificarGestorFrequencia', 0],
      ];
      for (const [campo, atributo, padrao] of tempos) if (numero(n, campo, padrao) !== padrao) a.push(`${atributo}="${numero(n, campo) / 60}"`);
    }
    if ([60, 64, 65, 68].includes(e.tipo)) {
      const esperado = e.tipo === 68 ? 'false' : 'true';
      if (texto(n, 'notifyAuthorityDelay', esperado) !== esperado) {
        throw new ErroFluigctl(
          `o fim ${e.id} é do tipo ${e.tipo} com notifyAuthorityDelay=${texto(n, 'notifyAuthorityDelay')}, ` +
            'e o .process não tem campo para isso: no fim terminal (68) o Studio grava false sempre ' +
            '(`getProcessStateFromEndEvents`, decompilado). Republicar gravaria false. ' +
            'Ajuste o valor no servidor antes de baixar.',
          6,
        );
      }
      if (texto(n, 'notifyRequisitionerFollowUp') === 'true') a.push('notificaRequisitante="true"');
    }
    if (numero(n, 'signalId')) a.push(`signalId="${numero(n, 'signalId')}"`);
    if (e.tipo === 36) {
      const captura = capturaPorLancamento.get(e.seq);
      if (!captura) throw new ErroFluigctl(`o evento de link ${e.id} não aponta para um recebimento`, 6);
      a.push(`linkId="${captura.id}"`);
    }
    if (e.tipo === 43) {
      const pai = numero(n, 'parentSequence');
      const tarefa = porSeq.get(pai);
      a.push(`parentTask="${tarefa!.id}"`, `linkId="${tarefa!.id}"`, `sequenceAttached="${pai}"`);
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
      if (e.tipo === 84) {
        const gs = gatilhosPorEstado.get(e.seq) ?? [];
        if (gs.length !== 1 || numero(gs[0], 'type') !== 0) throw new ErroFluigctl(`a tarefa de e-mail ${e.id} precisa ter um gatilho type 0`, 6);
        const valor = texto(gs[0], 'value');
        const campo = (nome: string) => new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`).exec(valor)?.[1] ?? '';
        const message = `<org.eclipse.bpmn2.documentacional.BpmnMessageData>${elemento('type', campo('Type'))}${elemento('receiver', campo('Receiver'))}${elemento('subject', campo('Subject'))}${elemento('content', campo('Content'))}</org.eclipse.bpmn2.documentacional.BpmnMessageData>`;
        a.push(`messageData="${attr(message)}"`);
      }
      const auth = boolAttr(n, 'notifyAuthorityFollowUp'); if (auth !== undefined) a.push(`authNotify="${auth}"`);
      a.push(`selecionaColaboradores="${numero(n, 'selectColleague')}"`);
      if (numero(n, 'deadlineTime')) a.push(`prazoConclusao="${numero(n, 'deadlineTime') / 60}"`);
      if (texto(n, 'deadlineFieldName')) a.push(`deadlineFieldName="${attr(texto(n, 'deadlineFieldName'))}"`);
      if (texto(n, 'instruction')) a.push(`instrucoes="${attr(texto(n, 'instruction'))}"`);
      if (texto(n, 'joint') === 'true') a.push('atividadeConjunta="true"');
      if (numero(n, 'agreementPercentage')) a.push(`consenso="${numero(n, 'agreementPercentage')}"`);
      if (texto(n, 'periodId')) a.push(`expediente="${attr(texto(n, 'periodId'))}"`);
      if (e.tipo === 82) {
        const erros = errosPorTarefa.get(e.seq) ?? [];
        if (erros.length) a.push(`attachedEvents="${erros.map((x) => x.id).join(' ')}"`);
        const servico = lista('ProcessStateService').find((s) => numero(s, 'sequence') === e.seq);
        a.push(`executionType="${numero(n, 'executionType')}"`);
        if (servico) {
          if (filhos(servico, 'serviceName').length) a.push(`serviceName="${attr(texto(servico, 'serviceName'))}"`);
          if (filhos(servico, 'sucessFullMessage').length) a.push(`executionSucessfulMessage="${attr(texto(servico, 'sucessFullMessage'))}"`);
          a.push(`executionAttempts="${numero(servico, 'attempts')}"`, `frequency="${numero(servico, 'frequency')}"`, `frequencyType="${numero(servico, 'frequencyType')}"`);
        }
      }
    }
    if (e.tipo === 101) {
      if (texto(n, 'instruction')) a.push(`instructions="${attr(texto(n, 'instruction'))}"`);
      if (texto(n, 'initialState') === 'true') a.push('initialTask="true"');
      a.push(`selectColleague="${numero(n, 'selectColleague', 1)}"`);
    }
    if (e.tipo === 100) {      a.push(`process="${attr(texto(n, 'subProcessId'))}"`);
      if (texto(n, 'transferAttachments') === 'true') a.push('transferAttachments="true"');
      if (texto(n, 'cancelSubProcess') === 'true') a.push('cancelSubProcess="true"');
      if (texto(n, 'sendToNextTaskInSubProcess') === 'true') a.push('sendToNextTaskInSubProcess="true"');
      const maps = relacoesSub.get(e.seq) ?? [];
      if (maps.length) a.push(`formMaps="${attr(blobLista('org.eclipse.bpmn2.impl.BpmnProcessFormMap', maps.map((m) => ({ processField: texto(m, 'processField'), subProcessField: texto(m, 'subProcessField'), mapFlow: numero(m, 'mapFlow') }))))}"`);
    }
    const configuracoes = apps.get(e.seq) ?? [];
    if (configuracoes.length) {
      const chaves = new Set(configuracoes.map((c) => texto(c, 'appKey')));
      if (chaves.size !== 1) throw new ErroFluigctl(`a tarefa ${e.id} tem mais de um appKey`, 6);
      const itens = configuracoes.map((c) => `<org.eclipse.bpmn2.documentacional.BpmnProcessAppConfiguration>${elemento('appField', texto(c, 'appField'))}${elemento('description', texto(c, 'description'))}</org.eclipse.bpmn2.documentacional.BpmnProcessAppConfiguration>`).join('');
      a.push(`appsConfiguration="${attr(`<map><entry><string>${attr([...chaves][0]!)}</string><list>${itens}</list></entry></map>`)}"`);
    }
    const anexos = regrasAnexo.get(e.seq) ?? [];
    if (anexos.length) a.push(`attachmentRules="${attr(blobLista('org.eclipse.bpmn2.documentacional.BpmnProcessAttachmentRules', anexos.map((r, i) => ({ id: i, message: texto(r, 'message'), operator: numero(r, 'operator'), amount: texto(r, 'amount'), name: texto(r, 'name') }))))}"`);
    objetos.push(`  <bpmn2:${e.tag} ${a.join(' ')}/>`);
  });
  const propriedades = lista('ExtendedPropertyField').filter((p) => numero(filhos(p, 'extendedPropertyFieldPK')[0], 'stateSequence') === 0);
  const extendedFields = propriedades.length
    ? blobLista('org.eclipse.bpmn2.impl.ExtendedPropertyImpl', propriedades.map((p) => ({
        propertyName: texto(filhos(p, 'extendedPropertyFieldPK')[0], 'propertyName'), propertyType: numero(p, 'propertyType'),
        propertyDescription: texto(p, 'propertyDescription'), propertyValue: texto(p, 'propertyValue'), isDefaultProperty: texto(p, 'isDefaultProperty', 'false'),
      })))
    : '<list/>';
  const descritores = lista('ProcessFormField');
  const descriptorFields = descritores.length
    ? blobLista('org.eclipse.bpmn2.impl.BpmnProcessFormField', descritores.sort((a, b) => numero(a, 'slotId') - numero(b, 'slotId')).map((p) => ({
        id: texto(filhos(p, 'processFormFieldPK')[0], 'fieldId'), label: texto(p, 'fieldDescription'), cardIndex: '',
      })))
    : undefined;
  const procAttrs = [
    `id="${attr(processId)}"`, `name="${attr(descricao)}"`, `version="${versao}"`, 'author=""', `extendedFields="${attr(extendedFields)}"`,
    `cardIndex="${attr(texto(pdv, 'formId'))}"`, 'formSource="server"', `category="${attr(texto(pd, 'categoryId'))}"`,
    `volume="${attr(texto(pd, 'volumeId'))}"`, `expedient="${attr(texto(pd, 'periodId'))}"`, `instruction="${attr(texto(pd, 'instruction'))}"`,
  ];
  if (descriptorFields) procAttrs.push(`descriptorFields="${attr(descriptorFields)}"`);
  const processoBooleanos: [No, string, string, boolean][] = [
    [pd, 'active', 'activeProcess', true], [pd, 'publicProcess', 'publicProcess', false],
    [pd, 'uniqueCardVersion', 'uniquecardversion', false], [pd, 'notifyRequisitionerComplements', 'notifyRequisitionerComplements', false],
    [pd, 'notifyAuthorityComplements', 'notifyResponsibleComplements', false], [pdv, 'updateAttachmentsVersion', 'updateAttachment', false],
    [pdv, 'inheritFormSecurity', 'inheritFormSecurity', false], [pdv, 'mobileReady', 'mobileReady', false],
  ];
  for (const [no, campo, atributo, padrao] of processoBooleanos) {
    if (texto(no, campo, String(padrao)) !== String(padrao)) procAttrs.push(`${atributo}="${texto(no, campo)}"`);
  }
  if (numero(pd, 'complementsLevel', 1) !== 1) procAttrs.push(`complementsLevel="${numero(pd, 'complementsLevel')}"`);
  if (numero(pd, 'deadlineTime')) procAttrs.push(`deadlineTime="${numero(pd, 'deadlineTime') / 60}"`);
  if (numero(pd, 'warningDeadlineTime')) procAttrs.push(`warningTime="${numero(pd, 'warningDeadlineTime') / 60}"`);
  if (texto(pd, 'notifyManagerComplements') === 'true') procAttrs.push('notifyManagerComplements="true"');
  if (texto(pdv, 'controlsAttachmentsSecurity') === 'true') procAttrs.push('controlsAttachmentsSecurity="true"');
  const segurancas = lista('ProcessAttachmentSecurity');
  if (segurancas.length) {
    const itens = segurancas.map((s) => {
      const pk = filhos(s, 'processAttachmentSecurityPK')[0];
      const mecanismo = texto(s, 'engineAllocationId');
      const config = atribuicao(mecanismo, texto(s, 'engineAllocationConfiguration'));
      const cfg = config ? `<engineAllocationConfiguration class="${/\.([A-Za-z]+)>/.exec(config)?.[1] ?? ''}">${config.replace(/^<[^>]+>|<\/[^>]+>$/g, '')}</engineAllocationConfiguration>` : '';
      return `<org.eclipse.bpmn2.ECMProcessAttachmentSecurityImpl>${elemento('companyId', 0)}${elemento('processId', '')}${elemento('version', 1)}${elemento('sequence', numero(pk, 'sequence'))}${elemento('engineAllocationId', mecanismo)}${cfg}${elemento('accessLevel', texto(s, 'accessLevel'))}${elemento('editionMode', texto(s, 'editionMode'))}</org.eclipse.bpmn2.ECMProcessAttachmentSecurityImpl>`;
    }).join('');
    procAttrs.push(`processAttachmentSecurity="${attr(`<list>${itens}</list>`)}"`);
  }
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
    if (filhos(l, 'expression').length) a.push(`expression="${attr(texto(l, 'expression'))}"`);
    const movimentos = ['movementTitle', 'movementDescription', 'movementAccessLinkDescription'];
    if (movimentos.some((m) => filhos(l, m).length)) for (const m of movimentos) a.push(`${m}="${attr(texto(l, m))}"`);
    objetos.push(`  <bpmn2:SequenceFlow ${a.join(' ')}/>`);
  });
  associacoes.forEach((l) => {
    const seq = numero(filhos(l, 'processLinkAssocPK')[0], 'linkSequence');
    const de = graficoPorSeq.get(numero(l, 'initialStateSequence'))!, para = porSeq.get(numero(l, 'finalStateSequence'))!;
    objetos.push(`  <bpmn2:SequenceFlow id="flow${seq}" name="" sourceRef="${de.id}" targetRef="${para.id}" atividadeFluxo="" atividadeRetorno="" extendedFields="&lt;list/>"/>`);
  });

  const indiceDaLigacao = new Map([
    ...links.map((l) => `flow${numero(filhos(l, 'processLinkPK')[0], 'linkSequence')}`),
    ...associacoes.map((l) => `flow${numero(filhos(l, 'processLinkAssocPK')[0], 'linkSequence')}`),
  ].map((f, i) => [f, i]));
  const shapes: string[] = [];
  const shapeIndex = new Map<string, number>();
  const addShape = (id: string, x: number, y: number, w: number, h: number, forma: 'Rectangle'|'Ellipse' = 'Rectangle') => {
    const i = shapes.length; shapeIndex.set(id, i);
    // A âncora lista as ligações dos dois lados, como o Studio grava; o índice
    // é a posição do fluxo em connections (os links, depois as associações).
    const refs = (fluxos: string[] | undefined) => fluxos?.map((f) => `/0/@connections.${indiceDaLigacao.get(f)}`).join(' ');
    const out = refs(saida.get(id)), inc = refs(entrada.get(id));
    shapes.push(`    <children xsi:type="pi:ContainerShape" visible="true" active="true"><graphicsAlgorithm xsi:type="al:${forma}" lineWidth="1" width="${w}" height="${h}" x="${x}" y="${y}"/><link businessObjects="${id}"/><anchors xsi:type="pi:ChopboxAnchor"${out ? ` outgoingConnections="${out}"` : ''}${inc ? ` incomingConnections="${inc}"` : ''}/></children>`);
  };
  const lanesPorPool = new Map<number, No[]>();
  for (const r of raias.filter((x) => numero(x, 'type') === 2)) {
    const pai = numero(r, 'parentSequence');
    lanesPorPool.set(pai, [...(lanesPorPool.get(pai) ?? []), r]);
  }
  for (const [i, r] of raias.entries()) {
    const tipo = numero(r, 'type');
    if (tipo === 2) continue;
    if (tipo === 3) { addShape(raiaIds.get(numero(filhos(r,'swimLanePK')[0],'sequence',i+1))!, numero(r,'positionX'), numero(r,'positionY'), numero(r,'width',300), numero(r,'height',150)); continue; }
    const seq = numero(filhos(r, 'swimLanePK')[0], 'sequence', i + 1);
    const id = raiaIds.get(seq)!;
    const filhosLane = (lanesPorPool.get(seq) ?? []).map((lane) => {
      const lid = raiaIds.get(numero(filhos(lane,'swimLanePK')[0],'sequence'))!;
      return `<children xsi:type="pi:ContainerShape" visible="true" active="true"><graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="${numero(lane,'width',870)}" height="${numero(lane,'height',150)}" x="${numero(lane,'positionX')-numero(r,'positionX')}" y="${numero(lane,'positionY')-numero(r,'positionY')}"/><link businessObjects="${lid}"/></children>`;
    }).join('');
    const top = shapes.length; shapeIndex.set(id, top);
    shapes.push(`    <children xsi:type="pi:ContainerShape" visible="true" active="true"><graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="${numero(r,'width',900)}" height="${numero(r,'height',300)}" x="${numero(r,'positionX')}" y="${numero(r,'positionY')}"/><link businessObjects="${id}"/><anchors xsi:type="pi:ChopboxAnchor"/>${filhosLane}</children>`);
  }
  graficos.forEach((g) => addShape(g.id, g.x, g.y, g.tipo === 1 ? 120 : 50, g.tipo === 1 ? 50 : 60));
  estados.forEach((e) => addShape(e.id, e.x, e.y, [10,32,35,36,37,41,42,43,60,64,65,68].includes(e.tipo) ? 35 : 106, [10,32,35,36,37,41,42,43,60,64,65,68].includes(e.tipo) ? 35 : 67, [10,32,35,36,37,41,42,43,60,64,65,68].includes(e.tipo) ? 'Ellipse' : 'Rectangle'));
  const connections = links.map((l) => {
    const seq = numero(filhos(l,'processLinkPK')[0], 'linkSequence'); const de = porSeq.get(numero(l,'initialStateSequence'))!, para = porSeq.get(numero(l,'finalStateSequence'))!;
    const bends = lista('ProcessLinkBend').filter((b) => numero(filhos(b,'processLinkBendPK')[0], 'linkSequence') === seq).map((b) => `<bendpoints x="${numero(b,'positionX')}" y="${numero(b,'positionY')}"/>`).join('');
    return `    <connections xsi:type="pi:FreeFormConnection" visible="true" active="true" start="/0/@children.${shapeIndex.get(de.id)}/@anchors.0" end="/0/@children.${shapeIndex.get(para.id)}/@anchors.0"><graphicsAlgorithm xsi:type="al:Polyline" lineWidth="1"/><link businessObjects="flow${seq}"/>${bends}</connections>`;
  });
  connections.push(...associacoes.map((l) => {
    const seq = numero(filhos(l,'processLinkAssocPK')[0], 'linkSequence');
    const de = graficoPorSeq.get(numero(l,'initialStateSequence'))!, para = porSeq.get(numero(l,'finalStateSequence'))!;
    return `    <connections xsi:type="pi:FreeFormConnection" visible="true" active="true" start="/0/@children.${shapeIndex.get(de.id)}/@anchors.0" end="/0/@children.${shapeIndex.get(para.id)}/@anchors.0"><graphicsAlgorithm xsi:type="al:Polyline" lineWidth="1"/><link businessObjects="flow${seq}"/></connections>`;
  }));
  const nome = attr(nomeDoArquivo ?? processId);
  const process = `<?xml version="1.0" encoding="ASCII"?>\n<xmi:XMI xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:al="http://eclipse.org/graphiti/mm/algorithms" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL-XMI" xmlns:pi="http://eclipse.org/graphiti/mm/pictograms">\n  <pi:Diagram visible="true" gridUnit="10" diagramTypeId="BPMNdiagram" name="${nome}" snapToGrid="true" version="0.16.0"><graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="1200" height="1000"/>\n${shapes.join('\n')}\n${connections.join('\n')}\n  </pi:Diagram>\n${objetos.join('\n')}\n</xmi:XMI>\n`;
  // O pictograma acima é só a geometria; o visual (estilos, cores, rótulos,
  // setas) é o mesmo reparo do diagram check --fix, para o Studio mostrar as formas.
  return { processId, process: garantirVisual(process) };
}
