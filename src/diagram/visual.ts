import { lerDiagrama, type ObjetoBpmn } from '../push/diagram/modelo.js';
import { ESTILOS_STUDIO } from './estilos-studio.js';
import { garantirFontes } from './fonts.js';
import { codificarAtributo, estiloDoArquivo } from './props.js';

/**
 * A parte visual que o Studio grava e que um diagrama montado fora dele não
 * tem: estilos (`<styles>`), cores (`<colors>`), o retângulo arredondado da
 * tarefa, a seta do fluxo. Sem ela o Studio abre o arquivo, mas pinta as formas
 * sem cor sobre o fundo cinza e só os ícones aparecem.
 *
 * O reparo redesenha, como o Studio grava (acervo: 95 diagramas), cada forma
 * ou ligação que não tem estilo nenhum, mantendo o que é do usuário: posição,
 * tamanho, rótulo, ligações e dobras. O que já tem estilo não é tocado, então
 * um diagrama do Studio passa sem mudança. Estilos e cores novos entram no fim
 * das listas, e nenhuma referência existente muda de índice. Cada forma ganha
 * os seus estilos, como o Studio faz; a ponta da seta é uma só para todas.
 */

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;

interface Elemento {
  nome: string;
  /** Atributos como estão no arquivo, sem decodificar. */
  attrs: Map<string, string>;
  filhos: Elemento[];
  inicio: number;
  fim: number;
}

function lerAtributos(texto: string): Map<string, string> {
  return new Map([...texto.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

/** Árvore de um trecho de XML, com as posições de cada elemento no texto. */
function arvore(xml: string, de = 0, ate = xml.length): Elemento[] {
  const raiz: Elemento = { nome: '', attrs: new Map(), filhos: [], inicio: de, fim: ate };
  const pilha = [raiz];
  TOKEN.lastIndex = de;
  for (let m = TOKEN.exec(xml); m && m.index < ate; m = TOKEN.exec(xml)) {
    const [inteiro, fecha, nome, attrs, vazia] = m;
    if (nome === undefined) continue;
    if (fecha) {
      const el = pilha.pop()!;
      el.fim = m.index + inteiro.length;
      continue;
    }
    const el: Elemento = { nome, attrs: lerAtributos(attrs ?? ''), filhos: [], inicio: m.index, fim: m.index + inteiro.length };
    pilha[pilha.length - 1]!.filhos.push(el);
    if (!vazia) pilha.push(el);
  }
  return raiz.filhos;
}

const filhos = (e: Elemento, nome: string) => e.filhos.filter((f) => f.nome === nome);
const primeiro = (e: Elemento, nome: string) => e.filhos.find((f) => f.nome === nome);

function temEstilo(xml: string, e: Elemento): boolean {
  return /\sstyle="/.test(xml.slice(e.inicio, e.fim));
}

type Rgb = [number, number, number];

/** O que se acumula ao redesenhar: os estilos e as cores novos, com o índice que vão ter. */
class Paleta {
  readonly estilos: string[] = [];
  readonly cores: Rgb[] = [];
  private seta: string | undefined;
  constructor(
    private readonly qtdEstilos: number,
    private readonly coresExistentes: Rgb[],
  ) {}

  cor(rgb: Rgb): string {
    const igual = (c: Rgb) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2];
    const i = this.coresExistentes.findIndex(igual);
    if (i >= 0) return `/0/@colors.${i}`;
    let j = this.cores.findIndex(igual);
    if (j < 0) j = this.cores.push(rgb) - 1;
    return `/0/@colors.${this.coresExistentes.length + j}`;
  }

  estilo(id: string): string {
    const texto = ESTILOS_STUDIO[id];
    if (texto === undefined) throw new Error(`estilo do Studio desconhecido: ${id}`);
    this.estilos.push(texto.replace(/\{\{(\d+),(\d+),(\d+)\}\}/g, (_, r, g, b) => this.cor([+r, +g, +b])));
    return `/0/@styles.${this.qtdEstilos + this.estilos.length - 1}`;
  }

  /** A ponta da seta: o Studio grava uma e todas as ligações apontam para ela. */
  estiloDaSeta(existentes: Elemento[]): string {
    if (this.seta) return this.seta;
    const i = existentes.findIndex((e) => e.attrs.get('id') === 'BPMN-POLYGON-ARROW');
    this.seta = i >= 0 ? `/0/@styles.${i}` : this.estilo('BPMN-POLYGON-ARROW');
    return this.seta;
  }
}

const PRETO: Rgb = [0, 0, 0];
const BRANCO: Rgb = [255, 255, 255];
const FUNDO: Rgb = [227, 238, 249];
const RAIO: Rgb = [153, 153, 0];

function attrs(pares: [string, string | undefined][]): string {
  return pares.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${v}"`).join(' ');
}

function corDoArquivo(e: Elemento): Rgb {
  return [Number(e.attrs.get('red') ?? 0), Number(e.attrs.get('green') ?? 0), Number(e.attrs.get('blue') ?? 0)];
}

function escreverCor([r, g, b]: Rgb): string {
  return `<colors${r ? ` red="${r}"` : ''}${g ? ` green="${g}"` : ''}${b ? ` blue="${b}"` : ''}/>`;
}

interface Contexto {
  xml: string;
  paleta: Paleta;
  objetos: Map<string, ObjetoBpmn>;
  codificar: (valor: string) => string;
  estilosExistentes: Elemento[];
}

/** O texto do rótulo como está no arquivo (codificado), ou o nome do objeto. */
function rotulo(ctx: Contexto, forma: Elemento, id: string): string {
  for (const c of filhos(forma, 'children')) {
    if (primeiro(c, 'link')) continue;
    const ga = primeiro(c, 'graphicsAlgorithm');
    const tipo = ga?.attrs.get('xsi:type');
    if (tipo === 'al:Text' || tipo === 'al:MultiText') return ga!.attrs.get('value') ?? '';
  }
  return ctx.codificar(ctx.objetos.get(id)?.attrs['name'] ?? '');
}

const ancoraCaixa = (recuo: string, ref: string, w: string, h: string) =>
  `${recuo}<anchors xsi:type="pi:BoxRelativeAnchor" visible="true" active="true" referencedGraphicsAlgorithm="${ref}" relativeWidth="${w}" relativeHeight="${h}">\n` +
  `${recuo}  <graphicsAlgorithm xsi:type="al:Ellipse" filled="false" lineVisible="false"/>\n` +
  `${recuo}</anchors>`;

/** A primeira âncora, com as ligações que já tinha: é a que os fluxos apontam. */
function ancoraDasLigacoes(forma: Elemento, recuo: string): string {
  const a = filhos(forma, 'anchors')[0];
  const ligacoes = a ? attrs([['outgoingConnections', a.attrs.get('outgoingConnections')], ['incomingConnections', a.attrs.get('incomingConnections')]]) : '';
  return `${recuo}<anchors xsi:type="pi:ChopboxAnchor"${ligacoes ? ` ${ligacoes}` : ''}/>`;
}

interface Caixa {
  x: string | undefined;
  y: string | undefined;
  w: number;
  h: number;
}

function caixaDe(forma: Elemento): Caixa {
  const ga = primeiro(forma, 'graphicsAlgorithm');
  return {
    x: ga?.attrs.get('x'),
    y: ga?.attrs.get('y'),
    w: Number(ga?.attrs.get('width') ?? 0),
    h: Number(ga?.attrs.get('height') ?? 0),
  };
}

function evento(ctx: Contexto, forma: Elemento, caminho: string, r: string, id: string, estiloId: string, linha: string): string {
  const c = caixaDe(forma);
  const p = ctx.paleta;
  return [
    `${r}<children xsi:type="pi:ContainerShape" visible="true" active="true">`,
    `${r}  <graphicsAlgorithm ${attrs([['xsi:type', 'al:Ellipse'], ['lineWidth', '1'], ['filled', 'false'], ['lineVisible', 'false'], ['transparency', '0.0'], ['width', String(c.w)], ['height', String(c.h)], ['x', c.x], ['y', c.y]])}>`,
    `${r}    <graphicsAlgorithmChildren ${attrs([['xsi:type', 'al:Ellipse'], ['lineWidth', linha], ['transparency', '0.0'], ['width', String(c.w)], ['height', String(c.h)], ['style', p.estilo(estiloId)]])}/>`,
    `${r}  </graphicsAlgorithm>`,
    `${r}  <link businessObjects="${id}"/>`,
    ancoraDasLigacoes(forma, `${r}  `),
    ancoraCaixa(`${r}  `, `${caminho}/@graphicsAlgorithm/@graphicsAlgorithmChildren.0`, '1.0', '0.51'),
  ].join('\n');
}

function redesenharForma(ctx: Contexto, forma: Elemento, caminho: string, r: string): string | undefined {
  const id = primeiro(forma, 'link')?.attrs.get('businessObjects');
  const o = id ? ctx.objetos.get(id) : undefined;
  if (!id || !o) return undefined;
  const p = ctx.paleta;
  const tipo = `${o.tipo}/${o.attrs['type'] ?? ''}`;
  const c = caixaDe(forma);
  const fim = `${r}</children>`;

  // Os outros tipos de evento (tempo, link, sinal, fim com mensagem...) têm um
  // ícone desenhado dentro; sem ele, ficam com o círculo e as cores do Studio.
  if (o.tipo === 'BpmnStartEvent' && tipo !== 'BpmnStartEvent/10') return [evento(ctx, forma, caminho, r, id, 'START-EVENT', '1'), fim].join('\n');
  if (o.tipo === 'BpmnEndEvent' && tipo !== 'BpmnEndEvent/60') return [evento(ctx, forma, caminho, r, id, 'END-EVENT', '3'), fim].join('\n');
  if (o.tipo === 'BpmnIntermediateEvent' && tipo !== 'BpmnIntermediateEvent/43') return [evento(ctx, forma, caminho, r, id, 'INTERMEDIATE-EVENT', '1'), fim].join('\n');

  switch (tipo) {
    case 'BpmnStartEvent/10':
      return [evento(ctx, forma, caminho, r, id, 'START-EVENT', '1'), fim].join('\n');
    case 'BpmnEndEvent/60':
      return [evento(ctx, forma, caminho, r, id, 'END-EVENT', '3'), fim].join('\n');
    case 'BpmnIntermediateEvent/43': {
      // O Studio grava o evento de erro com 30x30; mantém o centro.
      const ga = primeiro(forma, 'graphicsAlgorithm')!;
      const centro = (v: string | undefined, t: number) => String(Math.round(Number(v ?? 0) + t / 2 - 15));
      const ajustada: Elemento = {
        ...forma,
        filhos: forma.filhos.map((f) =>
          f === ga ? { ...ga, attrs: new Map([...ga.attrs, ['width', '30'], ['height', '30'], ['x', centro(c.x, c.w)], ['y', centro(c.y, c.h)]]) } : f,
        ),
      };
      const raio = [[6, 25], [12, 5], [18, 15], [26, 5], [18, 25], [12, 15]];
      return [
        evento(ctx, ajustada, caminho, r, id, 'INTERMEDIATE-EVENT', '1'),
        `${r}  <children visible="true">`,
        `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:Polygon'], ['foreground', p.cor(RAIO)], ['lineWidth', '2'], ['filled', 'false'], ['lineVisible', 'true'], ['transparency', '0.0'], ['width', '20'], ['height', '20']])}>`,
        ...raio.map(([x, y]) => `${r}      <points x="${x}" y="${y}"/>`),
        `${r}    </graphicsAlgorithm>`,
        `${r}  </children>`,
        fim,
      ].join('\n');
    }
    case 'BpmnTask/80':
    case 'BpmnTask/81':
    case 'BpmnTask/82':
    case 'BpmnTask/84':
    case 'BpmnTask/87': {
      const imagem = { 'BpmnTask/82': 'task.service', 'BpmnTask/84': 'task.mail' }[tipo as string];
      const icone = imagem
        ? [
            `${r}  <children visible="true">`,
            `${r}    <graphicsAlgorithm xsi:type="al:Image" lineWidth="1" transparency="0.0" width="16" height="16" x="5" y="5" id="com.totvs.tds.ecm.designer.${imagem}" stretchH="false" stretchV="false" proportional="false"/>`,
            `${r}  </children>`,
          ]
        : [];
      const texto = rotulo(ctx, forma, id);
      return [
        `${r}<children xsi:type="pi:ContainerShape" visible="true" active="true">`,
        `${r}  <graphicsAlgorithm ${attrs([['xsi:type', 'al:Rectangle'], ['lineWidth', '1'], ['filled', 'false'], ['lineVisible', 'false'], ['transparency', '0.0'], ['width', String(c.w)], ['height', String(c.h)], ['x', c.x], ['y', c.y]])}/>`,
        `${r}  <link businessObjects="${id}"/>`,
        ancoraDasLigacoes(forma, `${r}  `),
        ancoraCaixa(`${r}  `, `${caminho}/@graphicsAlgorithm`, '1.0', '0.51'),
        `${r}  <children visible="true">`,
        `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:RoundedRectangle'], ['lineWidth', '1'], ['transparency', '0.0'], ['width', String(c.w)], ['height', String(c.h)], ['style', p.estilo('TASK')], ['cornerHeight', '5'], ['cornerWidth', '5']])}/>`,
        `${r}  </children>`,
        `${r}  <children visible="true">`,
        `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:MultiText'], ['lineWidth', '1'], ['filled', 'false'], ['lineVisible', 'true'], ['transparency', '0.0'], ['width', String(c.w - 10)], ['height', String(c.h - 10)], ['x', '5'], ['y', '5'], ['style', p.estilo('BPMNCLASS-TEXT')], ['horizontalAlignment', 'ALIGNMENT_CENTER'], ['value', texto]])}/>`,
        `${r}  </children>`,
        ...icone,
        fim,
      ].join('\n');
    }
    case 'BpmnGateway/120':
    case 'BpmnGateway/121':
    case 'BpmnGateway/126':
    case 'BpmnGateway/127': {
      // O losango tem 60 de largura; o pull desenha o gateway como caixa de
      // tarefa, e aí a altura vira a do Studio com rótulo de uma linha.
      if (c.w !== 60) {
        c.w = 60;
        c.h = 86;
      }
      const losango = p.estilo('GATEWAY');
      const cruz = tipo === 'BpmnGateway/120'
        ? []
        : tipo === 'BpmnGateway/121'
        ? [`${r}      <graphicsAlgorithmChildren ${attrs([['xsi:type', 'al:Ellipse'], ['lineWidth', '1'], ['transparency', '0.0'], ['width', '35'], ['height', '35'], ['x', '13'], ['y', '13'], ['style', p.estilo('GATEWAY')]])}/>`]
        : [
            [[8, 27], [52, 27]],
            [[27, 8], [27, 52]],
          ].flatMap((pontos) => [
            `${r}      <graphicsAlgorithmChildren ${attrs([['xsi:type', 'al:Polyline'], ['lineWidth', '12'], ['filled', 'false'], ['transparency', '0.0'], ['style', p.estilo('GATEWAY')]])}>`,
            ...pontos.map(([x, y]) => `${r}        <points x="${x}" y="${y}"/>`),
            `${r}      </graphicsAlgorithmChildren>`,
          ]);
      const texto = rotulo(ctx, forma, id);
      const losangoRef = `${caminho}/@graphicsAlgorithm/@graphicsAlgorithmChildren.0`;
      return [
        `${r}<children xsi:type="pi:ContainerShape" visible="true" active="true">`,
        `${r}  <graphicsAlgorithm ${attrs([['xsi:type', 'al:Rectangle'], ['lineWidth', '1'], ['filled', 'false'], ['lineVisible', 'false'], ['transparency', '0.0'], ['width', String(c.w)], ['height', String(c.h)], ['x', c.x], ['y', c.y]])}>`,
        `${r}    <graphicsAlgorithmChildren ${attrs([['xsi:type', 'al:Polygon'], ['lineWidth', '1'], ['filled', 'true'], ['transparency', '0.0'], ['width', '60'], ['height', '60'], ['style', losango]])}>`,
        ...cruz,
        `${r}      <points y="30"/>`,
        `${r}      <points x="30"/>`,
        `${r}      <points x="60" y="30"/>`,
        `${r}      <points x="30" y="60"/>`,
        `${r}      <points y="30"/>`,
        `${r}    </graphicsAlgorithmChildren>`,
        `${r}  </graphicsAlgorithm>`,
        `${r}  <link businessObjects="${id}"/>`,
        ancoraDasLigacoes(forma, `${r}  `),
        `${r}  <anchors xsi:type="pi:ChopboxAnchor"/>`,
        ancoraCaixa(`${r}  `, losangoRef, '0.51', '0.1'),
        `${r}  <anchors xsi:type="pi:ChopboxAnchor"/>`,
        ancoraCaixa(`${r}  `, losangoRef, '0.51', '0.93'),
        `${r}  <children visible="true">`,
        `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:MultiText'], ['lineWidth', '1'], ['filled', 'false'], ['lineVisible', 'true'], ['transparency', '0.0'], ['width', '60'], ['height', String(Math.max(c.h - 60, 0))], ['y', '60'], ['style', p.estilo('BPMNCLASS-TEXT')], ['horizontalAlignment', 'ALIGNMENT_CENTER'], ['value', texto]])}/>`,
        `${r}  </children>`,
        fim,
      ].join('\n');
    }
    case 'BpmnPool/':
    case 'BpmnSwimLane/': {
      // A pool leva as raias dentro (x/y relativos) e o rótulo girado depois delas.
      const raias = filhos(forma, 'children').filter((f) => primeiro(f, 'link'));
      const desenhadas = raias.map((raia, i) => redesenharForma(ctx, raia, `${caminho}/@children.${i}`, `${r}  `) ?? ctx.xml.slice(raia.inicio, raia.fim));
      const texto = rotulo(ctx, forma, id);
      return [
        `${r}<children xsi:type="pi:ContainerShape" visible="true" active="true">`,
        `${r}  <graphicsAlgorithm ${attrs([['xsi:type', 'al:Rectangle'], ['background', p.cor(BRANCO)], ['foreground', p.cor(PRETO)], ['lineWidth', '1'], ['transparency', '0.0'], ['width', String(c.w)], ['height', String(c.h)], ['x', c.x], ['y', c.y], ['style', p.estilo('BPMN-SWIM_LANE-NOSTYLE')]])}/>`,
        `${r}  <link businessObjects="${id}"/>`,
        `${r}  <anchors xsi:type="pi:ChopboxAnchor"/>`,
        `${r}  <anchors xsi:type="pi:ChopboxAnchor"/>`,
        ancoraCaixa(`${r}  `, `${caminho}/@graphicsAlgorithm`, '1.0', '0.51'),
        ...desenhadas.map((d) => d.replace(/^[ \t]*/, `${r}  `)),
        `${r}  <children visible="true">`,
        `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:Text'], ['lineWidth', '1'], ['filled', 'false'], ['lineVisible', 'true'], ['transparency', '0.0'], ['width', '30'], ['height', String(c.h)], ['style', p.estilo('BPMNCLASS-TEXT-67-67-67')], ['horizontalAlignment', 'ALIGNMENT_CENTER'], ['verticalAlignment', 'ALIGNMENT_MIDDLE'], ['angle', '270'], ['value', texto], ['rotation', '270.0']])}/>`,
        `${r}  </children>`,
        fim,
      ].join('\n');
    }
    default:
      return undefined;
  }
}

function redesenharLigacao(ctx: Contexto, lig: Elemento, r: string): string | undefined {
  const id = primeiro(lig, 'link')?.attrs.get('businessObjects');
  if (!id || !ctx.objetos.has(id)) return undefined;
  const p = ctx.paleta;
  const nome = ctx.codificar(ctx.objetos.get(id)!.attrs['name'] ?? '');
  const dobras = filhos(lig, 'bendpoints').map((b) => `${r}  ${ctx.xml.slice(b.inicio, b.fim)}`);
  const preto = p.cor(PRETO);
  return [
    `${r}<connections ${attrs([['xsi:type', 'pi:FreeFormConnection'], ['visible', 'true'], ['active', 'true'], ['start', lig.attrs.get('start')], ['end', lig.attrs.get('end')]])}>`,
    `${r}  <graphicsAlgorithm ${attrs([['xsi:type', 'al:Polyline'], ['foreground', preto], ['lineWidth', '1'], ['filled', 'false'], ['transparency', '0.0']])}/>`,
    `${r}  <link businessObjects="${id}"/>`,
    `${r}  <connectionDecorators visible="true" active="true" locationRelative="true" location="0.5">`,
    `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:Text'], ['lineWidth', '1'], ['filled', 'false'], ['transparency', '0.0'], ['x', '10'], ['style', p.estilo('BPMNCLASS-TEXT')], ['value', nome]])}/>`,
    `${r}  </connectionDecorators>`,
    `${r}  <connectionDecorators visible="true" locationRelative="true" location="1.0">`,
    `${r}    <graphicsAlgorithm ${attrs([['xsi:type', 'al:Polygon'], ['background', preto], ['foreground', preto], ['lineWidth', '1'], ['filled', 'true'], ['transparency', '0.0'], ['style', p.estiloDaSeta(ctx.estilosExistentes)]])}>`,
    `${r}      <points x="-10" y="-5" before="3" after="3"/>`,
    `${r}      <points/>`,
    `${r}      <points x="-10" y="5" before="3" after="3"/>`,
    `${r}      <points x="-8" before="3" after="3"/>`,
    `${r}    </graphicsAlgorithm>`,
    `${r}  </connectionDecorators>`,
    ...dobras,
    `${r}</connections>`,
  ].join('\n');
}

function recuoDa(xml: string, pos: number): string {
  return /^[ \t]*/.exec(xml.slice(xml.lastIndexOf('\n', pos - 1) + 1))![0];
}

function diagramaDe(xml: string): Elemento | undefined {
  const raizes = arvore(xml);
  const xmi = raizes.find((e) => e.nome === 'xmi:XMI');
  return xmi ? primeiro(xmi, 'pi:Diagram') : undefined;
}

/** Quantas formas e ligações estão sem estilo nenhum (o que garantirVisual redesenha). */
export function formasSemEstilo(xml: string): number {
  const d = diagramaDe(xml);
  if (!d) return 0;
  return [...filhos(d, 'children'), ...filhos(d, 'connections')].filter((e) => primeiro(e, 'link') && !temEstilo(xml, e)).length;
}

/** Devolve o XML com a parte visual do Studio em toda forma e ligação que não a tinha; o mesmo texto quando nada falta. */
export function garantirVisual(xml: string): string {
  const d = diagramaDe(xml);
  if (!d) return xml;
  const semEstilo = (e: Elemento) => primeiro(e, 'link') !== undefined && !temEstilo(xml, e);
  const formas = filhos(d, 'children');
  const ligacoes = filhos(d, 'connections');
  const fundo = primeiro(d, 'graphicsAlgorithm');
  const fundoSemCor = fundo !== undefined && !fundo.attrs.has('background');
  if (!formas.some(semEstilo) && !ligacoes.some(semEstilo) && !fundoSemCor) return xml;

  const estilosExistentes = filhos(d, 'styles');
  const coresExistentes = filhos(d, 'colors');
  const paleta = new Paleta(estilosExistentes.length, coresExistentes.map(corDoArquivo));
  const estiloAttr = estiloDoArquivo(xml);
  const ctx: Contexto = {
    xml,
    paleta,
    objetos: new Map(lerDiagrama(xml).objetos.filter((o) => o.attrs['id']).map((o) => [o.attrs['id']!, o])),
    codificar: (v) => codificarAtributo(v, estiloAttr),
    estilosExistentes,
  };

  // Trocas no texto: [início, fim, texto novo], aplicadas do fim para o começo.
  const trocas: [number, number, string][] = [];
  formas.forEach((f, i) => {
    if (!semEstilo(f)) return;
    const novo = redesenharForma(ctx, f, `/0/@children.${i}`, recuoDa(xml, f.inicio));
    if (novo !== undefined) trocas.push([f.inicio - recuoDa(xml, f.inicio).length, f.fim, novo]);
  });
  for (const l of ligacoes) {
    if (!semEstilo(l)) continue;
    const novo = redesenharLigacao(ctx, l, recuoDa(xml, l.inicio));
    if (novo !== undefined) trocas.push([l.inicio - recuoDa(xml, l.inicio).length, l.fim, novo]);
  }
  if (fundo && fundoSemCor) {
    const tag = xml.slice(fundo.inicio, fundo.fim);
    const nova = tag.replace(/(xsi:type="[^"]*")(\s+lineWidth="[^"]*")?/, (_, t, lw) => `${t} background="${paleta.cor(BRANCO)}" foreground="${paleta.cor(FUNDO)}"${lw ?? ' lineWidth="1"'} transparency="0.0"`).replace(/ transparency="0\.0"(.*) transparency="[^"]*"/, ' transparency="0.0"$1');
    trocas.push([fundo.inicio, fundo.fim, nova]);
  }

  // Os estilos entram depois do último <styles> (ou antes da primeira ligação,
  // que é onde o Studio os grava); as cores, depois da última <colors> (ou
  // antes das fontes). Os índices novos foram contados a partir do fim das listas.
  const recuo = recuoDa(xml, (formas[0] ?? fundo ?? d).inicio);
  const posDepois = (lista: Elemento[], senao: number) => (lista.length ? lista[lista.length - 1]!.fim : senao);
  const fimDoDiagrama = xml.lastIndexOf('</pi:Diagram>', d.fim);
  const inicioDaLinha = (pos: number) => xml.lastIndexOf('\n', pos - 1) + 1;
  const antesDe = (e: Elemento | undefined) => (e ? inicioDaLinha(e.inicio) - 1 : inicioDaLinha(fimDoDiagrama) - 1);
  const ondeEstilos = posDepois(estilosExistentes, antesDe(ligacoes[0] ?? coresExistentes[0] ?? filhos(d, 'fonts')[0]));
  const ondeCores = posDepois(coresExistentes, antesDe(filhos(d, 'fonts')[0]));
  const blocoEstilos = paleta.estilos.map((e) => '\n' + e.split('\n').map((l) => recuo + l).join('\n')).join('');
  const blocoCores = paleta.cores.map((c) => `\n${recuo}${escreverCor(c)}`).join('');
  if (blocoEstilos) trocas.push([ondeEstilos, ondeEstilos, blocoEstilos]);
  if (blocoCores) trocas.push([ondeCores, ondeCores, blocoCores]);

  // Inserções num mesmo ponto: a dos estilos vem antes da das cores.
  trocas.sort((a, b) => b[0] - a[0] || (a[1] === a[0] && b[1] === b[0] ? (a[2] === blocoCores ? -1 : 1) : 0));
  let saida = xml;
  for (const [ini, fim, texto] of trocas) saida = saida.slice(0, ini) + texto + saida.slice(fim);
  return garantirFontes(saida);
}
