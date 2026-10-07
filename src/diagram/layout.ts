import { lerDiagrama, type Caixa, type Diagrama, type ObjetoBpmn, type Ponto as Point } from '../push/diagram/modelo.js';
import { caixaDaFigura } from '../push/diagram/svg.js';
import { EdicaoInvalida, trocarCoordenada, trocarVariasDobrasNoXml } from './edit.js';
import { formas, type Tag } from './lanes.js';
import { cruzaCards, pontasDoFluxo, rotaOrtogonal } from './route.js';
import { medirLayout } from './layout-medida.js';
import { refinarRotas } from './rotas.js';

/**
 * Organizar o diagrama inteiro pela receita de layout da skill fluig-patterns,
 * sem spec escrita à mão (o relayout.py pede uma):
 *
 * 1. pares de recuperação: o evento de erro e o tratamento de uma service task
 *    não ocupam coluna; vão no canto e 33 px abaixo dela;
 * 2. colunas: a partir dos inícios, cada nó fica na coluna seguinte à do
 *    predecessor mais à direita (retornos não contam), em ordem cronológica;
 * 3. raias: cada nó fica na raia em que está (a raia é o papel); dois nós da
 *    mesma raia na mesma coluna: o segundo desce para uma linha de ramo, e um
 *    ramo continua na linha em que começou;
 * 4. cada raia com a altura que o conteúdo pede; a pool acompanha;
 * 5. todas as ligações traçadas pela rota da receita (com desvio de cards).
 *
 * Mexe só em geometria: x/y das formas soltas, tamanho da pool e das raias e as
 * dobras. Anotações e outros artefatos ficam onde estão.
 */

const NOS = new Set(['BpmnTask', 'BpmnGateway', 'BpmnStartEvent', 'BpmnEndEvent', 'BpmnIntermediateEvent', 'BpmnSubProcess']);
const GAP_PAR = 33;
const ESPACO_COLUNA = 70;
const MARGEM_ESQUERDA = 70;
const CENTRO_PRIMEIRA_LINHA = 90;
const ENTRE_LINHAS = 40;
const MARGEM_BAIXO = 30;
const ALTURA_MINIMA = 160;

interface No {
  id: string;
  o: ObjetoBpmn;
  c: Caixa;
  /** A parte desenhada (no gateway, sem o rótulo pendurado). */
  f: Caixa;
  raia: number;
  coluna: number;
  linha: number;
  par?: { evento: string; tratamento?: string | undefined } | undefined;
}

const fluxosDe = (d: Diagrama) => d.objetos.filter((o) => o.tipo === 'SequenceFlow');

/**
 * Onde dois nós disputam o mesmo lugar (mesma raia e coluna), o primeiro que a
 * busca em profundidade encontra fica na linha principal; a ordem em que ela
 * visita as saídas de cada nó decide qual. O arquivo não diz nada sobre o
 * desenho, então cada ordem é tentada e fica a que deixa as ligações melhores
 * (menos por cima de forma, sobrepostas e cruzadas). No empate, a do arquivo:
 * organizar de novo não muda nada.
 */
type OrdemDasSaidas = 'arquivo' | 'invertida' | 'raia-acima' | 'raia-abaixo' | 'ramo-longo';
const ORDENS: OrdemDasSaidas[] = ['arquivo', 'invertida', 'raia-acima', 'raia-abaixo', 'ramo-longo'];

export function organizarNoXml(xml: string): { xml: string; nos: number } {
  let melhor: { xml: string; nos: number; custo: number } | undefined;
  for (const ordem of ORDENS) {
    const r = organizarCom(xml, ordem);
    const m = medirLayout(r.xml);
    const custo = m.cards * 10 + m.mistos * 4 + m.sobrepostas * 3 + m.cruzamentos;
    if (!melhor || custo < melhor.custo) melhor = { ...r, custo };
    if (custo === 0) break;
  }
  return { xml: melhor!.xml, nos: melhor!.nos };
}

function organizarCom(xml: string, ordemDasSaidas: OrdemDasSaidas): { xml: string; nos: number } {
  const d = lerDiagrama(xml);
  const objeto = (id: string) => d.objetos.find((o) => o.attrs['id'] === id);
  const fluxos = fluxosDe(d);
  const desenhados = d.objetos.filter((o) => NOS.has(o.tipo) && o.attrs['id'] && d.caixas.has(o.attrs['id']) && !d.caixas.get(o.attrs['id'])!.pai);
  if (desenhados.length === 0) throw new EdicaoInvalida('o diagrama não tem elementos para organizar');

  // 1. Pares de recuperação: evento preso + tratamento que só volta para a mesma tarefa.
  const satelites = new Set<string>();
  const pares = new Map<string, { evento: string; tratamento?: string | undefined }>();
  for (const e of desenhados) {
    const st = e.attrs['parentTask'];
    if (e.tipo !== 'BpmnIntermediateEvent' || e.attrs['type'] !== '43' || !st || !d.caixas.has(st)) continue;
    const saida = fluxos.find((f) => f.attrs['sourceRef'] === e.attrs['id']);
    const t = saida ? objeto(saida.attrs['targetRef'] ?? '') : undefined;
    const voltas = t ? fluxos.filter((f) => f.attrs['sourceRef'] === t.attrs['id']) : [];
    const entradas = t ? fluxos.filter((f) => f.attrs['targetRef'] === t.attrs['id']) : [];
    const tratamento = t && t.tipo === 'BpmnTask' && voltas.length > 0 && voltas.every((f) => f.attrs['targetRef'] === st) && entradas.length === 1 && !pares.has(st)
      ? t.attrs['id']
      : undefined;
    if (pares.has(st)) continue;
    pares.set(st, { evento: e.attrs['id']!, tratamento });
    satelites.add(e.attrs['id']!);
    if (tratamento) satelites.add(tratamento);
  }

  // Raias, de cima para baixo.
  const raias = d.objetos
    .filter((o) => o.tipo === 'BpmnSwimLane' && d.caixas.get(o.attrs['id'] ?? '')?.pai)
    .map((o) => ({ id: o.attrs['id']!, c: d.caixas.get(o.attrs['id']!)! }))
    .sort((a, b) => a.c.absY - b.c.absY);
  const raiaDe = (c: Caixa): number => {
    if (raias.length === 0) return 0;
    const cy = c.absY + c.altura / 2;
    let melhor = 0;
    let menor = Infinity;
    raias.forEach((r, i) => {
      const dist = cy < r.c.absY ? r.c.absY - cy : cy > r.c.absY + r.c.altura ? cy - (r.c.absY + r.c.altura) : 0;
      if (dist < menor) {
        menor = dist;
        melhor = i;
      }
    });
    return melhor;
  };

  const nos = new Map<string, No>();
  for (const o of desenhados) {
    const id = o.attrs['id']!;
    if (satelites.has(id)) continue;
    const c = d.caixas.get(id)!;
    nos.set(id, { id, o, c, f: caixaDaFigura(o, c), raia: raiaDe(c), coluna: 0, linha: 0, par: pares.get(id) });
  }

  // 2. Colunas: caminho mais longo a partir das fontes, sem as arestas de retorno.
  // A saída de um evento de erro preso (que não ocupa coluna) conta como saída
  // da tarefa dona dele: um tratamento compartilhado por várias service tasks
  // fica depois delas, e não na coluna 0, como se não tivesse entrada.
  const donoDoEvento = new Map<string, string>();
  for (const [st, par] of pares) donoDoEvento.set(par.evento, st);
  // E a volta do tratamento para a tarefa que falhou é retorno (a retentativa),
  // não avanço: não empurra a tarefa para depois do tratamento.
  const retentativas = new Set<string>();
  for (const f of fluxos) {
    const st = donoDoEvento.get(f.attrs['sourceRef'] ?? '');
    if (st) retentativas.add(`${f.attrs['targetRef']}>${st}`);
  }
  const arestas = fluxos
    .map((f) => [donoDoEvento.get(f.attrs['sourceRef'] ?? '') ?? f.attrs['sourceRef'] ?? '', f.attrs['targetRef'] ?? ''] as const)
    .filter(([a, b]) => nos.has(a) && nos.has(b) && a !== b && !retentativas.has(`${a}>${b}`));
  const saidas = new Map<string, string[]>();
  for (const [a, b] of arestas) saidas.set(a, [...(saidas.get(a) ?? []), b]);
  for (const [a, lista] of saidas) {
    const raia = (id: string) => nos.get(id)!.raia;
    if (ordemDasSaidas === 'invertida') saidas.set(a, [...lista].reverse());
    else if (ordemDasSaidas === 'raia-acima') saidas.set(a, [...lista].sort((p, q) => raia(p) - raia(q)));
    else if (ordemDasSaidas === 'raia-abaixo') saidas.set(a, [...lista].sort((p, q) => raia(q) - raia(p)));
  }
  if (ordemDasSaidas === 'ramo-longo') {
    // O ramo que alcança mais nós primeiro: o caminho principal fica na linha principal.
    const alcance = (id: string) => {
      const vistos = new Set([id]);
      const fila = [id];
      while (fila.length) for (const b of saidas.get(fila.shift()!) ?? []) if (!vistos.has(b)) { vistos.add(b); fila.push(b); }
      return vistos.size;
    };
    const tamanhoDoRamo = new Map([...nos.keys()].map((id) => [id, alcance(id)]));
    for (const [a, lista] of saidas) saidas.set(a, [...lista].sort((p, q) => tamanhoDoRamo.get(q)! - tamanhoDoRamo.get(p)!));
  }
  const entram = new Set(arestas.map(([, b]) => b));
  // Ordem de partida: inícios, depois quem não tem entrada, na ordem do arquivo.
  const fontes = [...nos.values()].filter((n) => n.o.tipo === 'BpmnStartEvent').concat([...nos.values()].filter((n) => n.o.tipo !== 'BpmnStartEvent' && !entram.has(n.id)));
  const retorno = new Set<string>();
  const estado = new Map<string, 'aberto' | 'fechado'>();
  const ordemDfs: string[] = [];
  const visitar = (id: string) => {
    estado.set(id, 'aberto');
    for (const b of saidas.get(id) ?? []) {
      if (estado.get(b) === 'aberto') retorno.add(`${id}>${b}`);
      else if (!estado.has(b)) visitar(b);
    }
    estado.set(id, 'fechado');
    ordemDfs.push(id);
  };
  for (const f of fontes) if (!estado.has(f.id)) visitar(f.id);
  for (const n of nos.values()) if (!estado.has(n.id)) visitar(n.id);
  const topologica = [...ordemDfs].reverse();
  for (const id of topologica) {
    const n = nos.get(id)!;
    for (const b of saidas.get(id) ?? []) {
      if (retorno.has(`${id}>${b}`)) continue;
      const alvo = nos.get(b)!;
      alvo.coluna = Math.max(alvo.coluna, n.coluna + 1);
    }
  }

  // 3. Linhas: na ordem de descoberta, cada nó fica na linha do primeiro predecessor já posto na mesma raia; se a vaga está ocupada, a próxima linha livre.
  const ocupado = new Set<string>();
  const ordem = [...nos.values()].sort((a, b) => topologica.indexOf(a.id) - topologica.indexOf(b.id));
  const predecessores = new Map<string, string[]>();
  for (const [a, b] of arestas) if (!retorno.has(`${a}>${b}`)) predecessores.set(b, [...(predecessores.get(b) ?? []), a]);
  const postos = new Set<string>();
  for (const n of ordem) {
    const pred = (predecessores.get(n.id) ?? []).map((p) => nos.get(p)!).find((p) => postos.has(p.id) && p.raia === n.raia);
    let linha = pred ? pred.linha : 0;
    while (ocupado.has(`${n.raia}|${n.coluna}|${linha}`)) linha++;
    n.linha = linha;
    ocupado.add(`${n.raia}|${n.coluna}|${linha}`);
    postos.add(n.id);
  }

  // Tamanhos: largura de cada coluna e alturas de cada linha de cada raia.
  const tamanho = (id: string) => d.caixas.get(id)!;
  const larguraNo = (n: No) => Math.max(n.c.largura, n.par?.tratamento ? tamanho(n.par.tratamento).largura : 0);
  const colunas = Math.max(...[...nos.values()].map((n) => n.coluna)) + 1;
  const larguraColuna = Array.from({ length: colunas }, (_, i) => Math.max(0, ...[...nos.values()].filter((n) => n.coluna === i).map(larguraNo)));
  const pool = d.objetos.find((o) => o.tipo === 'BpmnPool' && d.caixas.has(o.attrs['id'] ?? ''));
  const cp = pool ? d.caixas.get(pool.attrs['id']!)! : undefined;
  const xRaia = raias.length ? raias[0]!.c.absX : (cp?.absX ?? 0);
  const centros: number[] = [];
  let x = xRaia + MARGEM_ESQUERDA;
  larguraColuna.forEach((w, i) => {
    centros.push(Math.round(x + w / 2));
    x += w + Math.max(ESPACO_COLUNA, 200 - w);
    if (i === colunas - 1) x -= Math.max(ESPACO_COLUNA, 200 - w);
  });

  const nRaias = Math.max(1, raias.length);
  const acima = (n: No) => n.f.altura / 2;
  const abaixo = (n: No) => {
    let e = n.c.absY + n.c.altura - (n.f.absY + n.f.altura / 2); // inclui o rótulo pendurado do gateway
    if (n.par) {
      const ev = tamanho(n.par.evento);
      e = Math.max(e, n.f.altura / 2 + ev.altura / 2);
      if (n.par.tratamento) e = Math.max(e, n.f.altura / 2 + GAP_PAR + tamanho(n.par.tratamento).altura);
    }
    return e;
  };
  const centrosLinha: number[][] = [];
  const alturasRaia: number[] = [];
  for (let r = 0; r < nRaias; r++) {
    const daRaia = [...nos.values()].filter((n) => n.raia === r);
    const linhas = daRaia.length ? Math.max(...daRaia.map((n) => n.linha)) + 1 : 1;
    const cl: number[] = [];
    let ultimoAbaixo = 0;
    for (let l = 0; l < linhas; l++) {
      const naLinha = daRaia.filter((n) => n.linha === l);
      const subir = Math.max(0, ...naLinha.map(acima));
      const centro = l === 0 ? Math.max(CENTRO_PRIMEIRA_LINHA, Math.ceil(subir) + 20) : cl[l - 1]! + ultimoAbaixo + ENTRE_LINHAS + subir;
      cl.push(Math.round(centro));
      ultimoAbaixo = Math.max(0, ...naLinha.map(abaixo));
    }
    centrosLinha.push(cl);
    alturasRaia.push(Math.max(ALTURA_MINIMA, Math.ceil((cl.at(-1) ?? CENTRO_PRIMEIRA_LINHA) + ultimoAbaixo + MARGEM_BAIXO)));
  }
  const topoRaia: number[] = [];
  const yPool = raias.length ? raias[0]!.c.absY : 0;
  alturasRaia.reduce((y, h, i) => {
    topoRaia[i] = y;
    return y + h;
  }, yPool);

  // 4. Posições finais (canto superior esquerdo de cada forma solta).
  const posicoes = new Map<string, { x: number; y: number }>();
  for (const n of nos.values()) {
    const cx = centros[n.coluna]!;
    const cy = topoRaia[n.raia]! + centrosLinha[n.raia]![n.linha]!;
    const fx = Math.round(cx - n.f.largura / 2);
    const fy = Math.round(cy - n.f.altura / 2);
    // A forma pode ter a figura deslocada dentro dela (rótulo do gateway embaixo): mantém o deslocamento.
    const px = fx - (n.f.absX - n.c.absX);
    const py = fy - (n.f.absY - n.c.absY);
    posicoes.set(n.id, { x: px, y: py });
    if (n.par) {
      const ev = tamanho(n.par.evento);
      posicoes.set(n.par.evento, { x: fx + n.f.largura - Math.floor(ev.largura / 2), y: fy + n.f.altura - Math.floor(ev.altura / 2) });
      if (n.par.tratamento) {
        const t = tamanho(n.par.tratamento);
        posicoes.set(n.par.tratamento, { x: Math.round(fx + n.f.largura / 2 - t.largura / 2), y: fy + n.f.altura + GAP_PAR });
      }
    }
  }

  // Texto: formas soltas, raias e pool.
  const trocas: { inicio: number; antes: string; depois: string }[] = [];
  const trocar = (t: Tag, novo: string) => trocas.push({ inicio: t.inicio, antes: t.tag, depois: novo });
  const num = (tag: string, a: 'width' | 'height', v: number) => tag.replace(new RegExp(`\\s${a}="\\d+"`), ` ${a}="${v}"`);
  const larguraPool = cp ? Math.max(cp.largura, x - cp.absX + 80) : 0;
  const alturaPool = alturasRaia.reduce((a, b) => a + b, 0) + (cp && raias.length ? raias[0]!.c.absY - cp.absY : 0);
  for (const f of formas(xml)) {
    if (!f.ga || !f.id) continue;
    const p = posicoes.get(f.id);
    if (p && f.profundidade === 0) {
      const c = d.caixas.get(f.id)!;
      // Só o x/y da forma; as coordenadas de dentro são relativas a ela.
      trocar(f.ga, trocarCoordenada(trocarCoordenada(f.ga.tag, 'x', c.x + p.x - c.absX), 'y', c.y + p.y - c.absY));
      continue;
    }
    const i = raias.findIndex((r) => r.id === f.id);
    if (i >= 0 && cp) {
      const relY = topoRaia[i]! - cp.absY;
      const relX = raias[i]!.c.x;
      trocar(f.ga, trocarCoordenada(num(num(f.ga.tag, 'height', alturasRaia[i]!), 'width', larguraPool - relX), 'y', relY));
      for (const t of f.textos) trocar(t, num(t.tag, 'height', alturasRaia[i]!));
    } else if (cp && f.id === pool!.attrs['id']) {
      trocar(f.ga, num(num(f.ga.tag, 'width', larguraPool), 'height', alturaPool));
      for (const t of f.textos) trocar(t, num(t.tag, 'height', alturaPool));
    }
  }
  let texto = xml;
  for (const t of trocas.sort((a, b) => b.inicio - a.inicio)) texto = texto.slice(0, t.inicio) + t.depois + texto.slice(t.inicio + t.antes.length);

  // 5. Ligações pela rota da receita, no diagrama já reposicionado. Trechos de
  // fluxos diferentes não correm um em cima do outro: dividir o trilho só vale
  // para as saídas do mesmo elemento (as de um gateway) e juntar, para as
  // chegadas no mesmo elemento.
  const trechos: { vertical: boolean; pos: number; de: number; ate: number; origem: string; destino: string }[] = [];
  // O meio do vão entre cada par de colunas vizinhas.
  const vaos = centros.slice(0, -1).map((c, i) => Math.round((c + larguraColuna[i]! / 2 + centros[i + 1]! - larguraColuna[i + 1]! / 2) / 2));
  const segmentos = (pts: Point[]) => {
    const r: { vertical: boolean; pos: number; de: number; ate: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!, q = pts[i + 1]!;
      if (p.x === q.x) r.push({ vertical: true, pos: p.x, de: Math.min(p.y, q.y), ate: Math.max(p.y, q.y) });
      else if (p.y === q.y) r.push({ vertical: false, pos: p.y, de: Math.min(p.x, q.x), ate: Math.max(p.x, q.x) });
    }
    return r;
  };
  const colide = (pts: Point[], origem: string, destino: string) =>
    segmentos(pts).some((s) => trechos.some((t) => t.origem !== origem && t.destino !== destino && t.vertical === s.vertical && Math.abs(t.pos - s.pos) < 6 && Math.min(t.ate, s.ate) - Math.max(t.de, s.de) > 0));
  // Os curtos primeiro: têm menos vãos para escolher; os longos desviam deles.
  // As posições já não mudam: o diagrama é lido uma vez, e as dobras de todas
  // as ligações vão para o texto de uma vez no fim.
  const posicionado = lerDiagrama(texto);
  const vao = (f: ObjetoBpmn) => {
    const p = pontasDoFluxo(posicionado, f.attrs['id']!);
    return p ? Math.abs(p[1].x - p[0].x) : 0;
  };
  const rotas = new Map<string, Point[]>();
  for (const f of [...fluxos].sort((p, q) => vao(p) - vao(q))) {
    const id = f.attrs['id']!;
    if (!posicionado.dobras.has(id)) continue;
    const origem = f.attrs['sourceRef'] ?? '';
    const destino = f.attrs['targetRef'] ?? '';
    let dobras = rotaOrtogonal(posicionado, id);
    const pontas = pontasDoFluxo(posicionado, id);
    if (pontas && dobras.length === 2) {
      const linha = (db: Point[]) => [pontas[0], ...db, pontas[1]].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      if (colide(linha(dobras), origem, destino)) {
        const vertical = dobras[0]!.x === dobras[1]!.x;
        // Vizinhança do trilho e, no vertical, os vãos entre as colunas do caminho (o mais perto primeiro).
        const base = vertical ? dobras[0]!.x : dobras[0]!.y;
        const opcoes = new Set<number>([20, -20, 40, -40, 60, -60, 80, -80].map((p) => base + p));
        if (vertical) {
          const [a, b] = [Math.min(pontas[0].x, pontas[1].x), Math.max(pontas[0].x, pontas[1].x)];
          for (const v of vaos) for (const d of [0, 20, -20]) if (v + d > a && v + d < b) opcoes.add(v + d);
        }
        for (const alvo of [...opcoes].sort((p, q) => Math.abs(p - base) - Math.abs(q - base))) {
          const tentativa = vertical
            ? dobras.map((p) => ({ x: alvo, y: p.y }))
            : dobras.map((p) => ({ x: p.x, y: alvo }));
          if (!colide(linha(tentativa), origem, destino) && !cruzaCards(posicionado, id, tentativa)) {
            dobras = tentativa;
            break;
          }
        }
      }
      for (const sg of segmentos(linha(dobras))) trechos.push({ ...sg, origem, destino });
    }
    rotas.set(id, dobras);
  }
  refinarRotas(posicionado, rotas);
  texto = trocarVariasDobrasNoXml(texto, rotas);
  return { xml: texto, nos: posicoes.size };
}
