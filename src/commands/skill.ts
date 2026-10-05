import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErroFluigctl } from '../errors.js';

/**
 * A skill que ensina um agente a publicar com o `fluigctl` mora neste
 * repositório (`skills/fluig-deploy/`), e não num repositório de skills à parte.
 *
 * O motivo é o que aconteceu antes: a skill num repositório separado ficou
 * parada enquanto o CLI andava, e passou a mandar usar o Fluig Studio em
 * diagramas que já publicavam. Aqui as duas são a mesma versão por construção.
 *
 * Este módulo põe a skill onde os agentes procuram. Copiar é o que um arquivo
 * pede; **linkar** é melhor para este caso, porque `git pull` no repositório
 * atualiza o que o agente lê. O padrão é o link.
 */

const NOME = 'fluig-deploy';

/** Onde um agente procura skill: a convenção entre agentes e o Claude Code. */
export function locaisDeSkill(home = homedir()): string[] {
  return [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')];
}

/** A raiz do pacote instalado: `dist/src/commands/skill.js` sobe três níveis. */
export function raizDoPacote(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** A pasta da skill dentro do pacote. `raiz` existe para o teste apontar outro lugar. */
export function origemDaSkill(raiz = raizDoPacote()): string {
  const caminho = join(raiz, 'skills', NOME);
  if (!existsSync(join(caminho, 'SKILL.md'))) {
    throw new ErroFluigctl(
      `não achei a skill em ${caminho} — o pacote está incompleto (ou foi instalado sem a pasta skills/).`,
      3,
    );
  }
  return caminho;
}

export type Como = 'link' | 'copia';

export interface Estado {
  /** Pasta onde a skill ficaria (`<dir>/fluig-deploy`). */
  destino: string;
  /** A pasta de skills do agente existe? */
  pastaExiste: boolean;
  instalada: boolean;
  como?: Como | undefined;
  /** O que está instalado é nosso (link para o repositório, ou cópia igual)? */
  nossa?: boolean | undefined;
  /** Cópia nossa com conteúdo diferente do atual: precisa reinstalar. */
  desatualizada?: boolean | undefined;
}

function ehLinkParaNosso(destino: string, origem: string): boolean {
  try {
    if (!lstatSync(destino).isSymbolicLink()) return false;
    return resolve(dirname(destino), readlinkSync(destino)) === origem;
  } catch {
    return false;
  }
}

function mesmaSkill(destino: string, origem: string): boolean {
  try {
    return readFileSync(join(destino, 'SKILL.md'), 'utf8') === readFileSync(join(origem, 'SKILL.md'), 'utf8');
  } catch {
    return false;
  }
}

/**
 * O que está instalado é uma `fluig-deploy`?
 *
 * É assim que uma cópia (não um link) se identifica como nossa. O spec de
 * skills exige que o `name` do frontmatter seja único, então um diretório que
 * se declara `fluig-deploy` **é** esta skill — e atualizá-la é o que reinstalar
 * significa. Sem isso, uma cópia que envelheceu passaria a ser tratada como
 * coisa de outra pessoa, e o `install` recusaria atualizá-la.
 */
function declaraOFluigctl(destino: string): boolean {
  try {
    const texto = readFileSync(join(destino, 'SKILL.md'), 'utf8');
    return new RegExp(`^name:[ \\t]*${NOME}[ \\t]*$`, 'm').test(texto);
  } catch {
    return false;
  }
}

export function estadoEm(dir: string, origem = origemDaSkill()): Estado {
  const destino = join(dir, NOME);
  if (!existsSync(destino)) return { destino, pastaExiste: existsSync(dir), instalada: false };
  const link = ehLinkParaNosso(destino, origem);
  if (link) return { destino, pastaExiste: true, instalada: true, como: 'link', nossa: true };

  if (!existsSync(join(destino, 'SKILL.md'))) return { destino, pastaExiste: true, instalada: false };
  const igual = mesmaSkill(destino, origem);
  const nossa = igual || declaraOFluigctl(destino);
  return { destino, pastaExiste: true, instalada: true, como: 'copia', nossa, desatualizada: nossa && !igual };
}

export function estado(home = homedir(), origem = origemDaSkill()): Estado[] {
  return locaisDeSkill(home).map((dir) => estadoEm(dir, origem));
}

export interface OpcoesInstalar {
  /** Onde instalar; sem isso, na convenção entre agentes e no Claude Code, se existir. */
  dir?: string;
  /** Copiar em vez de linkar. */
  copiar?: boolean;
  /** Sobrepor uma skill que não é nossa. */
  forcar?: boolean;
  dryRun?: boolean;
  home?: string;
  origem?: string;
}

export interface ResultadoInstalar {
  feito: { destino: string; como: Como; acao: 'instalada' | 'atualizada' | 'ja estava' }[];
  recusados: { destino: string; motivo: string }[];
}

/** Sem `--dir`, instala na convenção entre agentes e onde o Claude Code já tem pasta. */
function destinos(opcoes: OpcoesInstalar, home: string): string[] {
  if (opcoes.dir !== undefined) return [resolve(opcoes.dir)];
  const [convencao, claude] = locaisDeSkill(home);
  return [convencao!, ...(existsSync(claude!) ? [claude!] : [])];
}

export function instalarSkill(opcoes: OpcoesInstalar = {}): ResultadoInstalar {
  const home = opcoes.home ?? homedir();
  const origem = opcoes.origem ?? origemDaSkill();
  const resultado: ResultadoInstalar = { feito: [], recusados: [] };

  for (const dir of destinos(opcoes, home)) {
    const antes = estadoEm(dir, origem);
    if (antes.instalada && antes.nossa !== true && !opcoes.forcar) {
      // Não sobrescreve o que não é nosso: pode ser a skill de outra pessoa.
      resultado.recusados.push({
        destino: antes.destino,
        motivo: 'já existe uma skill com este nome, e não foi o fluigctl que a pôs (use --force para sobrepor)',
      });
      continue;
    }
    const como: Como = opcoes.copiar ? 'copia' : 'link';
    if (antes.instalada && antes.como === como && antes.nossa === true && !antes.desatualizada) {
      resultado.feito.push({ destino: antes.destino, como, acao: 'ja estava' });
      continue;
    }

    if (!opcoes.dryRun) {
      // Link se apaga com unlink; cópia é diretório, e precisa de rm recursivo.
      if (antes.instalada) {
        if (antes.como === 'link') unlinkSync(antes.destino);
        else rmSync(antes.destino, { recursive: true, force: true });
      }
      mkdirSync(dirname(antes.destino), { recursive: true });
      if (como === 'link') symlinkSync(origem, antes.destino, 'dir');
      else {
        mkdirSync(antes.destino, { recursive: true });
        writeFileSync(join(antes.destino, 'SKILL.md'), readFileSync(join(origem, 'SKILL.md')));
      }
    }
    resultado.feito.push({ destino: antes.destino, como, acao: antes.instalada ? 'atualizada' : 'instalada' });
  }

  return resultado;
}

export interface OpcoesRemover {
  dir?: string;
  dryRun?: boolean;
  home?: string;
  origem?: string;
}

export function removerSkill(opcoes: OpcoesRemover = {}): { removidos: string[]; recusados: { destino: string; motivo: string }[] } {
  const home = opcoes.home ?? homedir();
  const origem = opcoes.origem ?? origemDaSkill();
  const removidos: string[] = [];
  const recusados: { destino: string; motivo: string }[] = [];

  for (const dir of opcoes.dir !== undefined ? [resolve(opcoes.dir)] : locaisDeSkill(home)) {
    const e = estadoEm(dir, origem);
    if (!e.instalada) continue;
    if (e.nossa !== true) {
      recusados.push({ destino: e.destino, motivo: 'não foi o fluigctl que pôs esta skill; remova você mesmo se for o caso' });
      continue;
    }
    if (!opcoes.dryRun) rmSync(e.destino, { recursive: true, force: true });
    removidos.push(e.destino);
  }
  return { removidos, recusados };
}
