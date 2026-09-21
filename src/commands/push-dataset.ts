import { serverUrl, type Server } from '../config.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { datasetClient } from '../fluig/dataset-service.js';
import { datasetNameFromFile, decideDataset } from '../push/dataset-resolve.js';
import { readDatasetFile } from '../push/dataset-source.js';

export interface OpcoesPushDataset {
  server: Server;
  senha: string;
  arquivo: string;
  create?: boolean;
  description?: string;
  dryRun?: boolean;
  prompt: PromptSenha;
}

export interface ResultadoPushDataset {
  nome: string;
  acao: 'create' | 'update';
  bytes: number;
}

/**
 * Sobe um dataset.
 *
 * A ordem importa: lê o catálogo (leitura), decide, passa pelo gate de
 * produção e só então escreve. Qualquer recusa acontece antes de qualquer
 * chamada que altere o servidor.
 */
export async function pushDataset(
  opcoes: OpcoesPushDataset,
): Promise<ResultadoPushDataset> {
  const { server, senha, arquivo } = opcoes;

  const nome = datasetNameFromFile(arquivo);
  const impl = readDatasetFile(arquivo);
  const bytes = Buffer.byteLength(impl, 'utf8');

  const cliente = await datasetClient(serverUrl(server), server.companyId, server.username, senha);
  const { acao } = decideDataset(nome, await cliente.listCustom(), opcoes.create ?? false);

  if (opcoes.dryRun) return { nome, acao, bytes };

  await confirmProduction(server, senha, `push dataset ${nome} (${acao})`, opcoes.prompt);

  const descricao = opcoes.description ?? nome;
  if (acao === 'create') await cliente.add(nome, descricao, impl);
  else await cliente.update(nome, descricao, impl);

  return { nome, acao, bytes };
}
