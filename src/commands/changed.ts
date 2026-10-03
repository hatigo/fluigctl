import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErroFluigctl } from '../errors.js';

/**
 * O que mudou no git, traduzido em artefatos do Fluig e no comando que publica
 * cada um. Só lê: nada é enviado, e os comandos saem um por artefato — publicar
 * em lote é como a skill publicar-fluig sobrescreveu 7 eventos do Boletim de
 * Medição em homologação.
 */

export type Artefato =
  | { tipo: 'dataset'; nome: string; arquivo: string }
  | { tipo: 'form'; pasta: string; camposNovos: string[]; htmlNovo: boolean }
  | { tipo: 'process'; processId: string; eventos: string[] }
  | { tipo: 'diagram'; arquivo: string }
  | { tipo: 'widget'; pasta: string }
  | { tipo: 'nao-suportado'; arquivo: string; motivo: string };

function git(raiz: string, args: string[]): string {
  return execFileSync('git', ['-C', raiz, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function raizDoRepositorio(dir: string): string {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new ErroFluigctl(`${dir} não está num repositório git`, 3);
  }
}

/** Arquivos alterados: desde `desde` (commit/branch), ou o working tree + não versionados. */
export function arquivosAlterados(raiz: string, desde?: string): string[] {
  const nomes = new Set<string>();
  const linhas = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

  try {
    if (desde) {
      for (const f of linhas(git(raiz, ['diff', '--name-only', `${desde}...HEAD`]))) nomes.add(f);
    }
    for (const f of linhas(git(raiz, ['diff', '--name-only', 'HEAD']))) nomes.add(f);
    for (const f of linhas(git(raiz, ['ls-files', '--others', '--exclude-standard']))) nomes.add(f);
  } catch (erro) {
    throw new ErroFluigctl(`git recusou a comparação: ${(erro as Error).message.split('\n')[0]}`, 3);
  }

  return [...nomes].sort();
}

/** Os `name="..."` de um HTML de formulário. */
export function camposDoHtml(html: string): Set<string> {
  const campos = new Set<string>();
  for (const m of html.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)) campos.add(m[1]!);
  return campos;
}

/**
 * Campo novo exige nova versão do formulário: com --keep-version o servidor
 * recusa ("O formulário possui alterações na estrutura e precisa ter a versão
 * alterada", medido no HML da Cetenco) ou, em outras versões, o campo não grava.
 */
function camposNovos(raiz: string, pasta: string, base: string): { campos: string[]; htmlNovo: boolean } {
  const principal = join(pasta, `${pasta.split('/').pop()}.html`);
  const caminho = join(raiz, principal);
  if (!existsSync(caminho)) return { campos: [], htmlNovo: false };

  let anterior: string;
  try {
    anterior = git(raiz, ['show', `${base}:${principal}`]);
  } catch {
    return { campos: [], htmlNovo: true };
  }

  const antes = camposDoHtml(anterior);
  const agora = camposDoHtml(readFileSync(caminho, 'utf8'));
  return { campos: [...agora].filter((c) => !antes.has(c)).sort(), htmlNovo: false };
}

export function classificar(raiz: string, arquivos: readonly string[], base: string): Artefato[] {
  const datasets = new Map<string, Artefato>();
  const forms = new Set<string>();
  const processos = new Map<string, Set<string>>();
  const widgets = new Set<string>();
  const outros: Artefato[] = [];

  for (const arquivo of arquivos) {
    const partes = arquivo.split('/');

    if (partes[0] === 'datasets' && arquivo.endsWith('.js')) {
      const nome = partes.at(-1)!.replace(/\.js$/, '');
      datasets.set(nome, { tipo: 'dataset', nome, arquivo });
    } else if (partes[0] === 'forms' && partes.length >= 3) {
      if (partes.at(-1) !== '.metadata') forms.add(`forms/${partes[1]}`);
    } else if (partes[0] === 'workflow' && partes[1] === 'scripts' && partes.length === 3) {
      const m = /^(.+)\.([^.]+)\.js$/.exec(partes[2]!);
      if (m) {
        const eventos = processos.get(m[1]!) ?? new Set<string>();
        eventos.add(m[2]!);
        processos.set(m[1]!, eventos);
      }
    } else if (partes[0] === 'workflow' && (arquivo.endsWith('.process') || arquivo.endsWith('.ecm30.xml'))) {
      outros.push({ tipo: 'diagram', arquivo });
    } else if (partes[0] === 'wcm' && partes[1] === 'widget' && partes.length >= 4) {
      widgets.add(`wcm/widget/${partes[2]}`);
    } else if (['events', 'mechanisms'].includes(partes[0]!) || (partes[0] === 'wcm' && partes[1] === 'layout')) {
      outros.push({
        tipo: 'nao-suportado',
        arquivo,
        motivo: 'evento global, mecanismo e layout ainda não são publicados pelo fluigctl',
      });
    }
  }

  return [
    ...[...datasets.values()],
    ...[...forms].sort().map((pasta): Artefato => {
      const { campos, htmlNovo } = camposNovos(raiz, pasta, base);
      return { tipo: 'form', pasta, camposNovos: campos, htmlNovo };
    }),
    ...[...processos].map(([processId, eventos]): Artefato => ({
      tipo: 'process',
      processId,
      eventos: [...eventos].sort(),
    })),
    ...[...widgets].sort().map((pasta): Artefato => ({ tipo: 'widget', pasta })),
    ...outros,
  ];
}

export function changedArtifacts(dir: string, desde?: string): { raiz: string; artefatos: Artefato[] } {
  const raiz = raizDoRepositorio(dir);
  return { raiz, artefatos: classificar(raiz, arquivosAlterados(raiz, desde), desde ?? 'HEAD') };
}

/** O comando sugerido para cada artefato, um por linha. */
export function comandoSugerido(a: Artefato, servidor: string): string {
  const s = `--server ${servidor}`;
  switch (a.tipo) {
    case 'dataset':
      return `fluigctl push dataset ${a.arquivo} ${s} --dry-run`;
    case 'form': {
      const versao = a.camposNovos.length > 0 || a.htmlNovo ? '--new-version' : '--keep-version';
      return `fluigctl push form ${a.pasta}/ ${s} ${versao} --dry-run`;
    }
    case 'process':
      return `fluigctl push process ${a.processId} ${s} --dry-run`;
    case 'widget':
      return `fluigctl push widget ${a.pasta} ${s} --dry-run`;
    case 'diagram':
      return `# ${a.arquivo}: diagrama — pelo Studio, ou export do servidor + push process --base`;
    case 'nao-suportado':
      return `# ${a.arquivo}: ${a.motivo}`;
  }
}
