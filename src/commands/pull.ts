import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { loadDataset, type DatasetNoServidor } from '../fluig/dataset-service.js';
import { login } from '../fluig/session.js';
import { workflowEngineClient, type WorkflowEngineClient } from '../fluig/workflow-service.js';
import { eventosDoProcesso, normalizar } from '../push/process-events.js';
import { prefixoDosScripts } from '../push/process-source.js';

/**
 * Baixa do servidor o que está publicado — o caminho inverso do push. Nunca
 * sobrescreve em silêncio: arquivo novo é gravado, igual fica como está, e
 * arquivo local diferente do servidor só é trocado com `--overwrite`. Sem ele, se
 * algum diferir, nada é gravado (código 6): gravar parte e parar deixaria a
 * pasta numa mistura difícil de entender. Só lê do servidor.
 */

export interface ArquivoBaixado {
  /** Caminho relativo à pasta de trabalho. */
  caminho: string;
  conteudo: string;
}

export interface ResultadoPull {
  novos: string[];
  iguais: string[];
  /** Locais diferentes do servidor: sobrescritos só com `--overwrite`. */
  diferentes: string[];
  gravados: string[];
}

/** Compara com o disco e, se puder, grava. A comparação é a do push (fim de linha, "?" fora do latin1). */
export function aplicarPull(
  raiz: string,
  arquivos: readonly ArquivoBaixado[],
  opcoes: { dryRun?: boolean; sobrescrever?: boolean },
): ResultadoPull {
  const novos: string[] = [];
  const iguais: string[] = [];
  const diferentes: string[] = [];
  for (const a of arquivos) {
    const caminho = resolve(raiz, a.caminho);
    if (!existsSync(caminho)) novos.push(a.caminho);
    else if (normalizar(readFileSync(caminho, 'utf8')) === normalizar(a.conteudo)) iguais.push(a.caminho);
    else diferentes.push(a.caminho);
  }

  const gravados: string[] = [];
  if (opcoes.dryRun) return { novos, iguais, diferentes, gravados };
  if (diferentes.length > 0 && !opcoes.sobrescrever) {
    throw new ErroFluigctl(
      `estes arquivos locais diferem do servidor e não foram tocados — nada foi gravado:\n  ` +
        diferentes.join('\n  ') +
        '\nConfira a diferença (o --dry-run lista) e rode de novo com --overwrite para trazer a versão do servidor.',
      6,
    );
  }
  for (const a of arquivos) {
    if (iguais.includes(a.caminho)) continue;
    const caminho = resolve(raiz, a.caminho);
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, a.conteudo.endsWith('\n') ? a.conteudo : `${a.conteudo}\n`, 'utf8');
    gravados.push(a.caminho);
  }
  return { novos, iguais, diferentes, gravados };
}

export interface OpcoesPullProcess {
  server: Server;
  senha: string;
  processId: string;
  /** Pasta `workflow` do repositório (padrão: `workflow`). */
  pastaWorkflow: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: WorkflowEngineClient;
}

/**
 * Scripts de um processo: os `WorkflowProcessEvent` da definição publicada, em
 * `<workflow>/scripts/<prefixo>.<eventId>.js` — com o prefixo do push process (o
 * nome do `.process` local com este id, ou o próprio id).
 */
export async function pullProcess(opcoes: OpcoesPullProcess): Promise<ResultadoPull & { prefixo: string }> {
  const { server, senha, processId } = opcoes;
  const cliente =
    opcoes.cliente ??
    (await workflowEngineClient(serverUrl(server), server.companyId, server.username, senha, server.userCode));
  if (!(await cliente.listProcessIds()).includes(processId)) {
    throw new ErroFluigctl(`o processo "${processId}" não existe em ${serverUrl(server)}`, 3);
  }
  const definicao = (await cliente.exportProcess(processId)).toString('latin1');
  const { prefixo } = await prefixoDosScripts(opcoes.pastaWorkflow, processId);
  const pastaScripts = join(opcoes.pastaWorkflow, 'scripts');
  const arquivos = eventosDoProcesso(definicao)
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    .map((e) => ({ caminho: join(pastaScripts, `${prefixo}.${e.eventId}.js`), conteudo: e.codigo }));
  return { ...aplicarPull('.', arquivos, opcoes), prefixo };
}

export interface OpcoesPullDataset {
  server: Server;
  senha: string;
  nome: string;
  /** Raiz do repositório (padrão: a pasta atual). */
  raiz?: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  carregar?: (nome: string) => Promise<DatasetNoServidor>;
}

/** Os `datasets/**\/<nome>.js` do repositório. */
function datasetsLocais(raiz: string, nome: string): string[] {
  const achados: string[] = [];
  const visitar = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const caminho = join(dir, entrada);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (entrada === `${nome}.js`) achados.push(relative(raiz, caminho));
    }
  };
  if (existsSync(join(raiz, 'datasets'))) visitar(join(raiz, 'datasets'));
  return achados.sort();
}

/**
 * Código de um dataset, no arquivo que o repositório já tem para ele
 * (`datasets/**\/<nome>.js`) ou, sem nenhum, em `datasets/<nome>.js`. Dois
 * arquivos com o nome: recusa, por não saber qual é.
 */
export async function pullDataset(opcoes: OpcoesPullDataset): Promise<ResultadoPull & { arquivo: string }> {
  const raiz = opcoes.raiz ?? '.';
  const locais = datasetsLocais(raiz, opcoes.nome);
  if (locais.length > 1) {
    throw new ErroFluigctl(`mais de um arquivo para o dataset "${opcoes.nome}": ${locais.join(', ')}`, 6);
  }
  const carregar =
    opcoes.carregar ??
    (async (nome: string) => {
      const url = serverUrl(opcoes.server);
      return loadDataset(url, await login(url, opcoes.server.username, opcoes.senha), nome);
    });
  const noServidor = await carregar(opcoes.nome);
  if (noServidor.impl === undefined) {
    throw new ErroFluigctl(`o dataset "${opcoes.nome}" não existe em ${serverUrl(opcoes.server)} (ou não é customizado)`, 3);
  }
  if (noServidor.tipo !== undefined && noServidor.tipo !== 'CUSTOM') {
    throw new ErroFluigctl(`o dataset "${opcoes.nome}" é ${noServidor.tipo}, não customizado: não tem código JavaScript para baixar`, 6);
  }
  const arquivo = locais[0] ?? join('datasets', `${opcoes.nome}.js`);
  return { ...aplicarPull(raiz, [{ caminho: arquivo, conteudo: noServidor.impl }], opcoes), arquivo };
}
