import { serverUrl, type Server } from '../config.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { datasetClient, loadDataset } from '../fluig/dataset-service.js';
import { login } from '../fluig/session.js';
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
  /** Num update: o código do servidor já era igual ao local (antes de enviar). */
  jaIgual?: boolean;
  /** Onde ficou a cópia do código que estava no servidor antes do update. */
  backup?: string;
  /** Depois de enviar: o servidor devolve exatamente o código local. */
  conferido?: boolean;
}

/** Pasta das cópias: `$XDG_STATE_HOME/fluigctl/backups`, ou `~/.local/state/...`. */
export function pastaBackups(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state'), 'fluigctl', 'backups');
}

function normaliza(codigo: string): string {
  return codigo.replace(/\r\n/g, '\n');
}

function gravaBackup(host: string, nome: string, impl: string): string {
  const pasta = join(pastaBackups(), host, 'datasets');
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const quando = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivo = join(pasta, `${nome}.${quando}.js`);
  writeFileSync(arquivo, impl, 'utf8');
  return arquivo;
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

  const url = serverUrl(server);
  const cliente = await datasetClient(url, server.companyId, server.username, senha);
  const { acao } = decideDataset(nome, await cliente.listCustom(), opcoes.create ?? false);

  // Num update, o que está no servidor serve três vezes: preservar a descrição, guardar uma
  // cópia antes de sobrescrever e dizer, já na simulação, se há algo a enviar.
  const cookie = acao === 'update' ? await login(url, server.username, senha) : undefined;
  const atual = cookie ? await loadDataset(url, cookie, nome) : {};
  const jaIgual = atual.impl === undefined ? undefined : normaliza(atual.impl) === normaliza(impl);

  if (opcoes.dryRun) return { nome, acao, bytes, ...(jaIgual === undefined ? {} : { jaIgual }) };

  await confirmProduction(server, senha, `push dataset ${nome} (${acao})`, opcoes.prompt);

  // O web service grava a descrição que receber: o default ingênuo apagaria a do cliente.
  const descricao = opcoes.description ?? atual.description ?? nome;
  const backup = atual.impl !== undefined && !jaIgual ? gravaBackup(server.host, nome, atual.impl) : undefined;

  if (acao === 'create') await cliente.add(nome, descricao, impl);
  else await cliente.update(nome, descricao, impl);

  // Prova pelo conteúdo: o que o servidor devolve agora é o arquivo local.
  const depois = await loadDataset(url, cookie ?? (await login(url, server.username, senha)), nome);
  const conferido = depois.impl === undefined ? undefined : normaliza(depois.impl) === normaliza(impl);

  return {
    nome,
    acao,
    bytes,
    ...(jaIgual === undefined ? {} : { jaIgual }),
    ...(backup === undefined ? {} : { backup }),
    ...(conferido === undefined ? {} : { conferido }),
  };
}
