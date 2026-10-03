import { ErroFluigctl } from '../errors.js';
import { primeiroXmlDoZip } from '../push/zip.js';
import { fluigSoapClient, invoke, itens } from './soap.js';

export interface WorkflowEngineClient {
  listProcessIds(): Promise<string[]>;
  /** Definição corrente do processo, nos bytes ISO-8859-1 que o servidor guarda. */
  exportProcess(processId: string): Promise<Buffer>;
  createVersion(processId: string): Promise<void>;
  /**
   * `novo`: cria o processo (newProcess, sem overWrite), como o fluig-cd; senão sobrescreve a versão em edição.
   * `imagem`: o `<nome>.processimage.svg` que o Studio manda junto (principal false, attach true);
   * sem ele, a versão fica sem imagem e a tela do processo não mostra o fluxo.
   */
  importProcess(processId: string, xml: Buffer, novo?: boolean, imagem?: { nome: string; svg: Buffer }): Promise<string>;
  releaseProcess(processId: string): Promise<{ ok: boolean; mensagem: string }>;
}

/**
 * Cliente do ECMWorkflowEngineService para publicar processos.
 *
 * A sequência de publicação (nova versão → import → liberação) e o formato do
 * anexo seguem o que o fluiglocaldev (StrategiConsultoria) usa em produção:
 * anexo `<processId>.xml`, bytes latin1 sem declaração `<?xml?>`, principal.
 */
export async function workflowEngineClient(
  baseUrl: string,
  companyId: number,
  username: string,
  password: string,
  colleagueId: string,
): Promise<WorkflowEngineClient> {
  const cliente = await fluigSoapClient(baseUrl, 'ECMWorkflowEngineService');
  const credencial = { username, password, companyId };

  return {
    async listProcessIds(): Promise<string[]> {
      const r = await invoke<{ result?: { item?: { processId?: string } | { processId?: string }[] } }>(
        cliente,
        'getAllProcessAvailableToExport',
        { ...credencial },
      );
      return itens(r?.result).map((p) => String(p.processId ?? ''));
    },

    async exportProcess(processId: string): Promise<Buffer> {
      // O formato ZIP preserva os bytes ISO-8859-1; o exportProcess (string) passa por
      // conversão de charset no caminho e pode estragar os acentos.
      const r = await invoke<{ result?: string }>(cliente, 'exportProcessInZipFormat', {
        ...credencial,
        processId,
      });
      if (typeof r?.result !== 'string' || r.result.trim() === '') {
        throw new ErroFluigctl(`o servidor não devolveu o pacote do processo "${processId}"`, 7);
      }
      return primeiroXmlDoZip(Buffer.from(r.result, 'base64'), processId);
    },

    async createVersion(processId: string): Promise<void> {
      await invoke(cliente, 'createWorkFlowProcessVersion', { ...credencial, processId });
    },

    async importProcess(processId: string, xml: Buffer, novo = false, imagem?: { nome: string; svg: Buffer }): Promise<string> {
      const anexos: Record<string, unknown>[] = [
        {
          fileName: `${processId}.xml`,
          fileSize: xml.length,
          filecontent: xml.toString('base64'),
          principal: true,
        },
      ];
      if (imagem) {
        anexos.push({
          attach: true,
          fileName: imagem.nome,
          fileSize: imagem.svg.length,
          filecontent: imagem.svg.toString('base64'),
          principal: false,
        });
      }
      const r = await invoke<{ result?: string }>(cliente, 'importProcess', {
        ...credencial,
        processId,
        attachments: { item: anexos },
        newProcess: novo,
        overWrite: !novo,
        colleagueId,
      });
      return String(r?.result ?? '');
    },

    async releaseProcess(processId: string): Promise<{ ok: boolean; mensagem: string }> {
      const r = await invoke<{ result?: string }>(cliente, 'releaseProcess', { ...credencial, processId });
      const mensagem = String(r?.result ?? '');
      return { ok: /(^|[^A-Za-z])ok=true/.test(mensagem), mensagem };
    },
  };
}
