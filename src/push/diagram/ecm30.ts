import { ErroFluigctl } from '../../errors.js';
import { codificar } from '../process-events.js';
import { lerDiagrama, type Caixa, type Diagrama, type ObjetoBpmn } from './modelo.js';
import { decodificarEntidades, escaparTexto, filhos, lerXml, type No } from './xml.js';

/**
 * Converte o `.process` no XML que `ECMWorkflowEngineService.importProcess`
 * aceita — o formato do `.ecm30.xml` que o Studio exporta: uma `<list>` com 20
 * filhos, sempre na mesma ordem (ver docs/plano-push-diagrama.md).
 *
 * Ideia portada de `fluig-cd/src/core/processConverter.ts` (fluiglocaldev,
 * StrategiConsultoria), com correções medidas contra o Studio: a PK de
 * State/Link/Lane leva `version=1`, enquanto a `ProcessDefinitionVersion` e a
 * PK do `ProcessLinkBend` levam a versão do `.process`; e
 * `ProcessDefinitionVersion.processId` é a descrição do processo (118/118).
 * Como no fluig-cd, o `sequence` da raia é a posição entre pools e lanes na
 * ordem do arquivo, não o sufixo do id. Como lá, nenhum campo que os ecm30 do Studio
 * não tenham é emitido: o XStream do Fluig 1.8.2 aborta em campo desconhecido.
 *
 * Fase 1: pool, lane, início, tarefas (de usuário e de serviço), gateways
 * exclusivo/paralelo/join com condições, eventos intermediários (temporizador,
 * condicional, sinal, erro anexado), fim, anotação, fluxo de sequência,
 * bendpoints e — quando quem chama passa — os scripts. Qualquer outra coisa é
 * recusada com código 6 listando o que falta — nunca um XML parcial.
 */

export interface OpcoesConversao {
  companyId: number;
  /** formId já resolvido; sem ele, vale o `cardIndex` numérico do `.process`. */
  formId?: number;
  /**
   * Só para o harness diferencial: em vez de recusar, pula o que não é
   * suportado e converte o resto. Nunca usado para gerar o que vai ao servidor.
   */
  parcial?: boolean;
  /**
   * Scripts do processo por eventId (`workflow/scripts/<processId>.<eventId>.js`).
   * Cada um vira um `WorkflowProcessEvent`, como o Studio faz — inclusive o
   * código da tarefa de serviço (`servicetaskN`). Sem eles, o filho 6 sai vazio.
   */
  scripts?: Map<string, string>;
}

export interface ResultadoConversao {
  processId: string;
  versao: number;
  cardIndex: string;
  formId: number;
  xml: string;
  contagens: {
    estados: number;
    links: number;
    raias: number;
    dobras: number;
    condicoes: number;
    eventos: number;
    anotacoes: number;
  };
  avisos: string[];
  /** Vazio, a não ser em modo parcial. */
  naoSuportados: string[];
}

/** `{ xml }` é texto já codificado (o script, pelas regras do `aplicarScripts`). */
type Valor = string | number | boolean | Campo[] | null | { xml: string };
/** `null` sai como `<campo/>`, do jeito que o Studio escreve lista vazia. */
type Campo = [string, Valor];

const TAREFAS = new Set(['80', '81', '82', '84', '87']);
const SERVICO = '82';
const FINS = new Set(['60', '64', '65', '68']);
/** `stateType` de cada gateway; o 121 só aparece num ecm30, sem `.process` que o mostre. */
const GATEWAYS: Record<string, number> = { '120': 1, '126': 3, '127': 4 };
/**
 * 32 temporizador, 35 condicional, 37/41 sinal (envio/recebimento), 43 erro
 * anexado a tarefa de serviço, 36/42 link (envio/recebimento). O link não tem
 * campo próprio no estado: o Studio liga os dois lados com `ProcessLink`s que
 * não estão no `.process` (ver `linksDeEvento`).
 */
const INTERMEDIARIOS = new Set(['32', '35', '36', '37', '41', '42', '43']);
/** O sinal não usa o nome na descrição: o Studio grava um texto fixo mais o `signalId`. */
const DESCRICAO_SINAL: Record<string, string> = {
  '37': 'Intermediário Sinal ',
  '41': 'Intermediário Recebimento Sinal ',
};
const INSTRUCAO_INTERMEDIARIO: Record<string, string> = {
  '37': 'Evento intermediário por sinal. Aguardando envio do sinal ',
  '41': 'Evento intermediário por recebimento de sinal. Aguardando recebimento do sinal ',
};
/** `runType` do `BpmnTriggerData` → número do `ProcessStateTrigger` (medido nos pares). */
const RUN_TYPE: Record<string, number> = { MINUTE: 0, HOUR: 1, DAY: 2 };
const CONFIGURACAO_DO_CAMINHO = 'mecanismoAtribuicaoConfiguracao';

/** Atributos que alimentam filhos ainda não gerados: presentes, o XML ficaria incompleto. */
const ATRIBUTOS_NAO_SUPORTADOS: Record<string, string> = {
  appsConfiguration: 'configuração de app (appsConfiguration)',
  attachmentRules: 'regras de anexo (attachmentRules)',
  descriptorFields: 'campos descritores (descriptorFields)',
};

const EM_ATRASO = ['Responsavel', 'Requisitante', 'Gestor'].flatMap((quem) =>
  ['', 'Tolerancia', 'Frequencia'].map((sufixo) => `emAtrasoNotificar${quem}${sufixo}`),
);
const EXPIRACAO = ['noticeExpirationAuthorityTime', 'noticeExpirationRequisitionerTime', 'noticeExpirationManagerTime'];
/**
 * Texto de movimentação do fluxo. Quando o `.process` tem os três, o Studio
 * grava os três no `ProcessLink`, com o mesmo valor — mas em nenhum par o valor
 * é não vazio, então só o vazio é aceito (ver VALOR_NEUTRO).
 */
const MOVIMENTO = ['movementTitle', 'movementDescription', 'movementAccessLinkDescription'];
/** Da tarefa de serviço (82): viram `executionType` e `ProcessStateService`. */
const SERVICO_ATRIBUTOS = [
  'serviceName', 'scriptFileName', 'attachedEvents', 'executionType', 'executionSucessfulMessage', 'frequencyType',
];

/**
 * Atributos que a conversão conhece, por tipo de objeto. Os que não viram campo
 * (autor, servidor de origem...) são do Studio e não vão ao servidor — conferido
 * nos pares. Qualquer outro atributo é recusado: descartá-lo em silêncio poderia
 * publicar um processo diferente do desenhado.
 */
const ATRIBUTOS_CONHECIDOS: Record<string, string[]> = {
  BpmnProcess: [
    'id', 'name', 'version', 'cardIndex', 'managerMechanism', 'managerAssignmentController', 'category',
    'volume', 'expedient', 'instruction', 'complementsLevel', 'notifyResponsibleComplements',
    'notifyRequisitionerComplements', 'publicProcess', 'mobileReady', 'inheritFormSecurity',
    'descriptionVersion', 'updateAttachment', 'uniquecardversion', 'extendedFields',
    // Só do Studio: o ecm30 não tem onde guardar, e keyWord sai sempre vazio (118/118).
    'serverId', 'author', 'formSource', 'formType', 'keyWord',
  ],
  BpmnStartEvent: [
    'id', 'name', 'incoming', 'outgoing', 'type', 'extendedFields', 'signalId', 'expediente', 'selecionaColaboradores',
    'esforcoCalculo', 'initializerConfiguration', 'instrucoes', 'prazoConclusao', 'notificaResponsavel',
    'notificaRequisitante', 'notificaGestor', 'inibeOpcaoTransferir', ...EM_ATRASO, ...EXPIRACAO,
  ],
  BpmnTask: [
    'id', 'name', 'incoming', 'outgoing', 'type', 'extendedFields', 'managerMechanism',
    'managerAssignmentControllerString', 'loopType', 'authNotify', 'expediente', 'atividadeConjunta',
    'consenso', 'selecionaColaboradores', 'esforcoCalculo', 'executionAttempts', 'frequency', 'instrucoes',
    'prazoConclusao', 'deadlineFieldName', 'notificaRequisitante', 'notificaGestor', 'inibeOpcaoTransferir',
    'confirmarSenha', ...EM_ATRASO, ...EXPIRACAO,
  ],
  BpmnEndEvent: ['id', 'name', 'incoming', 'type', 'extendedFields', 'signalId', 'notificaRequisitante'],
  BpmnGateway: ['id', 'name', 'incoming', 'outgoing', 'type', 'extendedFields', 'condition'],
  BpmnIntermediateEvent: [
    'id', 'name', 'incoming', 'outgoing', 'type', 'extendedFields', 'sequenceAttached', 'signalId', 'linkId',
    'parentTask', 'trigger',
  ],
  BpmnAnnotation: ['id', 'name', 'outgoing', 'type'],
  SequenceFlow: [
    'id', 'name', 'sourceRef', 'targetRef', 'atividadeFluxo', 'atividadeRetorno', 'extendedFields',
    'fluxoAutomatico', 'permiteRetorno', 'defaultLink', ...MOVIMENTO,
  ],
  BpmnPool: ['id', 'name', 'cores'],
  BpmnSwimLane: ['id', 'name', 'cores'],
};

/** Atributos conhecidos que não viram campo; só o valor neutro é aceito. */
const VALOR_NEUTRO: Record<string, string> = {
  esforcoCalculo: '0', loopType: '0', executionAttempts: '0', frequency: '0',
  movementTitle: '', movementDescription: '', movementAccessLinkDescription: '',
};
/** Na tarefa de serviço, tentativas e frequência viram campo do `ProcessStateService`. */
const CAMPOS_DO_SERVICO = new Set(['executionAttempts', 'frequency']);

const sufixo = (id: string | undefined): number => Number(/(\d+)$/.exec(id ?? '')?.[1] ?? 0);

/** Minutos do `.process` (`"480.0"`) para os segundos do servidor. */
const segundos = (minutos: string | undefined, padrao: number): number =>
  minutos === undefined || minutos === '' ? padrao : Math.round(Number(minutos) * 60);

const booleano = (valor: string | undefined, padrao: boolean): boolean =>
  valor === undefined || valor === '' ? padrao : valor === 'true';

function lerBlob(blob: string | undefined): { classe: string; campos: Record<string, string> } | undefined {
  if (!blob) return undefined;
  const classe = /^\s*<([\w.]+)/.exec(blob)?.[1];
  if (!classe) return undefined;
  const campos: Record<string, string> = {};
  for (const m of blob.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) campos[m[1]!] ??= decodificarEntidades(m[2]!);
  return { classe: classe.replace(/^.*\./, ''), campos };
}

/**
 * Lê um blob XStream que vale como documento (`<list>` de condições, o
 * `BpmnTriggerData`) com o mesmo tokenizer do `.process`: o atributo já chega
 * decodificado. Ilegível volta `undefined`, para virar recusa.
 */
function arvoreDoBlob(blob: string): No | undefined {
  try {
    const raiz = lerXml(blob).filhos;
    return raiz.length === 1 ? raiz[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Folhas de um elemento XStream; `undefined` se um filho não é folha ou se repete. */
function folhas(no: No): Map<string, string> | undefined {
  const campos = new Map<string, string>();
  for (const f of no.filhos) {
    if (f.filhos.length > 0 || campos.has(f.nome)) return undefined;
    campos.set(f.nome, f.texto);
  }
  return campos;
}

interface Atribuicao {
  id?: string;
  configuracao?: string;
}

/**
 * Nenhum par do Studio tem `<`, `>`, `&` ou aspas num grupo, papel, usuário ou
 * campo, então não se sabe se o Studio escapa o valor dentro da string; na
 * dúvida, recusa.
 */
const controlador = (tag: string, valor: string | undefined): Atribuicao['configuracao'] =>
  valor === undefined || /[<>&"']/.test(valor)
    ? undefined
    : `<AssignmentController><${tag}>${valor}</${tag}></AssignmentController>`;

const comConfiguracao = (id: string, configuracao: string | undefined): Atribuicao | undefined =>
  configuracao === undefined ? undefined : { id, configuracao };

/**
 * O `managerAssignmentControllerString` do `.process` é um objeto XStream
 * (`org.eclipse.bpmn2.impl.AssignmentController*`); o servidor quer um
 * `<AssignmentController>` simples. Só o que foi conferido contra os pares do
 * Studio está aqui — o resto volta `undefined` e é recusado.
 */
function atribuicao(mecanismo: string, blob: string, idsPorSufixo: (id: string) => number): Atribuicao | undefined {
  const lido = lerBlob(blob);
  return lido ? atribuicaoLida(mecanismo, lido, idsPorSufixo) : undefined;
}

function atribuicaoLida(
  mecanismo: string,
  lido: { classe: string; campos: Record<string, string> },
  idsPorSufixo: (id: string) => number,
): Atribuicao | undefined {
  const c = lido.campos;
  switch (lido.classe) {
    case 'AssignmentControllerPoolGroup':
    case 'AssignmentControllerGroup':
      return comConfiguracao(mecanismo, controlador('Group', c['groupId']));
    case 'AssignmentControllerPoolRole':
    case 'AssignmentControllerRole':
      return comConfiguracao(mecanismo, controlador('Role', c['roleId']));
    case 'AssignmentControllerColleague':
      return comConfiguracao(mecanismo, controlador('User', c['colleagueId']));
    case 'AssignmentControllerFormField':
      return comConfiguracao(mecanismo, controlador('FormField', c['formField']));
    case 'AssignmentControllerExecutorMechanism': {
      // 1 → Last em dezenas de pares; 0 → First em um; 2 não aparece em nenhum par conferível.
      const retorno = { '0': 'First', '1': 'Last' }[c['returns'] ?? ''];
      if (!retorno || !c['idNode']) return undefined;
      return {
        id: mecanismo,
        configuracao:
          `<AssignmentController><BaseActivity>${idsPorSufixo(c['idNode'])}</BaseActivity>` +
          `<Returns>${retorno}</Returns></AssignmentController>`,
      };
    }
    case 'AssignmentControllerCustom':
      return { id: mecanismo, configuracao: '' };
    default:
      return undefined;
  }
}

function serializar(campos: Campo[], nivel: number): string {
  const recuo = '  '.repeat(nivel);
  return campos
    .map(([nome, valor]) => {
      if (valor === null) return `${recuo}<${nome}/>`;
      if (Array.isArray(valor)) return `${recuo}<${nome}>\n${serializar(valor, nivel + 1)}\n${recuo}</${nome}>`;
      if (typeof valor === 'object') return `${recuo}<${nome}>${valor.xml}</${nome}>`;
      return `${recuo}<${nome}>${escaparTexto(String(valor))}</${nome}>`;
    })
    .join('\n');
}

function lista(nome: string, entidades: Campo[][]): Campo {
  return entidades.length === 0 ? ['list', null] : ['list', entidades.map((e): Campo => [nome, e])];
}

export function converterDiagrama(texto: string, opcoes: OpcoesConversao): ResultadoConversao {
  return gerarEcm30(lerDiagrama(texto), opcoes);
}

export function gerarEcm30(diagrama: Diagrama, opcoes: OpcoesConversao): ResultadoConversao {
  const { objetos, caixas, dobras } = diagrama;
  const naoSuportados = new Set<string>();
  const avisos: string[] = [];
  /*
   * Toda recusa precisa ser coletada antes da verificação: uma que chegasse
   * depois sairia como XML com um campo vazio e código 0.
   */
  let verificado = false;
  const recusar = (motivo: string) => {
    if (verificado) throw new Error(`recusa depois da verificação: ${motivo}`);
    naoSuportados.add(motivo);
  };

  const processos = objetos.filter((o) => o.tipo === 'BpmnProcess');
  const processo = processos[0];
  if (!processo || processos.length > 1) {
    throw new ErroFluigctl(
      processo ? 'o .process tem mais de um <bpmn2:BpmnProcess>' : 'o .process não tem <bpmn2:BpmnProcess>',
      6,
    );
  }
  const p = processo.attrs;
  const processId = p['id'] ?? '';
  const descricao = p['name'] ?? '';
  const versao = Number(p['version'] || '1');
  const { companyId } = opcoes;

  const nos = new Map<string, ObjetoBpmn>();
  const inicios: ObjetoBpmn[] = [];
  const tarefas: ObjetoBpmn[] = [];
  const intermediarios: ObjetoBpmn[] = [];
  const gateways: ObjetoBpmn[] = [];
  const fins: ObjetoBpmn[] = [];
  const anotacoes: ObjetoBpmn[] = [];
  /** Pools e lanes na ordem do arquivo. */
  const raiasBpmn: ObjetoBpmn[] = [];
  const fluxos: ObjetoBpmn[] = [];

  for (const o of objetos) {
    const tipo = o.attrs['type'] ?? '';
    if (o.tipo === 'BpmnProcess') continue;
    else if (o.tipo === 'BpmnPool' || o.tipo === 'BpmnSwimLane') raiasBpmn.push(o);
    else if (o.tipo === 'SequenceFlow') fluxos.push(o);
    else if (o.tipo === 'BpmnStartEvent' && tipo === '10') inicios.push(o);
    else if (o.tipo === 'BpmnTask' && TAREFAS.has(tipo)) tarefas.push(o);
    else if (o.tipo === 'BpmnIntermediateEvent' && INTERMEDIARIOS.has(tipo)) intermediarios.push(o);
    else if (o.tipo === 'BpmnGateway' && GATEWAYS[tipo] !== undefined) gateways.push(o);
    else if (o.tipo === 'BpmnEndEvent' && FINS.has(tipo)) fins.push(o);
    else if (o.tipo === 'BpmnAnnotation' && tipo === '0') anotacoes.push(o);
    else {
      recusar(tipo ? `${o.tipo} (type ${tipo})` : o.tipo);
      continue;
    }
    if (o.tipo !== 'SequenceFlow' && o.attrs['id']) nos.set(o.attrs['id'], o);
  }

  /** Na ordem em que o Studio lista os estados: início, tarefas, intermediários, gateways, fim. */
  const estadosBpmn = [...inicios, ...tarefas, ...intermediarios, ...gateways, ...fins];
  const servico = (o: ObjetoBpmn | undefined) => o?.tipo === 'BpmnTask' && o.attrs['type'] === SERVICO;
  const idsDeEstado = new Set(estadosBpmn.map((o) => o.attrs['id'] ?? ''));
  const ehEstado = (id: string | undefined) => id !== undefined && id !== '' && idsDeEstado.has(id);

  for (const o of [processo, ...estadosBpmn, ...anotacoes, ...raiasBpmn, ...fluxos]) {
    const conhecidos = [...(ATRIBUTOS_CONHECIDOS[o.tipo] ?? []), ...(servico(o) ? SERVICO_ATRIBUTOS : [])];
    for (const [attr, valor] of Object.entries(o.attrs)) {
      const rotulo = ATRIBUTOS_NAO_SUPORTADOS[attr];
      if (rotulo) {
        if (valor) recusar(rotulo);
      } else if (!conhecidos.includes(attr)) {
        recusar(`atributo ${attr} em ${o.attrs['id'] ?? o.tipo}`);
      } else if (servico(o) && CAMPOS_DO_SERVICO.has(attr)) {
        if (!/^\d+$/.test(valor)) recusar(`${attr}="${valor}" em ${o.attrs['id']}`);
      } else if (VALOR_NEUTRO[attr] !== undefined && valor !== VALOR_NEUTRO[attr]) {
        recusar(`${attr}="${valor}" em ${o.attrs['id'] ?? o.tipo}`);
      }
    }
    const ext = o.attrs['extendedFields'];
    if (ext && !/^<list\s*\/>$/.test(ext.trim())) recusar('propriedades estendidas (extendedFields)');
  }

  const caixa = (id: string): Caixa => {
    const c = caixas.get(id);
    if (c) return c;
    recusar(`${id} sem forma no diagrama`);
    return { x: 0, y: 0, largura: 0, altura: 0, absX: 0, absY: 0 };
  };

  const pk = (sequencia: Campo[]): Campo[] => [
    ['companyId', companyId],
    ['processId', processId],
    ['version', 1],
    ...sequencia,
  ];

  /*
   * Sem `managerMechanism` no arquivo, a tarefa não leva nenhum dos dois campos;
   * com ele vazio, leva só `engineAllocationId` vazio — como o Studio.
   */
  const atribuicaoDe = (o: ObjetoBpmn, mecanismo: string | undefined, blob: string | undefined): Atribuicao => {
    if (!blob) return mecanismo === undefined ? {} : { id: mecanismo };
    const nome = mecanismo || lerBlob(blob)?.campos['mechanismName'] || '';
    const a = atribuicao(nome, blob, sufixo);
    if (!a) {
      recusar(`atribuição ${lerBlob(blob)?.classe ?? nome} em ${o.attrs['id']}`);
      return {};
    }
    return a;
  };

  const estado = (o: ObjetoBpmn): Campo[] => {
    const a = o.attrs;
    const tipo = a['type'] ?? '';
    const inicio = tipo === '10';
    const tarefa = TAREFAS.has(tipo);
    const fim = FINS.has(tipo);
    const pos = caixa(a['id'] ?? '');
    const at = inicio
      ? atribuicaoDe(o, undefined, a['initializerConfiguration'])
      : tarefa
        ? atribuicaoDe(o, a['managerMechanism'], a['managerAssignmentControllerString'])
        : {};

    const campos: Campo[] = [
      ['processStatePK', pk([['sequence', sufixo(a['id'])]])],
      ['stateName', a['name'] ?? ''],
      ['stateDescription', a['name'] ?? ''],
      ['instruction', fim ? 'Atividade final do processo' : (a['instrucoes'] ?? '')],
      ['deadlineTime', segundos(a['prazoConclusao'], 0)],
    ];
    if (tarefa) campos.push(['deadlineFieldName', a['deadlineFieldName'] ?? '']);
    campos.push(
      ['joint', booleano(a['atividadeConjunta'], false)],
      ['agreementPercentage', a['consenso'] ?? 0],
    );
    if (!tarefa || at.id !== undefined) campos.push(['engineAllocationId', at.id ?? '']);
    if (!tarefa || at.configuracao !== undefined) campos.push(['engineAllocationConfiguration', at.configuracao ?? '']);
    campos.push(
      ['selectColleague', fim ? 0 : (a['selecionaColaboradores'] ?? 1)],
      ['initialState', inicio],
      ['notifyAuthorityDelay', booleano(a['emAtrasoNotificarResponsavel'], true)],
      ['notifyRequisitionerDelay', booleano(a['emAtrasoNotificarRequisitante'], false)],
      ['allowanceAuthorityTime', fim ? 0 : segundos(a['emAtrasoNotificarResponsavelTolerancia'], 3600)],
      ['frequenceAuthorityTime', fim ? 1 : segundos(a['emAtrasoNotificarResponsavelFrequencia'], 3600)],
      ['allowanceRequisitionerTime', segundos(a['emAtrasoNotificarRequisitanteTolerancia'], 0)],
      ['frequenceRequisitionerTime', segundos(a['emAtrasoNotificarRequisitanteFrequencia'], 0)],
      ['transferAttachments', false],
      ['subProcessId', ''],
      ['formFolder', 0],
      ['notifyAuthorityFollowUp', tarefa ? booleano(a['authNotify'], true) : booleano(a['notificaResponsavel'], false)],
      ['notifyRequisitionerFollowUp', booleano(a['notificaRequisitante'], false)],
      ['automatic', false],
      ['positionX', pos.absX],
      ['positionY', pos.absY],
      ['forecastedEffortType', 0],
      ['forecastedEffort', 0],
      ['notifyManagerFollowUp', booleano(a['notificaGestor'], false)],
      ['notifyManagerDelay', booleano(a['emAtrasoNotificarGestor'], false)],
      ['allowanceManagerTime', segundos(a['emAtrasoNotificarGestorTolerancia'], 0)],
      ['frequenceManagerTime', segundos(a['emAtrasoNotificarGestorFrequencia'], 0)],
      ['inhibitTransfer', booleano(a['inibeOpcaoTransferir'], false)],
      ['periodId', a['expediente'] ?? ''],
      ['stateType', fim ? 6 : 0],
      ['bpmnType', tipo],
      ['signalId', a['signalId'] ?? 0],
      ['counterSign', false],
      ['openInstances', 0],
    );
    if (!fim) {
      campos.push(
        ['noticeExpirationAuthorityTime', segundos(a['noticeExpirationAuthorityTime'], 0)],
        ['noticeExpirationRequisitionerTime', segundos(a['noticeExpirationRequisitionerTime'], 0)],
        ['noticeExpirationManagerTime', segundos(a['noticeExpirationManagerTime'], 0)],
      );
    }
    campos.push(['destinationStates', null], ['digitalSignature', booleano(a['confirmarSenha'], false)]);
    if (tarefa) campos.push(['executionType', tipo === SERVICO ? Number(a['executionType'] || 0) : 0]);
    return campos;
  };

  /** Gateway: o Studio grava só estes campos, sem prazo, atribuição nem notificação (415/415). */
  const estadoGateway = (o: ObjetoBpmn): Campo[] => {
    const a = o.attrs;
    const tipo = a['type'] ?? '';
    const pos = caixa(a['id'] ?? '');
    return [
      ['processStatePK', pk([['sequence', sufixo(a['id'])]])],
      ['stateName', a['name'] ?? ''],
      ['stateDescription', a['name'] ?? ''],
      ['joint', false],
      ['initialState', false],
      ['transferAttachments', false],
      ['subProcessId', ''],
      ['formFolder', 0],
      ['automatic', tipo === '120'],
      ['positionX', pos.absX],
      ['positionY', pos.absY],
      ['inhibitTransfer', false],
      ['stateType', GATEWAYS[tipo] ?? 0],
      ['bpmnType', tipo],
      ['signalId', 0],
      ['openInstances', 0],
      ['destinationStates', null],
      ['digitalSignature', false],
    ];
  };

  /*
   * Evento intermediário: tudo constante nos ecm30 (863 estados), menos nome,
   * posição, o `automatic` do temporizador, o `signalId` e o `parentSequence` do
   * erro — a tarefa de serviço a que ele está anexado.
   */
  const estadoIntermediario = (o: ObjetoBpmn): Campo[] => {
    const a = o.attrs;
    const tipo = a['type'] ?? '';
    const pos = caixa(a['id'] ?? '');
    return [
      ['processStatePK', pk([['sequence', sufixo(a['id'])]])],
      ['stateName', a['name'] ?? ''],
      ['stateDescription', DESCRICAO_SINAL[tipo] === undefined ? (a['name'] ?? '') : `${DESCRICAO_SINAL[tipo]}${a['signalId'] ?? ''}`],
      ['instruction', INSTRUCAO_INTERMEDIARIO[tipo] ?? 'Evento intermediário do processo'],
      ['deadlineTime', 0],
      ['joint', false],
      ['agreementPercentage', 0],
      ['engineAllocationId', ''],
      ['engineAllocationConfiguration', ''],
      ['selectColleague', 0],
      ['initialState', false],
      ['notifyAuthorityDelay', true],
      ['notifyRequisitionerDelay', false],
      ['allowanceAuthorityTime', 1],
      ['frequenceAuthorityTime', 1],
      ['allowanceRequisitionerTime', 0],
      ['frequenceRequisitionerTime', 0],
      ['transferAttachments', false],
      ['subProcessId', ''],
      ['formFolder', 0],
      ['notifyAuthorityFollowUp', true],
      ['notifyRequisitionerFollowUp', false],
      ['automatic', tipo === '32'],
      ['positionX', pos.absX],
      ['positionY', pos.absY],
      ['forecastedEffortType', 0],
      ['forecastedEffort', 0],
      ['notifyManagerFollowUp', false],
      ['notifyManagerDelay', false],
      ['frequenceManagerTime', 0],
      ['inhibitTransfer', false],
      ['periodId', ''],
      ['stateType', 0],
      ['bpmnType', tipo],
      ['signalId', a['signalId'] ?? 0],
      ['counterSign', false],
      ['openInstances', 0],
      ['destinationStates', null],
      ['digitalSignature', false],
      ['parentSequence', tipo === '43' ? sufixo(a['parentTask']) : 0],
    ];
  };

  const estados = estadosBpmn.map((o) =>
    o.tipo === 'BpmnGateway' ? estadoGateway(o) : o.tipo === 'BpmnIntermediateEvent' ? estadoIntermediario(o) : estado(o),
  );

  /*
   * Erro anexado: o `.process` guarda o vínculo dos dois lados (`attachedEvents`
   * na tarefa; `parentTask`, `linkId` e `sequenceAttached` no evento). Qualquer
   * desacordo entre eles é recusado — não se sabe qual o Studio usaria.
   */
  for (const o of intermediarios) {
    const a = o.attrs;
    const id = a['id'] ?? '';
    if (a['type'] === '43') {
      const pai = nos.get(a['parentTask'] ?? '');
      const anexados = (pai?.attrs['attachedEvents'] ?? '').split(' ');
      if (!servico(pai) || !anexados.includes(id) || String(sufixo(a['parentTask'])) !== a['sequenceAttached'] ||
        (a['linkId'] !== undefined && a['linkId'] !== a['parentTask'])) {
        recusar(`evento de erro ${id} sem vínculo coerente com a tarefa de serviço`);
      }
    } else if ((a['sequenceAttached'] ?? '0') !== '0' || a['parentTask'] !== undefined ||
      (a['linkId'] !== undefined && a['type'] !== '36')) {
      recusar(`evento intermediário ${id} anexado a outro elemento`);
    }
    if (a['type'] === '36') {
      const capturas = intermediarios.filter((c) => c.attrs['type'] === '42' && c.attrs['id'] === a['linkId']);
      if (!a['linkId'] || capturas.length !== 1) recusar(`evento de link ${id} sem um único recebimento (42) em linkId`);
      if (fluxos.some((f) => f.attrs['sourceRef'] === id)) recusar(`evento de link ${id} (36) com fluxo de saída`);
    }
    if (a['type'] !== '37' && a['type'] !== '41' && (a['signalId'] ?? '0') !== '0') recusar(`signalId em ${id}`);
  }
  for (const o of tarefas.filter(servico)) {
    const a = o.attrs;
    for (const anexo of (a['attachedEvents'] ?? '').split(' ').filter(Boolean)) {
      if (nos.get(anexo)?.attrs['parentTask'] !== a['id']) recusar(`evento anexado ${anexo} em ${a['id']} não aponta de volta`);
    }
    // O código vem de workflow/scripts/<processId>.<id>.js; outro nome é script de outro processo.
    const script = a['scriptFileName'];
    if (script !== undefined && script !== '' && script !== `${processId}.${a['id']}.js`) {
      recusar(`scriptFileName "${script}" em ${a['id']}`);
    }
    if (a['frequencyType'] !== undefined && !/^\d+$/.test(a['frequencyType'])) recusar(`frequencyType em ${a['id']}`);
    if (!/^\d+$/.test(a['executionType'] ?? '')) recusar(`executionType em ${a['id']}`);
  }

  /*
   * Tarefa de serviço → `ProcessStateService`. Frequência 0 (ou ausente) sai 1
   * e `frequencyType` ausente sai 0 (medido em 460 tarefas); `serviceName` só
   * vai quando o `.process` tem o atributo.
   */
  const servicos = tarefas.filter(servico).map((o): Campo[] => {
    const a = o.attrs;
    const campos: Campo[] = [
      ['companyId', companyId],
      ['processId', processId],
      ['version', 1],
      ['sequence', sufixo(a['id'])],
      ['attempts', Number(a['executionAttempts'] || 0)],
      ['sucessFullMessage', a['executionSucessfulMessage'] ?? ''],
    ];
    if (a['serviceName'] !== undefined) campos.push(['serviceName', a['serviceName']]);
    campos.push(
      ['frequency', Number(a['frequency'] || 0) || 1],
      ['frequencyType', Number(a['frequencyType'] || 0)],
    );
    return campos;
  });

  /*
   * Condição do gateway: lista XStream de `ConditionImpl` → um
   * `ConditionProcessState` por caminho (PK com a versão do .process, como a
   * PDV) e as regras em `ConditionProcessAutomaticRules`. Só os campos
   * conferidos são aceitos; atribuição por caminho (`mechanism`) fica recusada.
   */
  const condicoes: Campo[][] = [];
  const regras: Campo[][] = [];
  for (const o of gateways) {
    const a = o.attrs;
    const id = a['id'] ?? '';
    const sequencia = sufixo(id);
    const blob = (a['condition'] ?? '').trim();
    // Exclusivo sem condição: o Studio não grava nenhum ConditionProcessState (um par gabarito).
    if (blob === '' || /^<list\s*\/>$/.test(blob)) continue;
    if (a['type'] !== '120') {
      recusar(`condição em gateway ${id} (type ${a['type']})`);
      continue;
    }
    const lista = arvoreDoBlob(blob);
    if (!lista || lista.nome !== 'list') {
      recusar(`condição ilegível em ${id}`);
      continue;
    }
    // O destino de uma condição precisa ser um estado ao qual sai um fluxo deste gateway.
    const saidas = new Set(fluxos.filter((f) => f.attrs['sourceRef'] === id).map((f) => f.attrs['targetRef'] ?? ''));
    const ordens = new Set<string>();
    for (const c of lista.filhos) {
      const campos = c.nome === 'org.eclipse.bpmn2.impl.ConditionImpl'
        ? folhas({ ...c, filhos: c.filhos.filter((f) => f.nome !== 'rules' && f.nome !== CONFIGURACAO_DO_CAMINHO) })
        : undefined;
      const conhecidos = ['order', 'expression', 'targetTask', 'conditionType', 'mechanism'];
      if (!campos || [...campos.keys()].some((k) => !conhecidos.includes(k))) {
        const extra = campos ? [...campos.keys()].filter((k) => !conhecidos.includes(k)).join(', ') : c.nome;
        recusar(`condição em ${id} com ${extra}`);
        continue;
      }
      const ordem = campos.get('order') ?? '';
      const tipoCondicao = campos.get('conditionType') ?? '';
      const destino = campos.get('targetTask') ?? '';
      if (!/^\d+$/.test(ordem) || (tipoCondicao !== '0' && tipoCondicao !== '1') || !ehEstado(destino)) {
        recusar(`condição ${ordem} de ${id} incompleta ou para destino não suportado`);
        continue;
      }
      if (!saidas.has(destino)) {
        recusar(`condição ${ordem} de ${id} aponta para ${destino}, sem fluxo do gateway até lá`);
        continue;
      }
      if (ordens.has(ordem)) {
        recusar(`condição com order ${ordem} repetido em ${id}`);
        continue;
      }
      ordens.add(ordem);
      const condicao: Campo[] = [
        ['conditionProcessStatePK', [
          ['companyId', companyId],
          ['processId', processId],
          ['expressionOrder', Number(ordem)],
          ['version', versao],
          ['sequence', sequencia],
        ]],
      ];
      if (campos.has('expression')) condicao.push(['condition', campos.get('expression')!]);
      condicao.push(['destinationSequenceId', sufixo(destino)]);
      /*
       * Atribuição do caminho: `mechanism` + `mecanismoAtribuicaoConfiguracao`
       * viram os campos de atribuição da condição, no formato do estado (6/6 nos pares).
       */
      const configuracao = filhos(c, CONFIGURACAO_DO_CAMINHO);
      if (campos.has('mechanism') || configuracao.length > 0) {
        const mecanismo = campos.get('mechanism') ?? '';
        const cf = configuracao.length === 1 ? folhas(configuracao[0]!) : undefined;
        const classe = (configuracao[0]?.attrs['class'] ?? '').replace(/^.*\./, '');
        const at = cf && mecanismo
          ? atribuicaoLida(mecanismo, { classe, campos: Object.fromEntries(cf) }, sufixo)
          : undefined;
        if (!at || at.configuracao === undefined) {
          recusar(`atribuição ${classe || mecanismo} na condição ${ordem} de ${id}`);
        } else {
          condicao.push(['engineAllocationConfiguration', at.configuracao], ['engineAllocationId', at.id ?? '']);
        }
      }
      condicao.push(['conditionType', Number(tipoCondicao)]);
      condicoes.push(condicao);

      const blocosDeRegras = filhos(c, 'rules');
      const listaDeRegras = blocosDeRegras.flatMap((r) => r.filhos);
      if (tipoCondicao === '0' && listaDeRegras.length > 0) recusar(`condição por expressão com regras em ${id}`);
      const ordensDeRegra = new Set<string>();
      for (const r of listaDeRegras) {
        const rf = r.nome === 'com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules' ? folhas(r) : undefined;
        const esperados = ['tenantId', 'version', 'sequence', 'expressionOrder', 'ruleOrder', 'field', 'value', 'operator', 'valueType'];
        // operator e valueType: só inteiros, como nos 1509 que aparecem nos .process (0–9 e 0–1).
        if (!rf || [...rf.keys()].some((k) => !esperados.includes(k)) || rf.get('tenantId') !== '0' || rf.get('version') !== '0' ||
          rf.get('expressionOrder') !== ordem || !/^\d+$/.test(rf.get('ruleOrder') ?? '') ||
          !rf.has('field') || !rf.has('value') ||
          !/^\d+$/.test(rf.get('operator') ?? '') || !/^\d+$/.test(rf.get('valueType') ?? '')) {
          recusar(`regra de condição não suportada em ${id}`);
          continue;
        }
        if (ordensDeRegra.has(rf.get('ruleOrder')!)) {
          recusar(`regra com ruleOrder ${rf.get('ruleOrder')} repetido na condição ${ordem} de ${id}`);
          continue;
        }
        ordensDeRegra.add(rf.get('ruleOrder')!);
        regras.push([
          ['sequence', sequencia],
          ['expressionOrder', Number(ordem)],
          ['ruleOrder', Number(rf.get('ruleOrder'))],
          ['field', rf.get('field') ?? ''],
          ['value', rf.get('value') ?? ''],
          ['operator', Number(rf.get('operator'))],
          ['valueType', Number(rf.get('valueType'))],
        ]);
      }
    }
  }

  /*
   * Temporizador (32) e condicional (35): `BpmnTriggerData` → `ProcessStateTrigger`,
   * com a PK na versão do .process e `triggerSequence` contando 0, 1, 2... na
   * ordem do arquivo. O condicional leva em `value` o nome do script dele —
   * `<processId>.<id>.js`, mesmo quando o blob não traz `scriptCondition`.
   */
  const gatilhos: Campo[][] = [];
  for (const o of intermediarios) {
    const a = o.attrs;
    const id = a['id'] ?? '';
    const tipo = a['type'] ?? '';
    const temGatilho = tipo === '32' || tipo === '35';
    if (!temGatilho) {
      if (a['trigger'] !== undefined) recusar(`trigger em ${id}`);
      continue;
    }
    const arvore = arvoreDoBlob(a['trigger'] ?? '');
    const t = arvore?.nome === 'org.eclipse.bpmn2.documentacional.BpmnTriggerData' ? folhas(arvore) : undefined;
    const conhecidos = ['runType', 'timeTrigger', 'frequencia', 'isCondition', ...(tipo === '35' ? ['scriptCondition'] : [])];
    const runType = RUN_TYPE[t?.get('runType') ?? ''];
    const scriptCondicional = `${processId}.${id}.js`;
    if (!t || [...t.keys()].some((k) => !conhecidos.includes(k)) || runType === undefined ||
      t.get('isCondition') !== 'false' || !/^\d+$/.test(t.get('frequencia') ?? '') ||
      (t.has('scriptCondition') && t.get('scriptCondition') !== scriptCondicional)) {
      recusar(`gatilho não suportado em ${id}`);
      continue;
    }
    const gatilho: Campo[] = [
      ['processStateTriggerPK', [
        ['companyId', companyId],
        ['processId', processId],
        ['version', versao],
        ['stateSequence', sufixo(id)],
        ['triggerSequence', gatilhos.length],
      ]],
      ['runType', runType],
      ['type', tipo === '32' ? 2 : 3],
    ];
    if (tipo === '35') gatilho.push(['value', scriptCondicional]);
    if (t.has('timeTrigger')) gatilho.push(['timeTrigger', t.get('timeTrigger')!]);
    gatilho.push(['frequencia', t.get('frequencia')!]);
    gatilhos.push(gatilho);
  }

  /*
   * Fluxo liga dois estados; associação sai de uma anotação para um estado.
   * Pool, lane ou anotação em qualquer outra ponta é recusada.
   */
  const deAnotacao = (f: ObjetoBpmn) => nos.get(f.attrs['sourceRef'] ?? '')?.tipo === 'BpmnAnnotation';
  const fluxosCobertos = fluxos.filter((f) => {
    if ((deAnotacao(f) || ehEstado(f.attrs['sourceRef'])) && ehEstado(f.attrs['targetRef'])) return true;
    recusar(`fluxo ${f.attrs['id']} ligado a elemento não suportado`);
    return false;
  });
  const fluxosDeEstado = fluxosCobertos.filter((f) => !deAnotacao(f));
  const associacoesBpmn = fluxosCobertos.filter(deAnotacao);

  const links = fluxosDeEstado.map((f): Campo[] => {
    const a = f.attrs;
    const campos: Campo[] = [
      ['processLinkPK', pk([['linkSequence', sufixo(a['id'])]])],
      ['actionLabel', a['atividadeFluxo'] ?? ''],
      ['returnPermited', booleano(a['permiteRetorno'], false)],
      ['initialStateSequence', sufixo(a['sourceRef'])],
      ['finalStateSequence', sufixo(a['targetRef'])],
      ['returnLabel', a['atividadeRetorno'] ?? ''],
      ['name', a['name'] ?? ''],
      ['automaticLink', booleano(a['fluxoAutomatico'], false)],
      ['defaultLink', booleano(a['defaultLink'], false)],
      ['type', 0],
    ];
    const movimento = MOVIMENTO.filter((m) => a[m] !== undefined);
    if (movimento.length === MOVIMENTO.length) for (const m of MOVIMENTO) campos.push([m, a[m] ?? '']);
    else if (movimento.length > 0) recusar(`fluxo ${a['id']} com só parte de ${MOVIMENTO.join('/')}`);
    return campos;
  });

  /*
   * Link (36/42): o Studio grava, para cada fluxo que chega num 36, um
   * `ProcessLink` do 36 ao 42 apontado por `linkId`. Esse link não existe como
   * `SequenceFlow`; o sequence dele é o maior sufixo numérico de id do arquivo
   * (nós e fluxos) + 1, + 2..., na ordem do sufixo do fluxo de entrada (todos os
   * 36 juntos). Nada no estado guarda o `linkId`, e o link não leva `<name>`
   * (ao contrário dos de fluxo). Medido em 29 links de 10 pares.
   */
  const capturasApontadas = new Set<string>();
  const sinteticos = fluxosDeEstado
    .flatMap((f) => {
      const lancamento = nos.get(f.attrs['targetRef'] ?? '');
      if (lancamento?.tipo !== 'BpmnIntermediateEvent' || lancamento.attrs['type'] !== '36') return [];
      const captura = intermediarios.find((c) => c.attrs['type'] === '42' && c.attrs['id'] === lancamento.attrs['linkId']);
      if (!captura) return [];
      capturasApontadas.add(captura.attrs['id'] ?? '');
      return [{ entrada: sufixo(f.attrs['id']), de: sufixo(lancamento.attrs['id']), para: sufixo(captura.attrs['id']) }];
    })
    .sort((x, y) => x.entrada - y.entrada);
  for (const o of intermediarios.filter((c) => c.attrs['type'] === '42')) {
    const id = o.attrs['id'] ?? '';
    if (!capturasApontadas.has(id)) recusar(`evento de link ${id} (42) sem nenhum 36 apontando para ele`);
    if (fluxos.some((f) => f.attrs['targetRef'] === id)) recusar(`evento de link ${id} (42) com fluxo de entrada`);
  }
  const maiorSufixo = Math.max(0, ...objetos.filter((o) => o.tipo !== 'BpmnProcess').map((o) => sufixo(o.attrs['id'])));
  const sequenciasDeFluxo = new Set(fluxosCobertos.map((f) => sufixo(f.attrs['id'])));
  sinteticos.forEach((l, i) => {
    const sequencia = maiorSufixo + 1 + i;
    if (sequenciasDeFluxo.has(sequencia)) recusar(`link de evento com sequence ${sequencia} repetido`);
    links.push([
      ['processLinkPK', pk([['linkSequence', sequencia]])],
      ['actionLabel', ''],
      ['returnPermited', false],
      ['initialStateSequence', l.de],
      ['finalStateSequence', l.para],
      ['returnLabel', ''],
      ['automaticLink', false],
      ['defaultLink', false],
      ['type', 0],
    ]);
  });

  /*
   * Anotação → `ProcessComponGraf` (componType 1); o fluxo que sai dela →
   * `ProcessLinkAssoc`, que não tem rótulo, retorno nem movimentação: com
   * qualquer um deles preenchido, recusa.
   */
  const anotacoesXml = anotacoes.map((o): Campo[] => {
    const pos = caixa(o.attrs['id'] ?? '');
    return [
      ['componType', 1],
      ['positionX', pos.absX],
      ['positionY', pos.absY],
      ['processComponGrafPK', pk([['componGrafSequence', sufixo(o.attrs['id'])]])],
      ['stateName', o.attrs['name'] ?? ''],
    ];
  });
  const associacoes = associacoesBpmn.map((f): Campo[] => {
    const a = f.attrs;
    for (const attr of ['name', 'atividadeFluxo', 'atividadeRetorno', 'fluxoAutomatico', 'permiteRetorno', 'defaultLink']) {
      if (a[attr]) recusar(`${attr} no fluxo de anotação ${a['id']}`);
    }
    return [
      ['processLinkAssocPK', pk([['linkSequence', sufixo(a['id'])]])],
      ['initialStateSequence', sufixo(a['sourceRef'])],
      ['finalStateSequence', sufixo(a['targetRef'])],
    ];
  });

  /*
   * Scripts → `WorkflowProcessEvent`, um por arquivo, codificados como o
   * `aplicarScripts` faz. O Studio lista em ordem de HashMap; aqui vai por eventId.
   */
  const eventos = [...(opcoes.scripts ?? new Map<string, string>())]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([eventId, codigo]): Campo[] => [
      ['workflowProcessEventPK', [
        ['companyId', companyId],
        ['eventId', eventId],
        ['processId', processId],
        ['version', 1],
      ]],
      ['eventDescription', { xml: codificar(codigo) }],
    ]);
  for (const [eventId, codigo] of opcoes.scripts ?? []) {
    // XML 1.0 não admite caractere de controle além de tab, LF e CR.
    const controle = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(codigo);
    if (controle) {
      recusar(`script ${eventId} com caractere de controle U+${controle[0].charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
  }
  if (opcoes.scripts) {
    for (const o of tarefas.filter(servico)) {
      if (!opcoes.scripts.has(o.attrs['id'] ?? '')) avisos.push(`a tarefa de serviço ${o.attrs['id']} não tem script local`);
    }
  }

  /*
   * O sequence da raia é a posição dela entre pools e lanes, na ordem do
   * arquivo — e não o sufixo do id: com lanes criadas depois de outros nós
   * (`swimlane13`), o Studio grava 4, 5... (medido nos pares; ver o harness).
   */
  const sequenciaRaia = new Map(raiasBpmn.map((o, i) => [o.attrs['id'] ?? '', i + 1]));
  const raias = raiasBpmn.map((o): Campo[] => {
    const tipo = o.tipo === 'BpmnPool' ? 1 : 2;
    const c = caixa(o.attrs['id'] ?? '');
    const pai = tipo === 2 ? (sequenciaRaia.get(c.pai ?? '') ?? 0) : 0;
    return [
      ['color', o.attrs['cores'] || 'FFFFFF'],
      ['height', c.altura],
      ['width', c.largura],
      ['positionX', c.absX],
      ['positionY', c.absY],
      ['stateName', o.attrs['name'] ?? ''],
      ['type', tipo],
      ['parentSequence', pai],
      ['swimLanePK', pk([['sequence', sequenciaRaia.get(o.attrs['id'] ?? '') ?? 0]])],
    ];
  });

  const bends: Campo[][] = [];
  for (const f of fluxosCobertos) {
    (dobras.get(f.attrs['id'] ?? '') ?? []).forEach((ponto, i) => {
      bends.push([
        ['processLinkBendPK', [
          ['companyId', companyId],
          ['processId', processId],
          ['version', versao],
          ['linkSequence', sufixo(f.attrs['id'])],
          ['bendSequence', i + 1],
        ]],
        ['positionX', ponto.x],
        ['positionY', ponto.y],
      ]);
    });
  }

  const gestor = atribuicaoDe(processo, p['managerMechanism'], p['managerAssignmentController']);

  /*
   * O sequence de estado e de link vem do sufixo do id, e nada no `.process`
   * impede `task5` e `endevent5`: dois estados com a mesma PK. A raia não
   * precisa disso — o sequence dela é a posição, único por construção.
   */
  const semRepeticao = (rotulo: string, ids: string[]) => {
    const porSequencia = new Map<number, string[]>();
    for (const id of ids) {
      if (!/\d$/.test(id)) recusar(`${rotulo} ${id} sem sufixo numérico no id`);
      porSequencia.set(sufixo(id), [...(porSequencia.get(sufixo(id)) ?? []), id]);
    }
    for (const [sequencia, repetidos] of porSequencia) {
      if (repetidos.length > 1) recusar(`${rotulo} com sequence ${sequencia} repetido (${repetidos.join(', ')})`);
    }
  };
  semRepeticao('estado', estadosBpmn.map((o) => o.attrs['id'] ?? ''));
  semRepeticao('anotação', anotacoes.map((o) => o.attrs['id'] ?? ''));
  semRepeticao('fluxo', fluxosCobertos.map((f) => f.attrs['id'] ?? ''));

  if (naoSuportados.size > 0 && !opcoes.parcial) {
    throw new ErroFluigctl(
      `o diagrama "${processId}" usa o que a conversão ainda não cobre: ${[...naoSuportados].join('; ')}. ` +
        'Publique este pelo Fluig Studio.',
      6,
    );
  }
  verificado = true;

  const cardIndex = p['cardIndex'] ?? '';
  let formId = opcoes.formId;
  if (formId === undefined) {
    if (/^\d+$/.test(cardIndex)) formId = Number(cardIndex);
    else {
      formId = 0;
      if (cardIndex) {
        avisos.push(
          `o formulário está referenciado pelo nome ("${cardIndex}"); o XML leva formId 0 — ` +
            'na publicação ele será resolvido pelo nome no servidor de destino',
        );
      }
    }
  }

  const definicao: Campo[] = [
    ['processDefinitionPK', [['companyId', companyId], ['processId', processId]]],
    ['processDescription', descricao],
    ['instruction', p['instruction'] ?? ''],
    ['active', true],
    ['publicProcess', booleano(p['publicProcess'], false)],
    ['volumeId', p['volume'] ?? ''],
    ['categoryId', p['category'] ?? ''],
    ['managerEngineAllocationId', gestor.id ?? ''],
  ];
  if (gestor.configuracao !== undefined) definicao.push(['managerEngineAllocationConfiguration', gestor.configuracao]);
  definicao.push(
    ['snapshotFrequency', 0],
    ['baseDay', 0],
    ['baseMonth', 0],
    ['periodId', p['expedient'] ?? ''],
    ['uniqueCardVersion', booleano(p['uniquecardversion'], false)],
    ['keyWord', ''],
    ['complementsLevel', p['complementsLevel'] || 1],
    ['notifyRequisitionerComplements', booleano(p['notifyRequisitionerComplements'], false)],
    ['notifyManagerComplements', false],
    ['deadlineTime', 0],
    ['warningDeadlineTime', 0],
    ['notifyAuthorityComplements', booleano(p['notifyResponsibleComplements'], false)],
  );

  const versaoDefinicao: Campo[] = [
    ['processDefinitionVersionPK', [['companyId', companyId], ['processId', descricao], ['version', versao]]],
    ['versionDescription', p['descriptionVersion'] ?? ''],
    ['formId', formId],
    ['editionMode', true],
    ['updateAttachmentsVersion', booleano(p['updateAttachment'], false)],
    ['controlsAttachmentsSecurity', false],
    ['active', true],
    ['blockedVersion', false],
    ['counterSign', false],
    ['openInstances', 0],
    ['bpmnVersion', 2],
    ['processStates', null],
    ['favorito', false],
    ['inheritFormSecurity', booleano(p['inheritFormSecurity'], false)],
    ['mobileReady', booleano(p['mobileReady'], false)],
  ];

  const vazio: Campo = ['list', null];
  const filhosDaRaiz: Campo[] = [
    ['ProcessDefinition', definicao],
    ['ProcessDefinitionVersion', versaoDefinicao],
    lista('ProcessState', estados),
    lista('ConditionProcessState', condicoes),
    lista('ProcessLink', links),
    vazio,
    lista('WorkflowProcessEvent', eventos),
    vazio,
    lista('SwimLane', raias),
    lista('ProcessComponGraf', anotacoesXml),
    lista('ProcessLinkAssoc', associacoes),
    lista('ProcessLinkBend', bends),
    lista('ProcessStateTrigger', gatilhos),
    vazio,
    vazio,
    lista('ProcessStateService', servicos),
    vazio,
    vazio,
    vazio,
    lista('ConditionProcessAutomaticRules', regras),
  ];

  return {
    processId,
    versao,
    cardIndex,
    formId,
    xml: `<list>\n${serializar(filhosDaRaiz, 1)}\n</list>`,
    contagens: {
      estados: estados.length,
      links: links.length,
      raias: raias.length,
      dobras: bends.length,
      condicoes: condicoes.length,
      eventos: eventos.length,
      anotacoes: anotacoes.length,
    },
    avisos,
    naoSuportados: [...naoSuportados],
  };
}
