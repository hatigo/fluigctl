import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { consultarDataset } from '../fluig/dataset-rest.js';
import { login } from '../fluig/session.js';
import { workflowEngineClient } from '../fluig/workflow-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';

/**
 * Versões de um processo: quais existem, qual roda (liberada) e quais ficaram
 * em edição — o que sobra de um push cuja liberação falhou. Não há operação de
 * descartar versão no SOAP do Fluig; liberar a que está em edição, sim.
 *
 * A lista vem do dataset interno `processDefinitionVersion` (o painel do Fluig
 * lê dali): `active` diz que a versão pode rodar e `editionMode` que ainda está
 * em edição. A que roda é a maior ativa fora de edição.
 */

export interface VersaoProcesso {
  versao: number;
  emEdicao: boolean;
  ativa: boolean;
  bloqueada: boolean;
  /** A versão que novas solicitações usam. */
  emUso: boolean;
}

export interface OpcoesVersoes {
  server: Server;
  senha: string;
  prompt: PromptSenha;
  /** Para testes: as linhas do dataset, sem servidor. */
  linhas?: Record<string, unknown>[];
  /** Para testes. */
  liberar?: (processId: string) => Promise<{ ok: boolean; mensagem: string }>;
}

async function linhasDoDataset(o: OpcoesVersoes, processId: string): Promise<Record<string, unknown>[]> {
  if (o.linhas) return o.linhas;
  const url = serverUrl(o.server);
  const cookie = await login(url, o.server.username, o.senha);
  const r = await consultarDataset(url, cookie, {
    nome: 'processDefinitionVersion',
    restricoes: [{ campo: 'processDefinitionVersionPK.processId', inicial: processId, final: processId, tipo: 1 }],
  });
  return r?.linhas ?? [];
}

export async function versoesDoProcesso(o: OpcoesVersoes, processId: string): Promise<VersaoProcesso[]> {
  const linhas = await linhasDoDataset(o, processId);
  const versoes = linhas
    .filter((l) => l['processDefinitionVersionPK.processId'] === processId)
    .map((l) => ({
      versao: Number(l['processDefinitionVersionPK.version']),
      emEdicao: l['editionMode'] === true,
      ativa: l['active'] === true,
      bloqueada: l['blockedVersion'] === true,
      emUso: false,
    }))
    .filter((v) => Number.isInteger(v.versao))
    .sort((a, b) => a.versao - b.versao);
  const emUso = [...versoes].reverse().find((v) => v.ativa && !v.emEdicao);
  if (emUso) emUso.emUso = true;
  return versoes;
}

/** Libera a versão em edição do processo (a mais nova). */
export async function liberarVersao(
  o: OpcoesVersoes,
  processId: string,
  dryRun = false,
): Promise<{ versao: number; liberada: boolean; mensagem?: string }> {
  const versoes = await versoesDoProcesso(o, processId);
  if (versoes.length === 0) throw new ErroFluigctl(`o processo "${processId}" não existe em ${serverUrl(o.server)}`, 6);
  const ultima = versoes.at(-1)!;
  if (!ultima.emEdicao) throw new ErroFluigctl(`a versão mais nova de "${processId}" (${ultima.versao}) não está em edição: não há o que liberar`, 6);
  if (dryRun) return { versao: ultima.versao, liberada: false };
  await confirmProduction(o.server, o.senha, `liberar a versão ${ultima.versao} de ${processId}`, o.prompt);
  const liberar =
    o.liberar ??
    (async (id: string) =>
      (await workflowEngineClient(serverUrl(o.server), o.server.companyId, o.server.username, o.senha, o.server.userCode ?? o.server.username)).releaseProcess(id));
  const r = await liberar(processId);
  if (!r.ok) {
    throw new ErroFluigctl(
      `o servidor não liberou a versão ${ultima.versao} de "${processId}": ${r.mensagem.slice(0, 400)}`,
      7,
    );
  }
  return { versao: ultima.versao, liberada: true, mensagem: r.mensagem };
}
