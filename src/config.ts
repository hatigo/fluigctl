import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ErroFluigctl } from './errors.js';

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

export function resolvePassword(server: Server): string {
  const senha = process.env[server.passwordEnv];
  if (!senha) {
    throw new ErroFluigctl(
      `a variável de ambiente ${server.passwordEnv} não está definida. ` +
        `Defina-a com a senha de ${server.username} antes de usar este servidor.`,
      4,
    );
  }
  return senha;
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
