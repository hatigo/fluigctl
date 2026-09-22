import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envFilePath, resolvePassword } from '../src/config.js';
import type { Server } from '../src/config.js';

const servidor: Server = {
  host: 'h', port: 8021, ssl: false, username: 'integracao.fluig',
  companyId: 1, userCode: 'x', passwordEnv: 'FLUIG_CETENCO_HML_PASSWORD',
};

function arquivoEnv(conteudo: string, modo = 0o600): string {
  const caminho = join(mkdtempSync(join(tmpdir(), 'fluigctl-env-')), 'env');
  writeFileSync(caminho, conteudo);
  chmodSync(caminho, modo);
  return caminho;
}

test('a variável de ambiente tem precedência sobre o arquivo', () => {
  const caminho = arquivoEnv("export FLUIG_CETENCO_HML_PASSWORD='do-arquivo'\n");
  process.env['FLUIG_CETENCO_HML_PASSWORD'] = 'do-ambiente';

  try {
    assert.equal(resolvePassword(servidor, caminho), 'do-ambiente');
  } finally {
    delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  }
});

test('sem a variável, lê do arquivo na forma export com aspas simples', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  const caminho = arquivoEnv("export FLUIG_CETENCO_HML_PASSWORD='Cetenco#2026'\n");

  assert.equal(resolvePassword(servidor, caminho), 'Cetenco#2026');
});

test('lê aspas duplas, sem export, e ignora espaços em volta', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];

  assert.equal(
    resolvePassword(servidor, arquivoEnv('  FLUIG_CETENCO_HML_PASSWORD = "com aspas"\n')),
    'com aspas',
  );
});

test('lê valor sem aspas', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];

  assert.equal(
    resolvePassword(servidor, arquivoEnv('FLUIG_CETENCO_HML_PASSWORD=simples\n')),
    'simples',
  );
});

test('ignora comentários e linhas em branco e acha a variável certa entre várias', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  const caminho = arquivoEnv(
    '# senhas do fluig\n\n' +
      "export FLUIG_DOISA_PROD_PASSWORD='outra'\n" +
      "export FLUIG_CETENCO_HML_PASSWORD='certa'\n",
  );

  assert.equal(resolvePassword(servidor, caminho), 'certa');
});

test('a mensagem cita a variável e o arquivo quando nenhum dos dois tem a senha', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  const caminho = arquivoEnv("export FLUIG_OUTRO_PASSWORD='x'\n");

  assert.throws(
    () => resolvePassword(servidor, caminho),
    (e: Error) =>
      /FLUIG_CETENCO_HML_PASSWORD/.test(e.message) && new RegExp(caminho).test(e.message),
  );
});

test('arquivo inexistente não quebra, só resulta na mensagem da variável', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];

  assert.throws(
    () => resolvePassword(servidor, '/nao/existe/env'),
    /FLUIG_CETENCO_HML_PASSWORD/,
  );
});

test('avisa quando o arquivo de senhas é legível por outros', () => {
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  const caminho = arquivoEnv("export FLUIG_CETENCO_HML_PASSWORD='x'\n", 0o644);
  const avisos: string[] = [];
  const original = console.error;
  console.error = (m: unknown) => avisos.push(String(m));

  try {
    resolvePassword(servidor, caminho);
  } finally {
    console.error = original;
  }

  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /600/);
});

test('envFilePath fica ao lado do servers.json', () => {
  const anterior = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-teste';

  try {
    assert.equal(envFilePath(), '/tmp/xdg-teste/fluigctl/env');
  } finally {
    if (anterior === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = anterior;
  }
});
