import { ErroFluigctl } from '../errors.js';

/**
 * As duas famílias de REST do Fluig que o fluigctl usa respondem no mesmo
 * envelope: `{"content":"OK","message":null}` quando deu certo, e
 * `{"content":"ERROR","message":{"message":...,"detail":...,"errorCode":...}}`
 * quando não deu — este último quase sempre com HTTP 500.
 *
 * O `content` é o sinal confiável: já houve resposta 200 com erro dentro. Quem
 * chama passa o contexto ("o evento global \"x\""), e a mensagem do servidor vai
 * junto porque é ela que diz o que fazer — o compilador de evento, por exemplo,
 * recusa com o erro de sintaxe e a linha.
 */

interface Envelope {
  content?: unknown;
  message?: unknown;
}

/** A mensagem legível de um envelope de erro, se houver. */
export function mensagemDoEnvelope(texto: string): string | undefined {
  let lido: Envelope;
  try {
    lido = JSON.parse(texto) as Envelope;
  } catch {
    return undefined;
  }
  const m = lido.message;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') {
    const campos = m as { message?: unknown; detail?: unknown };
    for (const v of [campos.message, campos.detail]) if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

/** Recusa quando o envelope não é o de sucesso; devolve nada quando é. */
export function exigirOk(texto: string, contexto: string, status?: number): void {
  let lido: Envelope | undefined;
  try {
    lido = JSON.parse(texto) as Envelope;
  } catch {
    lido = undefined;
  }
  if (lido?.content === 'OK') return;

  const motivo = mensagemDoEnvelope(texto) ?? (texto.trim() === '' ? 'resposta vazia' : texto.trim().slice(0, 300));
  throw new ErroFluigctl(
    `o servidor recusou ${contexto}: ${motivo}` + (status === undefined || status < 400 ? '' : ` (HTTP ${status})`),
    7,
  );
}
