import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O `bin` do pacote, que é o que o `npm link` põe no PATH.
 *
 * Ele existe como arquivo versionado porque o `tsc` reescreve o compilado sem o
 * bit de execução: apontar o `bin` para o compilado fazia o `fluigctl` do PATH
 * responder "permissão negada" depois de qualquer build ou `npm test`.
 */

// Os testes rodam de `dist/test/`, então a raiz do repositório está dois níveis
// acima — o mesmo motivo pelo qual os fixtures são copiados para o dist.
const BIN = fileURLToPath(new URL('../../bin/fluigctl.js', import.meta.url));

test('o bin tem o bit de execução, e o compilado não precisa dele', () => {
  const modo = execFileSync('stat', ['-c', '%a', BIN]).toString().trim();
  assert.equal(modo, '755', 'o arquivo versionado precisa continuar executável');
});

test('o bin repassa a saída e o código de saída do CLI', async () => {
  // `server test` de um servidor que não existe sai com 3, e a mensagem do CLI.
  const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(process.execPath, [BIN, 'server', 'test', 'nao-existe'], (erro, _out, stderr) => {
      resolve({ code: (erro as { code?: number } | null)?.code ?? 0, stderr });
    });
  });

  assert.equal(r.code, 3, 'o código de saída é o do CLI, não o do wrapper');
  assert.match(r.stderr, /não está cadastrado/);
});

test('sem o compilado, o bin explica em vez de estourar um erro de módulo', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-bin-'));
  try {
    // Uma cópia do bin sem o dist ao lado: é o que acontece num clone recém-baixado.
    mkdirSync(join(raiz, 'bin'));
    copyFileSync(BIN, join(raiz, 'bin/fluigctl.js'));

    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(process.execPath, [join(raiz, 'bin/fluigctl.js')], (erro, _out, stderr) => {
        resolve({ code: (erro as { code?: number } | null)?.code ?? 0, stderr });
      });
    });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /ainda não foi compilado\. Rode: npm run build/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
