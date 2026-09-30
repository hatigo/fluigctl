import { ErroFluigctl } from '../../errors.js';

/**
 * Leitor de XML mínimo, sem dependência, para o `.process` (XMI do Graphiti) e
 * para o `.ecm30.xml` do Studio.
 *
 * Portado do `tokenize` de `fluig-cd/src/core/processConverter.ts`, do
 * fluiglocaldev (StrategiConsultoria). O ponto que importa: a regex da tag
 * consome o valor entre aspas inteiro, então um `>` cru dentro de atributo — o
 * `.process` tem muitos, nos blobs XStream — não encerra a tag. Diferente do
 * original, o que não casa com a regex é erro, e não pulado em silêncio: uma
 * tag perdida mudaria a árvore sem ninguém ver.
 */

export interface No {
  nome: string;
  attrs: Record<string, string>;
  filhos: No[];
  /** Texto decodificado do elemento, quando ele não tem filhos. */
  texto: string;
}

const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/y;
const ATRIBUTO = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

const NOMEADAS: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return NOMEADAS[ref] ?? '';
  });
}

/** Escapa texto de elemento como o XStream do Studio escreve no `.ecm30.xml`. */
export function escaparTexto(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#xd;');
}

function ilegivel(motivo: string): ErroFluigctl {
  return new ErroFluigctl(`XML ilegível: ${motivo}`, 6);
}

/** Monta a árvore do documento. Declaração, comentário e DOCTYPE são ignorados. */
export function lerXml(xml: string): No {
  const raiz: No = { nome: '#documento', attrs: {}, filhos: [], texto: '' };
  const pilha: No[] = [raiz];
  let texto = '';
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      texto += xml.slice(i);
      break;
    }
    texto += xml.slice(i, lt);

    if (xml.startsWith('<?', lt) || xml.startsWith('<!--', lt)) {
      const fim = xml.startsWith('<!--', lt) ? xml.indexOf('-->', lt) + 2 : xml.indexOf('?>', lt) + 1;
      if (fim < lt) throw ilegivel(`declaração sem fim na posição ${lt}`);
      i = fim + 1;
      continue;
    }
    // CDATA e DOCTYPE não aparecem nos arquivos do Studio; pular mudaria o conteúdo sem aviso.
    if (xml.startsWith('<!', lt)) throw ilegivel(`${xml.slice(lt, lt + 10)} na posição ${lt} não é suportado`);

    TAG.lastIndex = lt;
    const m = TAG.exec(xml);
    if (!m) throw ilegivel(`tag malformada na posição ${lt}: ${xml.slice(lt, lt + 40)}`);
    i = TAG.lastIndex;

    const [, fecha, nome = '', attrsBrutos = '', vazia] = m;
    const topo = pilha[pilha.length - 1]!;
    // Texto só vale como conteúdo de um elemento folha; entre elementos, só espaço.
    const misto = !fecha || topo.filhos.length > 0;
    if (misto && texto.trim() !== '') {
      throw ilegivel(`texto fora de elemento folha antes da posição ${lt}: ${texto.trim().slice(0, 40)}`);
    }

    if (fecha) {
      if (topo.nome !== nome) throw ilegivel(`</${nome}> fecha <${topo.nome}>`);
      if (topo.filhos.length === 0) topo.texto = decodificarEntidades(texto);
      pilha.pop();
      texto = '';
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const a of attrsBrutos.matchAll(ATRIBUTO)) attrs[a[1]!] = decodificarEntidades(a[2]!);
    const no: No = { nome, attrs, filhos: [], texto: '' };
    topo.filhos.push(no);
    if (!vazia) pilha.push(no);
    texto = '';
  }

  if (pilha.length > 1) throw ilegivel(`<${pilha[pilha.length - 1]!.nome}> sem fechamento`);
  if (texto.trim() !== '') throw ilegivel(`texto depois do elemento raiz: ${texto.trim().slice(0, 40)}`);
  return raiz;
}

export function filhos(no: No, nome: string): No[] {
  return no.filhos.filter((f) => f.nome === nome);
}
