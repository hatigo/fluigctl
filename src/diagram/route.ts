import type { Caixa, Diagrama, ObjetoBpmn, Ponto } from '../push/diagram/modelo.js';
import { caixaDaFigura, centroDaFigura } from '../push/diagram/svg.js';

/**
 * Rota ortogonal de um fluxo, pela receita de layout da skill fluig-patterns:
 *
 * - cada ponta do fluxo mira o centro da figura (chopbox), então a primeira
 *   dobra divide x ou y com o centro da origem, e a última com o do destino:
 *   assim os segmentos das pontas saem retos;
 * - alvo à direita: sai pela direita, desce ou sobe no meio do vão entre as
 *   duas formas, e entra pela esquerda;
 * - alvo atrás (um retorno): sai por cima, corre num corredor 20 px acima das
 *   duas formas e desce no alvo pelo centro;
 * - mesma coluna: vertical, com o degrau no meio do vão;
 * - a saída de um evento de erro anexado é a diagonal curta do padrão: sem dobras.
 */

const GRADE = 10;
const CORREDOR = 20;
const encaixar = (n: number) => Math.round(n / GRADE) * GRADE;

function objeto(diagrama: Diagrama, id: string | undefined): ObjetoBpmn | undefined {
  return diagrama.objetos.find((o) => o.attrs['id'] === id);
}

export function rotaOrtogonal(diagrama: Diagrama, fluxoId: string): Ponto[] {
  // O .process guarda dobras inteiras.
  return desviar(diagrama, fluxoId, rota(diagrama, fluxoId)).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

const NOS = new Set(['BpmnTask', 'BpmnGateway', 'BpmnStartEvent', 'BpmnEndEvent', 'BpmnIntermediateEvent', 'BpmnSubProcess']);

/** As figuras que uma linha não pode atravessar: todo nó, menos as pontas e os eventos presos a elas. */
function obstaculos(diagrama: Diagrama, origem: string, destino: string): Caixa[] {
  return diagrama.objetos
    .filter((o) => NOS.has(o.tipo))
    .filter((o) => {
      const id = o.attrs['id'] ?? '';
      return id !== origem && id !== destino && o.attrs['parentTask'] !== origem && o.attrs['parentTask'] !== destino;
    })
    .flatMap((o) => {
      const c = diagrama.caixas.get(o.attrs['id'] ?? '');
      return c ? [caixaDaFigura(o, c)] : [];
    });
}

/** O segmento de a até b passa por dentro da caixa (com 2 px de folga na borda)? */
function cruza(a: Ponto, b: Ponto, c: Caixa): boolean {
  const x0 = c.absX + 2, x1 = c.absX + c.largura - 2, y0 = c.absY + 2, y1 = c.absY + c.altura - 2;
  // Liang-Barsky: recorta o segmento contra o retângulo.
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

function atravessa(linha: Ponto[], obs: Caixa[]): boolean {
  for (let i = 0; i < linha.length - 1; i++) if (obs.some((c) => cruza(linha[i]!, linha[i + 1]!, c))) return true;
  return false;
}

/** A linha com estas dobras atravessa algum card (fora as pontas e os eventos presos a elas)? */
export function cruzaCards(diagrama: Diagrama, fluxoId: string, pontos: Ponto[]): boolean {
  const fluxo = objeto(diagrama, fluxoId);
  const o = objeto(diagrama, fluxo?.attrs['sourceRef']), d = objeto(diagrama, fluxo?.attrs['targetRef']);
  const co = diagrama.caixas.get(fluxo?.attrs['sourceRef'] ?? ''), cd = diagrama.caixas.get(fluxo?.attrs['targetRef'] ?? '');
  if (!fluxo || !o || !d || !co || !cd) return false;
  return atravessa([centroDaFigura(o, co), ...pontos, centroDaFigura(d, cd)], obstaculos(diagrama, o.attrs['id']!, d.attrs['id']!));
}

/** Os centros que as pontas de um fluxo miram. */
export function pontasDoFluxo(diagrama: Diagrama, fluxoId: string): [Ponto, Ponto] | undefined {
  const fluxo = objeto(diagrama, fluxoId);
  const o = objeto(diagrama, fluxo?.attrs['sourceRef']), d = objeto(diagrama, fluxo?.attrs['targetRef']);
  const co = diagrama.caixas.get(fluxo?.attrs['sourceRef'] ?? ''), cd = diagrama.caixas.get(fluxo?.attrs['targetRef'] ?? '');
  if (!o || !d || !co || !cd) return undefined;
  return [centroDaFigura(o, co), centroDaFigura(d, cd)];
}

/**
 * Nenhuma linha cruza um card (receita de layout). Se a rota atravessa algum nó,
 * ela vai pelo corredor 20 px acima dos nós daquele trecho, sai por cima da
 * origem e desce no destino; sem espaço em cima, passa por baixo. Se nem assim
 * fica livre, fica a rota original: quem decide é a pessoa, arrastando as dobras.
 */
function desviar(diagrama: Diagrama, fluxoId: string, pontos: Ponto[]): Ponto[] {
  const fluxo = objeto(diagrama, fluxoId)!;
  const ido = fluxo.attrs['sourceRef'] ?? '';
  const idd = fluxo.attrs['targetRef'] ?? '';
  const o = objeto(diagrama, ido), d = objeto(diagrama, idd);
  const co = diagrama.caixas.get(ido), cd = diagrama.caixas.get(idd);
  if (!o || !d || !co || !cd) return pontos;
  if (o.tipo === 'BpmnIntermediateEvent' && o.attrs['type'] === '43' && o.attrs['parentTask']) return pontos;
  const a = centroDaFigura(o, co), b = centroDaFigura(d, cd);
  const obs = obstaculos(diagrama, ido, idd);
  if (!atravessa([a, ...pontos, b], obs)) return pontos;

  const fa = caixaDaFigura(o, co), fb = caixaDaFigura(d, cd);
  const xmin = Math.min(a.x, b.x), xmax = Math.max(a.x, b.x);

  const noTrecho = [fa, fb, ...obs.filter((c) => c.absX < xmax && c.absX + c.largura > xmin)];
  const acima = Math.min(...noTrecho.map((c) => c.absY)) - CORREDOR;
  const abaixo = Math.max(...noTrecho.map((c) => c.absY + c.altura)) + CORREDOR;

  // Candidatas ortogonais com as pontas mirando os centros:
  //   horizontal-vertical-horizontal, com o degrau em x;
  //   vertical-horizontal-vertical, com o corredor em y.
  const xs = new Set<number>([encaixar((xmin + xmax) / 2)]);
  for (const c of [fa, fb, ...obs]) {
    for (const x of [c.absX - CORREDOR, c.absX + c.largura + CORREDOR]) if (x > xmin && x < xmax) xs.add(encaixar(x));
  }
  const ys = new Set<number>([acima, abaixo]);
  for (const c of [fa, fb, ...obs.filter((c) => c.absX < xmax && c.absX + c.largura > xmin)]) {
    for (const y of [c.absY - CORREDOR, c.absY + c.altura + CORREDOR]) ys.add(Math.round(y));
  }
  const candidatas: Ponto[][] = [
    ...[...xs].map((x) => [{ x, y: a.y }, { x, y: b.y }]),
    ...[...ys].filter((y) => y >= 0).map((y) => [{ x: a.x, y }, { x: b.x, y }]),
  ];
  const comprimento = (pts: Ponto[]) => {
    const linha = [a, ...pts, b];
    let total = 0;
    for (let i = 0; i < linha.length - 1; i++) total += Math.abs(linha[i + 1]!.x - linha[i]!.x) + Math.abs(linha[i + 1]!.y - linha[i]!.y);
    return total;
  };
  // Um retorno prefere o corredor de cima (receita); fora isso, a mais curta.
  const atras = fb.absX + fb.largura < fa.absX;
  const livres = candidatas.filter((c) => !atravessa([a, ...c, b], obs));
  if (livres.length === 0) return pontos;
  if (atras) {
    const deCima = livres.filter((c) => c[0]!.x === a.x && c[0]!.y < Math.min(fa.absY, fb.absY));
    if (deCima.length) return deCima.sort((p, q) => q[0]!.y - p[0]!.y)[0]!;
  }
  // Empate: a mais alta, como o corredor de cima da receita.
  return livres.sort((p, q) => comprimento(p) - comprimento(q) || Math.min(p[0]!.y, p[1]!.y) - Math.min(q[0]!.y, q[1]!.y))[0]!;
}

function rota(diagrama: Diagrama, fluxoId: string): Ponto[] {
  const fluxo = objeto(diagrama, fluxoId);
  if (!fluxo || fluxo.tipo !== 'SequenceFlow') throw new Error(`fluxo ${fluxoId} não existe`);
  const origem = objeto(diagrama, fluxo.attrs['sourceRef']);
  const destino = objeto(diagrama, fluxo.attrs['targetRef']);
  const co = diagrama.caixas.get(fluxo.attrs['sourceRef'] ?? '');
  const cd = diagrama.caixas.get(fluxo.attrs['targetRef'] ?? '');
  if (!origem || !destino || !co || !cd) throw new Error(`o fluxo ${fluxoId} não tem as duas pontas desenhadas`);

  if (origem.tipo === 'BpmnIntermediateEvent' && origem.attrs['type'] === '43' && origem.attrs['parentTask']) return [];

  const a = centroDaFigura(origem, co);
  const b = centroDaFigura(destino, cd);
  const fa: Caixa = caixaDaFigura(origem, co);
  const fb: Caixa = caixaDaFigura(destino, cd);
  const direitaA = fa.absX + fa.largura;
  const direitaB = fb.absX + fb.largura;
  const atras = direitaB < fa.absX;

  // Até 1 px é alinhado: tarefa de altura ímpar tem o centro em meio pixel (259,5 contra 260).
  // Um retorno alinhado não vai reto: atravessaria a linha inteira e entraria pela direita.
  if (Math.abs(a.x - b.x) <= 1 || (Math.abs(a.y - b.y) <= 1 && !atras)) return [];

  // Alvo à direita, com vão entre as duas: degrau no meio do vão, entra pela esquerda.
  if (fb.absX > direitaA) {
    const x = encaixar((direitaA + fb.absX) / 2);
    return [{ x, y: a.y }, { x, y: b.y }];
  }
  // Alvo atrás: retorno pelo corredor acima das duas formas.
  if (atras) {
    const acima = Math.min(fa.absY, fb.absY) - CORREDOR;
    // Sem espaço acima (forma colada no topo do diagrama), o corredor passa por baixo.
    const y = acima >= 0 ? acima : Math.max(fa.absY + fa.altura, fb.absY + fb.altura) + CORREDOR;
    return [{ x: a.x, y }, { x: b.x, y }];
  }
  // Mesma coluna: degrau vertical no meio do vão entre as duas.
  const embaixo = fb.absY > fa.absY;
  const vao = embaixo ? (fa.absY + fa.altura + fb.absY) / 2 : (fb.absY + fb.altura + fa.absY) / 2;
  const y = encaixar(vao);
  return [{ x: a.x, y }, { x: b.x, y }];
}
