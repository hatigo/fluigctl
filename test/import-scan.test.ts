import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanServersJson } from '../src/import.js';

function arvore(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-scan-'));

  for (const projeto of ['cetenco/fluigCetencoSC', 'doisa/fluigdoisa']) {
    const dir = join(raiz, projeto, '.vscode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'servers.json'), '{"configurations":[]}');
  }

  // ruído que não pode ser confundido com config de servidor
  mkdirSync(join(raiz, 'cetenco/fluigCetencoSC/node_modules/pacote/.vscode'), { recursive: true });
  writeFileSync(
    join(raiz, 'cetenco/fluigCetencoSC/node_modules/pacote/.vscode/servers.json'),
    '{"configurations":[]}',
  );
  mkdirSync(join(raiz, 'cetenco/fluigCetencoSC/.vscode/nested'), { recursive: true });
  writeFileSync(join(raiz, 'cetenco/fluigCetencoSC/.vscode/settings.json'), '{}');

  return raiz;
}

test('scanServersJson acha os servers.json de cada projeto', async () => {
  const raiz = arvore();

  const achados = await scanServersJson(raiz);

  assert.equal(achados.length, 2);
  assert.ok(achados.every((a) => a.path.endsWith('/.vscode/servers.json')));
});

test('scanServersJson ignora node_modules', async () => {
  const raiz = arvore();

  const achados = await scanServersJson(raiz);

  assert.equal(achados.some((a) => a.path.includes('node_modules')), false);
});

test('scanServersJson devolve o conteúdo junto do caminho', async () => {
  const raiz = arvore();

  const achados = await scanServersJson(raiz);

  assert.equal(achados[0]!.conteudo, '{"configurations":[]}');
});

test('scanServersJson explica quando o diretório não existe', async () => {
  await assert.rejects(() => scanServersJson('/nao/existe/mesmo'), /não existe/i);
});
