import { garantirFontes } from './fonts.js';
import { garantirLosangos } from './gateways.js';
import { garantirVisual } from './visual.js';
import { medidorDoStudio } from './medida.js';
import { ajustarAoNome } from './tamanho.js';
import { basename, dirname, join } from 'node:path';

import { lerDiagrama, type Diagrama, type ObjetoBpmn } from '../push/diagram/modelo.js';
import { ConflitoEdicao, EdicaoInvalida, trocarDobrasNoXml } from './edit.js';
import { rotaOrtogonal } from './route.js';
import { refinarRotas } from './rotas.js';
import { MODELOS, type Modelo } from './modelos.js';
import { blobDeAtribuicao, codificarAtributo, estiloDoArquivo, trocarAtributosNaTag, type EstiloAtributo } from './props.js';

/**
 * Criar elementos e ligações sem o Studio.
 *
 * O pictograma do Graphiti aponta para os próprios nós por posição
 * (`/0/@children.8/@anchors.0`), e uma forma do Studio aponta para si mesma
 * (a âncora `BoxRelativeAnchor` referencia `/0/@children.<ela>/@graphicsAlgorithm`).
 * Por isso:
 *
 * - o que se cria vai para o **fim** da lista de formas (ou de conexões): nada
 *   que já existe muda de posição, e nenhuma referência antiga precisa mudar;
 * - a forma nova é um clone de uma forma do mesmo tipo do próprio arquivo, que
 *   já está no estilo dele (cores, fontes, estilos do Studio); só sem nenhuma
 *   no arquivo é que vale o modelo embutido (modelos.ts);
 * - o clone tem as referências a si mesmo reescritas para o índice novo, e as
 *   ligações do modelo tiradas;
 * - o id novo leva um número que nenhum outro id usa: o servidor usa esse
 *   número como sequência do estado.
 *
 * O resultado passa pelo aplicarEdicao, que recusa qualquer erro de estrutura
 * novo no diagram check.
 */

export type TipoNovo = 'humana' | 'servico' | 'gateway' | 'fim' | 'inicio' | 'paralelo' | 'juncao' | 'recuperacao';

const TIPOS: Record<Exclude<TipoNovo, 'recuperacao'> | 'erro', { tipo: string; type: string; prefixo: string; nome: string }> = {
  humana: { tipo: 'BpmnTask', type: '80', prefixo: 'task', nome: 'Nova tarefa' },
  servico: { tipo: 'BpmnTask', type: '82', prefixo: 'servicetask', nome: 'Nova service task' },
  gateway: { tipo: 'BpmnGateway', type: '120', prefixo: 'exclusivegateway', nome: 'Decisão?' },
  fim: { tipo: 'BpmnEndEvent', type: '60', prefixo: 'endevent', nome: 'Fim' },
  inicio: { tipo: 'BpmnStartEvent', type: '10', prefixo: 'startevent', nome: 'Início' },
  paralelo: { tipo: 'BpmnGateway', type: '126', prefixo: 'parallelgateway', nome: 'Paralelo' },
  juncao: { tipo: 'BpmnGateway', type: '127', prefixo: 'joingateway', nome: 'Junção' },
  erro: { tipo: 'BpmnIntermediateEvent', type: '43', prefixo: 'intermediateerror', nome: 'Erro' },
};

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const TAG_BPMN = /<bpmn2:[\w.-]+(?:\s+[\w:.-]+\s*=\s*"[^"]*")*\s*\/?>/g;

interface Bloco {
  tipo: 'children' | 'connections';
  /** Início da linha do bloco e fim (depois da quebra da última linha). */
  inicio: number;
  fim: number;
  indice: number;
  id?: string | undefined;
}

/** Os blocos diretos do `pi:Diagram`, com a posição no texto e o índice na lista de cada tipo. */
export function blocosDeTopo(xml: string): { blocos: Bloco[]; diagrama: { inicio: number; tag: string } } {
  const blocos: Bloco[] = [];
  const pilha: string[] = [];
  let nivel = -1;
  let diagrama: { inicio: number; tag: string } | undefined;
  let atual: Bloco | undefined;
  const contagem = { children: 0, connections: 0 };
  const inicioDaLinha = (i: number) => xml.lastIndexOf('\n', i - 1) + 1;
  for (const m of xml.matchAll(TOKEN)) {
    const [inteiro, fecha, nome] = m;
    if (nome === undefined) continue;
    const vazia = m[4] === '/';
    if (fecha) {
      pilha.pop();
      if (atual && nome === atual.tipo && pilha.length === nivel + 1) {
        const quebra = xml.indexOf('\n', m.index);
        atual.fim = quebra === -1 ? xml.length : quebra + 1;
        blocos.push(atual);
        atual = undefined;
      }
      continue;
    }
    const profundidade = pilha.length;
    if (nome === 'pi:Diagram') {
      nivel = profundidade;
      diagrama = { inicio: m.index, tag: inteiro };
    } else if (nivel >= 0 && profundidade === nivel + 1 && (nome === 'children' || nome === 'connections')) {
      const tipo = nome;
      atual = { tipo, inicio: inicioDaLinha(m.index), fim: 0, indice: contagem[tipo]++ };
      if (vazia) atual = undefined;
    } else if (atual && profundidade === nivel + 2 && nome === 'link') {
      atual.id = /\sbusinessObjects="([^"]*)"/.exec(inteiro)?.[1];
    }
    if (!vazia) pilha.push(nome);
  }
  if (!diagrama) throw new EdicaoInvalida('o .process não tem <pi:Diagram>');
  return { blocos, diagrama };
}

function tagBpmn(xml: string, id: string): { inicio: number; tag: string } | undefined {
  for (const m of xml.matchAll(TAG_BPMN)) {
    if (/\sid="([^"]*)"/.exec(m[0])?.[1] === id) return { inicio: m.index, tag: m[0] };
  }
  return undefined;
}

/** O próximo número de id: maior que qualquer sufixo numérico em uso. */
function proximoNumero(d: Diagrama): number {
  return Math.max(0, ...d.objetos.map((o) => Number(/(\d+)$/.exec(o.attrs['id'] ?? '')?.[1] ?? 0))) + 1;
}

/** Um modelo do mesmo tipo no próprio arquivo, ou o embutido. */
function modeloPara(xml: string, d: Diagrama, chave: keyof typeof TIPOS | 'fluxo'): Modelo {
  const blocos = blocosDeTopo(xml).blocos;
  const procurado = chave === 'fluxo' ? undefined : TIPOS[chave];
  const candidatos = d.objetos.filter((o) =>
    chave === 'fluxo' ? o.tipo === 'SequenceFlow' : o.tipo === procurado!.tipo && o.attrs['type'] === procurado!.type,
  );
  for (const o of candidatos) {
    const id = o.attrs['id']!;
    const bloco = blocos.find((b) => b.id === id && b.tipo === (chave === 'fluxo' ? 'connections' : 'children'));
    const tag = tagBpmn(xml, id);
    if (bloco && tag) return { id, forma: xml.slice(bloco.inicio, bloco.fim).replace(/\n$/, ''), indice: bloco.indice, modelo: tag.tag };
  }
  return MODELOS[chave]!;
}

/**
 * Reescreve um bloco clonado: índice próprio, id, sem ligações, sem dobras e
 * sem estilos. Os estilos o garantirVisual refaz, um conjunto por forma como o
 * Studio grava: dividir os da forma copiada amarraria uma à outra.
 */
function clonarForma(m: Modelo, tipoLista: 'children' | 'connections', indice: number, id: string): string {
  const proprio = new RegExp(`/0/@${tipoLista}\\.${m.indice}(?=[/"\\s])`, 'g');
  return m.forma
    .replace(proprio, `/0/@${tipoLista}.${indice}`)
    .replace(/ style="[^"]*"/g, '')
    .replace(/ (outgoingConnections|incomingConnections)="[^"]*"/g, '')
    .replace(/\n\s*<bendpoints\b[^>]*\/>/g, '')
    .replace(`businessObjects="${m.id}"`, `businessObjects="${id}"`);
}

function trocarXY(bloco: string, x: number, y: number): string {
  // A primeira tag graphicsAlgorithm é a da forma; as de dentro são relativas a ela.
  return bloco.replace(/<graphicsAlgorithm\b[^>]*?\/?>/, (tag) => {
    let t = tag;
    for (const [k, v] of [['x', x], ['y', y]] as const) {
      const re = new RegExp(`\\s${k}="-?\\d+"`);
      if (v === 0) t = t.replace(re, '');
      else if (re.test(t)) t = t.replace(re, ` ${k}="${v}"`);
      else t = t.replace(/( height="\d+")/, `$1 ${k}="${v}"`);
    }
    return t;
  });
}

function tamanho(bloco: string): { w: number; h: number } {
  const tag = /<graphicsAlgorithm\b[^>]*?\/?>/.exec(bloco)?.[0] ?? '';
  return { w: Number(/\swidth="(\d+)"/.exec(tag)?.[1] ?? 0), h: Number(/\sheight="(\d+)"/.exec(tag)?.[1] ?? 0) };
}

/** O nome aparece no texto da forma (MultiText/Text) e no decorador do fluxo. */
function trocarTextos(bloco: string, nome: string, estilo: EstiloAtributo): string {
  return bloco.replace(/(<graphicsAlgorithm xsi:type="al:(?:MultiText|Text)"[^>]*?\svalue=")[^"]*(")/g, (_, a: string, b: string) => a + codificarAtributo(nome, estilo) + b);
}

/** Onde entra um bloco novo: logo depois do último do mesmo tipo. */
function pontoDeInsercao(xml: string, tipo: 'children' | 'connections'): number {
  const { blocos, diagrama } = blocosDeTopo(xml);
  const doTipo = blocos.filter((b) => b.tipo === tipo);
  if (doTipo.length) return doTipo.at(-1)!.fim;
  // Sem conexões ainda: depois da última forma. Sem formas: logo depois do graphicsAlgorithm do diagrama.
  const formas = blocos.filter((b) => b.tipo === 'children');
  if (formas.length) return formas.at(-1)!.fim;
  return xml.indexOf('\n', xml.indexOf('<graphicsAlgorithm', diagrama.inicio)) + 1;
}

function acrescentarAoDiagrama(xml: string, link: string): string {
  // pictogramLinks, quando o Studio o escreveu, lista os <link> do diagrama.
  return xml.replace(/(<pi:Diagram\b[^>]*?\spictogramLinks=")([^"]*)(")/, (_, a: string, lista: string, b: string) => `${a}${lista ? `${lista} ` : ''}${link}${b}`);
}

function inserirModelo(xml: string, tag: string, depoisDe: string | undefined, eFluxo: boolean): string {
  let pos: number;
  const ancora = depoisDe ? tagBpmn(xml, depoisDe) : undefined;
  if (ancora) {
    pos = ancora.inicio + ancora.tag.length;
  } else {
    // Sem modelo do tipo no arquivo: estados antes dos fluxos; fluxos no fim.
    const primeiroFluxo = xml.search(/\n\s*<bpmn2:SequenceFlow\b/);
    pos = !eFluxo && primeiroFluxo >= 0 ? primeiroFluxo : xml.lastIndexOf('\n', xml.lastIndexOf('</xmi:XMI>'));
    if (pos < 0) throw new EdicaoInvalida('não achei onde pôr o objeto no modelo');
  }
  const linhaAnterior = xml.lastIndexOf('\n', pos - 1) + 1;
  const recuo = /^\s*/.exec(xml.slice(linhaAnterior))![0].replace(/\n/g, '') || '  ';
  return `${xml.slice(0, pos)}\n${recuo}${tag}${xml.slice(pos)}`;
}

export interface Criacao {
  tipo: Exclude<TipoNovo, 'recuperacao'> | 'erro';
  nome: string;
  /** Canto superior esquerdo, em coordenadas do diagrama. */
  x: number;
  y: number;
  /** Atributos do objeto, além dos que toda criação ajusta. */
  atributos?: Record<string, string | null>;
}

function idDoProcesso(d: Diagrama): string {
  return d.objetos.find((o) => o.tipo === 'BpmnProcess')?.attrs['id'] ?? 'processo';
}

/** Cria um elemento solto; devolve o texto e o id criado. */
export function criarNoXml(xml: string, c: Criacao): { xml: string; id: string } {
  const d = lerDiagrama(xml);
  const estilo = estiloDoArquivo(xml);
  const info = TIPOS[c.tipo];
  const id = `${info.prefixo}${proximoNumero(d)}`;
  const modelo = modeloPara(xml, d, c.tipo);
  const { blocos } = blocosDeTopo(xml);
  const indice = blocos.filter((b) => b.tipo === 'children').length;

  let forma = clonarForma(modelo, 'children', indice, id);
  forma = trocarTextos(trocarXY(forma, Math.round(c.x), Math.round(c.y)), c.nome, estilo);

  const mudancas: Record<string, string | null> = {
    id,
    name: c.nome,
    incoming: null,
    outgoing: null,
    ...(c.tipo === 'humana' ? { managerMechanism: null, managerAssignmentControllerString: null, instrucoes: null, prazoConclusao: null, atividadeConjunta: null } : {}),
    ...(c.tipo === 'servico'
      ? { scriptFileName: `${idDoProcesso(d)}.${id}.js`, attachedEvents: null, executionType: '1', managerMechanism: '', managerAssignmentControllerString: null }
      : {}),
    ...(c.tipo === 'gateway' || c.tipo === 'paralelo' || c.tipo === 'juncao' ? { condition: '<list/>' } : {}),
    ...(c.tipo === 'erro' ? { parentTask: null, linkId: null, sequenceAttached: null } : {}),
    ...(c.atributos ?? {}),
  };
  const tag = trocarAtributosNaTag(modelo.modelo, mudancas, ['extendedFields', 'type'], estilo);

  let novo = xml;
  const pos = pontoDeInsercao(novo, 'children');
  novo = novo.slice(0, pos) + forma + '\n' + novo.slice(pos);
  novo = acrescentarAoDiagrama(novo, `/0/@children.${indice}/@link`);
  const doArquivo = d.objetos.some((o) => o.attrs['id'] === modelo.id);
  novo = inserirModelo(novo, tag, doArquivo ? modelo.id : undefined, false);
  // Texto sem fonte e losango sem pontos impedem o Studio de abrir, e forma sem
  // estilo aparece sem cor: o que entra sai certo, e o arquivo inteiro é
  // acertado junto (veja fonts.ts, gateways.ts e visual.ts). O tamanho e o
  // rótulo saem como o Studio os recalcula ao abrir (tamanho.ts).
  return { xml: ajustarAoNome(garantirVisual(garantirLosangos(garantirFontes(novo))), [id]), id };
}

/** O tamanho com que a forma vai ficar: o do Studio para tarefa e gateway, o do modelo para o resto. */
export function tamanhoPrevisto(xml: string, d: Diagrama, tipo: Criacao['tipo'], nome: string): { w: number; h: number } {
  const m = medidorDoStudio();
  if (tipo === 'humana' || tipo === 'servico') {
    const t = m.tarefa(nome);
    return { w: t.largura, h: t.altura };
  }
  if (tipo === 'gateway' || tipo === 'paralelo' || tipo === 'juncao') return { w: 60, h: 60 + m.rotuloDoGateway(nome).altura };
  return tamanho(modeloPara(xml, d, tipo).forma);
}

function anexarALista(xml: string, id: string, attr: 'incoming' | 'outgoing', valor: string): string {
  const atual = tagBpmn(xml, id);
  if (!atual) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  const lista = new RegExp(`\\s${attr}="([^"]*)"`).exec(atual.tag)?.[1] ?? '';
  // Como o Studio: name, incoming, outgoing, nessa ordem.
  const novaTag = trocarAtributosNaTag(atual.tag, { [attr]: lista ? `${lista} ${valor}` : valor }, attr === 'incoming' ? ['name'] : ['incoming', 'name'], estiloDoArquivo(xml));
  return xml.slice(0, atual.inicio) + novaTag + xml.slice(atual.inicio + atual.tag.length);
}

/** Acrescenta uma conexão a uma lista da primeira âncora (ChopboxAnchor) da forma. */
function anexarAncora(xml: string, id: string, attr: 'incomingConnections' | 'outgoingConnections', caminho: string): string {
  const bloco = blocosDeTopo(xml).blocos.find((b) => b.tipo === 'children' && b.id === id);
  if (!bloco) throw new EdicaoInvalida(`${id} não é uma forma solta no diagrama`);
  const texto = xml.slice(bloco.inicio, bloco.fim);
  const ancora = /<anchors\b[^>]*?\/?>/.exec(texto);
  if (!ancora || !/ChopboxAnchor/.test(ancora[0])) throw new EdicaoInvalida(`a forma de ${id} não tem a âncora de ligação`);
  const re = new RegExp(`\\s${attr}="([^"]*)"`);
  const atual = re.exec(ancora[0]);
  let tag: string;
  if (atual) {
    tag = ancora[0].replace(re, ` ${attr}="${atual[1] ? `${atual[1]} ` : ''}${caminho}"`);
  } else if (attr === 'outgoingConnections') {
    tag = ancora[0].replace(/(xsi:type="pi:ChopboxAnchor")/, `$1 outgoingConnections="${caminho}"`);
  } else {
    // incoming vem depois de outgoing, como o EMF escreve.
    tag = /\soutgoingConnections="[^"]*"/.test(ancora[0])
      ? ancora[0].replace(/(\soutgoingConnections="[^"]*")/, `$1 incomingConnections="${caminho}"`)
      : ancora[0].replace(/(xsi:type="pi:ChopboxAnchor")/, `$1 incomingConnections="${caminho}"`);
  }
  const ini = bloco.inicio + ancora.index;
  return xml.slice(0, ini) + tag + xml.slice(ini + ancora[0].length);
}

/** Liga dois elementos com um fluxo novo; devolve o texto e o id do fluxo. */
export function ligarNoXml(xml: string, origem: string, destino: string, nome = ''): { xml: string; id: string } {
  const d = lerDiagrama(xml);
  const o = d.objetos.find((x) => x.attrs['id'] === origem);
  const t = d.objetos.find((x) => x.attrs['id'] === destino);
  if (!o || !t) throw new ConflitoEdicao('elemento-removido', `o elemento ${!o ? origem : destino} não existe mais`);
  if (origem === destino) throw new EdicaoInvalida('um elemento não se liga a si mesmo');
  const ligavel = (x: ObjetoBpmn) => !['BpmnPool', 'BpmnSwimLane', 'SequenceFlow', 'BpmnProcess'].includes(x.tipo);
  if (!ligavel(o) || !ligavel(t)) throw new EdicaoInvalida('fluxos ligam tarefas, eventos e gateways');
  if (o.tipo === 'BpmnEndEvent') throw new EdicaoInvalida('o evento de fim não tem saída');
  if (t.tipo === 'BpmnStartEvent') throw new EdicaoInvalida('o evento de início não tem entrada');
  if (d.objetos.some((f) => f.tipo === 'SequenceFlow' && f.attrs['sourceRef'] === origem && f.attrs['targetRef'] === destino)) {
    throw new EdicaoInvalida('já existe um fluxo entre esses dois elementos');
  }
  const { blocos } = blocosDeTopo(xml);
  const io = blocos.find((b) => b.tipo === 'children' && b.id === origem);
  const it = blocos.find((b) => b.tipo === 'children' && b.id === destino);
  if (!io || !it) throw new EdicaoInvalida('os dois elementos precisam ser formas soltas no diagrama');

  const estilo = estiloDoArquivo(xml);
  const id = `flow${proximoNumero(d)}`;
  const indice = blocos.filter((b) => b.tipo === 'connections').length;
  const caminho = `/0/@connections.${indice}`;
  const modelo = modeloPara(xml, d, 'fluxo');
  let forma = clonarForma(modelo, 'connections', indice, id)
    .replace(/\sstart="[^"]*"/, ` start="/0/@children.${io.indice}/@anchors.0"`)
    .replace(/\send="[^"]*"/, ` end="/0/@children.${it.indice}/@anchors.0"`);
  forma = trocarTextos(forma, nome, estilo);
  const tag = trocarAtributosNaTag(
    modelo.modelo,
    { id, name: nome, sourceRef: origem, targetRef: destino, atividadeRetorno: '', atividadeFluxo: '', expression: null },
    ['name'],
    estilo,
  );

  let novo = xml;
  const pos = pontoDeInsercao(novo, 'connections');
  novo = novo.slice(0, pos) + forma + '\n' + novo.slice(pos);
  novo = acrescentarAoDiagrama(novo, `${caminho}/@link`);
  novo = anexarAncora(novo, origem, 'outgoingConnections', caminho);
  novo = anexarAncora(novo, destino, 'incomingConnections', caminho);
  // Depois do último fluxo do modelo; sem nenhum, no fim.
  const ultimoFluxo = d.objetos.filter((x) => x.tipo === 'SequenceFlow').at(-1)?.attrs['id'];
  novo = inserirModelo(novo, tag, ultimoFluxo, true);
  novo = anexarALista(novo, origem, 'outgoing', id);
  novo = anexarALista(novo, destino, 'incoming', id);
  // Texto sem fonte e losango sem pontos impedem o Studio de abrir, e forma sem
  // estilo aparece sem cor: o que entra sai certo, e o arquivo inteiro é
  // acertado junto (veja fonts.ts, gateways.ts e visual.ts).
  let pronto = garantirVisual(garantirLosangos(garantirFontes(novo)));
  // A ligação já sai traçada em ângulo reto, como o Endireitar a deixaria
  // (route.ts e rotas.ts); a que já fica reta (formas alinhadas, saída do
  // evento de erro) fica sem dobra.
  const final = lerDiagrama(pronto);
  const rotas = new Map(final.dobras);
  rotas.set(id, rotaOrtogonal(final, id));
  refinarRotas(final, rotas, new Set([id]));
  const pontos = rotas.get(id)!;
  if (pontos.length) pronto = trocarDobrasNoXml(pronto, id, pontos);
  return { xml: pronto, id };
}

const GAP = 33;

export interface PedidoAdicionar {
  tipo: TipoNovo;
  /** Centro onde o elemento vai ficar, em coordenadas do diagrama. */
  x: number;
  y: number;
  nome?: string;
  /** Grupo de suporte da tarefa de tratamento (recuperação). */
  grupo?: string;
}

/**
 * Cria um elemento centrado em (x, y). "recuperacao" cria o padrão inteiro da
 * skill: service task automática, evento de erro no canto inferior direito,
 * tarefa de tratamento logo abaixo (Pool Grupo do suporte) e as duas ligações.
 */
export function adicionarNoXml(xml: string, p: PedidoAdicionar): { xml: string; criados: string[] } {
  if (![p.x, p.y].every((n) => Number.isFinite(n) && n >= 0 && n < 100000)) throw new EdicaoInvalida('posição inválida');
  if (!['humana', 'servico', 'gateway', 'fim', 'inicio', 'paralelo', 'juncao', 'recuperacao'].includes(p.tipo)) throw new EdicaoInvalida(`tipo desconhecido: ${p.tipo}`);
  const d = lerDiagrama(xml);
  const nome = (p.nome ?? '').trim() || (p.tipo === 'recuperacao' ? TIPOS.servico.nome : TIPOS[p.tipo].nome);

  const pool = d.objetos.find((o) => o.tipo === 'BpmnPool')?.attrs['id'];
  const limites = pool ? d.caixas.get(pool) : undefined;
  const dentro = (x: number, y: number, w: number, h: number) =>
    !limites || (x >= limites.absX && y >= limites.absY && x + w <= limites.absX + limites.largura && y + h <= limites.absY + limites.altura);

  const tipoBase = p.tipo === 'recuperacao' ? 'servico' : p.tipo;
  const { w, h } = tamanhoPrevisto(xml, d, tipoBase, nome);
  // No gateway, o (x, y) é o centro do losango, que é o quadrado de cima da forma.
  const x = Math.round(p.x - w / 2);
  const ehGateway = tipoBase === 'gateway' || tipoBase === 'paralelo' || tipoBase === 'juncao';
  const y = Math.round(p.y - (ehGateway ? w / 2 : h / 2));
  if (!dentro(x, y, w, h)) throw new EdicaoInvalida('o elemento ficaria fora da pool; escolha um ponto dentro dela');

  let r = criarNoXml(xml, { tipo: tipoBase, nome, x, y });
  if (p.tipo !== 'recuperacao') return { xml: r.xml, criados: [r.id] };

  const servico = r.id;
  const grupo = (p.grupo ?? 'suporte_processos').trim();
  if (!/^[\w.@-]+$/.test(grupo)) throw new EdicaoInvalida(`grupo inválido: ${grupo}`);
  const t = tamanhoPrevisto(r.xml, lerDiagrama(r.xml), 'humana', `Tratar erro: ${nome}`);
  const ty = y + h + GAP;
  if (!dentro(x + w / 2 - t.w / 2, ty, t.w, t.h)) throw new EdicaoInvalida('a tarefa de tratamento ficaria fora da pool; escolha um ponto mais acima');
  // O padrão pede o tratamento na mesma raia da service task (sem raia de suporte).
  const raias = d.objetos.filter((o) => o.tipo === 'BpmnSwimLane').flatMap((o) => {
    const c = d.caixas.get(o.attrs['id'] ?? '');
    return c ? [{ nome: o.attrs['name'] || o.attrs['id'] || '', c }] : [];
  });
  const raiaEm = (cy: number) => raias.find((r) => cy >= r.c.absY && cy < r.c.absY + r.c.altura);
  const raiaServico = raiaEm(y + h / 2);
  const raiaTratamento = raiaEm(ty + t.h / 2);
  if (raiaServico && raiaTratamento !== raiaServico) {
    throw new EdicaoInvalida(
      `o tratamento cairia ${raiaTratamento ? `na raia ${raiaTratamento.nome}` : 'fora das raias'}, e o padrão o quer na raia ${raiaServico.nome}, junto da service task; escolha um ponto mais acima ou aumente a raia`,
    );
  }
  const tratamento = criarNoXml(r.xml, {
    tipo: 'humana',
    nome: `Tratar erro: ${nome}`,
    x: Math.round(x + w / 2 - t.w / 2),
    y: ty,
    atributos: {
      managerMechanism: 'Pool Grupo',
      managerAssignmentControllerString: blobDeAtribuicao({ mecanismo: 'Pool Grupo', customizado: false, campos: { groupId: grupo } }),
    },
  });
  r = tratamento;
  const de = tamanho(modeloPara(r.xml, lerDiagrama(r.xml), 'erro').forma);
  const numero = /(\d+)$/.exec(servico)![1]!;
  const comLink = /\slinkId="/.test(modeloPara(r.xml, lerDiagrama(r.xml), 'erro').modelo);
  const evento = criarNoXml(r.xml, {
    tipo: 'erro',
    nome: `Erro: ${nome}`,
    x: Math.round(x + w - de.w / 2),
    y: Math.round(y + h - de.h / 2),
    atributos: { sequenceAttached: numero, parentTask: servico, ...(comLink ? { linkId: servico } : {}) },
  });
  r = evento;
  // A service task conhece o evento preso a ela.
  const tagServico = tagBpmn(r.xml, servico)!;
  r = {
    ...r,
    xml: r.xml.slice(0, tagServico.inicio) +
      trocarAtributosNaTag(tagServico.tag, { attachedEvents: evento.id }, ['esforcoCalculo', 'scriptFileName'], estiloDoArquivo(r.xml)) +
      r.xml.slice(tagServico.inicio + tagServico.tag.length),
  };
  const f1 = ligarNoXml(r.xml, evento.id, tratamento.id);
  const f2 = ligarNoXml(f1.xml, tratamento.id, servico);
  return { xml: f2.xml, criados: [servico, evento.id, tratamento.id, f1.id, f2.id] };
}

/** Comentário de script do servidor é ASCII (skill fluig-patterns): tira acentos e o que sobrar. */
function ascii(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?').replace(/\*\//g, '* /');
}

/**
 * Esqueleto do script de uma service task nova, no padrão da skill fluig-patterns:
 * Rhino ES5, cabeçalho de sempre, e — como a skill pede de uma tarefa que ainda
 * não faz nada — um comentário dizendo isso e um log, nunca uma função vazia.
 */
export function scriptDeServico(processId: string, id: string, nome: string): string {
  const prefixo = `${processId}.${id}`;
  return `function ${id}(attempt, message) {
	var user = getValue("WKUser");
	var idfluig = getValue("WKNumProces");
	var documentId = getValue("WKCardId");

	/*
	 * ${ascii(nome)}: ainda nao implementada.
	 *
	 * Esta service task e automatica e tem o padrao de recuperacao: um throw aqui
	 * abre a tarefa de tratamento no grupo de suporte, que volta para esta mesma
	 * tarefa. Lance uma mensagem em portugues que o suporte consiga seguir, e deixe
	 * a tarefa idempotente: grave o marcador de "feito" so depois do efeito (o card
	 * e desfeito quando a tarefa falha).
	 */
	log.warn("${prefixo}: ainda nao implementada (solicitacao " + idfluig + ", tentativa " + attempt + ")");
	hAPI.setTaskComments(user, idfluig, 0, "${ascii(nome).replace(/["\\]/g, '')}: tarefa automatica ainda nao implementada.");
}
`;
}

/** Os scripts que as service tasks criadas pedem, ao lado do diagrama em workflow/scripts/. */
export function scriptsDasCriadas(arquivo: string, xml: string, criados: string[]): { caminho: string; conteudo: string }[] {
  const pastaDiagrama = dirname(arquivo);
  // Só no layout do workspace (workflow/diagrams/x.process): fora dele não há onde pôr.
  if (basename(pastaDiagrama) !== 'diagrams' || basename(dirname(pastaDiagrama)) !== 'workflow') return [];
  const scripts = join(dirname(pastaDiagrama), 'scripts');
  const d = lerDiagrama(xml);
  const processo = idDoProcesso(d);
  return criados.flatMap((id) => {
    const o = d.objetos.find((x) => x.attrs['id'] === id);
    if (!o || o.tipo !== 'BpmnTask' || o.attrs['type'] !== '82') return [];
    const arquivoScript = o.attrs['scriptFileName'] || `${processo}.${id}.js`;
    if (!/^[\w.-]+\.js$/.test(arquivoScript)) return [];
    return [{ caminho: join(scripts, arquivoScript), conteudo: scriptDeServico(processo, id, o.attrs['name'] ?? id) }];
  });
}
