import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeFluig } from './helpers/fake-fluig.js';
import { serverUi } from '../src/commands/server-ui.js';
import type { Terminal, Tecla } from '../src/tui/terminal.js';

/**
 * O shell do TUI, de ponta a ponta: teclas de verdade, config isolado e um
 * Fluig de mentira. É o que cobre o que os testes do redutor não alcançam — a
 * ordem entre provar a credencial e gravar o arquivo.
 *
 * `XDG_CONFIG_HOME` é apontado para uma pasta temporária, então nada aqui toca
 * o cadastro de quem roda os testes.
 */

const LOGIN = '/portal/api/servlet/login.do';
const USUARIO = '/portal/api/rest/wcmservice/rest/user/findUserByLogin';

/** Um terminal de mentira: entrega as teclas e guarda os quadros desenhados. */
interface Visto {
  ouviu?: boolean;
  desinscreveu?: boolean;
  avisar?: () => void;
}

function terminalDas(teclas: Tecla[], quadros: string[] = [], visto?: Visto): Terminal {
  return {
    tamanho: () => ({ colunas: 100, linhas: 30 }),
    desenhar: (q) => void quadros.push(q),
    async *teclas() {
      for (const t of teclas) yield t;
    },
    aoRedimensionar(ouvinte) {
      if (visto) {
        visto.ouviu = true;
        visto.avisar = () => ouvinte({ colunas: 120, linhas: 40 });
      }
      return () => {
        if (visto) visto.desinscreveu = true;
      };
    },
    fechar: () => {},
  };
}

const t = (valor: string): Tecla => ({ tipo: 'caractere', valor });
const digitos = (texto: string): Tecla[] => [...texto].map(t);
const TAB: Tecla = { tipo: 'tab' };
const ENTER: Tecla = { tipo: 'enter' };

/** Roda o TUI com um config isolado e devolve o que ficou gravado. */
async function rodar(
  config: Record<string, unknown>,
  teclas: Tecla[],
  ambiente: Record<string, string> = {},
): Promise<{ config: Record<string, { [k: string]: unknown }>; quadros: string[]; env: string }> {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-tui-'));
  const anteriorXdg = process.env['XDG_CONFIG_HOME'];
  const anteriores = new Map(Object.keys(ambiente).map((k) => [k, process.env[k]]));

  process.env['XDG_CONFIG_HOME'] = raiz;
  for (const [k, v] of Object.entries(ambiente)) process.env[k] = v;
  mkdirSync(join(raiz, 'fluigctl'), { recursive: true });
  writeFileSync(join(raiz, 'fluigctl/servers.json'), JSON.stringify({ version: 1, servers: config }));

  const quadros: string[] = [];
  try {
    await serverUi({ terminal: terminalDas(teclas, quadros) });
    const lido = JSON.parse(readFileSync(join(raiz, 'fluigctl/servers.json'), 'utf8')) as {
      servers: Record<string, { [k: string]: unknown }>;
    };
    let env = '';
    try {
      env = readFileSync(join(raiz, 'fluigctl/env'), 'utf8');
    } catch {
      env = '';
    }
    return { config: lido.servers, quadros, env };
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    if (anteriorXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = anteriorXdg;
    for (const [k, v] of anteriores) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function comFluig<T>(rotas: Parameters<typeof fakeFluig>[0], usar: (url: string) => Promise<T>): Promise<T> {
  const f = await fakeFluig({
    [LOGIN]: { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } },
    ...rotas,
  });
  try {
    return await usar(f.url);
  } finally {
    await f.close();
  }
}

const semCores = (q: string) => q.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const ultimoQuadro = (quadros: string[]) => semCores(quadros.at(-1) ?? '');
const tudo = (quadros: string[]) => semCores(quadros.join('\n'));

test('cadastrar prova a credencial e grava com a identidade que o servidor devolveu', async () => {
  await comFluig(
    {
      [USUARIO]: { headers: { 'content-type': 'application/json' }, body: '{"content":{"tenantId":7,"userCode":"Integracao.Fluig"}}' },
    },
    async (url) => {
      const { hostname, port } = new URL(url);
      const porta = Number(port);
      const r = await rodar(
        {},
        [
          t('a'),
          ...digitos('novo-servidor'),
          TAB,
          ...digitos(hostname),
          TAB,
          ...digitos(String(porta)),
          TAB,
          TAB,
          ...digitos('integracao'),
          ENTER,
        ],
        { FLUIG_NOVO_SERVIDOR_PASSWORD: 'segredo' },
      );

      assert.deepEqual(r.config['novo-servidor'], {
        host: hostname,
        port: porta,
        ssl: false,
        username: 'integracao',
        companyId: 7,
        userCode: 'Integracao.Fluig',
        passwordEnv: 'FLUIG_NOVO_SERVIDOR_PASSWORD',
      });
      assert.match(tudo(r.quadros), /cadastrado em http:\/\/127\.0\.0\.1:\d+ · companyId 7 · userCode Integracao\.Fluig/);
    },
  );
});

test('rever um servidor sem trocar o nome grava (o addServer recusaria o nome repetido)', async () => {
  await comFluig(
    {
      [USUARIO]: { headers: { 'content-type': 'application/json' }, body: '{"content":{"tenantId":1,"userCode":"admin"}}' },
    },
    async (url) => {
      const { hostname, port } = new URL(url);
      const existente = {
        alvo: {
          host: hostname,
          port: Number(port),
          ssl: false,
          username: 'admin',
          companyId: 1,
          userCode: 'admin',
          passwordEnv: 'FLUIG_ALVO_PASSWORD',
        },
      };
      // `enter` abre o formulário preenchido; `enter` de novo conclui sem mexer em nada.
      const r = await rodar(existente, [ENTER, ENTER], { FLUIG_ALVO_PASSWORD: 's' });

      assert.deepEqual(Object.keys(r.config), ['alvo'], 'continua sendo um servidor só');
      assert.equal(r.config['alvo']!['userCode'], 'admin');
      assert.match(tudo(r.quadros), /"alvo" cadastrado/);
      assert.ok(!tudo(r.quadros).includes('já existe'), 'a edição não pode esbarrar no addServer');
    },
  );
});

test('rever trocando o nome renomeia, sem deixar o antigo para trás', async () => {
  await comFluig(
    {
      [USUARIO]: { headers: { 'content-type': 'application/json' }, body: '{"content":{"tenantId":1,"userCode":"admin"}}' },
    },
    async (url) => {
      const { hostname, port } = new URL(url);
      const existente = {
        antigo: { host: hostname, port: Number(port), ssl: false, username: 'admin', companyId: 1, userCode: 'admin', passwordEnv: 'FLUIG_ANTIGO_PASSWORD' },
      };
      // Abre o de sempre, apaga o nome, escreve o novo, conclui.
      const r = await rodar(
        existente,
        // "antigo" tem 6 letras: apaga tudo antes de escrever o nome novo.
        [ENTER, ...Array.from({ length: 6 }, () => ({ tipo: 'backspace' }) as Tecla), ...digitos('novo'), ENTER],
        { FLUIG_NOVO_PASSWORD: 's' },
      );

      assert.deepEqual(Object.keys(r.config), ['novo']);
      assert.equal(r.config['novo']!['passwordEnv'], 'FLUIG_NOVO_PASSWORD');
    },
  );
});

test('login que falha não grava nada, e o formulário continua com os dados', async () => {
  await comFluig(
    {
      [USUARIO]: { headers: { 'content-type': 'application/json' }, body: '{"content":null}' },
    },
    async (url) => {
      const { hostname, port } = new URL(url);
      const r = await rodar(
        {},
        [
          t('a'),
          ...digitos('quebrado'),
          TAB,
          ...digitos(hostname),
          TAB,
          ...digitos(port),
          TAB,
          TAB,
          ...digitos('naoexiste'),
          ENTER,
        ],
        { FLUIG_QUEBRADO_PASSWORD: 's' },
      );

      assert.deepEqual(r.config, {}, 'nada pode ser gravado quando o login falha');
      const tela = ultimoQuadro(r.quadros);
      assert.match(tela, /não reconheceu o usuário/, 'a tela diz o motivo');
      assert.match(tela, /nome\s+quebrado/, 'e o que foi digitado continua ali');
    },
  );
});

test('a senha digitada vai para o arquivo próprio, e não para o servidores.json', async () => {
  await comFluig(
    {
      [USUARIO]: { headers: { 'content-type': 'application/json' }, body: '{"content":{"tenantId":1,"userCode":"admin"}}' },
    },
    async (url) => {
      const { hostname, port } = new URL(url);
      const r = await rodar(
        {},
        [
          t('a'),
          ...digitos('com-senha'),
          TAB,
          ...digitos(hostname),
          TAB,
          ...digitos(port),
          TAB,
          TAB,
          ...digitos('admin'),
          TAB,
          ...digitos('aSenhaSecreta'),
          ENTER,
        ],
      );

      assert.equal(r.config['com-senha']!['passwordEnv'], 'FLUIG_COM_SENHA_PASSWORD');
      assert.ok(!JSON.stringify(r.config).includes('aSenhaSecreta'), 'a senha não pode ir para o cadastro');
      assert.match(r.env, /export FLUIG_COM_SENHA_PASSWORD='aSenhaSecreta'/);
      assert.ok(!tudo(r.quadros).includes('aSenhaSecreta'), 'e não pode aparecer na tela');
    },
  );
});

test('remover tira do cadastro, e o arquivo de senhas fica como está', async () => {
  const existente = {
    fora: { host: 'h', port: 80, ssl: false, username: 'u', companyId: 1, userCode: 'u', passwordEnv: 'FLUIG_FORA_PASSWORD' },
  };
  const r = await rodar(existente, [t('x'), t('s')]);

  assert.deepEqual(r.config, {});
  assert.match(tudo(r.quadros), /removido do cadastro/);
});

test('marcar produção só grava depois da confirmação', async () => {
  const existente = {
    hml: { host: 'h', port: 80, ssl: false, username: 'u', companyId: 1, userCode: 'u', passwordEnv: 'FLUIG_HML_PASSWORD' },
  };

  // Sem confirmar, nada muda.
  const recusado = await rodar(existente, [t('p'), t('n')]);
  assert.equal(recusado.config['hml']!['prod'], undefined);

  const aceito = await rodar(existente, [t('p'), t('s')]);
  assert.equal(aceito.config['hml']!['prod'], true);
  assert.match(tudo(aceito.quadros), /PRODUÇÃO/);
});

test('importar grava os marcados e mantém o que já existe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-tui-import-'));
  try {
    mkdirSync(join(dir, 'proj/.vscode'), { recursive: true });
    writeFileSync(
      join(dir, 'proj/.vscode/servers.json'),
      JSON.stringify({
        configurations: [
          { name: 'Cliente HML', host: 'hml.cliente.com.br', port: 8021, ssl: false, username: 'integracao', companyId: 1, userCode: 'Integracao' },
          { name: 'Cliente Produção', host: 'fluig.cliente.com.br', port: 8021, ssl: false, username: 'integracao', companyId: 1, userCode: 'Integracao' },
        ],
      }),
    );

    // `i` lista, `enter` pede confirmação, `s` grava, `q` sai.
    const { config, quadros } = await rodarComDir({}, [t('i'), ENTER, t('s')], dir);

    assert.deepEqual(Object.keys(config).sort(), ['cliente-hml', 'cliente-producao']);
    assert.equal(config['cliente-producao']!['prod'], true, 'o nome de produção do candidato vira a marca');
    assert.match(tudo(quadros), /2 servidor\(es\) gravados/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Como `rodar`, mas com `--dir` (a importação precisa de um diretório de verdade). */
async function rodarComDir(
  config: Record<string, unknown>,
  teclas: Tecla[],
  dir: string,
): Promise<{ config: Record<string, { [k: string]: unknown }>; quadros: string[] }> {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-tui-'));
  const anterior = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = raiz;
  mkdirSync(join(raiz, 'fluigctl'), { recursive: true });
  writeFileSync(join(raiz, 'fluigctl/servers.json'), JSON.stringify({ version: 1, servers: config }));

  const quadros: string[] = [];
  try {
    await serverUi({ terminal: terminalDas(teclas, quadros), dir });
    const lido = JSON.parse(readFileSync(join(raiz, 'fluigctl/servers.json'), 'utf8')) as {
      servers: Record<string, { [k: string]: unknown }>;
    };
    return { config: lido.servers, quadros };
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    if (anterior === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = anterior;
  }
}

test('a tela ouve o redimensionamento e para de ouvir ao sair', async () => {
  const visto: { ouviu?: boolean; desinscreveu?: boolean; avisar?: () => void } = {};
  const quadros: string[] = [];
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-tui-'));
  const anterior = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = raiz;
  mkdirSync(join(raiz, 'fluigctl'), { recursive: true });
  writeFileSync(join(raiz, 'fluigctl/servers.json'), JSON.stringify({ version: 1, servers: {} }));

  try {
    const antes = quadros.length;
    await serverUi({ terminal: terminalDas([t('?'), t('z')], quadros, visto) });

    assert.equal(visto.ouviu, true, 'a tela precisa ouvir o SIGWINCH');
    assert.equal(visto.desinscreveu, true, 'e parar de ouvir ao sair, para não vazar ouvinte');

    // O aviso do tamanho redesenha o estado corrente, sem tecla nenhuma.
    const marco = quadros.length;
    visto.avisar!();
    assert.equal(quadros.length, marco + 1, 'o redimensionamento desenha um quadro');
    void antes;
  } finally {
    rmSync(raiz, { recursive: true, force: true });
    if (anterior === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = anterior;
  }
});
