import { lerDiagrama } from '../push/diagram/modelo.js';
import { blocosDeTopo } from './add.js';
import { ConflitoEdicao, EdicaoInvalida } from './edit.js';
import { blobDeCondicoes, lerAtribuicao, lerCondicoes, trocarAtributosNoXml } from './props.js';

/**
 * Remover elementos e fluxos sem o Studio.
 *
 * O pictograma referencia tudo por posição (`/0/@children.8`, `/0/@connections.12`),
 * então tirar um bloco do meio da lista desloca todos os que vêm depois. A remoção:
 *
 * 1. decide o que sai junto: o fluxo; ou o elemento, as ligações dele e, numa
 *    service task, os eventos de erro presos a ela;
 * 2. limpa o modelo: o fluxo sai do outgoing/incoming dos vizinhos e do
 *    attachedEvents, e a condição de gateway que apontava para quem saiu também;
 * 3. tira os blocos do pictograma e as linhas `bpmn2:`;
 * 4. renumera: a referência a um item depois de um removido desce o tanto de
 *    removidos antes dele, e a que apontava para um removido sai das listas
 *    (âncoras, pictogramLinks).
 *
 * O resultado passa pelo aplicarEdicao, que recusa qualquer erro de estrutura novo.
 */

const TAG_BPMN = /[ \t]*<bpmn2:[\w.-]+(?:\s+[\w:.-]+\s*=\s*"[^"]*")*\s*\/?>\r?\n?/g;
const REF = /\/0\/@(children|connections)\.(\d+)/g;

export interface Remocao {
  xml: string;
  /** Tudo o que saiu: o pedido e o que foi junto. */
  removidos: string[];
  /** Scripts de service task que ficaram no disco. */
  scripts: string[];
}

export function removerNoXml(xml: string, id: string): Remocao {
  const d = lerDiagrama(xml);
  const alvo = d.objetos.find((o) => o.attrs['id'] === id);
  if (!alvo) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  if (['BpmnPool', 'BpmnSwimLane', 'BpmnProcess'].includes(alvo.tipo)) throw new EdicaoInvalida('pool e raias não se removem por aqui');

  // 1. O que sai junto.
  const nos = new Set<string>();
  const fluxos = new Set<string>();
  if (alvo.tipo === 'SequenceFlow') {
    fluxos.add(id);
  } else {
    nos.add(id);
    if (alvo.tipo === 'BpmnTask') {
      for (const o of d.objetos) if (o.tipo === 'BpmnIntermediateEvent' && o.attrs['parentTask'] === id && o.attrs['id']) nos.add(o.attrs['id']);
    }
    for (const f of d.objetos) {
      if (f.tipo === 'SequenceFlow' && (nos.has(f.attrs['sourceRef'] ?? '') || nos.has(f.attrs['targetRef'] ?? ''))) fluxos.add(f.attrs['id']!);
    }
  }
  const sai = new Set([...nos, ...fluxos]);

  // Recusas: o que ainda aponta para quem sai e não se limpa sozinho.
  for (const o of d.objetos) {
    const oid = o.attrs['id'] ?? '';
    if (sai.has(oid) || o.tipo !== 'BpmnTask') continue;
    const at = lerAtribuicao(o);
    if (at.campos['idNode'] && nos.has(at.campos['idNode'])) {
      throw new EdicaoInvalida(`a atribuição de ${o.attrs['name'] || oid} (Executor Atividade) usa ${at.campos['idNode']}; troque a atribuição antes de remover`);
    }
  }
  // Destinos que um gateway perde: a condição para eles sai junto (o push recusa
  // condição para um destino sem fluxo do gateway). Vale para elemento removido e
  // para fluxo removido de um destino que continua no diagrama.
  const gateways = d.objetos.filter((o) => o.tipo === 'BpmnGateway' && !sai.has(o.attrs['id'] ?? ''));
  const perdidos = new Map<string, Set<string>>();
  for (const g of gateways) {
    const gid = g.attrs['id']!;
    const saidas = d.objetos.filter((f) => f.tipo === 'SequenceFlow' && f.attrs['sourceRef'] === gid);
    const ficam = new Set(saidas.filter((f) => !fluxos.has(f.attrs['id']!)).map((f) => f.attrs['targetRef']));
    const perde = new Set(saidas.filter((f) => fluxos.has(f.attrs['id']!)).map((f) => f.attrs['targetRef']!).filter((t) => !ficam.has(t)));
    if (perde.size === 0) continue;
    perdidos.set(gid, perde);
    const blob = g.attrs['condition'] ?? '';
    if (!lerCondicoes(g).editavel && [...perde].some((t) => blob.includes(`>${t}<`))) {
      throw new EdicaoInvalida(`as condições de ${g.attrs['name'] || gid} apontam para o que sai, e o painel não as regrava; ajuste no XML`);
    }
  }

  // 2. Limpa o modelo dos que ficam.
  let texto = xml;
  for (const o of d.objetos) {
    const oid = o.attrs['id'] ?? '';
    if (sai.has(oid) || !oid) continue;
    const mudancas: Record<string, string | null> = {};
    for (const attr of ['incoming', 'outgoing', 'attachedEvents'] as const) {
      const lista = (o.attrs[attr] ?? '').split(/\s+/).filter(Boolean);
      const resto = lista.filter((x) => !sai.has(x));
      if (resto.length !== lista.length) mudancas[attr] = resto.length ? resto.join(' ') : null;
    }
    if (Object.keys(mudancas).length) texto = trocarAtributosNoXml(texto, oid, mudancas);
  }
  for (const [gid, perde] of perdidos) {
    const c = lerCondicoes(d.objetos.find((o) => o.attrs['id'] === gid)!);
    if (!c.editavel || !c.condicoes.some((x) => perde.has(x.destino))) continue;
    // Direto no blob: preserva o resto como o Studio deixou (inclusive duas condições para o mesmo destino).
    texto = trocarAtributosNoXml(texto, gid, { condition: blobDeCondicoes(gid, c.condicoes.filter((x) => !perde.has(x.destino))) });
  }

  // 3. Tira os blocos do pictograma (do fim para o começo) e as linhas do modelo.
  const { blocos } = blocosDeTopo(texto);
  const fora = blocos.filter((b) => b.id !== undefined && sai.has(b.id));
  const removidosPorTipo = { children: fora.filter((b) => b.tipo === 'children').map((b) => b.indice), connections: fora.filter((b) => b.tipo === 'connections').map((b) => b.indice) };
  for (const b of [...fora].sort((x, y) => y.inicio - x.inicio)) texto = texto.slice(0, b.inicio) + texto.slice(b.fim);
  texto = texto.replace(TAG_BPMN, (tag) => (sai.has(/\sid="([^"]*)"/.exec(tag)?.[1] ?? '') ? '' : tag));

  // 4. Renumera as referências por posição.
  const novoIndice = (tipo: 'children' | 'connections', n: number): number | undefined =>
    removidosPorTipo[tipo].includes(n) ? undefined : n - removidosPorTipo[tipo].filter((r) => r < n).length;
  // Listas de caminhos: some o que apontava para um removido.
  texto = texto.replace(/\s(outgoingConnections|incomingConnections|pictogramLinks)="([^"]*)"/g, (inteiro, attr: string, valor: string) => {
    const resto = valor.split(/\s+/).filter(Boolean).filter((t) => {
      const m = /^\/0\/@(children|connections)\.(\d+)/.exec(t);
      return !m || novoIndice(m[1] as 'children' | 'connections', Number(m[2])) !== undefined;
    });
    return resto.length ? ` ${attr}="${resto.join(' ')}"` : attr === 'pictogramLinks' ? ` ${attr}=""` : '';
  });
  texto = texto.replace(REF, (inteiro, tipo: 'children' | 'connections', n: string) => {
    const novo = novoIndice(tipo, Number(n));
    // Sobrou referência a um removido fora das listas: o diagram check vai acusar.
    return novo === undefined ? inteiro : `/0/@${tipo}.${novo}`;
  });

  // Eventos de link andam em par: o "envia" (36) aponta pelo linkId para um "recebe"
  // (42), e todo "recebe" precisa de um "envia" com fluxo de entrada. Remover um
  // lado deixa o outro órfão, e o push não publica.
  const depois = lerDiagrama(texto);
  const nome = (id: string) => depois.objetos.find((o) => o.attrs['id'] === id)?.attrs['name'] || d.objetos.find((o) => o.attrs['id'] === id)?.attrs['name'] || id;
  const links = depois.objetos.filter((o) => o.tipo === 'BpmnIntermediateEvent');
  for (const envia of links.filter((o) => o.attrs['type'] === '36')) {
    const linkId = envia.attrs['linkId'];
    if (linkId && sai.has(linkId)) {
      throw new EdicaoInvalida(`o evento de link "${nome(envia.attrs['id']!)}" envia para "${nome(linkId)}", que sairia; remova os dois ou troque o destino do link`);
    }
  }
  // Só conta fluxo que sai de um estado: o de uma anotação ou artefato não leva ao link (o conversor o ignora).
  const ARTEFATOS = new Set(['BpmnAnnotation', 'TextAnnotation', 'BpmnDocument', 'BpmnDatabase', 'BpmnGroup']);
  const deEstado = (diag: typeof d, f: (typeof d.objetos)[number]) =>
    !ARTEFATOS.has(diag.objetos.find((o) => o.attrs['id'] === f.attrs['sourceRef'])?.tipo ?? '');
  const comEntrada = (id: string) => depois.objetos.some((f) => f.tipo === 'SequenceFlow' && f.attrs['targetRef'] === id && deEstado(depois, f));
  for (const recebe of links.filter((o) => o.attrs['type'] === '42')) {
    const rid = recebe.attrs['id']!;
    const antes = d.objetos.some((o) => o.attrs['type'] === '36' && o.attrs['linkId'] === rid &&
      d.objetos.some((f) => f.tipo === 'SequenceFlow' && f.attrs['targetRef'] === o.attrs['id'] && deEstado(d, f)));
    const agora = links.some((o) => o.attrs['type'] === '36' && o.attrs['linkId'] === rid && comEntrada(o.attrs['id']!));
    if (antes && !agora) {
      throw new EdicaoInvalida(`o evento de link "${nome(rid)}" ficaria sem nenhum envio que chegue até ele; remova o par inteiro ou religue`);
    }
  }

  const processo = d.objetos.find((o) => o.tipo === 'BpmnProcess')?.attrs['id'] ?? '';
  const scripts = [...nos]
    .map((n) => d.objetos.find((o) => o.attrs['id'] === n)!)
    .filter((o) => o.tipo === 'BpmnTask' && o.attrs['type'] === '82')
    .map((o) => o.attrs['scriptFileName'] || `${processo}.${o.attrs['id']}.js`);
  return { xml: texto, removidos: [...nos, ...fluxos], scripts };
}
