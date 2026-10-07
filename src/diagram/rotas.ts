import type { Diagrama, Ponto } from '../push/diagram/modelo.js';
import { caixaDaFigura } from '../push/diagram/svg.js';
import { cruzam, ladoDoSegmento, sobrepoem, type Lado } from './layout-medida.js';
import { contarFormas, cruza, cruzaCards, pontasDoFluxo } from './route.js';

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
 * volta), a que tem o menor custo. A saída é sempre pela direita (regra do
 * humano, 2026-10-07): outra saída custa mais que tudo o resto junto. A entrada
 * é pela esquerda sempre que possível: por cima ou por baixo custa 5, pela
 * direita 8. Depois, lado em que uma chega e outra sai (4), correr em cima de
 * outra (3) e cruzar outra (1). Não passa por forma, não entra na figura das pontas e não sai da
 * pool; se nenhuma rota pela direita escapa de passar por forma, fica a que
 * passa por menos. No empate, fica como estava. O desenho do padrão de
 * recuperação não muda: a diagonal curta do evento de erro para o tratamento
 * logo abaixo e a vertical do tratamento de volta para a service task. Usado pelo Organizar (todas mudam), pelo Endireitar (as do
 * elemento) e pela ligação nova (só ela).
 */
export function refinarRotas(d: Diagrama, dobrasPorFluxo: Map<string, Ponto[]>, moveis?: ReadonlySet<string>): void {
  const porId = new Map(d.objetos.filter((o) => o.attrs['id']).map((o) => [o.attrs['id']!, o]));
  interface Rota { id: string; origem: string; destino: string; a: Ponto; b: Ponto; dobras: Ponto[]; tracado?: Tracado | undefined }
  type Tracado = { segmentos: [Ponto, Ponto][]; x0: number; x1: number; y0: number; y1: number };
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
  const tracar = (r: Rota, dobras: Ponto[]): Tracado => {
    const sg = segmentos(r, dobras);
    const xs = sg.flatMap(([p, q]) => [p.x, q.x]);
    const ys = sg.flatMap(([p, q]) => [p.y, q.y]);
    return { segmentos: sg, x0: Math.min(...xs) - 6, x1: Math.max(...xs) + 6, y0: Math.min(...ys) - 6, y1: Math.max(...ys) + 6 };
  };
  const tracadoDe = (r: Rota) => (r.tracado ??= tracar(r, r.dobras));
  const FORA_DA_DIREITA = 1000;
  const PELA_SAIDA: Record<Lado, number> = { direita: 0, cima: FORA_DA_DIREITA, baixo: FORA_DA_DIREITA, esquerda: FORA_DA_DIREITA };
  const PELA_ENTRADA: Record<Lado, number> = { esquerda: 0, cima: 5, baixo: 5, direita: 8 };
  /**
   * A rota volta por dentro da própria origem ou do destino? O teste de forma
   * (cruzaCards) não olha as pontas; aqui, fora o trecho que sai da origem e o
   * que chega no destino, nenhum passa por elas.
   */
  const pelasPontas = (r: Rota, dobras: Ponto[]) => {
    const sg = segmentos(r, dobras);
    const fa = figura(r.origem);
    const fb = figura(r.destino);
    return sg.some(([p, q], i) => (i > 0 && fa && cruza(p, q, fa)) || (i < sg.length - 1 && fb && cruza(p, q, fb)));
  };
  /** O custo da rota com estas dobras; para de contar assim que passa do `limite` (já perdeu). */
  const custo = (r: Rota, dobras: Ponto[], limite = Infinity) => {
    const eu = tracar(r, dobras);
    const { sai, entra } = lados(r, dobras);
    let n = mistos(r, dobras) * 4 + (sai ? PELA_SAIDA[sai] : 0) + (entra ? PELA_ENTRADA[entra] : 0) + (dobras.length && pelasPontas(r, dobras) ? 500 : 0);
    for (const outra of rotas) {
      if (outra === r) continue;
      const ela = tracadoDe(outra);
      if (ela.x1 < eu.x0 || ela.x0 > eu.x1 || ela.y1 < eu.y0 || ela.y0 > eu.y1) continue;
      const mesmaPonta = outra.origem === r.origem || outra.destino === r.destino;
      if (eu.segmentos.some((s) => ela.segmentos.some((t) => cruzam(s, t)))) n += 1;
      if (!mesmaPonta && eu.segmentos.some((s) => ela.segmentos.some((t) => sobrepoem(s, t)))) n += 3;
      if (n > limite) return n;
    }
    return n;
  };

  // A rota não sai da pool (nem encosta na borda dela).
  const pool = d.objetos.find((o) => o.tipo === 'BpmnPool' && d.caixas.has(o.attrs['id'] ?? ''));
  const cp = pool ? d.caixas.get(pool.attrs['id']!)! : undefined;
  const naPool = (y: number) => !cp || (y > cp.absY + 10 && y < cp.absY + cp.altura - 10);
  const naPoolX = (x: number) => !cp || (x > cp.absX + 10 && x < cp.absX + cp.largura - 10);
  const comprimento = (r: Rota, dobras: Ponto[]) => segmentos(r, dobras).reduce((t, [p, q]) => t + Math.abs(q.x - p.x) + Math.abs(q.y - p.y), 0);
  // A volta do tratamento para a service task logo acima é a vertical do padrão
  // de recuperação (fluig-patterns), como a diagonal curta do evento de erro:
  // não segue a regra da saída pela direita.
  const fluxos = d.objetos.filter((o) => o.tipo === 'SequenceFlow');
  const retentativa = (r: Rota) =>
    r.dobras.length === 0 &&
    Math.abs(r.a.x - r.b.x) <= 1 &&
    r.b.y < r.a.y &&
    fluxos.some((f) => f.attrs['targetRef'] === r.origem && porId.get(f.attrs['sourceRef'] ?? '')?.attrs['parentTask'] === r.destino);
  // Linha reta sem dobra só se mexe se for reta de verdade (a diagonal curta do evento de erro fica).
  const ortogonal = (r: Rota) =>
    !retentativa(r) &&
    (r.dobras.length >= 2 && r.dobras.length <= 4 || (r.dobras.length === 0 && (Math.abs(r.a.x - r.b.x) <= 1 || Math.abs(r.a.y - r.b.y) <= 1)));

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
      // O degrau só tem sentido com desnível; alinhadas, a reta já é a rota.
      if (Math.abs(r.a.y - r.b.y) > 1) {
        for (let x = Math.ceil(x0 / 10) * 10; x < x1; x += 10) if (x > x0 && foraEmX(x)) candidatas.push([{ x, y: Math.round(r.a.y) }, { x, y: Math.round(r.b.y) }]);
      }
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
      for (const xr of [20, 30, 40, 50, 60, 80, 100, 120].map((m) => Math.round((direita + m) / 10) * 10)) {
        if (!foraEmX(xr) || !naPoolX(xr)) continue;
        for (let y = Math.floor((topo - 120) / 10) * 10; y <= fundo + 120; y += 10) {
          if (foraEmY(y)) candidatas.push([{ x: xr, y: Math.round(r.a.y) }, { x: xr, y }, { x: Math.round(r.b.x), y }]);
        }

      }
      // Entrando pela esquerda quando o destino não está logo à direita da saída:
      // sai pela direita, vai a um corredor, passa à esquerda do destino, vai à
      // altura dele e entra pela esquerda (quatro dobras).
      const esquerdaDoDestino = fb.absX;
      for (const xr of [20, 40, 60, 100].map((m) => Math.round((direita + m) / 10) * 10)) {
        if (!foraEmX(xr) || !naPoolX(xr)) continue;
        for (const xl of [20, 40, 60].map((m) => Math.round((esquerdaDoDestino - m) / 10) * 10)) {
          if (xl < 0 || !naPoolX(xl) || !foraEmX(xl) || xl >= xr) continue;
          for (let y = Math.floor((topo - 120) / 20) * 20; y <= fundo + 120; y += 20) {
            if (foraEmY(y)) candidatas.push([{ x: xr, y: Math.round(r.a.y) }, { x: xr, y }, { x: xl, y }, { x: xl, y: Math.round(r.b.y) }]);
          }
        }
      }
      let melhor = { dobras: r.dobras, custo: atual, comprimento: comprimento(r, r.dobras) };
      const porForma: { dobras: Ponto[]; custo: number }[] = [];
      for (const tentativa of candidatas) {
        const c = custo(r, tentativa, melhor.custo);
        if (c > melhor.custo) continue;
        const l = comprimento(r, tentativa);
        // Menor custo ganha; no empate, só troca o que já cruzava algo, e pela rota mais curta.
        const ganha = c < melhor.custo || (melhor.dobras !== r.dobras && l < melhor.comprimento);
        // Passar por forma é o teste mais caro: só para quem ganharia.
        if (!ganha) continue;
        if (!cruzaCards(d, r.id, tentativa)) melhor = { dobras: tentativa, custo: c, comprimento: l };
        else if (c < FORA_DA_DIREITA) porForma.push({ dobras: tentativa, custo: c });
      }
      // Nenhuma rota pela direita livre de forma: a saída pela direita vale mais,
      // e fica a que passa por menos formas.
      if (melhor.custo >= FORA_DA_DIREITA && porForma.length) {
        const formas = (dobras: Ponto[]) => contarFormas(d, r.id, dobras);
        const escolhida = porForma.sort((p, q) => formas(p.dobras) - formas(q.dobras) || p.custo - q.custo)[0]!;
        melhor = { dobras: escolhida.dobras, custo: escolhida.custo, comprimento: comprimento(r, escolhida.dobras) };
      }
      if (melhor.dobras !== r.dobras) {
        r.dobras = melhor.dobras;
        r.tracado = undefined;
        mudou = true;
      }
      usar(r, r.dobras, 1);
    }
    if (!mudou) break;
  }
  for (const r of rotas) dobrasPorFluxo.set(r.id, r.dobras);
}
