import { ErroFluigctl } from '../errors.js';
import type { AnexoForm, EventoForm } from '../push/form-source.js';
import { fluigSoapClient, invoke, itens } from './soap.js';

export interface FormNoServidor {
  documentId: number;
  documentDescription: string;
  datasetName: string;
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

      return itens<FormNoServidor>(r?.result).map((f) => ({
        documentId: Number(f.documentId),
        documentDescription: String(f.documentDescription ?? ''),
        datasetName: String(f.datasetName ?? ''),
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
