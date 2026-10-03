import { fluigSoapClient, invoke, itens } from './soap.js';

/**
 * Cadastros do servidor que o `.process` cita pelo nome e que precisam existir
 * no destino: volumes e expedientes. São as mesmas listas que o Studio oferece
 * nas propriedades do processo e da tarefa (`WSMethods.getListaVolumesFromWS` e
 * `getListaExpedientesFromWS`, decompilados). A categoria não entra: no Studio é
 * texto livre, e o servidor não tem cadastro de categorias.
 */
export interface CadastroClient {
  listVolumes(): Promise<string[]>;
  listExpedientes(): Promise<string[]>;
}

export async function cadastroClient(
  baseUrl: string,
  companyId: number,
  username: string,
  password: string,
): Promise<CadastroClient> {
  const credencial = { username, password, companyId };
  return {
    async listVolumes(): Promise<string[]> {
      const cliente = await fluigSoapClient(baseUrl, 'ECMGlobalParamService');
      const r = await invoke<{ resultXML?: { item?: { volumeId?: unknown } | { volumeId?: unknown }[] } }>(
        cliente,
        'getVolumes',
        credencial,
      );
      return itens(r?.resultXML).map((v) => String(v.volumeId ?? ''));
    },
    async listExpedientes(): Promise<string[]> {
      const cliente = await fluigSoapClient(baseUrl, 'ECMBusinessPeriodService');
      const r = await invoke<{ resultXML?: { item?: { periodId?: unknown } | { periodId?: unknown }[] } }>(
        cliente,
        'getBusinessPeriods',
        credencial,
      );
      return itens(r?.resultXML).map((p) => String(p.periodId ?? ''));
    },
  };
}
