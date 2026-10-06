import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolvePassword, type Server } from '../src/config.js';
import { gravarNoEnv } from '../src/env-file.js';
import { garantirIgnorado } from '../src/gitignore.js';
import { decifrar, machineIds, pareceCifrada, senhaNosArquivos, serversJsonAcima } from '../src/vscode-credentials.js';

/** Cifra como a extensão Fluiggers: AES-256-CBC, chave scrypt do machineId. */
function cifrar(senha: string, machineId: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const chave = scryptSync(machineId, salt, 32);
  const c = createCipheriv('aes-256-cbc', chave, iv);
  const text = Buffer.concat([c.update(senha, 'utf8'), c.final()]).toString('hex');
  return Buffer.from(JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), text })).toString('base64');
}

const MAQUINA = 'f3b0c4a1-maquina-de-teste';

const SERVIDOR: Server = {
  host: 'hml.exemplo.com.br', port: 8021, ssl: false, username: 'integracao.fluig',
  companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_TESTE_VSCODE_PASSWORD',
};

function serversJson(entradas: object[]): string {
  return JSON.stringify({ version: '1.0.0', configurations: entradas });
}

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'fluigctl-vscode-'));
}

/** Um home falso com o storage.json do VS Code. */
function homeCom(machineId: string): string {
  const home = temp();
  const pasta = join(home, '.config', 'Code', 'User', 'globalStorage');
  mkdirSync(pasta, { recursive: true });
  writeFileSync(join(pasta, 'storage.json'), JSON.stringify({ 'telemetry.machineId': machineId }));
  return home;
}

test('decifra a senha no formato da extensão', () => {
  const blob = cifrar('s3nh@-de-teste', MAQUINA);
  assert.ok(pareceCifrada(blob));
  assert.equal(decifrar(blob, MAQUINA), 's3nh@-de-teste');
  assert.throws(() => decifrar(blob, 'outra-maquina'));
  assert.equal(pareceCifrada('senha-em-claro'), false);
});

test('chave errada que passa no padding por acaso é recusada, e não devolve lixo', () => {
  // Achado em 1.193 IVs: com 'outra-maquina', este blob decifra sem erro de
  // padding em 15 bytes de lixo. Era o que fazia o teste acima falhar ~1 vez em 256.
  const blob = 'eyJzYWx0IjoiMDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDciLCJpdiI6IjY0MWNiOWQ3ZGU2MGZlOTExYzFhMjczZGFiODFhZmU0IiwidGV4dCI6ImU0ZGQxY2Q5MTllY2UxNTQ2YWM4Njg5YjY3ZGM3MzE5In0=';
  assert.equal(decifrar(blob, MAQUINA), 's3nh@-de-teste');
  assert.throws(() => decifrar(blob, 'outra-maquina'), /esta chave não decifra a senha/);
});

test('machineIds lê o storage.json do VS Code e ignora editor ausente', () => {
  const home = homeCom(MAQUINA);
  try {
    assert.deepEqual(machineIds(home, 'linux'), [MAQUINA]);
    assert.deepEqual(machineIds(temp(), 'linux'), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('casa o servidor por host, porta, ssl e usuário, sem diferenciar caixa', () => {
  const arquivo = {
    path: '/repo/.vscode/servers.json',
    conteudo: serversJson([
      { name: 'Outro', host: 'hml.exemplo.com.br', port: 9999, ssl: false, username: 'integracao.fluig', password: cifrar('errada', MAQUINA) },
      { name: 'HML', host: 'HML.exemplo.com.br', port: 8021, ssl: false, username: 'Integracao.Fluig', password: cifrar('certa', MAQUINA) },
    ]),
  };

  assert.deepEqual(senhaNosArquivos(SERVIDOR, [arquivo], [MAQUINA]), { senha: 'certa', origem: arquivo.path });
});

test('senha cifrada noutra máquina é pulada, e outro arquivo pode ter a que decifra', () => {
  const deOutra = { path: '/a/.vscode/servers.json', conteudo: serversJson([{ host: SERVIDOR.host, port: 8021, username: 'integracao.fluig', password: cifrar('x', 'outra') }]) };
  const daqui = { path: '/b/.vscode/servers.json', conteudo: serversJson([{ host: SERVIDOR.host, port: 8021, username: 'integracao.fluig', password: cifrar('boa', MAQUINA) }]) };

  assert.equal(senhaNosArquivos(SERVIDOR, [deOutra], [MAQUINA]), undefined);
  assert.deepEqual(senhaNosArquivos(SERVIDOR, [deOutra, daqui], [MAQUINA]), { senha: 'boa', origem: daqui.path });
});

test('senha em claro no servers.json é aceita', () => {
  const arquivo = { path: '/r/.vscode/servers.json', conteudo: serversJson([{ host: SERVIDOR.host, port: 8021, username: 'integracao.fluig', password: 'em-claro' }]) };
  assert.equal(senhaNosArquivos(SERVIDOR, [arquivo], [])?.senha, 'em-claro');
});

test('serversJsonAcima acha o arquivo subindo a partir de uma subpasta', () => {
  const raiz = temp();
  try {
    mkdirSync(join(raiz, '.vscode'));
    writeFileSync(join(raiz, '.vscode', 'servers.json'), serversJson([]));
    mkdirSync(join(raiz, 'forms', 'formX'), { recursive: true });

    const achados = serversJsonAcima(join(raiz, 'forms', 'formX'));
    assert.equal(achados[0]?.path, join(raiz, '.vscode', 'servers.json'));
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('resolvePassword usa o servers.json quando não há variável nem arquivo, e o põe no .gitignore', () => {
  const repo = temp();
  const home = homeCom(MAQUINA);
  delete process.env[SERVIDOR.passwordEnv];
  try {
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(
      join(repo, '.vscode', 'servers.json'),
      serversJson([{ host: SERVIDOR.host, port: 8021, ssl: false, username: 'integracao.fluig', password: cifrar('do-vscode', MAQUINA) }]),
    );

    const senha = resolvePassword(SERVIDOR, join(repo, 'env-inexistente'), { inicio: repo, home });

    assert.equal(senha, 'do-vscode');
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /^\.vscode\/servers\.json$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a variável de ambiente e o arquivo próprio vêm antes do servers.json', () => {
  const dir = temp();
  const home = homeCom(MAQUINA);
  try {
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'servers.json'), serversJson([{ host: SERVIDOR.host, port: 8021, username: 'integracao.fluig', password: cifrar('do-vscode', MAQUINA) }]));
    const env = join(dir, 'env');
    gravarNoEnv(env, SERVIDOR.passwordEnv, 'do-arquivo');

    assert.equal(resolvePassword(SERVIDOR, env, { inicio: dir, home }), 'do-arquivo');

    process.env[SERVIDOR.passwordEnv] = 'da-variavel';
    assert.equal(resolvePassword(SERVIDOR, env, { inicio: dir, home }), 'da-variavel');
  } finally {
    delete process.env[SERVIDOR.passwordEnv];
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('sem nenhuma fonte, a mensagem nomeia as três', () => {
  delete process.env[SERVIDOR.passwordEnv];
  const dir = temp();
  try {
    assert.throws(
      () => resolvePassword(SERVIDOR, join(dir, 'env'), { inicio: dir, home: dir }),
      /FLUIG_TESTE_VSCODE_PASSWORD.*env.*\.vscode\/servers\.json/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gravarNoEnv cria com permissão 600, atualiza a linha e preserva as outras', () => {
  const dir = temp();
  const env = join(dir, 'sub', 'env');
  try {
    assert.equal(gravarNoEnv(env, 'FLUIG_A_PASSWORD', 'um'), 'nova');
    assert.equal(gravarNoEnv(env, 'FLUIG_B_PASSWORD', "com'aspa"), 'nova');
    assert.equal(gravarNoEnv(env, 'FLUIG_A_PASSWORD', 'dois'), 'atualizada');
    assert.equal(gravarNoEnv(env, 'FLUIG_A_PASSWORD', 'dois'), 'igual');

    assert.equal(statSync(env).mode & 0o777, 0o600);
    assert.equal(readFileSync(env, 'utf8'), `export FLUIG_A_PASSWORD='dois'\nexport FLUIG_B_PASSWORD="com'aspa"\n`);

    // O leitor do fluigctl devolve exatamente o que foi gravado.
    const s = { ...SERVIDOR, passwordEnv: 'FLUIG_B_PASSWORD' };
    delete process.env['FLUIG_B_PASSWORD'];
    assert.equal(resolvePassword(s, env, false), "com'aspa");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gravarNoEnv recusa senha com os dois tipos de aspa ou quebra de linha', () => {
  const dir = temp();
  try {
    assert.throws(() => gravarNoEnv(join(dir, 'env'), 'FLUIG_X_PASSWORD', `a'b"c`), /aspas/);
    assert.throws(() => gravarNoEnv(join(dir, 'env'), 'FLUIG_X_PASSWORD', 'a\nb'), /quebra de linha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('garantirIgnorado: acrescenta uma vez, reconhece o que já está e acusa arquivo versionado', () => {
  const repo = temp();
  try {
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, '.vscode'));
    const arquivo = join(repo, '.vscode', 'servers.json');
    writeFileSync(arquivo, '{}');

    assert.equal(garantirIgnorado(arquivo, false).tipo, 'a-adicionar');
    assert.equal(garantirIgnorado(arquivo).tipo, 'adicionado');
    assert.equal(garantirIgnorado(arquivo).tipo, 'ja-ignorado');
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8').match(/servers\.json/g)?.length, 1);

    execFileSync('git', ['-C', repo, 'add', '-f', '.vscode/servers.json']);
    assert.equal(garantirIgnorado(arquivo).tipo, 'versionado');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('garantirIgnorado fora de repositório não escreve nada', () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'servers.json'), '{}');
    assert.equal(garantirIgnorado(join(dir, '.vscode', 'servers.json')).tipo, 'fora-de-repositorio');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
