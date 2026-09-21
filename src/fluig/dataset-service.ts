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
