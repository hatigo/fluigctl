import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * O tamanho que o Studio dá às formas. Ao abrir um diagrama ele recalcula a
 * tarefa e o rótulo do gateway pelo texto, com a fonte da máquina, e marca o
 * arquivo como alterado quando o tamanho gravado é outro. Criar já no tamanho
 * dele deixa o arquivo estável: abrir e salvar no Studio não muda nada.
 *
 * Medido no Studio (dois diagramas de calibração abertos e salvos, 86
 * elementos, com nomes na fronteira da quebra) e conferido no acervo:
 * - o rótulo é Arial 8 negrito; sem Arial na máquina, vale a fonte que o
 *   sistema põe no lugar (no Linux, a do fc-match);
 * - 8 pt a 96 dpi, com o kerning da fonte (o par "To" encolhe 0,75 px na
 *   Noto Sans, e é o que decide a quebra na fronteira);
 * - a linha tem a subida mais a descida da fonte, cada uma arredondada para
 *   cima: 16 px com Noto Sans, 13 px com Arial (o passo do acervo do Windows);
 * - a tarefa tem sempre 106 de largura e 28 + linha × (linhas + 1) de altura;
 *   o texto mede letra a letra, cada uma arredondada, e quebra depois de 85 px;
 * - o rótulo do gateway mede sem arredondar, quebra depois de 47,5 px e é
 *   gravado já quebrado, uma linha por
 *   `\n`; mais de 3 linhas, a 3ª perde as 3 últimas letras para o "...";
 *   a altura do rótulo é linha × (linhas + 1).
 * A quebra é por palavra e depois do hífen; a palavra que não cabe sozinha
 * quebra por letra.
 */

export interface Fonte {
  /** Unidades por em. */
  em: number;
  subida: number;
  descida: number;
  avanco(letra: string): number;
  /** Ajuste do par (kerning), somado ao avanço da primeira letra. */
  par(primeira: string, segunda: string): number;
}

/** Larguras da Arial Bold (as da Helvetica Bold, que a Arial copia), em milésimos do em. */
const ARIAL_NEGRITO: Record<string, number> = {
  ' ': 278, '!': 333, '"': 474, '#': 556, $: 556, '%': 889, '&': 722, "'": 238, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975, '[': 333, '\\': 278, ']': 333, '^': 584, _: 556, '`': 333, '{': 389, '|': 280, '}': 389, '~': 584,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  'º': 365, 'ª': 370,
};
for (const d of '0123456789') ARIAL_NEGRITO[d] = 556;

export const FONTE_ARIAL: Fonte = {
  em: 1000,
  subida: 905,
  descida: 212,
  // Letra acentuada tem a largura da letra sem acento.
  avanco: (l) => ARIAL_NEGRITO[l] ?? ARIAL_NEGRITO[l.normalize('NFD')[0] ?? ''] ?? 556,
  par: () => 0,
};

/** Lê as larguras de um TrueType/OpenType (tabelas head, hhea, hmtx e cmap). */
export function lerFonte(arquivo: string): Fonte {
  const b = readFileSync(arquivo);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tabelas: Record<string, number> = {};
  for (let i = 0; i < dv.getUint16(4); i++) tabelas[b.toString('latin1', 12 + 16 * i, 16 + 16 * i)] = dv.getUint32(20 + 16 * i);
  const { head, hhea, hmtx, cmap } = tabelas;
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) throw new Error(`${arquivo}: não é uma fonte TrueType`);
  const em = dv.getUint16(head + 18);
  const qtd = dv.getUint16(hhea + 34);
  const larguras = Array.from({ length: qtd }, (_, i) => dv.getUint16(hmtx + 4 * i));

  // Subtabela Unicode: formato 12 (3,10) ou 4 (3,1 ou 0,x).
  let f4: number | undefined;
  let f12: number | undefined;
  for (let i = 0; i < dv.getUint16(cmap + 2); i++) {
    const plat = dv.getUint16(cmap + 4 + 8 * i);
    const sub = cmap + dv.getUint32(cmap + 8 + 8 * i);
    const formato = dv.getUint16(sub);
    if (formato === 12 && (plat === 3 || plat === 0)) f12 = sub;
    if (formato === 4 && (plat === 3 || plat === 0)) f4 ??= sub;
  }
  const glifo = (c: number): number => {
    if (f12 !== undefined) {
      for (let i = 0; i < dv.getUint32(f12 + 12); i++) {
        const g = f12 + 16 + 12 * i;
        const ini = dv.getUint32(g);
        if (c >= ini && c <= dv.getUint32(g + 4)) return dv.getUint32(g + 8) + c - ini;
      }
      return 0;
    }
    if (f4 === undefined) return 0;
    const n = dv.getUint16(f4 + 6) / 2;
    const fins = f4 + 14;
    const inicios = fins + 2 * n + 2;
    const deltas = inicios + 2 * n;
    const desvios = deltas + 2 * n;
    for (let i = 0; i < n; i++) {
      if (c > dv.getUint16(fins + 2 * i)) continue;
      const ini = dv.getUint16(inicios + 2 * i);
      if (c < ini) return 0;
      const delta = dv.getInt16(deltas + 2 * i);
      const desvio = dv.getUint16(desvios + 2 * i);
      if (!desvio) return (c + delta) & 0xffff;
      const g = dv.getUint16(desvios + 2 * i + desvio + 2 * (c - ini));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const kerning = tabelas['GPOS'] === undefined ? () => 0 : lerKerning(dv, tabelas['GPOS']);
  const g = (l: string) => glifo(l.codePointAt(0) ?? 0);
  return {
    em,
    subida: dv.getInt16(hhea + 4),
    descida: -dv.getInt16(hhea + 6),
    avanco: (l) => larguras[Math.min(g(l), qtd - 1)] ?? 0,
    par: (a, b) => kerning(g(a), g(b)),
  };
}

/**
 * O kerning da feature `kern` do GPOS: ajustes de par (lookup 2, formatos 1 e
 * 2, também dentro de extensão), só o avanço horizontal da primeira letra.
 */
function lerKerning(dv: DataView, gpos: number): (a: number, b: number) => number {
  const u16 = (o: number) => dv.getUint16(o);
  const cobertura = (o: number): Map<number, number> => {
    const m = new Map<number, number>();
    if (u16(o) === 1) for (let i = 0; i < u16(o + 2); i++) m.set(u16(o + 4 + 2 * i), i);
    else
      for (let i = 0; i < u16(o + 2); i++) {
        const r = o + 4 + 6 * i;
        for (let gl = u16(r); gl <= u16(r + 2); gl++) m.set(gl, u16(r + 4) + gl - u16(r));
      }
    return m;
  };
  const classes = (o: number): Map<number, number> => {
    const m = new Map<number, number>();
    if (u16(o) === 1) for (let i = 0; i < u16(o + 4); i++) m.set(u16(o + 2) + i, u16(o + 6 + 2 * i));
    else
      for (let i = 0; i < u16(o + 2); i++) {
        const r = o + 4 + 6 * i;
        for (let gl = u16(r); gl <= u16(r + 2); gl++) m.set(gl, u16(r + 4));
      }
    return m;
  };
  const bytes = (vf: number) => 2 * [0, 1, 2, 3, 4, 5, 6, 7].filter((b) => vf & (1 << b)).length;
  const avancoX = (o: number, vf: number) => (vf & 4 ? dv.getInt16(o + (vf & 1 ? 2 : 0) + (vf & 2 ? 2 : 0)) : 0);

  const features = gpos + u16(gpos + 6);
  const lookups = gpos + u16(gpos + 8);
  const usadas = new Set<number>();
  for (let i = 0; i < u16(features); i++) {
    const r = features + 2 + 6 * i;
    if (String.fromCharCode(dv.getUint8(r), dv.getUint8(r + 1), dv.getUint8(r + 2), dv.getUint8(r + 3)) !== 'kern') continue;
    const f = features + u16(r + 4);
    for (let j = 0; j < u16(f + 2); j++) usadas.add(u16(f + 4 + 2 * j));
  }
  interface Sub { so: number; cobertura: Map<number, number>; c1?: Map<number, number>; c2?: Map<number, number> }
  const subtabelas: Sub[] = [];
  for (const li of usadas) {
    const lo = lookups + u16(lookups + 2 + 2 * li);
    for (let s = 0; s < u16(lo + 4); s++) {
      let so = lo + u16(lo + 6 + 2 * s);
      let tipo = u16(lo);
      if (tipo === 9) {
        tipo = u16(so + 2);
        so += dv.getUint32(so + 4);
      }
      if (tipo !== 2) continue;
      const sub: Sub = { so, cobertura: cobertura(so + u16(so + 2)) };
      if (u16(so) === 2) {
        sub.c1 = classes(so + u16(so + 8));
        sub.c2 = classes(so + u16(so + 10));
      }
      subtabelas.push(sub);
    }
  }
  const cache = new Map<number, number>();
  return (a, b) => {
    const chave = a * 65536 + b;
    const guardado = cache.get(chave);
    if (guardado !== undefined) return guardado;
    let v = 0;
    for (const { so, cobertura: cob, c1, c2 } of subtabelas) {
      const idx = cob.get(a);
      if (idx === undefined) continue;
      const vf1 = u16(so + 4);
      const tam = bytes(vf1) + bytes(u16(so + 6));
      if (c1 && c2) {
        v = avancoX(so + 16 + ((c1.get(a) ?? 0) * u16(so + 14) + (c2.get(b) ?? 0)) * tam, vf1);
        break;
      }
      const ps = so + u16(so + 10 + 2 * idx);
      let achou = false;
      for (let i = 0; i < u16(ps); i++) {
        const r = ps + 2 + i * (2 + tam);
        if (u16(r) === b) {
          v = avancoX(r + 2, vf1);
          achou = true;
          break;
        }
      }
      if (achou) break;
    }
    cache.set(chave, v);
    return v;
  };
}

/**
 * A fonte que o Studio desta máquina usa para "Arial negrito".
 * FLUIGCTL_FONTE_STUDIO escolhe outra: o caminho de um .ttf, ou "arial" para as
 * larguras embutidas (as do Studio no Windows).
 */
export function fonteDoStudio(): Fonte {
  const escolha = process.env['FLUIGCTL_FONTE_STUDIO'];
  if (escolha === 'arial') return FONTE_ARIAL;
  if (escolha) return lerFonte(escolha);
  const candidatos: string[] = [];
  if (process.platform === 'win32') candidatos.push(join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', 'arialbd.ttf'));
  else {
    try {
      candidatos.push(execFileSync('fc-match', ['-f', '%{file}', 'Arial:bold'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim());
    } catch {
      // Sem fontconfig: tenta os lugares de sempre.
    }
    candidatos.push('/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/TTF/arialbd.ttf');
  }
  for (const c of candidatos) {
    if (!c || !existsSync(c) || !/\.(ttf|otf)$/i.test(c)) continue;
    try {
      return lerFonte(c);
    } catch {
      // Fonte que não se lê (coleção .ttc, por exemplo): a próxima.
    }
  }
  return FONTE_ARIAL;
}

/**
 * Quebra como o Studio: por palavra, e também depois do hífen entre letras
 * ("ar-|condicionado"); a palavra que não cabe sozinha quebra por letra.
 */
export function quebrar(texto: string, cabe: (linha: string) => boolean): string[] {
  const linhas: string[] = [];
  for (const paragrafo of texto.split('\n')) {
    // Pedaços entre oportunidades de quebra; `junto` diz que o pedaço vem colado ao anterior (depois de um hífen).
    const pedacos = paragrafo.split(' ').flatMap((palavra) =>
      palavra.split(/(?<=\p{L}-)(?=\p{L})/u).map((texto, i) => ({ texto, junto: i > 0 })),
    );
    let atual = '';
    let vazia = true;
    for (const { texto: pedaco, junto } of pedacos) {
      const tentativa = vazia ? pedaco : `${atual}${junto ? '' : ' '}${pedaco}`;
      if (cabe(tentativa)) {
        atual = tentativa;
        vazia = false;
        continue;
      }
      if (!vazia) linhas.push(atual);
      let resto = pedaco;
      while (resto && !cabe(resto)) {
        let k = 1;
        while (k < resto.length && cabe(resto.slice(0, k + 1))) k++;
        linhas.push(resto.slice(0, k));
        resto = resto.slice(k);
      }
      atual = resto;
      vazia = false;
    }
    linhas.push(atual);
  }
  return linhas;
}

const LARGURA_TAREFA = 106;
/** A tarefa mede letra a letra, cada uma arredondada; cabe até 85 px. */
const TEXTO_TAREFA = 85;
/** O rótulo do gateway mede sem arredondar; cabe até 47,5 px (47,09 cabe, 47,95 não). */
const TEXTO_GATEWAY = 47.5;
const LINHAS_GATEWAY = 3;

export interface Medidor {
  /** Altura de uma linha de texto, em px. */
  linha: number;
  largura(texto: string): number;
  tarefa(nome: string): { largura: number; altura: number };
  /** O rótulo do gateway como o Studio grava (quebrado, uma linha por \n) e a altura dele. */
  rotuloDoGateway(nome: string): { valor: string; altura: number };
}

export function medidor(fonte: Fonte = fonteDoStudio()): Medidor {
  const px = (8 * 96) / 72;
  const escala = px / fonte.em;
  const linha = Math.ceil(fonte.subida * escala) + Math.ceil(fonte.descida * escala);
  const avancos = (texto: string) => {
    const letras = [...texto];
    return letras.map((l, i) => (fonte.avanco(l) + (i + 1 < letras.length ? fonte.par(l, letras[i + 1]!) : 0)) * escala);
  };
  const largura = (texto: string) => avancos(texto).reduce((soma, a) => soma + Math.round(a), 0);
  const larguraExata = (texto: string) => avancos(texto).reduce((soma, a) => soma + a, 0);
  return {
    linha,
    largura,
    tarefa(nome) {
      const n = quebrar(nome, (l) => largura(l) <= TEXTO_TAREFA).length;
      return { largura: LARGURA_TAREFA, altura: 28 + linha * (n + 1) };
    },
    rotuloDoGateway(nome) {
      let linhas = quebrar(nome, (l) => larguraExata(l) <= TEXTO_GATEWAY);
      if (linhas.length > LINHAS_GATEWAY) {
        const ultima = linhas[LINHAS_GATEWAY - 1]!;
        linhas = [...linhas.slice(0, LINHAS_GATEWAY - 1), `${ultima.slice(0, Math.max(ultima.length - 3, 0))}...`];
      }
      return { valor: linhas.map((l) => `${l}\n`).join(''), altura: linha * (linhas.length + 1) };
    },
  };
}

let padrao: Medidor | undefined;
/** O medidor desta máquina, lido uma vez. */
export function medidorDoStudio(): Medidor {
  padrao ??= medidor();
  return padrao;
}
