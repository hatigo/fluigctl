import type { Diagrama, Ponto } from '../push/diagram/modelo.js';
import { caixaDaFigura } from '../push/diagram/svg.js';
import { cruzam, ladoDoSegmento, sobrepoem, type Lado } from './layout-medida.js';
import { cruzaCards, pontasDoFluxo } from './route.js';

/**
 * Cada ligação é traçada sozinha (route.ts), sem saber das outras: duas que
 * trocam de raia no mesmo vão se cruzam, a ida e a volta entre duas tarefas
 * correm uma em cima da outra, e uma seta chega pelo mesmo ponto de onde outra
 * sai (a ponta mira o centro da figura: a linha reta que chega pelo lado
 * encosta no meio dele, como a que sai por ali).
 *
 * Aqui cada ligação que pode mudar procura, em passos de 10 px, entre as
 * formas de rota ortogonal (degrau: o trecho do meio vertical; corredor: o
 * trecho do meio horizontal; e as de três dobras que saem pela direita e dão a
 * volta), a que tem o menor custo: lado em que uma chega e outra sai (4),
 * correr em cima de outra (3), cruzar outra (1) e não sair pela direita (0,5
 * por cima ou por baixo, 0,8 pela esquerda: a saída pela direita é a
 * preferida, mas não a ponto de cruzar outra ligação). Nunca passa por forma,
 * não entra na figura das pontas e não sai da pool. No empate, fica como
 * estava. Usado pelo Organizar (todas mudam), pelo Endireitar (as do
 * elemento) e pela ligação nova (só ela).
 */
export function refinarRotas(d: Diagrama, dobrasPorFluxo: Map<string, Ponto[]>, moveis?: ReadonlySet<string>): void {
  const porId = new Map(d.objetos.filter((o) => o.attrs['id']).map((o) => [o.attrs['id']!, o]));
  interface Rota { id: string; origem: string; destino: string; a: Ponto; b: Ponto; dobras: Ponto[] }
  const rotas: Rota[] = [];
  for (const [id, dobras] of dobrasPorFluxo) {
    const pontas = pontasDoFluxo(d, id);
    const f = porId.get(id);
    if (!pontas || !f) continue;
    rotas.push({ id, origem: f.attrs['sourceRef'] ?? '', destino: f.attrs['targetRef'] ?? '', a: pontas[0], b: pontas[1], dobras });
  }
  const pontos = (r: Rota, dobras = r.dobras) => [r.a, ...dobras, r.b].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const segmentos = (r: Rota, dobras = r.dobras): [Ponto, Ponto][] => {
    const pts = pontos(r, dobras);
    return pts.slice(0, -1).map((p, i) => [p, pts[i + 1]!]);
  };
  const figura = (id: string) => {
    const o = porId.get(id);
    const c = d.caixas.get(id);
    return o && c ? caixaDaFigura(o, c) : undefined;
  };

  // Os lados de cada figura e quem chega ou sai por eles.
  const lados = (r: Rota, dobras = r.dobras): { sai?: Lado | undefined; entra?: Lado | undefined } => {
    const pts = pontos(r, dobras);
    return { sai: ladoDoSegmento(pts[0]!, pts[1]!), entra: ladoDoSegmento(pts[pts.length - 1]!, pts[pts.length - 2]!) };
  };
  const uso = new Map<string, { entra: number; sai: number }>();
  const usar = (r: Rota, dobras: Ponto[], sinal: 1 | -1) => {
    const l = lados(r, dobras);
    for (const [no, lado, como] of [[r.origem, l.sai, 'sai'], [r.destino, l.entra, 'entra']] as const) {
      if (!lado) continue;
      const k = `${no}|${lado}`;
      const u = uso.get(k) ?? { entra: 0, sai: 0 };
      u[como] += sinal;
      uso.set(k, u);
    }
  };
  for (const r of rotas) usar(r, r.dobras, 1);
  /** Quantas pontas desta rota caem num lado usado no sentido contrário (fora ela mesma). */
  const mistos = (r: Rota, dobras: Ponto[]) => {
    const l = lados(r, dobras);
    let n = 0;
    if (l.sai && (uso.get(`${r.origem}|${l.sai}`)?.entra ?? 0) > 0) n++;
    if (l.entra && (uso.get(`${r.destino}|${l.entra}`)?.sai ?? 0) > 0) n++;
    return n;
  };

  // Segmentos e caixa envolvente de cada rota, guardados: o custo é perguntado
  // para cada posição candidata de cada ligação, contra todas as outras.
  type Tracado = { segmentos: [Ponto, Ponto][]; x0: number; x1: number; y0: number; y1: number };
  const tracar = (r: Rota, dobras: Ponto[]): Tracado => {
    const sg = segmentos(r, dobras);
    const xs = sg.flatMap(([p, q]) => [p.x, q.x]);
    const ys = sg.flatMap(([p, q]) => [p.y, q.y]);
    return { segmentos: sg, x0: Math.min(...xs) - 6, x1: Math.max(...xs) + 6, y0: Math.min(...ys) - 6, y1: Math.max(...ys) + 6 };
  };
  const tracados = new Map<Rota, Tracado>();
  const tracadoDe = (r: Rota) => {
    let t = tracados.get(r);
    if (!t) tracados.set(r, (t = tracar(r, r.dobras)));
    return t;
  };
  const PELA_SAIDA: Record<Lado, number> = { direita: 0, cima: 0.5, baixo: 0.5, esquerda: 0.8 };
  const custo = (r: Rota, dobras: Ponto[]) => {
    const eu = tracar(r, dobras);
    const sai = lados(r, dobras).sai;
    let n = mistos(r, dobras) * 4 + (sai ? PELA_SAIDA[sai] : 0);
    for (const outra of rotas) {
      if (outra === r) continue;
      const ela = tracadoDe(outra);
      if (ela.x1 < eu.x0 || ela.x0 > eu.x1 || ela.y1 < eu.y0 || ela.y0 > eu.y1) continue;
      const mesmaPonta = outra.origem === r.origem || outra.destino === r.destino;
      if (eu.segmentos.some((s) => ela.segmentos.some((t) => cruzam(s, t)))) n += 1;
      if (!mesmaPonta && eu.segmentos.some((s) => ela.segmentos.some((t) => sobrepoem(s, t)))) n += 3;
    }
    return n;
  };

  // A rota não sai da pool (nem encosta na borda dela).
  const pool = d.objetos.find((o) => o.tipo === 'BpmnPool' && d.caixas.has(o.attrs['id'] ?? ''));
  const cp = pool ? d.caixas.get(pool.attrs['id']!)! : undefined;
  const naPool = (y: number) => !cp || (y > cp.absY + 10 && y < cp.absY + cp.altura - 10);
  const comprimento = (r: Rota, dobras: Ponto[]) => segmentos(r, dobras).reduce((t, [p, q]) => t + Math.abs(q.x - p.x) + Math.abs(q.y - p.y), 0);
  // Linha reta sem dobra só se mexe se for reta de verdade (a diagonal curta do evento de erro fica).
  const ortogonal = (r: Rota) =>
    r.dobras.length === 2 || r.dobras.length === 3 || (r.dobras.length === 0 && (Math.abs(r.a.x - r.b.x) <= 1 || Math.abs(r.a.y - r.b.y) <= 1));

  for (let passada = 0; passada < 3; passada++) {
    let mudou = false;
    for (const r of rotas) {
      if ((moveis && !moveis.has(r.id)) || !ortogonal(r)) continue;
      const fa = figura(r.origem);
      const fb = figura(r.destino);
      if (!fa || !fb) continue;
      usar(r, r.dobras, -1);
      const atual = custo(r, r.dobras);
      if (atual === 0) {
        usar(r, r.dobras, 1);
        continue;
      }
      const foraEmX = (x: number) => [fa, fb].every((c) => x < c.absX - 5 || x > c.absX + c.largura + 5);
      const foraEmY = (y: number) => y >= 0 && naPool(y) && [fa, fb].every((c) => y < c.absY - 5 || y > c.absY + c.altura + 5);
      const candidatas: Ponto[][] = [];
      const [x0, x1] = [Math.min(r.a.x, r.b.x), Math.max(r.a.x, r.b.x)];
      for (let x = Math.ceil(x0 / 10) * 10; x < x1; x += 10) if (x > x0 && foraEmX(x)) candidatas.push([{ x, y: Math.round(r.a.y) }, { x, y: Math.round(r.b.y) }]);
      const topo = Math.min(fa.absY, fb.absY);
      const fundo = Math.max(fa.absY + fa.altura, fb.absY + fb.altura);
      for (let y = Math.floor((topo - 120) / 10) * 10; y <= fundo + 120; y += 10) if (foraEmY(y)) candidatas.push([{ x: Math.round(r.a.x), y }, { x: Math.round(r.b.x), y }]);
      // Do lado de fora das duas figuras: entra pela lateral e sai por cima/baixo, ou o contrário.
      for (const x of [fa.absX - 30, fa.absX + fa.largura + 30, fb.absX - 30, fb.absX + fb.largura + 30].map((v) => Math.round(v / 10) * 10)) {
        if (x >= 0 && foraEmX(x)) candidatas.push([{ x, y: Math.round(r.a.y) }, { x, y: Math.round(r.b.y) }]);
      }
      // Saindo pela direita e dando a volta, para quem não tem o destino à
      // direita (retorno, mesma coluna): sai pela lateral direita, sobe ou
      // desce até um corredor e chega no destino por cima ou por baixo; ou
      // desce/sobe pela direita e entra no destino pela lateral direita.
      const direita = fa.absX + fa.largura;
      for (const xr of [20, 30, 40, 60].map((m) => Math.round((direita + m) / 10) * 10)) {
        if (!foraEmX(xr) || (xr > Math.min(r.a.x, r.b.x) && xr < Math.max(r.a.x, r.b.x) && r.b.x > direita)) continue;
        for (let y = Math.floor((topo - 120) / 10) * 10; y <= fundo + 120; y += 10) {
          if (foraEmY(y)) candidatas.push([{ x: xr, y: Math.round(r.a.y) }, { x: xr, y }, { x: Math.round(r.b.x), y }]);
        }
        if (r.b.x < xr && Math.abs(r.a.y - r.b.y) > 1) candidatas.push([{ x: xr, y: Math.round(r.a.y) }, { x: xr, y: Math.round(r.b.y) }]);
      }
      let melhor = { dobras: r.dobras, custo: atual, comprimento: comprimento(r, r.dobras) };
      for (const tentativa of candidatas) {
        const c = custo(r, tentativa);
        if (c > melhor.custo) continue;
        const l = comprimento(r, tentativa);
        // Menor custo ganha; no empate, só troca o que já cruzava algo, e pela rota mais curta.
        const ganha = c < melhor.custo || (melhor.dobras !== r.dobras && l < melhor.comprimento);
        // Passar por forma é o teste mais caro: só para quem ganharia.
        if (ganha && !cruzaCards(d, r.id, tentativa)) melhor = { dobras: tentativa, custo: c, comprimento: l };
      }
      if (melhor.dobras !== r.dobras) {
        r.dobras = melhor.dobras;
        tracados.delete(r);
        mudou = true;
      }
      usar(r, r.dobras, 1);
    }
    if (!mudou) break;
  }
  for (const r of rotas) dobrasPorFluxo.set(r.id, r.dobras);
}
