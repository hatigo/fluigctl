import { createClientAsync, type Client } from 'soap';

import { ErroFluigctl } from '../errors.js';

/**
 * Cria um cliente SOAP para um serviço do Fluig.
 *
 * O endpoint é sempre forçado para o servidor alvo: o `soap:address` publicado
 * no WSDL aponta para o host que gerou o arquivo, e confiar nele faria um push
 * destinado a um servidor chegar em outro.
 */
export async function fluigSoapClient(
  baseUrl: string,
  servico:
    | 'ECMDatasetService'
    | 'ECMCardIndexService'
    | 'ECMWorkflowEngineService'
    | 'ECMGlobalParamService'
    | 'ECMBusinessPeriodService'
    | 'ECMGroupService'
    | 'ECMColleagueGroupService',
): Promise<Client> {
  const endpoint = `${baseUrl}/webdesk/${servico}`;
  const cliente = await createClientAsync(`${endpoint}?wsdl`, { endpoint });
  cliente.setEndpoint(endpoint);
  return cliente;
}

/**
 * Invoca uma operação e devolve o primeiro elemento da resposta.
 *
 * Confere antes se a operação existe e quais parâmetros ela aceita, para que um
 * servidor com versão de Fluig diferente produza uma mensagem precisa em vez de
 * um HTTP 500 opaco. Nenhuma mensagem de erro carrega os argumentos, porque
 * entre eles vai a senha.
 */
export async function invoke<T>(
  cliente: Client,
  operacao: string,
  argumentos: Record<string, unknown>,
): Promise<T> {
  const metodo = (cliente as unknown as Record<string, unknown>)[`${operacao}Async`];
  if (typeof metodo !== 'function') {
    throw new ErroFluigctl(
      `este servidor não expõe a operação "${operacao}". ` +
        `Pode ser uma versão de Fluig incompatível.`,
      7,
    );
  }

  try {
    const [resultado] = (await (
      metodo as (a: unknown) => Promise<unknown[]>
    ).call(cliente, argumentos)) as [T];
    return resultado;
  } catch (erro) {
    throw new ErroFluigctl(`o servidor recusou "${operacao}": ${resumoErro(erro)}`, 7);
  }
}

/** Extrai só a mensagem do erro — nunca o envelope, que contém a senha. */
function resumoErro(erro: unknown): string {
  const e = erro as { root?: unknown; message?: string };
  const fault = (e.root as { Envelope?: { Body?: { Fault?: { faultstring?: string } } } })
    ?.Envelope?.Body?.Fault?.faultstring;
  if (typeof fault === 'string' && fault.length > 0) return fault;
  const primeiraLinha = (e.message ?? String(erro)).split('\n')[0] ?? '';
  return primeiraLinha.slice(0, 300);
}

/**
 * Normaliza um `*Array` do Fluig para lista.
 *
 * O node-soap devolve `item` como array quando há vários elementos e como
 * objeto quando há um só — e omite o campo quando não há nenhum.
 */
export function itens<T>(array: { item?: T | T[] } | undefined | null): T[] {
  const item = array?.item;
  if (item === undefined || item === null) return [];
  return Array.isArray(item) ? item : [item];
}
