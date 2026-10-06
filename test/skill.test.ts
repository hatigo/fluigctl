import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { estado, estadoEm, instalarSkill, locaisDeSkill, origemDaSkill, removerSkill, SKILLS } from '../src/commands/skill.js';
import { ErroFluigctl } from '../src/errors.js';

/**
 * A skill mora no repositório e o `skill install` a põe onde os agentes
 * procuram. O que estes testes protegem: que ele não sobrescreva o que não é
 * dele, que reinstalar atualize uma cópia velha, e que o "não é meu" seja
 * decidido pelo `name` do frontmatter — o spec exige nome único, então um
 * diretório que se declara `fluig-deploy` é esta skill.
 */

const ORIGEM = origemDaSkill();

function casa(): { home: string; limpar: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'fluigctl-skill-'));
  return { home, limpar: () => rmSync(home, { recursive: true, force: true }) };
}

const skillAlheia = (dir: string) => {
  mkdirSync(join(dir, 'fluig-deploy'), { recursive: true });
  writeFileSync(join(dir, 'fluig-deploy/SKILL.md'), '---\nname: outra-coisa\n---\n\n# Outra\n');
};

test('a skill vem do repositório, e o caminho dela existe', () => {
  assert.match(ORIGEM, /skills\/fluig-deploy$/);
  assert.ok(existsSync(join(ORIGEM, 'SKILL.md')));
});

test('cada skill declara no frontmatter o mesmo nome do diretório, como o spec pede', () => {
  // Implementações mais estritas recusam nome diferente do diretório.
  for (const nome of SKILLS) {
    const texto = readFileSync(join(origemDaSkill(undefined, nome), 'SKILL.md'), 'utf8');
    assert.match(texto, new RegExp(`^name: ${nome}$`, 'm'));
  }
});

test('os links relativos da skill apontam para arquivos que existem', () => {
  for (const nome of SKILLS) {
    const origem = origemDaSkill(undefined, nome);
    const texto = readFileSync(join(origem, 'SKILL.md'), 'utf8');
    for (const [, alvo] of texto.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
      assert.ok(existsSync(join(origem, alvo!)), `${nome}: ${alvo} não existe`);
    }
  }
});

test('instalar linka para o repositório, e o link aponta para a skill certa', () => {
  const { home, limpar } = casa();
  try {
    const r = instalarSkill({ home });
    const destino = join(locaisDeSkill(home)[0]!, 'fluig-deploy');
    assert.deepEqual(r.feito.map((f) => f.acao), SKILLS.map(() => 'instalada'), 'todas as skills do pacote');
    for (const nome of SKILLS) assert.ok(existsSync(join(locaisDeSkill(home)[0]!, nome, 'SKILL.md')));
    assert.ok(lstatSync(destino).isSymbolicLink(), 'linkar é o padrão: git pull atualiza o que o agente lê');
    assert.ok(existsSync(join(destino, 'SKILL.md')));
  } finally {
    limpar();
  }
});

test('instalar de novo é idempotente, e não reescreve nada', () => {
  const { home, limpar } = casa();
  try {
    instalarSkill({ home });
    const marco = lstatSync(join(locaisDeSkill(home)[0]!, 'fluig-deploy')).ino;
    const r = instalarSkill({ home });
    assert.deepEqual(r.feito.map((f) => f.acao), SKILLS.map(() => 'ja estava'));
    assert.equal(lstatSync(join(locaisDeSkill(home)[0]!, 'fluig-deploy')).ino, marco, 'o mesmo link');
  } finally {
    limpar();
  }
});

test('--copy copia o conteúdo, e uma cópia desatualizada é atualizada', () => {
  const { home, limpar } = casa();
  try {
    const destino = join(locaisDeSkill(home)[0]!, 'fluig-deploy');
    instalarSkill({ home, copiar: true });
    assert.ok(!lstatSync(destino).isSymbolicLink());
    assert.equal(readFileSync(join(destino, 'SKILL.md'), 'utf8'), readFileSync(join(ORIGEM, 'SKILL.md'), 'utf8'));

    // Envelhece a cópia: reinstalar tem de trazer a versão do repositório de volta.
    writeFileSync(join(destino, 'SKILL.md'), '---\nname: fluig-deploy\n---\n\n# versão velha\n');
    const r = instalarSkill({ home, copiar: true });
    assert.deepEqual(r.feito.map((f) => [basename(f.destino), f.acao]), SKILLS.map((n) => [n, n === 'fluig-deploy' ? 'atualizada' : 'ja estava']));
    assert.equal(readFileSync(join(destino, 'SKILL.md'), 'utf8'), readFileSync(join(ORIGEM, 'SKILL.md'), 'utf8'));
  } finally {
    limpar();
  }
});

test('--copy leva as referências, e uma referência velha também desatualiza a cópia', () => {
  const { home, limpar } = casa();
  try {
    const origem = origemDaSkill(undefined, 'fluig-patterns');
    const dir = locaisDeSkill(home)[0]!;
    const destino = join(dir, 'fluig-patterns');
    instalarSkill({ home, copiar: true, origem });
    const ref = join(destino, 'references', 'datasets.md');
    assert.equal(readFileSync(ref, 'utf8'), readFileSync(join(origem, 'references', 'datasets.md'), 'utf8'));

    writeFileSync(ref, 'versão velha\n');
    assert.equal(estadoEm(dir, origem).desatualizada, true, 'o SKILL.md igual não basta');
    const r = instalarSkill({ home, copiar: true, origem });
    assert.deepEqual(r.feito.map((f) => f.acao), ['atualizada']);
    assert.equal(readFileSync(ref, 'utf8'), readFileSync(join(origem, 'references', 'datasets.md'), 'utf8'));
  } finally {
    limpar();
  }
});

test('skill com outro nome no frontmatter é recusada, e nada dela é tocado', () => {
  const { home, limpar } = casa();
  try {
    const dir = locaisDeSkill(home)[0]!;
    mkdirSync(dir, { recursive: true });
    skillAlheia(dir);

    const r = instalarSkill({ home });
    assert.ok(!r.feito.some((f) => basename(f.destino) === 'fluig-deploy'), 'a ocupada não é tocada');
    assert.equal(r.recusados.length, 1);
    assert.match(r.recusados[0]!.motivo, /não foi o fluigctl que a pôs/);
    assert.match(readFileSync(join(dir, 'fluig-deploy/SKILL.md'), 'utf8'), /outra-coisa/, 'intacta');
  } finally {
    limpar();
  }
});

test('--force sobrepõe o que não é nosso; sem ele, nada', () => {
  const { home, limpar } = casa();
  try {
    const dir = locaisDeSkill(home)[0]!;
    mkdirSync(dir, { recursive: true });
    skillAlheia(dir);

    instalarSkill({ home, forcar: true });
    assert.match(readFileSync(join(dir, 'fluig-deploy/SKILL.md'), 'utf8'), /^name: fluig-deploy$/m);
  } finally {
    limpar();
  }
});

test('--dry-run não escreve', () => {
  const { home, limpar } = casa();
  try {
    const r = instalarSkill({ home, dryRun: true });
    assert.equal(r.feito[0]!.acao, 'instalada');
    assert.ok(!existsSync(locaisDeSkill(home)[0]!), 'nada no disco');
  } finally {
    limpar();
  }
});

test('--dir instala só ali, sem espalhar nas pastas dos agentes', () => {
  const { home, limpar } = casa();
  try {
    const alvo = join(home, 'meu-lugar');
    mkdirSync(alvo, { recursive: true });
    instalarSkill({ home, dir: alvo });
    assert.ok(existsSync(join(alvo, 'fluig-deploy/SKILL.md')));
    assert.ok(!existsSync(join(locaisDeSkill(home)[0]!, 'fluig-deploy')), 'não instalou na convenção');
  } finally {
    limpar();
  }
});

test('sem --dir, instala também onde o Claude Code já tem pasta', () => {
  const { home, limpar } = casa();
  try {
    const [convencao, claude] = locaisDeSkill(home);
    mkdirSync(claude!, { recursive: true }); // o sinal de que o agente é usado
    const r = instalarSkill({ home });
    assert.deepEqual(
      r.feito.map((f) => f.destino).sort(),
      SKILLS.flatMap((n) => [join(convencao!, n), join(claude!, n)]).sort(),
    );
  } finally {
    limpar();
  }
});

test('desinstalar só remove o que foi o fluigctl que pôs', () => {
  const { home, limpar } = casa();
  try {
    const dir = locaisDeSkill(home)[0]!;
    instalarSkill({ home });
    const r = removerSkill({ home });
    assert.equal(r.removidos.length, SKILLS.length);
    for (const nome of SKILLS) assert.ok(!existsSync(join(dir, nome)));

    // O alheio fica.
    mkdirSync(dir, { recursive: true });
    skillAlheia(dir);
    const r2 = removerSkill({ home });
    assert.deepEqual(r2.removidos, []);
    assert.equal(r2.recusados.length, 1);
    assert.ok(existsSync(join(dir, 'fluig-deploy/SKILL.md')));
  } finally {
    limpar();
  }
});

test('desinstalar sem nada instalado não é erro', () => {
  const { home, limpar } = casa();
  try {
    assert.deepEqual(removerSkill({ home }), { removidos: [], recusados: [] });
  } finally {
    limpar();
  }
});

test('o estado diz onde está, como está, e se envelheceu', () => {
  const { home, limpar } = casa();
  try {
    const dir = locaisDeSkill(home)[0]!;
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(
      estadoEm(dir).instalada,
      false,
      'pasta existe, skill não instalada',
    );

    instalarSkill({ home, copiar: true });
    writeFileSync(join(dir, 'fluig-deploy/SKILL.md'), '---\nname: fluig-deploy\n---\nvelho\n');
    const e = estado(home).find((x) => x.destino === join(dir, 'fluig-deploy'))!;
    assert.equal(e.como, 'copia');
    assert.equal(e.nossa, true);
    assert.equal(e.desatualizada, true);
  } finally {
    limpar();
  }
});

test('pacote sem a pasta skills é recusado com mensagem clara, e não com erro de módulo', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pkg-'));
  try {
    const erro = (() => {
      try {
        return origemDaSkill(raiz);
      } catch (e) {
        return e as ErroFluigctl;
      }
    })();
    assert.ok(erro instanceof ErroFluigctl);
    assert.equal(erro.codigo, 3);
    assert.match(erro.message, /não achei a skill em .*skills\/fluig-deploy/);
    assert.match(erro.message, /pacote está incompleto/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('links quebrados e caminhos estranhos não derrubam o estado', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-skill-quebrado-'));
  try {
    const dir = join(raiz, 'skills');
    mkdirSync(dir, { recursive: true });
    // Link para um lugar que não existe.
    symlinkSync(join(raiz, 'nao-existe'), join(dir, 'fluig-deploy'), 'dir');
    const e = estadoEm(dir);
    assert.equal(e.instalada, false, 'link quebrado não conta como instalada');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
