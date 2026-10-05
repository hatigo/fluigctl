#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O `bin` do pacote aponta para cá, e não para o compilado.
 *
 * O motivo é chato mas real: o `tsc` reescreve `dist/src/cli.js` **sem o bit de
 * execução**, e o `npm link` aponta direto para ele. Depois de qualquer build —
 * ou de rodar os testes, que também recompilam — o `fluigctl` do PATH virava
 * "permissão negada", e o `which` nem o encontrava. Este arquivo é versionado,
 * então o bit dele não se perde: quem recompila o `dist` não mexe aqui.
 */
const compilado = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'src', 'cli.js');

if (!existsSync(compilado)) {
  console.error('fluigctl: o pacote ainda não foi compilado. Rode: npm run build');
  process.exit(1);
}

await import(compilado);
