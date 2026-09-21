import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { defaultPasswordEnv } from './commands/server.js';
import { ErroFluigctl } from './errors.js';
import type { Server } from './config.js';

export interface Candidato {
  nome: string;
  servidor: Server;
  origem: string;
  /** Veio sem companyId ou userCode; precisa de um `server test` para completar. */
  precisaIdentidade: boolean;
  /** Quantos `servers.json` apontavam para este mesmo servidor. */
  referencias: number;
}

export interface ResultadoImport {
  candidatos: Candidato[];
  ignorados: string[];
}

interface EntradaVSCode {
  name?: string;
  host?: string;
  port?: number;
  ssl?: boolean;
  username?: string;
  companyId?: number;
  userCode?: string;
}

/** `Produção` → `producao`, `CETENCO HML` → `cetenco-hml` */
export function slugServidor(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Nome do projeto que contém o `.vscode/servers.json`. */
function workspaceDe(caminho: string): string {
  return slugServidor(basename(dirname(dirname(caminho))));
}

/**
 * Converte os `.vscode/servers.json` da extensão Fluiggers em candidatos.
 *
 * A senha nunca é lida: lá ela é um blob AES cifrado com o machineId do VS
 * Code, ou seja, credencial. Cada candidato aponta para uma variável de
 * ambiente, e é o usuário quem a define.
 *
 * Função pura — quem lê disco é o comando.
 */
export function importCandidates(
  arquivos: readonly { path: string; conteudo: string }[],
): ResultadoImport {
  const ignorados: string[] = [];
  const brutos: { slug: string; workspace: string; candidato: Omit<Candidato, 'nome'> }[] = [];

  for (const arquivo of arquivos) {
    let entradas: EntradaVSCode[];
    try {
      const lido = JSON.parse(arquivo.conteudo) as { configurations?: EntradaVSCode[] };
      entradas = lido.configurations ?? [];
    } catch (erro) {
      ignorados.push(`${arquivo.path}: não é JSON válido (${(erro as Error).message})`);
      continue;
    }

    if (entradas.length === 0) {
      ignorados.push(`${arquivo.path}: nenhum servidor cadastrado`);
      continue;
    }

    for (const entrada of entradas) {
      if (!entrada.name || !entrada.host || !entrada.username) {
        ignorados.push(`${arquivo.path}: entrada sem name, host ou username`);
        continue;
      }

      const ssl = entrada.ssl ?? false;
      const slug = slugServidor(entrada.name);
      const ehProducao = EH_PRODUCAO.test(entrada.name);

      brutos.push({
        slug,
        workspace: workspaceDe(arquivo.path),
        candidato: {
          origem: arquivo.path,
          referencias: 1,
          precisaIdentidade:
            entrada.companyId === undefined || entrada.userCode === undefined,
          servidor: {
            host: entrada.host,
            port: entrada.port ?? (ssl ? 443 : 80),
            ssl,
            username: entrada.username,
            companyId: entrada.companyId ?? 0,
            userCode: entrada.userCode ?? '',
            passwordEnv: '',
            ...(ehProducao ? { prod: true as const } : {}),
          },
        },
      });
    }
  }

  // Um mesmo servidor costuma aparecer em vários projetos do mesmo cliente, às
  // vezes com nomes diferentes. Identidade é host+porta+ssl+usuário; o nome é
  // só rótulo. Sem isso, o mesmo Fluig entraria quatro vezes no cadastro.
  const porIdentidade = new Map<string, (typeof brutos)[number]>();
  for (const b of brutos) {
    const s = b.candidato.servidor;
    const chave = `${s.ssl ? 'https' : 'http'}://${s.username}@${s.host}:${s.port}`;
    const existente = porIdentidade.get(chave);
    if (existente) {
      existente.candidato.referencias += 1;
      // Se qualquer referência considera produção, o servidor é produção.
      if (s.prod) (existente.candidato.servidor as { prod?: true }).prod = true;
      continue;
    }
    porIdentidade.set(chave, b);
  }

  const unicos = [...porIdentidade.values()];

  // Nomes como "Produção" repetem entre clientes. Quem colide ganha o prefixo
  // do workspace; quem não colide fica com o nome curto.
  const vezes = new Map<string, number>();
  for (const b of unicos) vezes.set(b.slug, (vezes.get(b.slug) ?? 0) + 1);

  const candidatos = unicos.map((b) => {
    const nome = (vezes.get(b.slug) ?? 0) > 1 ? `${b.workspace}-${b.slug}` : b.slug;
    return {
      nome,
      ...b.candidato,
      servidor: { ...b.candidato.servidor, passwordEnv: defaultPasswordEnv(nome) },
    };
  });

  return { candidatos, ignorados };
}

/**
 * Reconhece nome de servidor de produção.
 *
 * Inclui `prd` porque existe assim nos workspaces reais: um servidor de
 * produção que não for marcado fica sem gate, que é a falha mais cara possível
 * aqui. Na dúvida, marcar a mais — um push a menos é recuperável.
 */
const EH_PRODUCAO = /(^|[^a-z])(prod|prd)/i;

const IGNORAR = new Set(['node_modules', '.git', 'dist', 'build', 'target']);

/** Varre a árvore atrás dos `.vscode/servers.json` da extensão Fluiggers. */
export async function scanServersJson(
  raiz: string,
): Promise<{ path: string; conteudo: string }[]> {
  try {
    if (!(await stat(raiz)).isDirectory()) {
      throw new ErroFluigctl(`${raiz} não é um diretório`, 3);
    }
  } catch (erro) {
    if (erro instanceof ErroFluigctl) throw erro;
    throw new ErroFluigctl(`o diretório ${raiz} não existe`, 3);
  }

  const achados: { path: string; conteudo: string }[] = [];

  async function desce(dir: string): Promise<void> {
    const entradas = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entrada of entradas) {
      if (!entrada.isDirectory()) continue;
      if (IGNORAR.has(entrada.name)) continue;

      const caminho = join(dir, entrada.name);

      if (entrada.name === '.vscode') {
        const arquivo = join(caminho, 'servers.json');
        const conteudo = await readFile(arquivo, 'utf8').catch(() => null);
        if (conteudo !== null) achados.push({ path: arquivo, conteudo });
        continue;
      }

      await desce(caminho);
    }
  }

  await desce(raiz);
  return achados.sort((a, b) => a.path.localeCompare(b.path));
}
