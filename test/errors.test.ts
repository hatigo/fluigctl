import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ErroFluigctl } from '../src/errors.js';
import { confirmProduction } from '../src/guard.js';
import { decideDataset, datasetNameFromFile } from '../src/push/dataset-resolve.js';
import { resolvePassword, resolveServer } from '../src/config.js';
import { readDatasetFile } from '../src/push/dataset-source.js';
import type { Server } from '../src/config.js';

const prod: Server = {
  host: 'h', port: 443, ssl: true, username: 'u', companyId: 1,
  userCode: 'u', passwordEnv: 'FLUIG_X_PASSWORD', prod: true,
};

function codigoDe(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ErroFluigctl ? e.codigo : undefined;
  }
  return undefined;
}

test('servidor desconhecido sai com código 3 (config)', () => {
  assert.equal(codigoDe(() => resolveServer({ version: 1, servers: {} }, 'x')), 3);
});

test('variável de senha ausente sai com código 4 (credencial)', () => {
  delete process.env['FLUIG_X_PASSWORD'];
  assert.equal(codigoDe(() => resolvePassword(prod)), 4);
});

test('gate de produção recusado sai com código 5', async () => {
  const erro = await confirmProduction(prod, 'certa', 'push', async () => 'errada').catch(
    (e: unknown) => e,
  );

  assert.ok(erro instanceof ErroFluigctl);
  assert.equal(erro.codigo, 5);
});

test('ausência de TTY sai com código 5, não com erro genérico', async () => {
  const erro = await confirmProduction(prod, 'c', 'push', async () => {
    throw new Error('sem tty');
  }).catch((e: unknown) => e);

  assert.ok(erro instanceof ErroFluigctl);
  assert.equal(erro.codigo, 5);
});

test('dataset sem correspondência sai com código 6 (resolução)', () => {
  assert.equal(codigoDe(() => decideDataset('dsNovo', ['dsVelho'], false)), 6);
});

test('arquivo que não é .js sai com código 6', () => {
  assert.equal(codigoDe(() => datasetNameFromFile('x.txt')), 6);
});

test('arquivo de dataset inexistente dá mensagem clara, não ENOENT cru', () => {
  const caminho = join(mkdtempSync(join(tmpdir(), 'fluigctl-')), 'dsFantasma.js');

  try {
    readDatasetFile(caminho);
    assert.fail('deveria ter falhado');
  } catch (e) {
    assert.ok(e instanceof ErroFluigctl);
    assert.equal(e.codigo, 3);
    assert.match(e.message, /não encontrei o arquivo/i);
    assert.doesNotMatch(e.message, /ENOENT/);
  }
});
