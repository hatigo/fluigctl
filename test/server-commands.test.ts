import test from 'node:test';
import assert from 'node:assert/strict';

import type { Config } from '../src/config.js';
import {
  addServer,
  defaultPasswordEnv,
  listServers,
  removeServer,
} from '../src/commands/server.js';

const vazia: Config = { version: 1, servers: {} };

const entrada = {
  host: 'homolog.cetenco.com.br',
  port: 8021,
  ssl: false,
  username: 'integracao.fluig',
  companyId: 1,
  userCode: 'Integracao.Fluig',
};

test('defaultPasswordEnv deriva o nome da variável a partir do servidor', () => {
  assert.equal(defaultPasswordEnv('cetenco-prod'), 'FLUIG_CETENCO_PROD_PASSWORD');
  assert.equal(defaultPasswordEnv('sebrae-rn-hml'), 'FLUIG_SEBRAE_RN_HML_PASSWORD');
});

test('addServer grava o servidor com a variável de senha derivada', () => {
  const config = addServer(vazia, 'cetenco-hml', entrada);

  assert.equal(config.servers['cetenco-hml']!.passwordEnv, 'FLUIG_CETENCO_HML_PASSWORD');
  assert.equal(config.servers['cetenco-hml']!.host, 'homolog.cetenco.com.br');
});

test('addServer não altera a config recebida', () => {
  addServer(vazia, 'cetenco-hml', entrada);

  assert.deepEqual(vazia.servers, {});
});

test('addServer recusa nome duplicado', () => {
  const config = addServer(vazia, 'cetenco-hml', entrada);

  assert.throws(() => addServer(config, 'cetenco-hml', entrada), /já existe/i);
});

test('addServer recusa nome que não é slug', () => {
  assert.throws(() => addServer(vazia, 'CETENCO HML', entrada), /nome/i);
});

test('addServer nunca aceita uma senha no objeto do servidor', () => {
  const config = addServer(vazia, 'cetenco-hml', {
    ...entrada,
    password: 'segredo',
  } as never);

  assert.equal(JSON.stringify(config).includes('segredo'), false);
  assert.equal('password' in config.servers['cetenco-hml']!, false);
});

test('removeServer tira o servidor e reclama de nome inexistente', () => {
  const config = addServer(vazia, 'cetenco-hml', entrada);

  assert.deepEqual(removeServer(config, 'cetenco-hml').servers, {});
  assert.throws(() => removeServer(config, 'nao-existe'), /nao-existe/);
});

test('listServers marca produção e mostra a variável de senha', () => {
  let config = addServer(vazia, 'cetenco-hml', entrada);
  config = addServer(config, 'cetenco-prod', { ...entrada, ssl: true, port: 443, prod: true });

  const saida = listServers(config);

  assert.match(saida, /cetenco-hml/);
  assert.match(saida, /http:\/\/homolog\.cetenco\.com\.br:8021/);
  assert.match(saida, /https:\/\/homolog\.cetenco\.com\.br\b/);
  assert.match(saida, /PRODUÇÃO/);
  assert.match(saida, /FLUIG_CETENCO_PROD_PASSWORD/);
});

test('listServers explica que não há servidor em vez de imprimir vazio', () => {
  assert.match(listServers(vazia), /nenhum servidor/i);
});
