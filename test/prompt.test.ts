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
