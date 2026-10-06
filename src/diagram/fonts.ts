import { blocosDeTopo } from './add.js';

/**
 * Todo texto do pictograma (`al:Text`, `al:MultiText`) precisa de fonte. O
 * Studio lê a fonte ao abrir o editor (`TotvsBpmnDiagramEditor.resizeGateway`
 * chama `getFont().getName()` no rótulo de cada gateway) e, sem ela, dá
 * NullPointerException e não abre o arquivo. Nos 3.585 textos dos diagramas do
 * acervo, todos têm `font="/0/@fonts.N"`; os rótulos de forma usam Arial 8
 * negrito e os de fluxo, Arial 8.
 *
 * O reparo é por patch de texto: acrescenta as fontes que faltam ao fim do
 * `pi:Diagram` (é onde o Studio as grava, depois de `colors`) e o atributo nos
 * textos que não o têm, na posição em que o Studio o escreve.
 */

const FONTE_FORMA = { name: 'Arial', size: '8', bold: true };
const FONTE_FLUXO = { name: 'Arial', size: '8', bold: false };

const TEXTO = /<graphicsAlgorithm\s[^>]*xsi:type="al:(?:Text|MultiText)"[^>]*?\/?>/g;

/** As `<fonts>` diretas do `pi:Diagram`, na ordem (o índice é o da referência). */
function fontesDoDiagrama(xml: string, inicio: number, fim: number): { name: string | undefined; size: string | undefined; bold: boolean }[] {
  const trecho = xml.slice(inicio, fim);
  return [...trecho.matchAll(/<fonts\s([^>]*?)\/?>/g)].map((m) => {
    const a = Object.fromEntries([...m[1]!.matchAll(/([\w:]+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]));
    return { name: a['name'], size: a['size'], bold: a['bold'] === 'true' };
  });
}

export function textosSemFonte(xml: string): number {
  return [...xml.matchAll(TEXTO)].filter((m) => !/\sfont="/.test(m[0])).length;
}

/** Devolve o XML com toda fonte que faltava; o mesmo texto quando nada falta. */
export function garantirFontes(xml: string): string {
  if (textosSemFonte(xml) === 0) return xml;
  const { blocos, diagrama } = blocosDeTopo(xml);
  const fimDiagrama = xml.indexOf('</pi:Diagram>', diagrama.inicio);
  if (fimDiagrama < 0) return xml;
  const fontes = fontesDoDiagrama(xml, diagrama.inicio, fimDiagrama);
  const novas: string[] = [];
  const indice = (f: typeof FONTE_FORMA) => {
    const i = fontes.findIndex((x) => x.name === f.name && x.size === f.size && x.bold === f.bold);
    if (i >= 0) return i;
    fontes.push({ name: f.name, size: f.size, bold: f.bold });
    novas.push(`<fonts name="${f.name}" size="${f.size}"${f.bold ? ' bold="true"' : ''}/>`);
    return fontes.length - 1;
  };
  const conexoes = blocos.filter((b) => b.tipo === 'connections');
  const ehFluxo = (pos: number) => conexoes.some((b) => pos >= b.inicio && pos < b.fim);

  let saida = '';
  let ultimo = 0;
  for (const m of xml.matchAll(TEXTO)) {
    const tag = m[0];
    if (/\sfont="/.test(tag)) continue;
    const ref = ` font="/0/@fonts.${indice(ehFluxo(m.index!) ? FONTE_FLUXO : FONTE_FORMA)}"`;
    // Onde o Studio escreve: antes do alinhamento e do valor, depois de style.
    const antes = /\s(?:horizontalAlignment|verticalAlignment|value)="/.exec(tag);
    const pos = antes ? antes.index : tag.length - (tag.endsWith('/>') ? 2 : 1);
    saida += xml.slice(ultimo, m.index!) + tag.slice(0, pos) + ref + tag.slice(pos);
    ultimo = m.index! + tag.length;
  }
  saida += xml.slice(ultimo);

  if (novas.length) {
    const fim = saida.indexOf('</pi:Diagram>', diagrama.inicio);
    const linha = saida.lastIndexOf('\n', fim) + 1;
    const recuo = /^[ \t]*$/.test(saida.slice(linha, fim)) ? saida.slice(linha, fim) : '';
    // Na linha do </pi:Diagram>, como os outros filhos dele; se a tag não está
    // sozinha na linha, entra logo antes dela.
    const onde = recuo || linha === fim ? linha : fim;
    saida = saida.slice(0, onde) + novas.map((n) => `${recuo}  ${n}\n`).join('') + saida.slice(onde);
  }
  return saida;
}
