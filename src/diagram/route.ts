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
  return rota(diagrama, fluxoId).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
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
