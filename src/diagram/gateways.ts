/**
 * O losango do gateway é um `al:Polygon` com pontos. Sem pontos o Studio abre o
 * arquivo mas não desenha: ao ligar o fluxo, a âncora (`GFChopboxAnchor`) pede
 * o contorno da figura, recebe a lista vazia e dá IndexOutOfBoundsException.
 * Nos 95 diagramas do acervo, os 3.190 polígonos têm pontos e os 257 gateways
 * são um `al:Rectangle` invisível com o losango 60x60 dentro, o rótulo embaixo.
 *
 * O reparo é por patch de texto e não muda o número de elementos: o contorno
 * externo vira o retângulo invisível (mesma caixa) e cada polígono sem pontos
 * ganha os cinco do losango. Referências por caminho continuam valendo.
 */

const POLIGONO = /<(graphicsAlgorithm|graphicsAlgorithmChildren)\s([^>]*?)(\/?)>/g;

const LOSANGO = [{ y: 30 }, { x: 30 }, { x: 60, y: 30 }, { x: 30, y: 60 }, { y: 30 }];

/** Ordem em que o Studio escreve os atributos de um graphicsAlgorithm. */
const ORDEM = ['xsi:type', 'background', 'foreground', 'lineWidth', 'filled', 'lineVisible', 'transparency', 'width', 'height', 'x', 'y', 'style'];

function lerAtributos(texto: string): Map<string, string> {
  return new Map([...texto.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

function escreverAtributos(a: Map<string, string>): string {
  const chaves = [...ORDEM.filter((k) => a.has(k)), ...[...a.keys()].filter((k) => !ORDEM.includes(k))];
  return chaves.map((k) => `${k}="${a.get(k)}"`).join(' ');
}

interface Poligono {
  inicio: number;
  /** Fim da tag de abertura (ou da tag vazia). */
  fimTag: number;
  /** Fim do elemento inteiro, com a tag de fechamento. */
  fim: number;
  nome: string;
  attrs: Map<string, string>;
  vazio: boolean;
  temPontos: boolean;
}

/** Os `al:Polygon` do arquivo, com a extensão de cada um e se têm `<points>` próprios. */
function poligonos(xml: string): Poligono[] {
  const achados: Poligono[] = [];
  for (const m of xml.matchAll(POLIGONO)) {
    if (!/xsi:type="al:Polygon"/.test(m[2]!)) continue;
    const inicio = m.index!;
    const fimTag = inicio + m[0].length;
    const vazio = m[3] === '/';
    let fim = fimTag;
    let temPontos = false;
    if (!vazio) {
      // Acha o fechamento do mesmo nome, contando aninhamento; os pontos que
      // contam são os filhos diretos (os de polilinhas internas não).
      const re = new RegExp(`<(/?)(${m[1]}|points)\\b[^>]*?(/?)>`, 'g');
      re.lastIndex = fimTag;
      let nivel = 0;
      for (let t = re.exec(xml); t; t = re.exec(xml)) {
        if (t[2] === 'points') { if (nivel === 0) temPontos = true; continue; }
        if (t[1]) { if (nivel === 0) { fim = t.index + t[0].length; break; } nivel--; }
        else if (t[3] !== '/') nivel++;
      }
    }
    achados.push({ inicio, fimTag, fim, nome: m[1]!, attrs: lerAtributos(m[2]!), vazio, temPontos });
  }
  return achados;
}

export function poligonosSemPontos(xml: string): number {
  return poligonos(xml).filter((p) => !p.temPontos).length;
}

function recuoDa(xml: string, pos: number): string {
  const linha = xml.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(xml.slice(linha))![0];
}

/** Devolve o XML com cada losango como o Studio grava; o mesmo texto quando nada falta. */
export function garantirLosangos(xml: string): string {
  const quebrados = poligonos(xml).filter((p) => !p.temPontos);
  if (quebrados.length === 0) return xml;
  let saida = xml;
  // Do fim para o começo, para os índices de antes continuarem valendo.
  for (const p of [...quebrados].reverse()) {
    const recuo = recuoDa(saida, p.inicio);
    const a = new Map(p.attrs);
    // O polígono que é a forma do elemento (graphicsAlgorithm direto do
    // ContainerShape) vira a caixa invisível; o losango vai dentro dela.
    if (p.nome === 'graphicsAlgorithm') {
      const caixa = new Map(a);
      caixa.set('xsi:type', 'al:Rectangle');
      caixa.set('filled', 'false');
      caixa.set('lineVisible', 'false');
      caixa.set('transparency', '0.0');
      const tag = `<graphicsAlgorithm ${escreverAtributos(caixa)}`;
      const temFilhoPoligono = !p.vazio && /<graphicsAlgorithmChildren\s[^>]*xsi:type="al:Polygon"/.test(saida.slice(p.fimTag, p.fim));
      if (temFilhoPoligono) {
        saida = saida.slice(0, p.inicio) + tag + '>' + saida.slice(p.fimTag);
      } else {
        const miolo = p.vazio ? '' : saida.slice(p.fimTag, p.fim - '</graphicsAlgorithm>'.length).replace(/\s*$/, '');
        const losango = desenharLosango(`${recuo}  `, new Map([['xsi:type', 'al:Polygon'], ['lineWidth', a.get('lineWidth') ?? '1']]));
        saida = saida.slice(0, p.inicio) + tag + '>' + miolo + '\n' + losango + '\n' + recuo + '</graphicsAlgorithm>' + saida.slice(p.fim);
      }
      continue;
    }
    // Um losango interno sem pontos: ganha os pontos e a caixa 60x60, mantendo o que já tinha dentro.
    const miolo = p.vazio ? '' : saida.slice(p.fimTag, p.fim - `</${p.nome}>`.length).replace(/\s*$/, '');
    saida = saida.slice(0, p.inicio) + desenharLosango(recuo, a, miolo).trimStart() + saida.slice(p.fim);
  }
  return saida;
}

function desenharLosango(recuo: string, a: Map<string, string>, miolo = ''): string {
  const attrs = new Map(a);
  if (!attrs.has('filled')) attrs.set('filled', 'true');
  if (!attrs.has('transparency')) attrs.set('transparency', '0.0');
  attrs.set('width', '60');
  attrs.set('height', '60');
  const pontos = LOSANGO.map((p) => `${recuo}  <points${p.x === undefined ? '' : ` x="${p.x}"`}${p.y === undefined ? '' : ` y="${p.y}"`}/>`);
  return `${recuo}<graphicsAlgorithmChildren ${escreverAtributos(attrs)}>${miolo}\n${pontos.join('\n')}\n${recuo}</graphicsAlgorithmChildren>`;
}
