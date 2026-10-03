import { escaparTexto } from './xml.js';
import type { Caixa, Diagrama, ObjetoBpmn, Ponto } from './modelo.js';

/**
 * Imagem do diagrama (`<processo>.processimage.svg`) que o Studio manda junto no
 * `importProcess`. Sem ela o servidor guarda a versão sem imagem, e a tela do
 * processo mostra "Não foi possível exibir o fluxo do processo".
 *
 * O visualizador do Fluig (`/webdesk/svgviewer`) destaca a atividade atual pelo
 * `<g sequence="N">` de cada estado; rótulos e raias vão em
 * `<g componentSequence="N">`, como no SVG do Studio. O desenho é uma versão
 * simples do Studio — mesmas formas, cores e posições, sem os ícones.
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

/** Contorno de cada forma no SVG do Studio. */
const CONTORNO: Record<string, string> = {
  inicio: '336633', fim: '993333', tarefa: '191970', gateway: '000000', intermediario: '999900',
};

/** Ponto onde a reta do centro de `c` até `alvo` sai da caixa (âncora "chopbox"). */
function borda(c: Caixa, alvo: Ponto): Ponto {
  const m = centro(c);
  const dx = alvo.x - m.x;
  const dy = alvo.y - m.y;
  if (dx === 0 && dy === 0) return m;
  const sx = dx === 0 ? Infinity : c.largura / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : c.altura / 2 / Math.abs(dy);
  const s = Math.min(sx, sy, 1);
  return { x: Math.round(m.x + dx * s), y: Math.round(m.y + dy * s) };
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

export function gerarSvg(diagrama: Diagrama): string {
  const { objetos, caixas, dobras } = diagrama;
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
    } else if (forma === 'gateway') {
      const pontos = `${x} ${m.y} ${m.x} ${y} ${x + w} ${m.y} ${m.x} ${y + h} ${x} ${m.y}`;
      const marca = o.attrs['type'] === '120' ? '' : `<path d="M${m.x - 8} ${m.y} L${m.x + 8} ${m.y} M${m.x} ${m.y - 8} L${m.x} ${m.y + 8}" style="stroke:#000000;stroke-width:3" />`;
      partes.push(`<g sequence="${seq}"><polygon points=" ${pontos}" ${preenchimento} stroke="#${CONTORNO['gateway']}" />${marca}</g>`);
      partes.push(`<g componentSequence="${seq}">${textoCentrado(m.x, y + h, nome, Math.max(w, 60))}</g>`);
    } else if (forma === 'anotacao') {
      partes.push(`<g componentSequence="${seq}"><path d="M${x + 15} ${y} L${x} ${y} L${x} ${y + h} L${x + 15} ${y + h}" style="fill:none;stroke:#000000" />` +
        `<text x="${x + 5}" y="${y + 2}" style="font-size:10px;stroke:none; fill:#333399">${linhas(o.attrs['text'] ?? nome, w)
          .map((l) => `<tspan dy="14" x="${x + 5}">${escaparTexto(l)}</tspan>`).join('')}</text></g>`);
    } else {
      const r = Math.min(w, h) / 2;
      const borda = forma === 'fim' ? 3 : 1;
      const interno = forma === 'intermediario' ? `<ellipse cx="${m.x}" cy="${m.y}" rx="${r - 3}" ry="${r - 3}" style="fill:none" stroke="#${CONTORNO['intermediario']}" />` : '';
      // Eventos sem rótulo, como no Studio.
      partes.push(`<g sequence="${seq}"><ellipse cx="${m.x}" cy="${m.y}" rx="${r}" ry="${r}" stroke-width="${borda}" ${preenchimento} stroke="#${CONTORNO[forma]}" />${interno}</g>`);
    }
  }

  // Fluxos: da borda da origem, pelas dobras, até a borda do destino, com seta.
  for (const o of objetos) {
    if (o.tipo !== 'SequenceFlow') continue;
    const objeto = (id: string | undefined) => objetos.find((x) => x.attrs['id'] === id);
    const caixaOrigem = caixas.get(o.attrs['sourceRef'] ?? '');
    const caixaDestino = caixas.get(o.attrs['targetRef'] ?? '');
    if (!caixaOrigem || !caixaDestino) continue;
    const origem = figura(objeto(o.attrs['sourceRef']), caixaOrigem);
    const destino = figura(objeto(o.attrs['targetRef']), caixaDestino);
    const meio = dobras.get(o.attrs['id'] ?? '') ?? [];
    const inicio = borda(origem, meio[0] ?? centro(destino));
    const fim = borda(destino, meio.at(-1) ?? centro(origem));
    const pontos = [inicio, ...meio, fim];
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
