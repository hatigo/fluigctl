import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { promptPassword } from '../src/prompt.js';

test('promptPassword falha quando o TTY não existe', async () => {
  await assert.rejects(
    () => promptPassword('Senha: ', '/caminho/que/nao/existe/tty'),
    /tty/i,
  );
});

test('promptPassword recusa um arquivo comum como se fosse terminal', async () => {
  // Sem esta checagem, redirecionar um arquivo para o lugar do TTY passaria
  // pelo gate de produção — exatamente o furo que o gate existe para fechar.
  const arquivo = join(mkdtempSync(join(tmpdir(), 'fluigctl-')), 'falso-tty');
  writeFileSync(arquivo, 'senha-do-atacante\n');

  await assert.rejects(() => promptPassword('Senha: ', arquivo), /não é um terminal/i);
});

/**
 * O caminho feliz precisa de um terminal de verdade. `script(1)` aloca um
 * pseudo-terminal; sem ele, o teste é pulado em vez de mentir que passou.
 */
async function comTty(entrada: string, corpo: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const modulo = new URL('../src/prompt.js', import.meta.url).pathname;
  const arquivo = join(mkdtempSync(join(tmpdir(), 'fluigctl-tty-')), 'harness.mjs');
  writeFileSync(arquivo, `import { promptPassword } from '${modulo}';\n${corpo}\n`);

  return new Promise((resolve, reject) => {
    const filho = execFile(
      'script',
      ['-qec', `node ${arquivo}`, '/dev/null'],
      (erro, stdout) => (erro ? reject(erro) : resolve(stdout.replace(/\r/g, ''))),
    );
    filho.stdin?.end(entrada);
  });
}

async function temScript(): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  return new Promise((r) => execFile('script', ['--version'], (e) => r(!e)));
}

test('promptPassword lê a senha digitada num terminal de verdade', async (t) => {
  if (!(await temScript())) return t.skip('script(1) não disponível');

  const saida = await comTty(
    'senha-digitada\n',
    `const s = await promptPassword('Senha: '); console.log('RESULTADO:' + s);`,
  );

  assert.match(saida, /RESULTADO:senha-digitada/);
});

test('promptPassword não ecoa a senha enquanto é digitada', async (t) => {
  if (!(await temScript())) return t.skip('script(1) não disponível');

  const saida = await comTty(
    'top-secret\n',
    `await promptPassword('Senha: '); console.log('FIM');`,
  );

  // A única ocorrência aceitável é o eco do pipe para dentro do pty, antes do
  // prompt. Depois de "Senha: " a senha não pode reaparecer.
  const depoisDoPrompt = saida.slice(saida.indexOf('Senha: '));
  assert.equal(depoisDoPrompt.includes('top-secret'), false);
});

test('promptPassword trata backspace', async (t) => {
  if (!(await temScript())) return t.skip('script(1) não disponível');

  const saida = await comTty(
    'abcX\x7f\n',
    `const s = await promptPassword('Senha: '); console.log('RESULTADO:' + s);`,
  );

  assert.match(saida, /RESULTADO:abc$/m);
});
