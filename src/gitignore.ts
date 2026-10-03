import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Mantém o `.vscode/servers.json` fora do git.
 *
 * O arquivo carrega host, usuário e a senha cifrada com uma chave que sai da
 * máquina do dono — reversível para quem tiver acesso a ela. Quando o fluigctl
 * usa esse arquivo, garante que ele está no `.gitignore` do repositório; se já
 * estiver versionado, ignorar não basta, e isso é avisado.
 */

const LINHA = '.vscode/servers.json';

function git(dir: string, args: string[]): { ok: boolean; saida: string } {
  try {
    const saida = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, saida: saida.trim() };
  } catch {
    return { ok: false, saida: '' };
  }
}

export type SituacaoGit =
  | { tipo: 'fora-de-repositorio' }
  | { tipo: 'ja-ignorado'; raiz: string }
  | { tipo: 'adicionado'; raiz: string; gitignore: string }
  | { tipo: 'a-adicionar'; raiz: string; gitignore: string }
  | { tipo: 'versionado'; raiz: string; adicionado: boolean };

/**
 * Garante que `arquivo` (um `.vscode/servers.json`) está ignorado pelo git do
 * repositório que o contém, acrescentando a linha ao `.gitignore` da raiz.
 * Com `corrigir: false` só diz o que faria.
 */
export function garantirIgnorado(arquivo: string, corrigir = true): SituacaoGit {
  const dir = dirname(arquivo);
  const raiz = git(dir, ['rev-parse', '--show-toplevel']);
  if (!raiz.ok || raiz.saida === '') return { tipo: 'fora-de-repositorio' };

  const versionado = git(raiz.saida, ['ls-files', '--error-unmatch', relative(raiz.saida, arquivo)]).ok;
  const ignorado = git(raiz.saida, ['check-ignore', '-q', '--no-index', arquivo]).ok;

  let adicionado = false;
  if (!ignorado && !corrigir) {
    if (!versionado) return { tipo: 'a-adicionar', raiz: raiz.saida, gitignore: join(raiz.saida, '.gitignore') };
  } else if (!ignorado) {
    const gitignore = join(raiz.saida, '.gitignore');
    let atual = '';
    try {
      atual = readFileSync(gitignore, 'utf8');
    } catch {
      // ainda não existe
    }
    const prefixo = atual === '' || atual.endsWith('\n') ? '' : '\n';
    appendFileSync(
      gitignore,
      `${prefixo}# credenciais da extensão Fluiggers (senha cifrada com a chave desta máquina)\n${LINHA}\n`,
      'utf8',
    );
    adicionado = true;
    if (!versionado) return { tipo: 'adicionado', raiz: raiz.saida, gitignore };
  }

  if (versionado) return { tipo: 'versionado', raiz: raiz.saida, adicionado };
  return { tipo: 'ja-ignorado', raiz: raiz.saida };
}

/** Uma linha de aviso para quem chamou, ou `undefined` se não há o que dizer. */
export function avisoGit(arquivo: string, s: SituacaoGit): string | undefined {
  switch (s.tipo) {
    case 'adicionado':
      return `${LINHA} acrescentado a ${s.gitignore}`;
    case 'a-adicionar':
      return `${LINHA} não está no .gitignore de ${s.raiz}; com --write ele é acrescentado`;
    case 'versionado':
      return (
        `ATENÇÃO: ${arquivo} está VERSIONADO no git de ${s.raiz}` +
        (s.adicionado ? ' (acrescentei ao .gitignore, mas isso não o tira do histórico)' : '') +
        `. Tire-o do índice com: git -C ${s.raiz} rm --cached ${LINHA} — e considere trocar as senhas.`
      );
    default:
      return undefined;
  }
}
