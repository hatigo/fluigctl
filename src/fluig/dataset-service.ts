import { fluigSoapClient, invoke, itens } from './soap.js';

export interface DatasetClient {
  listCustom(): Promise<string[]>;
  add(nome: string, descricao: string, impl: string): Promise<void>;
  update(nome: string, descricao: string, impl: string): Promise<void>;
}

interface FormDatasetDTO {
  datasetId?: string;
  type?: string;
}

export async function datasetClient(
  baseUrl: string,
  companyId: number,
  username: string,
  password: string,
): Promise<DatasetClient> {
  const cliente = await fluigSoapClient(baseUrl, 'ECMDatasetService');
  const credencial = { username, password };

  return {
    async listCustom(): Promise<string[]> {
      const r = await invoke<{ dataset?: { item?: FormDatasetDTO | FormDatasetDTO[] } }>(
        cliente,
        'findAllFormulariesDatasets',
        { companyId, ...credencial },
      );
      return itens<FormDatasetDTO>(r?.dataset)
        .filter((d) => d.type === 'CUSTOM')
        .map((d) => d.datasetId)
        .filter((id): id is string => typeof id === 'string');
    },

    async add(nome, descricao, impl): Promise<void> {
      await invoke(cliente, 'addDataset', {
        companyId,
        ...credencial,
        name: nome,
        description: descricao,
        impl,
      });
    },

    async update(nome, descricao, impl): Promise<void> {
      await invoke(cliente, 'updateDataset', {
        companyId,
        ...credencial,
        name: nome,
        description: descricao,
        impl,
      });
    },
  };
}

export interface DatasetNoServidor {
  description?: string;
  impl?: string;
}

/**
 * Lê descrição e código de um dataset pelo REST (`loadDataset`).
 *
 * O SOAP não devolve nenhum dos dois. Serve para preservar a descrição, guardar
 * uma cópia antes de sobrescrever e conferir depois o que o servidor gravou.
 */
export async function loadDataset(
  baseUrl: string,
  cookie: string,
  nome: string,
): Promise<DatasetNoServidor> {
  const url =
    `${baseUrl}/ecm/api/rest/ecm/dataset/loadDataset` +
    `?datasetId=${encodeURIComponent(nome)}`;

  const resposta = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  const texto = await resposta.text();

  try {
    const lido = JSON.parse(texto) as {
      datasetDescription?: string;
      datasetImpl?: string;
      content?: { datasetDescription?: string; datasetImpl?: string } | null;
    };
    const d = lido.datasetImpl !== undefined || lido.datasetDescription !== undefined ? lido : lido.content ?? {};
    return {
      ...(d.datasetDescription === undefined ? {} : { description: d.datasetDescription }),
      ...(d.datasetImpl === undefined ? {} : { impl: d.datasetImpl }),
    };
  } catch {
    return {};
  }
}

/**
 * Lê a descrição atual de um dataset.
 *
 * `updateDataset` grava a descrição que receber, então mandar a errada apaga a
 * do servidor — medido no homolog da CETENCO. Não há como obter a descrição
 * pelo SOAP (`findAllFormulariesDatasets` não a devolve), daí o REST.
 */
export async function loadDatasetDescription(
  baseUrl: string,
  cookie: string,
  nome: string,
): Promise<string | undefined> {
  const url =
    `${baseUrl}/ecm/api/rest/ecm/dataset/loadDataset` +
    `?datasetId=${encodeURIComponent(nome)}`;

  const resposta = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  const texto = await resposta.text();

  // O formato varia por servidor: o CETENCO HML devolve o dataset na raiz,
  // outros embrulham em `content`. Aceita os dois.
  try {
    const lido = JSON.parse(texto) as {
      datasetDescription?: string;
      content?: { datasetDescription?: string } | null;
    };
    return lido.datasetDescription ?? lido.content?.datasetDescription;
  } catch {
    return undefined;
  }
}
