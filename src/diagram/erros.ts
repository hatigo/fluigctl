import { lerDiagrama, type Caixa } from '../push/diagram/modelo.js';
import { formasDeTopo, trocarCoordenada } from './edit.js';

/**
 * O evento de erro fica centrado no canto inferior direito da service task.
 * Quando o Studio abre um diagrama, ele redimensiona as tarefas (resizeUserTask)
 * mas não leva junto os eventos presos a elas: a bolinha fica para trás, solta
 * ao lado do card. O encaixe a devolve ao canto, mexendo só no x/y dela.
 *
 * Só a bolinha solta (sem encostar no card) volta. Nos 95 diagramas do acervo,
 * 137 bolinhas fora do canto encostam no card (no canto de cima, na borda de
 * baixo): é escolha de quem desenhou, e o encaixe não mexe nelas.
 */

interface Desencaixe {
  evento: string;
  dx: number;
  dy: number;
}

/** O critério do check: o centro da bolinha a mais de um raio do canto. */
export function foraDoCanto(tarefa: Caixa, evento: Caixa): boolean {
  const cx = evento.absX + evento.largura / 2;
  const cy = evento.absY + evento.altura / 2;
  return Math.hypot(cx - (tarefa.absX + tarefa.largura), cy - (tarefa.absY + tarefa.altura)) > evento.largura / 2;
}

/** A bolinha não encosta no card: ficou para trás quando a tarefa mudou de tamanho ou de lugar. */
export function soltaDaTarefa(tarefa: Caixa, evento: Caixa): boolean {
  return !(
    evento.absX < tarefa.absX + tarefa.largura &&
    evento.absX + evento.largura > tarefa.absX &&
    evento.absY < tarefa.absY + tarefa.altura &&
    evento.absY + evento.altura > tarefa.absY
  );
}

function desencaixados(xml: string): Desencaixe[] {
  const d = lerDiagrama(xml);
  const formas = formasDeTopo(xml);
  const achados: Desencaixe[] = [];
  for (const o of d.objetos) {
    const evento = o.attrs['id'];
    const tarefa = o.attrs['parentTask'];
    if (o.tipo !== 'BpmnIntermediateEvent' || !evento || !tarefa || !formas.has(evento) || !formas.has(tarefa)) continue;
    const ce = d.caixas.get(evento);
    const ct = d.caixas.get(tarefa);
    if (!ce || !ct || !foraDoCanto(ct, ce) || !soltaDaTarefa(ct, ce)) continue;
    const x = Math.round(ct.absX + ct.largura - ce.largura / 2);
    const y = Math.round(ct.absY + ct.altura - ce.altura / 2);
    achados.push({ evento, dx: x - ce.absX, dy: y - ce.absY });
  }
  return achados;
}

export function errosForaDoCanto(xml: string): number {
  return desencaixados(xml).length;
}

/** Devolve o XML com cada evento de erro no canto da sua tarefa; o mesmo texto quando nada falta. */
export function encaixarErros(xml: string): string {
  const mudar = desencaixados(xml);
  if (mudar.length === 0) return xml;
  const d = lerDiagrama(xml);
  const formas = formasDeTopo(xml);
  // Do fim para o começo, para os índices do texto continuarem válidos.
  const trocas = mudar
    .map((m) => ({ ...m, forma: formas.get(m.evento)!, caixa: d.caixas.get(m.evento)! }))
    .sort((a, b) => b.forma.inicio - a.forma.inicio);
  let novo = xml;
  for (const { forma, caixa, dx, dy } of trocas) {
    const tag = trocarCoordenada(trocarCoordenada(forma.tag, 'x', caixa.x + dx), 'y', caixa.y + dy);
    novo = novo.slice(0, forma.inicio) + tag + novo.slice(forma.inicio + forma.tag.length);
  }
  return novo;
}
