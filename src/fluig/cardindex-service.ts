import { ErroFluigctl } from '../errors.js';
import type { AnexoForm, EventoForm } from '../push/form-source.js';
import { fluigSoapClient, invoke, itens } from './soap.js';

export interface FormNoServidor {
  documentId: number;
  documentDescription: string;
  datasetName: string;
  /**
   * Campo descritor do formulário. Na listagem ele vem como `cardDescription`;
   * no update, o mesmo valor vai em `descriptionField` (e `cardDescription` do
   * update é o NOME do formulário). Ausente quando o servidor não o informou.
   */
  descriptionField?: string;
  /** A pasta (documentId) onde o formulário está; ausente quando o servidor não a informou. */
  pasta?: number;
}

export interface ParametrosUpdate {
  documentId: number;
  cardDescription: string;
  descriptionField: string;
  datasetName: string;
  anexos: AnexoForm[];
  eventos: EventoForm[];
  versionOption: '0' | '2';
}

export interface ParametrosCreate {
  parentDocumentId: number;
  documentDescription: string;
  cardDescription: string;
  datasetName: string;
  anexos: AnexoForm[];
  eventos: EventoForm[];
  persistenceType: number;
}

export interface CardIndexClient {
  listForms(): Promise<FormNoServidor[]>;
  /** Nomes dos anexos do formulário, sem subpasta (é como o servidor os guarda). */
  listAttachments(documentId: number): Promise<string[]>;
  /** Bytes de um anexo, na versão pedida — a errada é recusada ("versão do documento é inválida"). */
  attachmentContent(documentId: number, version: number, nome: string): Promise<Buffer>;
  events(documentId: number): Promise<{ eventId: string; eventDescription: string }[]>;
  updateForm(p: ParametrosUpdate): Promise<void>;
  createForm(p: ParametrosCreate): Promise<number>;
}

interface MensagemWS {
  documentId?: number;
  documentDescription?: string;
  webServiceMessage?: string;
}

/** Os `*Array` do Fluig são sempre `{ item: [...] }`. */
const arrayDe = <T>(lista: T[]) => ({ item: lista });

/**
 * O servidor devolve HTTP 200 mesmo ao recusar: o veredito está em
 * `webServiceMessage`, que só vale como sucesso quando é exatamente "ok".
 */
function exigeOk(resposta: { result?: { item?: MensagemWS | MensagemWS[] } }, operacao: string): MensagemWS {
  const mensagens = itens<MensagemWS>(resposta?.result);
  const primeira = mensagens[0];

  if (!primeira) {
    throw new ErroFluigctl(`o servidor não respondeu nada em "${operacao}"`, 7);
  }
  if (primeira.webServiceMessage !== 'ok') {
    throw new ErroFluigctl(
      `o servidor recusou "${operacao}": ${primeira.webServiceMessage ?? 'sem mensagem'}`,
      7,
    );
  }

  return primeira;
}

export async function cardIndexClient(
  baseUrl: string,
  companyId: number,
  username: string,
  password: string,
  colleagueId: string,
): Promise<CardIndexClient> {
  const cliente = await fluigSoapClient(baseUrl, 'ECMCardIndexService');
  const credencial = { username, password, companyId };

  return {
    async listForms(): Promise<FormNoServidor[]> {
      const r = await invoke<{ result?: { item?: FormNoServidor | FormNoServidor[] } }>(
        cliente,
        'getCardIndexesWithoutApprover',
        { ...credencial, colleagueId },
      );

      return itens<FormNoServidor & { cardDescription?: unknown }>(r?.result).map((f) => ({
        documentId: Number(f.documentId),
        documentDescription: String(f.documentDescription ?? ''),
        datasetName: String(f.datasetName ?? ''),
        ...(Number.isInteger(Number((f as { parentDocumentId?: unknown }).parentDocumentId)) && (f as { parentDocumentId?: unknown }).parentDocumentId != null
          ? { pasta: Number((f as { parentDocumentId?: unknown }).parentDocumentId) }
          : {}),
        // Tag vazia chega como null (o formulário não tem descritor); só a tag ausente é "não sei".
        ...(Object.prototype.hasOwnProperty.call(f, 'cardDescription')
          ? { descriptionField: f.cardDescription === null ? '' : String(f.cardDescription) }
          : {}),
      }));
    },

    async listAttachments(documentId): Promise<string[]> {
      const r = await invoke<{ result?: { item?: string | string[] } }>(cliente, 'getAttachmentsList', {
        ...credencial,
        documentId,
      });
      return itens<string>(r?.result).map(String);
    },

    async attachmentContent(documentId, version, nome): Promise<Buffer> {
      const r = await invoke<{ folder?: string }>(cliente, 'getCardIndexContent', {
        ...credencial,
        documentId,
        colleagueId,
        version,
        nomeArquivo: nome,
      });
      return Buffer.from(r?.folder ?? '', 'base64');
    },

    async events(documentId) {
      type Evento = { eventId?: unknown; eventDescription?: unknown };
      const r = await invoke<{ result?: { item?: Evento | Evento[] } }>(cliente, 'getCustomizationEvents', {
        ...credencial,
        documentId,
      });
      return itens<Evento>(r?.result).map((e) => ({
        eventId: String(e.eventId ?? ''),
        eventDescription: e.eventDescription == null ? '' : String(e.eventDescription),
      }));
    },

    async updateForm(p): Promise<void> {
      const r = await invoke<{ result?: { item?: MensagemWS | MensagemWS[] } }>(
        cliente,
        'updateSimpleCardIndexWithDatasetAndGeneralInfo',
        {
          ...credencial,
          documentId: p.documentId,
          publisherId: colleagueId,
          cardDescription: p.cardDescription,
          descriptionField: p.descriptionField,
          datasetName: p.datasetName,
          Attachments: arrayDe(p.anexos),
          customEvents: arrayDe(p.eventos),
          generalInfo: { versionOption: p.versionOption },
        },
      );

      exigeOk(r, 'atualizar formulário');
    },

    async createForm(p): Promise<number> {
      const r = await invoke<{ result?: { item?: MensagemWS | MensagemWS[] } }>(
        cliente,
        'createSimpleCardIndexWithDatasetPersisteType',
        {
          ...credencial,
          parentDocumentId: p.parentDocumentId,
          publisherId: colleagueId,
          documentDescription: p.documentDescription,
          cardDescription: p.cardDescription,
          datasetName: p.datasetName,
          Attachments: arrayDe(p.anexos),
          customEvents: arrayDe(p.eventos),
          persistenceType: p.persistenceType,
        },
      );

      const mensagem = exigeOk(r, 'criar formulário');
      const id = Number(mensagem.documentId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ErroFluigctl(
          `o formulário foi criado, mas o servidor não devolveu um documentId utilizável ` +
            `(recebi "${String(mensagem.documentId)}")`,
          7,
        );
      }
      return id;
    },
  };
}
