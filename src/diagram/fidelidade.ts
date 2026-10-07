import { lerDiagrama } from '../push/diagram/modelo.js';
import { filhos, lerXml, type No } from '../push/diagram/xml.js';
import { garantirVisual } from './visual.js';

/**
 * Mede o quanto o visual que o fluigctl desenha difere do que o Studio grava.
 *
 * Um diagrama salvo pelo Studio perde os estilos (como um montado fora dele),
 * passa pelo garantirVisual e cada forma e ligação redesenhada é comparada com
 * a original. A comparação resolve as referências por posição: estilo vira o id
 * e o conteúdo dele, cor vira o RGB, fonte vira nome, tamanho e negrito. Assim
 * só conta o que o Studio veria diferente, e não o índice em que caiu.
 */

export interface Comparacao {
  /** Id do objeto BPMN (forma ou ligação). */
  id: string;
  /** Tipo do objeto, como `BpmnTask/82` ou `BpmnSequenceFlow`. */
  tipo: string;
  situacao: 'igual' | 'diferente' | 'nao-redesenhado';
  /** Linhas canônicas que só a original tem (-) ou só a redesenhada tem (+). */
  diferencas: string[];
}

/** O diagrama sem nenhum estilo: o estado em que o fluigctl recebe um diagrama montado fora do Studio. */
export function tirarEstilos(xml: string): string {
  return xml.replace(/\sstyle="[^"]*"/g, '');
}

interface Referencias {
  raiz: No;
  estilos: No[];
  cores: No[];
  fontes: No[];
}

function referencias(xml: string): Referencias {
  const raiz = filhos(lerXml(xml), 'xmi:XMI')[0]!;
  const diagrama = filhos(raiz, 'pi:Diagram')[0]!;
  return { raiz: diagrama, estilos: filhos(diagrama, 'styles'), cores: filhos(diagrama, 'colors'), fontes: filhos(diagrama, 'fonts') };
}

function rgb(no: No | undefined): string {
  if (!no) return '?';
  return `rgb(${no.attrs['red'] ?? 0},${no.attrs['green'] ?? 0},${no.attrs['blue'] ?? 0})`;
}

function resolverCor(r: Referencias, ref: string): string {
  const m = /^\/0\/@colors\.(\d+)$/.exec(ref);
  return m ? rgb(r.cores[Number(m[1])]) : ref;
}

function resolverEstilo(r: Referencias, ref: string): No | undefined {
  // /0/@styles.3 ou, num estilo aninhado, /0/@styles.3/@styles.0.
  let atual: No | undefined;
  for (const m of ref.matchAll(/@styles\.(\d+)/g)) {
    atual = atual ? filhos(atual, 'styles')[Number(m[1])] : r.estilos[Number(m[1])];
  }
  return atual;
}

function resolverFonte(r: Referencias, ref: string): string {
  const m = /^\/0\/@fonts\.(\d+)$/.exec(ref);
  const f = m ? r.fontes[Number(m[1])] : undefined;
  if (!f) return ref;
  return `fonte(${f.attrs['name']},${f.attrs['size']}${f.attrs['bold'] === 'true' ? ',negrito' : ''}${f.attrs['italic'] === 'true' ? ',itálico' : ''})`;
}

/** Atributos que guardam referência por posição; os outros vão como estão. */
function valorCanonico(r: Referencias, chave: string, valor: string): string {
  if (chave === 'foreground' || chave === 'background') return resolverCor(r, valor);
  if (chave === 'font') return resolverFonte(r, valor);
  return valor;
}

/**
 * Estilos que o Studio grava com nomes diferentes e o mesmo conteúdo. Na raia,
 * BPMN-SWIM_LANE (75 no acervo) e BPMN-SWIM_LANE-NOSTYLE (295) têm as mesmas
 * cores, e o fundo que aparece é o do retângulo; o fluigctl grava o segundo.
 */
const EQUIVALENTES: Record<string, string> = { 'BPMN-SWIM_LANE': 'BPMN-SWIM_LANE-NOSTYLE' };

function linhas(r: Referencias, no: No, recuo: string, saida: string[]): void {
  const attrs = Object.entries(no.attrs)
    .filter(([k]) => k !== 'style')
    .map(([k, v]) => `${k}=${k === 'id' && no.nome === 'styles' ? (EQUIVALENTES[v] ?? v) : valorCanonico(r, k, v)}`)
    .sort();
  saida.push(`${recuo}${no.nome} ${attrs.join(' ')}`.trimEnd());
  const ref = no.attrs['style'];
  if (ref !== undefined) {
    const estilo = resolverEstilo(r, ref);
    if (!estilo) saida.push(`${recuo}  style=${ref} (não existe)`);
    else linhas(r, estilo, `${recuo}  style:`, saida);
  }
  for (const f of no.filhos) linhas(r, f, `${recuo}  `, saida);
}

function canonico(r: Referencias, no: No): string[] {
  const saida: string[] = [];
  linhas(r, no, '', saida);
  return saida;
}

/** Diferença por linhas (LCS): o que só um dos lados tem, na ordem em que aparece. */
function diferenca(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const saida: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; }
    else if (j < m && (i === n || t[i]![j + 1]! >= t[i + 1]![j]!)) saida.push(`+ ${b[j++]}`);
    else saida.push(`- ${a[i++]}`);
  }
  return saida;
}

function blocos(r: Referencias): Map<string, No> {
  const mapa = new Map<string, No>();
  for (const no of [...filhos(r.raiz, 'children'), ...filhos(r.raiz, 'connections')]) {
    const id = filhos(no, 'link')[0]?.attrs['businessObjects'];
    if (id) mapa.set(id, no);
  }
  return mapa;
}

function temEstilo(no: No): boolean {
  return no.attrs['style'] !== undefined || no.filhos.some(temEstilo);
}

/** Tira o visual de um diagrama do Studio, redesenha pelo fluigctl e compara forma por forma. */
export function compararComStudio(xmlStudio: string): Comparacao[] {
  const redesenhado = garantirVisual(tirarEstilos(xmlStudio));
  const original = referencias(xmlStudio);
  const novo = referencias(redesenhado);
  const tipos = new Map(lerDiagrama(xmlStudio).objetos.filter((o) => o.attrs['id']).map((o) => [o.attrs['id']!, `${o.tipo}${o.attrs['type'] ? `/${o.attrs['type']}` : ''}`]));
  const novos = blocos(novo);
  const resultado: Comparacao[] = [];
  for (const [id, no] of blocos(original)) {
    const tipo = tipos.get(id) ?? '?';
    const outro = novos.get(id);
    if (!outro || !temEstilo(outro)) {
      resultado.push({ id, tipo, situacao: 'nao-redesenhado', diferencas: [] });
      continue;
    }
    const diferencas = diferenca(canonico(original, no), canonico(novo, outro));
    resultado.push({ id, tipo, situacao: diferencas.length ? 'diferente' : 'igual', diferencas });
  }
  return resultado;
}
