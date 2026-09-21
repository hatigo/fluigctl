import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPath, loadConfig, saveConfig } from '../src/config.js';
import type { Server } from '../src/config.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'fluigctl-')), 'servers.json');
}

const servidor: Server = {
  host: 'homolog.cetenco.com.br',
  port: 8080,
  ssl: false,
  username: 'thiago.ferreira',
  companyId: 1,
  userCode: 'thiago.ferreira',
  passwordEnv: 'FLUIG_CETENCO_HML_PASSWORD',
};

test('loadConfig devolve config vazia quando o arquivo não existe', () => {
  const config = loadConfig(join(tmpFile(), 'inexistente.json'));

  assert.deepEqual(config, { version: 1, servers: {} });
});

test('saveConfig e loadConfig fazem round-trip do servidor', () => {
  const caminho = tmpFile();

  saveConfig({ version: 1, servers: { 'cetenco-hml': servidor } }, caminho);

  assert.deepEqual(loadConfig(caminho).servers['cetenco-hml'], servidor);
});

test('saveConfig grava JSON legível por humano', () => {
  const caminho = tmpFile();

  saveConfig({ version: 1, servers: { 'cetenco-hml': servidor } }, caminho);

  assert.match(readFileSync(caminho, 'utf8'), /\n {2}"servers"/);
});

test('loadConfig explica qual arquivo está corrompido', () => {
  const caminho = tmpFile();
  writeFileSync(caminho, '{ isto não é json');

  assert.throws(() => loadConfig(caminho), new RegExp(caminho));
});

test('configPath respeita XDG_CONFIG_HOME', () => {
  const anterior = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = '/tmp/xdg-teste';

  try {
    assert.equal(configPath(), '/tmp/xdg-teste/fluigctl/servers.json');
  } finally {
    if (anterior === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = anterior;
  }
});
