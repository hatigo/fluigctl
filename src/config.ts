import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ErroFluigctl } from './errors.js';
import { avisoGit, garantirIgnorado } from './gitignore.js';
import { machineIds, senhaNosArquivos, serversJsonAcima } from './vscode-credentials.js';

export interface Server {
  host: string;
  port: number;
  ssl: boolean;
  username: string;
  companyId: number;
  userCode: string;
  passwordEnv: string;
  prod?: boolean;
}

export interface Config {
  version: 1;
  servers: Record<string, Server>;
}

export function resolveServer(config: Config, name: string): Server {
  const server = config.servers[name];
  if (!server) {
    const known = Object.keys(config.servers);
    const lista = known.length ? known.join(', ') : '(nenhum cadastrado)';
    throw new ErroFluigctl(
      `servidor "${name}" não está cadastrado. Disponíveis: ${lista}`,
      3,
    );
  }
  return server;
}

/** Arquivo opcional de senhas, ao lado do servers.json. */
export function envFilePath(): string {
  return join(dirname(configPath()), 'env');
}

/**
 * Lê uma linha `NOME=valor` de um arquivo no formato de ambiente de shell.
 * Aceita `export`, aspas simples, duplas ou nenhuma.
 */
function leDoArquivo(caminho: string, nome: string): string | undefined {
  let conteudo: string;
  try {
    const modo = statSync(caminho).mode & 0o077;
    if (modo !== 0) {
      console.error(
        `fluigctl: ${caminho} contém senha e está acessível a outros usuários. ` +
          `Corrija com: chmod 600 ${caminho}`,
      );
    }
    conteudo = readFileSync(caminho, 'utf8');
  } catch {
    return undefined;
  }

  for (const linha of conteudo.split('\n')) {
    const limpa = linha.trim().replace(/^export\s+/, '');
    if (limpa === '' || limpa.startsWith('#')) continue;

    const igual = limpa.indexOf('=');
    if (igual === -1) continue;
    if (limpa.slice(0, igual).trim() !== nome) continue;

    const valor = limpa.slice(igual + 1).trim();
    const aspas = valor[0];
    return aspas === "'" || aspas === '"'
      ? valor.slice(1, valor.lastIndexOf(aspas))
      : valor;
  }

  return undefined;
}

/** Onde procurar o `.vscode/servers.json` da extensão; `false` desliga a busca. */
export type OpcoesVscode = false | { inicio: string; home: string };

function vscodePadrao(): OpcoesVscode {
  if (process.env['FLUIGCTL_NO_VSCODE'] === '1') return false;
  return { inicio: process.cwd(), home: homedir() };
}

/**
 * Descobre a senha do servidor.
 *
 * Nesta ordem: a variável de ambiente; o arquivo de senhas do fluigctl; e o
 * `.vscode/servers.json` da extensão Fluiggers, da pasta atual para cima, com a
 * senha decifrada pela chave desta máquina. Quem lê é sempre o CLI — a senha não
 * passa por quem invoca o comando, e nada aqui a imprime.
 *
 * Ao usar o servers.json, garante que ele está no .gitignore do repositório e
 * sugere copiar a senha para o arquivo próprio (`server import --with-passwords`).
 */
export function resolvePassword(
  server: Server,
  envPath = envFilePath(),
  vscode: OpcoesVscode = vscodePadrao(),
): string {
  const doAmbiente = process.env[server.passwordEnv];
  if (doAmbiente) return doAmbiente;

  const doArquivo = leDoArquivo(envPath, server.passwordEnv);
  if (doArquivo) return doArquivo;

  if (vscode) {
    const achada = senhaNosArquivos(server, serversJsonAcima(vscode.inicio), machineIds(vscode.home));
    if (achada) {
      console.error(
        `fluigctl: senha de ${server.username}@${server.host} lida de ${achada.origem} (extensão Fluiggers). ` +
          `Para não depender dele: fluigctl server import <dir> --write --with-passwords`,
      );
      const aviso = avisoGit(achada.origem, garantirIgnorado(achada.origem));
      if (aviso) console.error(`fluigctl: ${aviso}`);
      return achada.senha;
    }
  }

  throw new ErroFluigctl(
    `não encontrei a senha de ${server.username}: a variável ` +
      `${server.passwordEnv} não está definida, ${envPath} não a contém` +
      (vscode
        ? ` e nenhum .vscode/servers.json de ${vscode.inicio} para cima tem este servidor ` +
          `com uma senha que esta máquina decifre.`
        : '.'),
    4,
  );
}

export function serverUrl(server: Server): string {
  const scheme = server.ssl ? 'https' : 'http';
  const padrao = server.ssl ? 443 : 80;
  const porta = server.port === padrao ? '' : `:${server.port}`;
  return `${scheme}://${server.host}${porta}`;
}

export function configPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'fluigctl', 'servers.json');
}

export function loadConfig(path: string = configPath()): Config {
  let bruto: string;
  try {
    bruto = readFileSync(path, 'utf8');
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, servers: {} };
    }
    throw erro;
  }

  try {
    const lido = JSON.parse(bruto) as Config;
    return { version: 1, servers: lido.servers ?? {} };
  } catch (erro) {
    throw new ErroFluigctl(`${path} não é JSON válido: ${(erro as Error).message}`, 3);
  }
}

export function saveConfig(config: Config, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}
