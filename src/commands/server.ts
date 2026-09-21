import { serverUrl, type Config, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';

export type EntradaServidor = Omit<Server, 'passwordEnv'> & { passwordEnv?: string };

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** `cetenco-prod` → `FLUIG_CETENCO_PROD_PASSWORD` */
export function defaultPasswordEnv(nome: string): string {
  return `FLUIG_${nome.toUpperCase().replace(/-/g, '_')}_PASSWORD`;
}

export function addServer(
  config: Config,
  nome: string,
  entrada: EntradaServidor,
): Config {
  if (!SLUG.test(nome)) {
    throw new ErroFluigctl(
      `nome de servidor inválido: "${nome}". ` +
        `Use minúsculas, números e hífen (ex.: cetenco-prod).`,
      2,
    );
  }
  if (config.servers[nome]) {
    throw new ErroFluigctl(`o servidor "${nome}" já existe. Remova-o antes de recadastrar.`, 2);
  }

  // Campo a campo, de propósito: garante que nada além do esperado — uma senha,
  // por exemplo — entre no arquivo de config.
  const servidor: Server = {
    host: entrada.host,
    port: entrada.port,
    ssl: entrada.ssl,
    username: entrada.username,
    companyId: entrada.companyId,
    userCode: entrada.userCode,
    passwordEnv: entrada.passwordEnv ?? defaultPasswordEnv(nome),
    ...(entrada.prod ? { prod: true } : {}),
  };

  return { version: 1, servers: { ...config.servers, [nome]: servidor } };
}

export function removeServer(config: Config, nome: string): Config {
  if (!config.servers[nome]) {
    throw new ErroFluigctl(`o servidor "${nome}" não está cadastrado.`, 3);
  }
  const servers = { ...config.servers };
  delete servers[nome];
  return { version: 1, servers };
}

export function listServers(config: Config): string {
  const nomes = Object.keys(config.servers).sort();
  if (nomes.length === 0) {
    return 'nenhum servidor cadastrado. Use "fluigctl server add" ou "fluigctl server import".';
  }

  const larguraNome = Math.max(...nomes.map((n) => n.length));
  return nomes
    .map((nome) => {
      const s = config.servers[nome]!;
      const marca = s.prod ? '  PRODUÇÃO' : '';
      return (
        `${nome.padEnd(larguraNome)}  ${serverUrl(s)}  ` +
        `${s.username}  ${s.passwordEnv}${marca}`
      );
    })
    .join('\n');
}

export function setProd(config: Config, nome: string, prod: boolean): Config {
  const servidor = config.servers[nome];
  if (!servidor) {
    throw new ErroFluigctl(`o servidor "${nome}" não está cadastrado.`, 3);
  }

  const { prod: _atual, ...resto } = servidor;
  return {
    version: 1,
    servers: { ...config.servers, [nome]: { ...resto, ...(prod ? { prod: true } : {}) } },
  };
}
