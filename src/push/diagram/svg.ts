import { escaparTexto } from './xml.js';
import type { Caixa, Diagrama, Icone, ObjetoBpmn, Ponto } from './modelo.js';

/**
 * Imagem do diagrama (`<processo>.processimage.svg`) que o Studio manda junto no
 * `importProcess`. Sem ela o servidor guarda a versão sem imagem, e a tela do
 * processo mostra "Não foi possível exibir o fluxo do processo".
 *
 * O visualizador do Fluig (`/webdesk/svgviewer`) destaca a atividade atual pelo
 * `<g sequence="N">` de cada estado; rótulos e raias vão em
 * `<g componentSequence="N">`, como no SVG do Studio. Mesmas formas, cores e
 * posições do Studio. As marcas de evento e de gateway repetem a geometria que o
 * Studio desenha (relativa ao centro, medida nos `.processimage.svg` do corpus);
 * os ícones de tarefa, que no Studio são PNGs da TOTVS, são desenhos próprios na
 * posição do `al:Image` do `.process`.
 */

const SUFIXO = /(\d+)$/;
const sequencia = (id: string | undefined): number => Number(SUFIXO.exec(id ?? '')?.[1] ?? 0);

/** Gradientes como os do Studio, por tipo de forma (de cima para baixo). */
const GRADIENTES: Record<string, string[]> = {
  inicio: ['66FF66', '96FF96', 'B6FFB6'],
  fim: ['FF6666', 'FF9696', 'FFB6B6'],
  tarefa: ['F8FBFE', 'EDF5FC', 'DEEDFA', 'D4E7F8', 'E2E5E9'],
  gateway: ['FAFBFC', 'FFFFCC'],
  intermediario: ['FFFF66', 'FFFF96', 'FFFFB6'],
};

type Forma = 'inicio' | 'fim' | 'tarefa' | 'gateway' | 'intermediario' | 'anotacao';

function formaDe(o: ObjetoBpmn): Forma | undefined {
  const tipo = o.attrs['type'] ?? '';
  if (o.tipo === 'BpmnStartEvent') return 'inicio';
  if (o.tipo === 'BpmnEndEvent') return 'fim';
  if (o.tipo === 'BpmnGateway') return 'gateway';
  if (o.tipo === 'BpmnIntermediateEvent' || o.tipo === 'BpmnBoundaryEvent') return 'intermediario';
  if (o.tipo === 'BpmnAnnotation' || o.tipo === 'TextAnnotation') return 'anotacao';
  if (o.tipo === 'BpmnTask' || o.tipo === 'BpmnSubProcess' || /^(8\d|100|101)$/.test(tipo)) return 'tarefa';
  return undefined;
}

/** Quebra o rótulo como o Studio: ~6,5 px por caractere de 10 px em negrito. */
function linhas(texto: string, largura: number): string[] {
  const max = Math.max(4, Math.floor(largura / 6.5));
  const saida: string[] = [];
  let atual = '';
  for (const palavra of texto.split(/\s+/).filter(Boolean)) {
    if (palavra.length > max) {
      if (atual) saida.push(atual);
      for (let i = 0; i < palavra.length; i += max) saida.push(palavra.slice(i, i + max));
      atual = '';
      continue;
    }
    if ((atual ? `${atual} ${palavra}` : palavra).length > max) {
      saida.push(atual);
      atual = palavra;
    } else {
      atual = atual ? `${atual} ${palavra}` : palavra;
    }
  }
  if (atual) saida.push(atual);
  return saida;
}

function textoCentrado(x: number, y: number, rotulo: string, largura: number, cor = '#333399'): string {
  const tspans = linhas(rotulo, largura)
    .map((l) => `<tspan dy="14" x="${x}">${escaparTexto(l)}</tspan>`)
    .join('');
  return `<text x="${x}" y="${y}" text-anchor="middle" style="font-weight:bold;font-size:10px;stroke:none; fill:${cor}">${tspans}</text>`;
}

const centro = (c: Caixa): Ponto => ({ x: c.absX + c.largura / 2, y: c.absY + c.altura / 2 });

/**
 * A parte da caixa que é desenho. No gateway, a caixa do `.process` inclui o
 * rótulo embaixo: o losango é o quadrado do topo (60×60 no Studio).
 */
function figura(o: ObjetoBpmn | undefined, c: Caixa): Caixa {
  if (o?.tipo === 'BpmnGateway' && c.altura > c.largura) return { ...c, altura: c.largura };
  return c;
}

/** Centro da parte desenhada: é para onde cada ponta de um fluxo aponta. */
export function centroDaFigura(o: ObjetoBpmn | undefined, c: Caixa): Ponto {
  return centro(figura(o, c));
}

/** A caixa desenhada (sem o rótulo pendurado do gateway). */
export function caixaDaFigura(o: ObjetoBpmn | undefined, c: Caixa): Caixa {
  return figura(o, c);
}

/** Contorno de cada forma no SVG do Studio. */
const CONTORNO: Record<string, string> = {
  inicio: '336633', fim: '993333', tarefa: '191970', gateway: '000000', intermediario: '999900',
};

/** Ponto onde a reta do centro de `c` até `alvo` sai da caixa (âncora "chopbox"). */
function borda(c: Caixa, alvo: Ponto, forma?: Forma): Ponto {
  const m = centro(c);
  const dx = alvo.x - m.x;
  const dy = alvo.y - m.y;
  if (dx === 0 && dy === 0) return m;

  // Um evento é visualmente circular. Usar o chopbox retangular dele faz a
  // conexão diagonal começar no canto invisível da caixa e parecer solta da
  // bolinha. A interseção com a elipse prende a linha na circunferência.
  if (forma === 'inicio' || forma === 'fim' || forma === 'intermediario') {
    const rx = c.largura / 2;
    const ry = c.altura / 2;
    const s = Math.min(1, 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2));
    return { x: Math.round(m.x + dx * s), y: Math.round(m.y + dy * s) };
  }

  const sx = dx === 0 ? Infinity : c.largura / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : c.altura / 2 / Math.abs(dy);
  const s = Math.min(sx, sy, 1);
  return { x: Math.round(m.x + dx * s), y: Math.round(m.y + dy * s) };
}

const pontos = (m: Ponto, rel: [number, number][]) => rel.map(([dx, dy]) => `${m.x + dx} ${m.y + dy}`).join(' ');
const traco = (m: Ponto, [x1, y1, x2, y2]: number[]) =>
  `<path style="fill:none; stroke-width:1; stroke:#000000;" d="M${m.x + x1!}.0 ${m.y + y1!}.0 L${m.x + x2!}.0 ${m.y + y2!}.0" />`;

const SETA_LINK: [number, number][] = [[-14, -7], [1, -7], [1, -14], [16, 1], [1, 16], [1, 9], [-14, 9]];
const TRIANGULO: [number, number][] = [[0, -11], [8, 10], [-7, 10]];
const RAIO: [number, number][] = [[-9, 10], [-3, -10], [3, 0], [11, -10], [3, 10], [-3, 0]];
const CRUZ: [number, number][] = [[-9, -4], [-4, -9], [1, -4], [6, -9], [11, -4], [6, 1], [11, 6], [6, 11], [1, 6], [-4, 11], [-9, 6], [-4, 1]];
/** Ponteiros e marcas do relógio do temporizador, como o Studio (x1, y1, x2, y2 relativos ao centro). */
const RELOGIO = [
  [-11, 0, -5, 0], [6, 0, 12, 0], [0, -11, 0, -5], [0, 6, 0, 12], [0, 0, 8, -5], [0, 0, -6, -4],
  [4, -7, 6, -10], [7, -4, 10, -6], [7, 4, 10, 6], [4, 7, 6, 10], [-4, 7, -6, 10], [-7, 4, -10, 6], [-4, -7, -6, -10], [-7, -4, -10, -6],
];

/** Marca dentro do evento, pelo `type` do `.process`; tipo sem marca no Studio volta vazio. */
function marcaDoEvento(tipo: string, m: Ponto): string {
  const cheio = (cor: string) => `style="stroke:none; fill:#${cor}"`;
  const vazado = (cor: string) => `style="stroke:#${cor}; fill:none"`;
  switch (tipo) {
    case '32':
      return `<ellipse cx="${m.x}" cy="${m.y}" rx="12" ry="12" stroke-width="1" style="stroke:#000000; fill:none" />` +
        `<ellipse cx="${m.x}" cy="${m.y}" rx="1" ry="1" stroke-width="1" style="stroke:#000000; fill:#000000" />` +
        RELOGIO.map((t) => traco(m, t)).join('');
    case '36': return `<polygon points=" ${pontos(m, SETA_LINK)}" ${cheio('999900')} />`;
    case '42': return `<polygon points=" ${pontos(m, SETA_LINK)}" ${vazado('999900')} />`;
    case '37': return `<polygon points=" ${pontos(m, TRIANGULO)}" ${cheio('999900')} />`;
    case '41': return `<polygon points=" ${pontos(m, TRIANGULO)}" ${vazado('999900')} />`;
    case '43': return `<polygon points=" ${pontos(m, RAIO)}" ${vazado('999900')} />`;
    case '64': return `<polygon points=" ${pontos(m, TRIANGULO)}" ${cheio('993333')} />`;
    case '65': return `<polygon points=" ${pontos(m, CRUZ)}" ${cheio('993333')} />`;
    default: return '';
  }
}

/** Ícone de 16×16 no canto da tarefa, desenho próprio para cada `al:Image` do Studio. */
function desenhoDoIcone(i: Icone): string {
  const { absX: x, absY: y } = i;
  const cor = 'stroke:#191970; fill:none; stroke-width:1';
  switch (i.id) {
    case 'com.totvs.tds.ecm.designer.task.service': {
      const cx = x + 8;
      const cy = y + 8;
      const dentes = [0, 45, 90, 135, 180, 225, 270, 315].map((g) => {
        const r = (g * Math.PI) / 180;
        const p = (d: number) => `${(cx + Math.cos(r) * d).toFixed(1)} ${(cy + Math.sin(r) * d).toFixed(1)}`;
        return `M${p(5)} L${p(7.5)}`;
      }).join(' ');
      return `<ellipse cx="${cx}" cy="${cy}" rx="5" ry="5" style="${cor}" /><ellipse cx="${cx}" cy="${cy}" rx="2" ry="2" style="${cor}" />` +
        `<path d="${dentes}" style="stroke:#191970; fill:none; stroke-width:2" />`;
    }
    case 'com.totvs.tds.ecm.designer.task.user':
      return `<ellipse cx="${x + 8}" cy="${y + 5}" rx="3" ry="3" style="${cor}" />` +
        `<path d="M${x + 2} ${y + 15} Q${x + 2} ${y + 9} ${x + 8} ${y + 9} Q${x + 14} ${y + 9} ${x + 14} ${y + 15} Z" style="${cor}" />`;
    case 'com.totvs.tds.ecm.designer.task.mail':
      return `<rect x="${x + 1}" y="${y + 3}" width="14" height="10" style="${cor}" />` +
        `<path d="M${x + 1} ${y + 3} L${x + 8} ${y + 9} L${x + 15} ${y + 3}" style="${cor}" />`;
    case 'com.totvs.tds.ecm.designer.subprocess.normal':
      return `<rect x="${x + 2}" y="${y + 2}" width="12" height="12" style="${cor}" />` +
        `<path d="M${x + 8} ${y + 4} L${x + 8} ${y + 12} M${x + 4} ${y + 8} L${x + 12} ${y + 8}" style="${cor}" />`;
    case 'com.totvs.tds.ecm.designer.subprocess.adhoc':
      return `<rect x="${x + 2}" y="${y + 2}" width="12" height="12" style="${cor}" />` +
        `<path d="M${x + 4} ${y + 9} Q${x + 6} ${y + 5} ${x + 8} ${y + 8} Q${x + 10} ${y + 11} ${x + 12} ${y + 7}" style="${cor}" />`;
    default:
      return '';
  }
}

function seta(de: Ponto, para: Ponto): string {
  const dx = para.x - de.x;
  const dy = para.y - de.y;
  const tamanho = Math.hypot(dx, dy) || 1;
  const ux = dx / tamanho;
  const uy = dy / tamanho;
  const base = { x: para.x - ux * 10, y: para.y - uy * 10 };
  const p1 = { x: base.x - uy * 5, y: base.y + ux * 5 };
  const p2 = { x: base.x + uy * 5, y: base.y - ux * 5 };
  const r = (n: number) => Math.round(n);
  return `<polygon style="fill:#000000; stroke:#000000;" points=" ${r(p1.x)} ${r(p1.y)} ${r(para.x)} ${r(para.y)} ${r(p2.x)} ${r(p2.y)}" />`;
}

/** A mesma linha que o SVG desenha, exposta para a camada de seleção do visualizador. */
export function pontosDoFluxo(diagrama: Diagrama, fluxo: ObjetoBpmn): Ponto[] | undefined {
  if (fluxo.tipo !== 'SequenceFlow') return undefined;
  const objeto = (id: string | undefined) => diagrama.objetos.find((x) => x.attrs['id'] === id);
  const caixaOrigem = diagrama.caixas.get(fluxo.attrs['sourceRef'] ?? '');
  const caixaDestino = diagrama.caixas.get(fluxo.attrs['targetRef'] ?? '');
  if (!caixaOrigem || !caixaDestino) return undefined;
  const objetoOrigem = objeto(fluxo.attrs['sourceRef']);
  const objetoDestino = objeto(fluxo.attrs['targetRef']);
  const origem = figura(objetoOrigem, caixaOrigem);
  const destino = figura(objetoDestino, caixaDestino);
  const meio = diagrama.dobras.get(fluxo.attrs['id'] ?? '') ?? [];
  const inicio = borda(origem, meio[0] ?? centro(destino), formaDe(objetoOrigem ?? { tipo: '', attrs: {} }));
  const fim = borda(destino, meio.at(-1) ?? centro(origem), formaDe(objetoDestino ?? { tipo: '', attrs: {} }));
  return [inicio, ...meio, fim];
}

export function gerarSvg(diagrama: Diagrama): string {
  const { objetos, caixas, dobras } = diagrama;
  const icones = diagrama.icones ?? new Map<string, Icone[]>();
  const usados = new Set<string>();
  const partes: string[] = [];

  // Raias: pool e lanes, na ordem do arquivo, com o rótulo girado na faixa da esquerda.
  let raia = 0;
  for (const o of objetos) {
    if (o.tipo !== 'BpmnPool' && o.tipo !== 'BpmnSwimLane') continue;
    raia++;
    const c = caixas.get(o.attrs['id'] ?? '');
    if (!c) continue;
    const cor = /^[0-9A-Fa-f]{6}$/.test(o.attrs['cores'] ?? '') ? o.attrs['cores'] : 'FFFFFF';
    partes.push(`<rect x="${c.absX}" y="${c.absY}" width="${c.largura}" height="${c.altura}" ry="0" rx="0" style="stroke:#000000; fill:#${cor}" />`);
    const meio = c.absY + c.altura / 2;
    const tspans = `<tspan dy="14" x="${-meio}">${escaparTexto(o.attrs['name'] ?? '')}</tspan>`;
    partes.push(
      `<g componentSequence="${raia}"><text x="${-meio}" y="${c.absX + 6}" transform="rotate(270)" text-anchor="middle" ` +
        `style="font-weight:bold;font-size:10px;stroke:none; fill:#434343">${tspans}</text></g>`,
    );
  }

  // Artefatos de documentação: só desenho, em <g componentSequence> (não são estados).
  for (const o of objetos) {
    const c = caixas.get(o.attrs['id'] ?? '');
    if (!c || !['BpmnGroup', 'BpmnDatabase', 'BpmnDocument'].includes(o.tipo)) continue;
    const { absX: x, absY: y, largura: w, altura: h } = c;
    const seq = sequencia(o.attrs['id']);
    const nome = o.attrs['name'] ?? '';
    const traco = 'stroke:#191970; fill:#F8FBFE; stroke-width:1';
    let desenho = '';
    if (o.tipo === 'BpmnGroup') {
      desenho = `<rect x="${x}" y="${y}" width="${w}" height="${h}" ry="5" rx="5" style="fill:none; stroke:#000000; stroke-dasharray:6,4" />` +
        `<text x="${x + 6}" y="${y + 14}" style="font-weight:bold;font-size:10px;stroke:none; fill:#434343">${escaparTexto(nome)}</text>`;
    } else if (o.tipo === 'BpmnDatabase') {
      const ry = Math.max(4, Math.round(h / 8));
      desenho = `<path d="M${x} ${y + ry} L${x} ${y + h - ry} A${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} L${x + w} ${y + ry}" style="${traco}" />` +
        `<ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" style="${traco}" />` +
        textoCentrado(x + w / 2, y + h, nome, Math.max(w, 80));
    } else {
      const dobra = Math.min(10, Math.round(w / 3));
      desenho = `<path d="M${x} ${y} L${x + w - dobra} ${y} L${x + w} ${y + dobra} L${x + w} ${y + h} L${x} ${y + h} Z" style="${traco}" />` +
        `<path d="M${x + w - dobra} ${y} L${x + w - dobra} ${y + dobra} L${x + w} ${y + dobra}" style="fill:none; stroke:#191970" />` +
        textoCentrado(x + w / 2, y + h, nome, Math.max(w, 80));
    }
    partes.push(`<g componentSequence="${seq}">${desenho}</g>`);
  }

  // Estados.
  for (const o of objetos) {
    const forma = formaDe(o);
    const id = o.attrs['id'] ?? '';
    const caixa = caixas.get(id);
    if (!forma || !caixa) continue;
    const c = figura(o, caixa);
    const seq = sequencia(id);
    const nome = o.attrs['name'] ?? '';
    const { absX: x, absY: y, largura: w, altura: h } = c;
    const m = centro(c);
    if (forma !== 'anotacao') usados.add(forma);
    const preenchimento = `style="fill:url(#gradiente-${forma});"`;

    if (forma === 'tarefa') {
      partes.push(`<g sequence="${seq}"><rect x="${x}" y="${y}" width="${w}" height="${h}" ry="5" rx="5" ${preenchimento} stroke="#${CONTORNO['tarefa']}" /></g>`);
      partes.push(`<g componentSequence="${seq}">${textoCentrado(m.x, y + 2, nome, w)}</g>`);
      const desenhos = (icones.get(id) ?? []).map(desenhoDoIcone).join('');
      if (desenhos) partes.push(`<g sequence="${seq}">${desenhos}</g>`);
    } else if (forma === 'gateway') {
      const pontos = `${x} ${m.y} ${m.x} ${y} ${x + w} ${m.y} ${m.x} ${y + h} ${x} ${m.y}`;
      partes.push(`<g sequence="${seq}"><polygon points=" ${pontos}" ${preenchimento} stroke="#${CONTORNO['gateway']}" /></g>`);
      // Paralelo e join: o "+" grosso, fora do <g sequence>, como no Studio; o exclusivo não tem marca.
      // Inclusivo: o círculo do BPMN (desenho próprio, sem SVG do Studio para comparar).
      if (o.attrs['type'] === '121') {
        partes.push(`<ellipse cx="${m.x}" cy="${m.y}" rx="12" ry="12" style="fill:none; stroke:#000000; stroke-width:3" />`);
      } else if (o.attrs['type'] !== '120') {
        partes.push(`<path style="fill:none; stroke-width:6; stroke:#000000;" d="M${m.x - 10}.0 ${m.y}.0 L${m.x + 10}.0 ${m.y}.0" />` +
          `<path style="fill:none; stroke-width:6; stroke:#000000;" d="M${m.x}.0 ${m.y - 10}.0 L${m.x}.0 ${m.y + 10}.0" />`);
      }
      partes.push(`<g componentSequence="${seq}">${textoCentrado(m.x, y + h, nome, Math.max(w, 60))}</g>`);
    } else if (forma === 'anotacao') {
      partes.push(`<g componentSequence="${seq}"><path d="M${x + 15} ${y} L${x} ${y} L${x} ${y + h} L${x + 15} ${y + h}" style="fill:none;stroke:#000000" />` +
        `<text x="${x + 5}" y="${y + 2}" style="font-size:10px;stroke:none; fill:#333399">${linhas(o.attrs['text'] ?? nome, w)
          .map((l) => `<tspan dy="14" x="${x + 5}">${escaparTexto(l)}</tspan>`).join('')}</text></g>`);
    } else {
      const r = Math.min(w, h) / 2;
      const borda = forma === 'fim' ? 3 : 1;
      // Eventos sem rótulo, como no Studio; a marca do tipo vai no mesmo <g sequence>.
      partes.push(`<g sequence="${seq}"><ellipse cx="${m.x}" cy="${m.y}" rx="${r}" ry="${r}" stroke-width="${borda}" ${preenchimento} stroke="#${CONTORNO[forma]}" />${marcaDoEvento(o.attrs['type'] ?? '', { x: Math.round(m.x), y: Math.round(m.y) })}</g>`);
    }
  }

  // Fluxos: da borda da origem, pelas dobras, até a borda do destino, com seta.
  for (const o of objetos) {
    if (o.tipo !== 'SequenceFlow') continue;
    const pontos = pontosDoFluxo(diagrama, o);
    if (!pontos) continue;
    const fim = pontos.at(-1)!;
    const d = pontos.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x}.0 ${p.y}.0`).join(' ');
    const anotacao = formaDe(objetos.find((x) => x.attrs['id'] === o.attrs['sourceRef']) ?? { tipo: '', attrs: {} }) === 'anotacao';
    partes.push(`<path style="fill:none; stroke:#000000;stroke-width:1${anotacao ? ';stroke-dasharray:3,3' : ''}" d="${d}" />`);
    if (!anotacao) partes.push(seta(pontos.at(-2)!, fim));
    const nome = o.attrs['name'] ?? '';
    if (nome) {
      const a = pontos[Math.floor((pontos.length - 1) / 2)]!;
      const b = pontos[Math.floor((pontos.length - 1) / 2) + 1]!;
      partes.push(`<g componentSequence="${sequencia(o.attrs['id'])}"><text x="${Math.round((a.x + b.x) / 2) + 3}" y="${Math.round((a.y + b.y) / 2) - 4}" ` +
        `style="font-size:10px;font-weight:none;stroke:none; fill:#333399">${escaparTexto(nome)}</text></g>`);
    }
  }

  let largura = 0;
  let altura = 0;
  for (const c of caixas.values()) {
    largura = Math.max(largura, c.absX + c.largura);
    altura = Math.max(altura, c.absY + c.altura);
  }
  for (const pontos of dobras.values()) {
    for (const p of pontos) {
      largura = Math.max(largura, p.x);
      altura = Math.max(altura, p.y);
    }
  }
  largura += 20;
  altura += 40;

  const defs = [...usados]
    .map((forma) => {
      const cores = GRADIENTES[forma]!;
      const stops = cores
        .map((cor, i) => `<stop style="stop-color:#${cor};stop-opacity:1;" offset="${cores.length === 1 ? 0 : (i / (cores.length - 1)).toFixed(2)}" />`)
        .join('');
      return `<linearGradient id="gradiente-${forma}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" style="font-family:'Arial'; font-size:12; fill:black; stroke:black; stroke-width:1;" ` +
    `contentScriptType="text/ecmascript" preserveAspectRatio="xMidYMid meet" zoomAndPan="magnify" version="1.0" contentStyleType="text/css" ` +
    `width="${largura}" height="${altura}"><defs>${defs}</defs>${partes.join('')}</svg>`
  );
}

/** Os `sequence` de estado que um SVG do Studio desenha (os `<g sequence="N">`). */
export function sequenciasDoSvg(svg: string): Set<number> {
  return new Set([...svg.matchAll(/<g sequence="(\d+)"/g)].map((m) => Number(m[1])));
}
