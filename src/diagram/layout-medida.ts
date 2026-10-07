import { lerDiagrama, type Ponto } from '../push/diagram/modelo.js';
import { cruzaCards, pontasDoFluxo } from './route.js';

/**
 * A qualidade das ligações de um diagrama, como o Organizar é medido:
 * - cards: ligações que passam por cima de uma forma (fora as pontas);
 * - sobrepostas: pares de ligações que correm uma em cima da outra (paralelas a
 *   menos de 6 px), fora as que saem da mesma forma ou chegam na mesma;
 * - cruzamentos: pares de ligações que se cruzam;
 * - mistos: lados de forma em que uma ligação chega e outra sai pelo mesmo
 *   ponto (a ponta mira o centro: a linha reta que chega pelo lado encosta no
 *   meio dele, como a que sai por ali).
 */
export interface MedidaLayout {
  ligacoes: number;
  cards: number;
  sobrepostas: number;
  cruzamentos: number;
  mistos: number;
}

export type Lado = 'cima' | 'baixo' | 'esquerda' | 'direita';

/** Por que lado o segmento que sai do centro `de` rumo a `para` cruza a borda; só para segmento reto (horizontal ou vertical). */
export function ladoDoSegmento(de: Ponto, para: Ponto): Lado | undefined {
  const dx = para.x - de.x;
  const dy = para.y - de.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) >= 0.5) return dy < 0 ? 'cima' : 'baixo';
  if (Math.abs(dy) < 0.5 && Math.abs(dx) >= 0.5) return dx < 0 ? 'esquerda' : 'direita';
  return undefined;
}

/**
 * Os lados em que chega e sai ligação ao mesmo tempo, dadas as rotas: cada uma
 * com a origem, o destino e os pontos (centro da origem, dobras, centro do destino).
 */
export function ladosMistos(rotas: { origem: string; destino: string; pontos: Ponto[] }[]): Set<string> {
  const uso = new Map<string, Set<'entra' | 'sai'>>();
  const marcar = (no: string, lado: Lado | undefined, como: 'entra' | 'sai') => {
    if (!lado) return;
    const k = `${no}|${lado}`;
    let u = uso.get(k);
    if (!u) uso.set(k, (u = new Set()));
    u.add(como);
  };
  for (const r of rotas) {
    const p = r.pontos;
    if (p.length < 2) continue;
    marcar(r.origem, ladoDoSegmento(p[0]!, p[1]!), 'sai');
    marcar(r.destino, ladoDoSegmento(p[p.length - 1]!, p[p.length - 2]!), 'entra');
  }
  return new Set([...uso].filter(([, u]) => u.size === 2).map(([k]) => k));
}

type Segmento = [Ponto, Ponto];

const comum = (a: number, b: number, c: number, d: number) => Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)) > 0;

export function cruzam([p, q]: Segmento, [u, v]: Segmento): boolean {
  const den = (q.x - p.x) * (v.y - u.y) - (q.y - p.y) * (v.x - u.x);
  if (den === 0) return false;
  const t = ((u.x - p.x) * (v.y - u.y) - (u.y - p.y) * (v.x - u.x)) / den;
  const w = ((u.x - p.x) * (q.y - p.y) - (u.y - p.y) * (q.x - p.x)) / den;
  return t > 0.02 && t < 0.98 && w > 0.02 && w < 0.98;
}

export function sobrepoem([p, q]: Segmento, [u, v]: Segmento): boolean {
  if (p.y === q.y && u.y === v.y) return Math.abs(p.y - u.y) < 6 && comum(p.x, q.x, u.x, v.x);
  if (p.x === q.x && u.x === v.x) return Math.abs(p.x - u.x) < 6 && comum(p.y, q.y, u.y, v.y);
  return false;
}

export function medirLayout(xml: string): MedidaLayout {
  const d = lerDiagrama(xml);
  const linhas: { origem: string; destino: string; segmentos: Segmento[]; pontos: Ponto[] }[] = [];
  let cards = 0;
  for (const f of d.objetos.filter((o) => o.tipo === 'SequenceFlow')) {
    const id = f.attrs['id']!;
    const pontas = pontasDoFluxo(d, id);
    if (!pontas) continue;
    const dobras = d.dobras.get(id) ?? [];
    if (cruzaCards(d, id, dobras)) cards++;
    const pts = [pontas[0], ...dobras, pontas[1]].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    linhas.push({ origem: f.attrs['sourceRef'] ?? '', destino: f.attrs['targetRef'] ?? '', segmentos: pts.slice(0, -1).map((p, i) => [p, pts[i + 1]!]), pontos: pts });
  }
  let sobrepostas = 0;
  let cruzamentos = 0;
  for (let i = 0; i < linhas.length; i++) {
    for (let j = i + 1; j < linhas.length; j++) {
      const a = linhas[i]!;
      const b = linhas[j]!;
      if (a.segmentos.some((s) => b.segmentos.some((t) => cruzam(s, t)))) cruzamentos++;
      if (a.origem !== b.origem && a.destino !== b.destino && a.segmentos.some((s) => b.segmentos.some((t) => sobrepoem(s, t)))) sobrepostas++;
    }
  }
  return { ligacoes: linhas.length, cards, sobrepostas, cruzamentos, mistos: ladosMistos(linhas).size };
}
