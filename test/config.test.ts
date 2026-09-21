import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePassword, resolveServer, serverUrl } from '../src/config.js';

const config = {
  version: 1 as const,
  servers: {
    'cetenco-hml': {
      host: 'homolog.cetenco.com.br',
      port: 8080,
      ssl: false,
      username: 'thiago.ferreira',
      companyId: 1,
      userCode: 'thiago.ferreira',
      passwordEnv: 'FLUIG_CETENCO_HML_PASSWORD',
    },
  },
};

test('resolveServer devolve o servidor cadastrado pelo nome', () => {
  const server = resolveServer(config, 'cetenco-hml');

  assert.equal(server.host, 'homolog.cetenco.com.br');
  assert.equal(server.username, 'thiago.ferreira');
});

test('resolveServer lista os nomes disponíveis quando o servidor não existe', () => {
  assert.throws(
    () => resolveServer(config, 'cetenco-prod'),
    /cetenco-prod.*cetenco-hml/s,
  );
});

test('resolvePassword lê a senha da variável de ambiente do servidor', () => {
  const server = config.servers['cetenco-hml']!;
  process.env['FLUIG_CETENCO_HML_PASSWORD'] = 'segredo-de-teste';

  try {
    assert.equal(resolvePassword(server), 'segredo-de-teste');
  } finally {
    delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  }
});

test('resolvePassword nomeia a variável que falta definir', () => {
  const server = config.servers['cetenco-hml']!;
  delete process.env['FLUIG_CETENCO_HML_PASSWORD'];

  assert.throws(
    () => resolvePassword(server),
    /FLUIG_CETENCO_HML_PASSWORD/,
  );
});

test('resolvePassword recusa variável definida como string vazia', () => {
  const server = config.servers['cetenco-hml']!;
  process.env['FLUIG_CETENCO_HML_PASSWORD'] = '';

  try {
    assert.throws(() => resolvePassword(server), /FLUIG_CETENCO_HML_PASSWORD/);
  } finally {
    delete process.env['FLUIG_CETENCO_HML_PASSWORD'];
  }
});

test('serverUrl omite a porta quando é a padrão do esquema', () => {
  assert.equal(
    serverUrl({ ...config.servers['cetenco-hml']!, ssl: true, port: 443 }),
    'https://homolog.cetenco.com.br',
  );
  assert.equal(
    serverUrl({ ...config.servers['cetenco-hml']!, ssl: false, port: 80 }),
    'http://homolog.cetenco.com.br',
  );
});

test('serverUrl mantém a porta quando não é a padrão', () => {
  assert.equal(
    serverUrl(config.servers['cetenco-hml']!),
    'http://homolog.cetenco.com.br:8080',
  );
});
