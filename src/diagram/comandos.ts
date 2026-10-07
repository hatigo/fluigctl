import { lerDiagrama, type Caixa, type Diagrama, type ObjetoBpmn } from '../push/diagram/modelo.js';
import { caixaDaFigura } from '../push/diagram/svg.js';
import { adicionarNoXml, ligarNoXml, tamanhoPrevisto, type TipoNovo } from './add.js';
import { EdicaoInvalida, endireitarNoXml, moverNoXml } from './edit.js';
import { redimensionarPoolNoXml } from './lanes.js';
import { lerAtribuicao, lerCondicoes, trocarCondicoesNoXml, type Condicao } from './props.js';
import { removerNoXml } from './remove.js';

/**
 * As edições do visualizador em forma de função sobre o texto, para os comandos
 * de terminal (`fluigctl diagram add/link/...`): o agente edita o diagrama sem
 * mexer no XML à mão. Tudo passa pelas mesmas funções do visualizador (add.ts,
 * props.ts, remove.ts), então o arquivo sai igual, com o visual, os tamanhos e
 * as rotas do Studio.
 */

const ESPACO = 70;

/** O elemento pelo id ou pelo nome exato (sem ambiguidade). */
export function resolverElemento(xml: string, ref: string): ObjetoBpmn {
  const d = lerDiagrama(xml);
  const porId = d.objetos.find((o) => o.attrs['id'] === ref);
  if (porId) return porId;
  // Pelo nome: primeiro os elementos (tarefa, gateway, evento, raia), depois as
  // ligações; uma ligação com o nome da tarefa não deixa o nome ambíguo.
  const buscar = (lista: ObjetoBpmn[]) => {
    const exatos = lista.filter((o) => o.attrs['name'] === ref);
    return exatos.length ? exatos : lista.filter((o) => (o.attrs['name'] ?? '').toLowerCase() === ref.toLowerCase());
  };
  let achados = buscar(d.objetos.filter((o) => o.tipo !== 'BpmnProcess' && o.tipo !== 'SequenceFlow'));
  if (achados.length === 0) achados = buscar(d.objetos.filter((o) => o.tipo === 'SequenceFlow'));
  if (achados.length === 1) return achados[0]!;
  if (achados.length === 0) throw new EdicaoInvalida(`não há elemento com id ou nome "${ref}"; veja os ids com fluigctl diagram show`);
  throw new EdicaoInvalida(`há ${achados.length} elementos chamados "${ref}" (${achados.map((o) => o.attrs['id']).join(', ')}); use o id`);
}

const figuraDe = (d: Diagrama, id: string): Caixa | undefined => {
  const o = d.objetos.find((x) => x.attrs['id'] === id);
  const c = d.caixas.get(id);
  return o && c ? caixaDaFigura(o, c) : undefined;
};

/** Os fluxos que tocam algum destes elementos. */
function fluxosDe(xml: string, ids: Iterable<string>): string[] {
  const conjunto = new Set(ids);
  return lerDiagrama(xml)
    .objetos.filter((o) => o.tipo === 'SequenceFlow' && (conjunto.has(o.attrs['sourceRef'] ?? '') || conjunto.has(o.attrs['targetRef'] ?? '')))
    .map((o) => o.attrs['id']!);
}

/**
 * Abre `largura` px de espaço a partir de `x`: toda forma solta que começa ali ou
 * depois anda para a direita (o evento de erro anda com a tarefa), e a pool
 * cresce se for preciso. Devolve os ids que andaram.
 */
function abrirEspaco(xml: string, x: number, largura: number): { xml: string; movidos: string[] } {
  let texto = xml;
  const d = lerDiagrama(texto);
  const soltas = d.objetos.filter((o) => {
    const c = d.caixas.get(o.attrs['id'] ?? '');
    return c && !c.pai && !['BpmnPool', 'BpmnSwimLane', 'SequenceFlow', 'BpmnProcess'].includes(o.tipo) && !o.attrs['parentTask'];
  });
  const andam = soltas.filter((o) => figuraDe(d, o.attrs['id']!)!.absX >= x);
  if (andam.length === 0) return { xml: texto, movidos: [] };
  const pool = d.objetos.find((o) => o.tipo === 'BpmnPool' && d.caixas.has(o.attrs['id'] ?? ''));
  if (pool) {
    const cp = d.caixas.get(pool.attrs['id']!)!;
    const maisDireita = Math.max(...andam.map((o) => {
      const c = d.caixas.get(o.attrs['id']!)!;
      return c.absX + c.largura;
    }));
    const precisa = maisDireita + largura + 40 - cp.absX;
    if (precisa > cp.largura) texto = redimensionarPoolNoXml(texto, pool.attrs['id']!, Math.ceil(precisa / 10) * 10);
  }
  const movidos: string[] = [];
  for (const o of andam) {
    const r = moverNoXml(texto, o.attrs['id']!, largura, 0);
    texto = r.xml;
    movidos.push(...r.movidos);
  }
  return { xml: texto, movidos };
}

export interface PedidoNovoElemento {
  tipo: TipoNovo;
  nome?: string;
  /** Grupo do tratamento, no padrão de recuperação. */
  grupo?: string;
}

/** O centro de uma raia na altura da linha principal, para quem pede `--lane`. */
function centroNaRaia(d: Diagrama, raia: string): number {
  const o = d.objetos.find((x) => x.tipo === 'BpmnSwimLane' && (x.attrs['id'] === raia || x.attrs['name'] === raia));
  const c = o ? d.caixas.get(o.attrs['id']!) : undefined;
  if (!c) throw new EdicaoInvalida(`não há raia "${raia}"; veja as raias com fluigctl diagram show`);
  return c.absY + Math.min(90, c.altura / 2);
}

/**
 * Insere um elemento entre `a` e `b`, que têm uma ligação de `a` para `b`: abre
 * espaço a partir de `b`, põe o novo na linha de `a` (ou na raia pedida), liga
 * `a` → novo → `b` mantendo o nome da ligação e, se `a` é gateway, a condição
 * que levava a `b` passa a levar ao novo. As ligações que mudaram são traçadas
 * de novo pela receita.
 */
export function inserirEntreNoXml(xml: string, a: string, b: string, novo: PedidoNovoElemento, raia?: string): { xml: string; criados: string[]; movidos: string[] } {
  let texto = xml;
  const d = lerDiagrama(texto);
  const fluxo = d.objetos.find((o) => o.tipo === 'SequenceFlow' && o.attrs['sourceRef'] === a && o.attrs['targetRef'] === b);
  if (!fluxo) throw new EdicaoInvalida(`não há ligação de ${a} para ${b}; use fluigctl diagram link para ligar`);
  const nomeDoFluxo = fluxo.attrs['name'] ?? '';
  const objA = d.objetos.find((o) => o.attrs['id'] === a)!;
  const condicao = objA.tipo === 'BpmnGateway' ? lerCondicoes(objA).condicoes.find((c) => c.destino === b) : undefined;
  const fa = figuraDe(d, a);
  const fb = figuraDe(d, b);
  if (!fa || !fb) throw new EdicaoInvalida(`${a} e ${b} precisam estar desenhados no diagrama`);

  const base = novo.tipo === 'recuperacao' ? 'servico' : novo.tipo;
  const { w } = tamanhoPrevisto(texto, d, base, novo.nome ?? '');
  const espaco = abrirEspaco(texto, fb.absX, w + ESPACO);
  texto = removerNoXml(espaco.xml, fluxo.attrs['id']!).xml;

  const cy = raia ? centroNaRaia(lerDiagrama(texto), raia) : fa.absY + fa.altura / 2;
  const cx = fb.absX + w / 2;
  const add = adicionarNoXml(texto, { tipo: novo.tipo, x: Math.round(cx), y: Math.round(cy), ...(novo.nome === undefined ? {} : { nome: novo.nome }), ...(novo.grupo === undefined ? {} : { grupo: novo.grupo }) });
  texto = add.xml;
  const principal = add.criados[0]!;
  texto = ligarNoXml(texto, a, principal, nomeDoFluxo).xml;
  texto = ligarNoXml(texto, principal, b).xml;
  if (condicao) {
    const atuais = lerCondicoes(lerDiagrama(texto).objetos.find((o) => o.attrs['id'] === a)!).condicoes;
    texto = trocarCondicoesNoXml(texto, a, [...atuais.filter((c) => c.destino !== principal), { ...condicao, destino: principal }]);
  }
  texto = endireitarNoXml(texto, fluxosDe(texto, [a, b, principal, ...espaco.movidos])).xml;
  return { xml: texto, criados: add.criados, movidos: espaco.movidos };
}

/** Põe um elemento logo à direita de `a`, na mesma linha, abrindo espaço, e liga `a` → novo. */
export function inserirDepoisNoXml(xml: string, a: string, novo: PedidoNovoElemento, raia?: string): { xml: string; criados: string[]; movidos: string[] } {
  let texto = xml;
  const d = lerDiagrama(texto);
  const fa = figuraDe(d, a);
  if (!fa) throw new EdicaoInvalida(`${a} precisa estar desenhado no diagrama`);
  const base = novo.tipo === 'recuperacao' ? 'servico' : novo.tipo;
  const { w } = tamanhoPrevisto(texto, d, base, novo.nome ?? '');
  const inicio = fa.absX + fa.largura + ESPACO;
  const espaco = abrirEspaco(texto, fa.absX + fa.largura + 1, w + ESPACO);
  texto = espaco.xml;
  const cy = raia ? centroNaRaia(lerDiagrama(texto), raia) : fa.absY + fa.altura / 2;
  const add = adicionarNoXml(texto, { tipo: novo.tipo, x: Math.round(inicio + w / 2), y: Math.round(cy), ...(novo.nome === undefined ? {} : { nome: novo.nome }), ...(novo.grupo === undefined ? {} : { grupo: novo.grupo }) });
  texto = ligarNoXml(add.xml, a, add.criados[0]!).xml;
  texto = endireitarNoXml(texto, fluxosDe(texto, [a, add.criados[0]!, ...espaco.movidos])).xml;
  return { xml: texto, criados: add.criados, movidos: espaco.movidos };
}

/** Troca (ou acrescenta) a condição de uma saída do gateway, sem mexer nas outras. */
export function definirCondicaoNoXml(xml: string, gateway: string, destino: string, condicao: Omit<Condicao, 'destino'>): string {
  const d = lerDiagrama(xml);
  const g = d.objetos.find((o) => o.attrs['id'] === gateway);
  if (!g || g.tipo !== 'BpmnGateway') throw new EdicaoInvalida(`${gateway} não é um gateway`);
  if (!d.objetos.some((o) => o.tipo === 'SequenceFlow' && o.attrs['sourceRef'] === gateway && o.attrs['targetRef'] === destino)) {
    throw new EdicaoInvalida(`o gateway ${gateway} não tem saída para ${destino}; ligue antes com fluigctl diagram link`);
  }
  const atuais = lerCondicoes(g);
  if (!atuais.editavel) throw new EdicaoInvalida(`as condições de ${gateway} não são editáveis aqui: ${atuais.motivo ?? ''}`);
  const anterior = atuais.condicoes.find((c) => c.destino === destino);
  const nova: Condicao = { ...condicao, destino, ...(anterior?.ordem ? { ordem: anterior.ordem } : {}) };
  return trocarCondicoesNoXml(xml, gateway, [...atuais.condicoes.filter((c) => c.destino !== destino), nova]);
}

const TIPO_LEGIVEL: Record<string, string> = {
  'BpmnStartEvent/10': 'início',
  'BpmnEndEvent/60': 'fim',
  'BpmnTask/80': 'tarefa humana',
  'BpmnTask/82': 'service task',
  'BpmnTask/84': 'e-mail',
  'BpmnGateway/120': 'gateway exclusivo',
  'BpmnGateway/121': 'gateway inclusivo',
  'BpmnGateway/126': 'gateway paralelo',
  'BpmnGateway/127': 'junção paralela',
  'BpmnIntermediateEvent/43': 'evento de erro',
  'BpmnAnnotation/0': 'anotação',
};

export interface ElementoMostrado {
  id: string;
  tipo: string;
  nome: string;
  raia?: string | undefined;
  atribuicao?: string | undefined;
  /** Evento de erro preso a uma tarefa. */
  presoA?: string | undefined;
  saidas: { fluxo: string; destino: string; nome: string; condicao?: string | undefined }[];
}

export interface DiagramaMostrado {
  processo: { id: string; nome: string; formulario: string };
  raias: { id: string; nome: string }[];
  elementos: ElementoMostrado[];
}

function descreverCondicao(c: Condicao | undefined): string | undefined {
  if (!c) return undefined;
  if (c.tipo === 'expressao') return `expressão ${c.expressao}`;
  return c.regras.map((r) => `${r.campo} ${r.operador === '1' ? '=' : r.operador === '2' ? '!=' : `(op ${r.operador})`} ${r.valor}`).join(' e ');
}

/** O que o agente precisa saber do diagrama para editá-lo, sem ler o XML. */
export function mostrarDiagrama(xml: string): DiagramaMostrado {
  const d = lerDiagrama(xml);
  const processo = d.objetos.find((o) => o.tipo === 'BpmnProcess');
  const raias = d.objetos.filter((o) => o.tipo === 'BpmnSwimLane' && d.caixas.has(o.attrs['id'] ?? '')).map((o) => ({ id: o.attrs['id']!, nome: o.attrs['name'] ?? '', c: d.caixas.get(o.attrs['id']!)! }));
  const raiaDe = (id: string) => {
    const f = figuraDe(d, id);
    if (!f) return undefined;
    const cy = f.absY + f.altura / 2;
    return raias.find((r) => cy >= r.c.absY && cy < r.c.absY + r.c.altura)?.nome;
  };
  const fluxos = d.objetos.filter((o) => o.tipo === 'SequenceFlow');
  // Na ordem do fluxo: a partir dos inícios, em largura; o que sobra, na ordem do arquivo.
  const nos = d.objetos.filter((o) => !['BpmnProcess', 'BpmnPool', 'BpmnSwimLane', 'SequenceFlow'].includes(o.tipo) && o.attrs['id']);
  const ordem: string[] = [];
  const fila = nos.filter((o) => o.tipo === 'BpmnStartEvent').map((o) => o.attrs['id']!);
  while (fila.length) {
    const atual = fila.shift()!;
    if (ordem.includes(atual)) continue;
    ordem.push(atual);
    // O evento de erro vem logo depois da tarefa dele.
    for (const ev of nos.filter((o) => o.attrs['parentTask'] === atual)) fila.unshift(ev.attrs['id']!);
    for (const f of fluxos.filter((x) => x.attrs['sourceRef'] === atual)) fila.push(f.attrs['targetRef'] ?? '');
  }
  for (const o of nos) if (!ordem.includes(o.attrs['id']!)) ordem.push(o.attrs['id']!);
  const elementos: ElementoMostrado[] = ordem
    .map((id) => nos.find((o) => o.attrs['id'] === id))
    .filter((o): o is ObjetoBpmn => o !== undefined)
    .map((o) => {
      const id = o.attrs['id']!;
      const at = o.tipo === 'BpmnTask' && o.attrs['type'] === '80' ? lerAtribuicao(o) : undefined;
      const condicoes = o.tipo === 'BpmnGateway' ? lerCondicoes(o).condicoes : [];
      return {
        id,
        tipo: TIPO_LEGIVEL[`${o.tipo}/${o.attrs['type'] ?? ''}`] ?? `${o.tipo}${o.attrs['type'] ? `/${o.attrs['type']}` : ''}`,
        nome: o.attrs['name'] ?? '',
        raia: raiaDe(id),
        atribuicao: at
          ? at.mecanismo
            ? `${at.mecanismo}${Object.keys(at.campos).length ? ` (${Object.entries(at.campos).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`
            : 'sem mecanismo'
          : undefined,
        presoA: o.attrs['parentTask'],
        saidas: fluxos
          .filter((f) => f.attrs['sourceRef'] === id)
          .map((f) => ({ fluxo: f.attrs['id']!, destino: f.attrs['targetRef'] ?? '', nome: f.attrs['name'] ?? '', condicao: descreverCondicao(condicoes.find((c) => c.destino === f.attrs['targetRef'])) })),
      };
    });
  return {
    processo: { id: processo?.attrs['id'] ?? '', nome: processo?.attrs['name'] ?? '', formulario: processo?.attrs['cardIndex'] ?? '' },
    raias: raias.map((r) => ({ id: r.id, nome: r.nome })),
    elementos,
  };
}

export function formatarDiagrama(m: DiagramaMostrado): string {
  const nomes = new Map(m.elementos.map((e) => [e.id, e.nome]));
  const linhas = [
    `processo ${m.processo.id} "${m.processo.nome}"${m.processo.formulario ? `, formulário ${m.processo.formulario}` : ', sem formulário'}`,
    `raias: ${m.raias.map((r) => `${r.id} "${r.nome}"`).join(', ') || '-'}`,
    '',
  ];
  for (const e of m.elementos) {
    linhas.push(`${e.id}  ${e.tipo}  "${e.nome}"${e.raia ? `  [${e.raia}]` : ''}${e.presoA ? `  preso a ${e.presoA}` : ''}`);
    if (e.atribuicao) linhas.push(`    atribuição: ${e.atribuicao}`);
    for (const s of e.saidas) {
      linhas.push(`    → ${s.destino} "${nomes.get(s.destino) ?? ''}"  (${s.fluxo}${s.nome ? `, "${s.nome}"` : ''})${s.condicao ? `  se ${s.condicao}` : ''}`);
    }
  }
  return linhas.join('\n');
}
