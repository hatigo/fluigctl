import { ErroFluigctl } from '../errors.js';
import { exigirOk } from './rest.js';
import { login } from './session.js';

/**
 * Evento global (`events/<eventId>.js`), pelo REST do Fluig.
 *
 * São quatro rotas, as mesmas que a extensão Fluiggers usa:
 *
 *   GET    /ecm/api/rest/ecm/globalevent/getEventList
 *   POST   /ecm/api/rest/ecm/globalevent/saveEventList
 *   DELETE /ecm/api/rest/ecm/globalevent/deleteGlobalEvent?eventName=<id>
 *
 * A que importa é a segunda, e ela tem uma armadilha medida no fluig-localdev:
 * **`saveEventList` substitui a lista inteira**. Mandar só um evento apaga todos
 * os outros do servidor. Não existe rota de gravar um evento só, então toda
 * escrita é ler a lista, trocar a entrada e mandar a lista de volta — e por isso
 * `listar` recusa quando não consegue ler, em vez de devolver lista vazia como
 * faz a extensão: uma leitura que falha viraria um `saveEventList` com a lista
 * vazia mais o nosso evento, apagando o resto do servidor.
 */

const PREFIXO = '/ecm/api/rest/ecm/globalevent/';

export interface EventoGlobal {
  eventId: string;
  /** O código JavaScript, que é o `eventDescription` do servidor. */
  codigo: string;
}

export interface GlobalEventClient {
  /**
   * A lista inteira, como está no servidor. Recusa quando a resposta não é a
   * lista esperada — nunca devolve vazio por não ter entendido.
   */
  listar(): Promise<EventoGlobal[]>;
  /** Substitui a lista inteira. Quem chama é quem garante que ela está completa. */
  gravar(lista: readonly EventoGlobal[]): Promise<void>;
  remover(eventId: string): Promise<void>;
}

interface EventoDTO {
  globalEventPK?: { companyId?: number; eventId?: string };
  eventDescription?: string;
}

export async function globalEventClient(
  baseUrl: string,
  companyId: number,
  username: string,
  password: string,
): Promise<GlobalEventClient> {
  const cookie = await login(baseUrl, username, password);
  const url = (rota: string) => `${baseUrl}${PREFIXO}${rota}`;
  const cabecalhos = { accept: 'application/json', cookie };

  return {
    async listar(): Promise<EventoGlobal[]> {
      const resposta = await fetch(url('getEventList'), { headers: cabecalhos, redirect: 'manual' });
      const texto = await resposta.text();
      if (!resposta.ok) exigirOk(texto, 'a leitura dos eventos globais', resposta.status);

      let lido: unknown;
      try {
        lido = JSON.parse(texto);
      } catch {
        throw new ErroFluigctl(
          `o servidor não devolveu a lista de eventos globais em ${baseUrl} (não é JSON)`,
          7,
        );
      }
      // Lista vazia é resposta legítima ("o servidor não tem evento global"), e é
      // por isso que o formato é conferido: `[]` de verdade só entra como `[]`.
      if (!Array.isArray(lido)) {
        throw new ErroFluigctl(
          `o servidor não devolveu a lista de eventos globais em ${baseUrl} (o formato mudou?)`,
          7,
        );
      }
      return lido.map((e) => {
        const dto = e as EventoDTO;
        const eventId = dto.globalEventPK?.eventId;
        if (typeof eventId !== 'string' || eventId === '') {
          throw new ErroFluigctl(`a lista de eventos globais de ${baseUrl} tem um evento sem eventId`, 7);
        }
        return { eventId, codigo: dto.eventDescription ?? '' };
      });
    },

    async gravar(lista: readonly EventoGlobal[]): Promise<void> {
      const corpo = JSON.stringify(
        lista.map((e) => ({ globalEventPK: { companyId, eventId: e.eventId }, eventDescription: e.codigo })),
      );
      const resposta = await fetch(url('saveEventList'), {
        method: 'POST',
        // A extensão manda JSON com este content-type e o servidor aceita; é o
        // contrato medido, não o que o cabeçalho sugere.
        headers: { ...cabecalhos, 'content-type': 'application/x-www-form-urlencoded' },
        body: corpo,
        redirect: 'manual',
      });
      exigirOk(await resposta.text(), 'a gravação dos eventos globais', resposta.status);
    },

    async remover(eventId: string): Promise<void> {
      const resposta = await fetch(url(`deleteGlobalEvent?eventName=${encodeURIComponent(eventId)}`), {
        method: 'DELETE',
        headers: cabecalhos,
        redirect: 'manual',
      });
      exigirOk(await resposta.text(), `a remoção do evento global "${eventId}"`, resposta.status);
    },
  };
}

/**
 * A lista do servidor com a entrada trocada — ou acrescentada no fim, se for
 * nova. Devolve a lista inteira, que é o que `gravar` exige: nada do que já
 * estava no servidor sai por causa de uma publicação local.
 */
export function comEvento(
  lista: readonly EventoGlobal[],
  evento: EventoGlobal,
): { lista: EventoGlobal[]; novo: boolean } {
  const i = lista.findIndex((e) => e.eventId === evento.eventId);
  if (i === -1) return { lista: [...lista, evento], novo: true };
  const copia = [...lista];
  copia[i] = evento;
  return { lista: copia, novo: false };
}
