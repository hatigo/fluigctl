import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeFluig, type RotaResposta } from './helpers/fake-fluig.js';
import { pushWidget } from '../src/commands/push-widget.js';
import type { Server } from '../src/config.js';
import { ErroFluigctl } from '../src/errors.js';
import { montarZip } from '../src/push/war.js';
import { readWidget } from '../src/push/widget-source.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/widgets/wdgExemplo', import.meta.url));
const LOGIN = '/portal/api/servlet/login.do';
const UPLOAD = '/portal/api/rest/wcmservice/rest/product/uploadfile';

/** O mapeamento da extensão Fluiggers, arquivo a arquivo, para a fixture. */
const ESPERADO: Record<string, string> = {
  'WEB-INF/jboss-web.xml': 'webapp/WEB-INF/jboss-web.xml',
  'WEB-INF/web.xml': 'webapp/WEB-INF/web.xml',
  'WEB-INF/classes/application.info': 'resources/application.info',
  'WEB-INF/classes/view.ftl': 'resources/view.ftl',
  'WEB-INF/classes/wdgExemplo.properties': 'resources/wdgExemplo.properties',
  'resources/css/wdgExemplo.css': 'webapp/resources/css/wdgExemplo.css',
  'resources/images/icon.png': 'webapp/resources/images/icon.png',
  'resources/js/wdgExemplo.js': 'webapp/resources/js/wdgExemplo.js',
};

function copiaDaFixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-wdg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pasta = join(dir, 'wdgExemplo');
  cpSync(FIXTURE, pasta, { recursive: true });
  return pasta;
}

async function ambiente(upload: RotaResposta = { body: '{"content":null}' }) {
  const fluig = await fakeFluig({
    [LOGIN]: { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } },
    [UPLOAD]: { headers: { 'content-type': 'application/json' }, ...upload },
  });

  const u = new URL(fluig.url);
  const server: Server = {
    host: u.hostname,
    port: Number(u.port),
    ssl: false,
    username: 'integracao',
    companyId: 1,
    userCode: 'Integracao.Fluig',
    passwordEnv: 'FLUIG_TESTE_PASSWORD',
  };

  return { fluig, server };
}

const uploads = (f: Awaited<ReturnType<typeof ambiente>>['fluig']) =>
  f.requests.filter((r) => r.url.startsWith(UPLOAD));

async function codigoDe(promessa: Promise<unknown>): Promise<number> {
  try {
    await promessa;
  } catch (e) {
    assert.ok(e instanceof ErroFluigctl, String(e));
    return e.codigo;
  }
  assert.fail('deveria ter falhado');
}

test('readWidget monta exatamente as entradas da extensão, com os bytes de cada arquivo', async () => {
  const widget = await readWidget(FIXTURE);

  assert.equal(widget.nome, 'wdgExemplo');
  assert.deepEqual(widget.entradas.map((e) => e.nome).sort(), Object.keys(ESPERADO).sort());
  for (const entrada of widget.entradas) {
    const origem = join(FIXTURE, 'src', 'main', ESPERADO[entrada.nome]!);
    assert.deepEqual(entrada.dados, readFileSync(origem), entrada.nome);
  }
});

test('readWidget não converte o .properties em latin1', async () => {
  // A extensão lê src/main/resources como UTF-8 e troca o "ç" (0xE7) por U+FFFD.
  const widget = await readWidget(FIXTURE);

  const props = widget.entradas.find((e) => e.nome === 'WEB-INF/classes/wdgExemplo.properties')!;
  assert.ok(props.dados.includes(0xe7));
});

test('o .war gerado é lido por um unzip comum, com o conteúdo intacto', async () => {
  const widget = await readWidget(FIXTURE);
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-war-'));
  const war = join(dir, 'wdgExemplo.war');
  writeFileSync(war, montarZip(widget.entradas));

  try {
    execFileSync('unzip', ['-tq', war]);
    const nomes = execFileSync('unzip', ['-Z1', war], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(nomes.sort(), Object.keys(ESPERADO).sort());

    for (const [nome, origem] of Object.entries(ESPERADO)) {
      const extraido = execFileSync('unzip', ['-p', war, nome]);
      assert.deepEqual(extraido, readFileSync(join(FIXTURE, 'src', 'main', origem)), nome);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readWidget recusa pasta que não é de widget, com código 3', async (t) => {
  const pasta = copiaDaFixture(t);
  rmSync(join(pasta, 'src', 'main', 'resources', 'application.info'));

  assert.equal(await codigoDe(readWidget(pasta)), 3);
});

test('readWidget tira o nome da pasta de verdade, não do texto do argumento', async () => {
  assert.equal((await readWidget(join(FIXTURE, '.'))).nome, 'wdgExemplo');
  assert.equal((await readWidget(`${FIXTURE}/.`)).nome, 'wdgExemplo');
  assert.equal((await readWidget(`${FIXTURE}/`)).nome, 'wdgExemplo');
  assert.equal((await readWidget(`${FIXTURE}/src/..`)).nome, 'wdgExemplo');
});

test('readWidget recusa caminho de onde não sai nome de widget, com código 3', async () => {
  assert.equal(await codigoDe(readWidget('/')), 3);
});

test('readWidget recusa link simbólico em vez de omiti-lo, com código 3', async (t) => {
  const pasta = copiaDaFixture(t);
  const js = join(pasta, 'src', 'main', 'webapp', 'resources', 'js');
  symlinkSync(join(js, 'wdgExemplo.js'), join(js, 'atalho.js'));

  const promessa = readWidget(pasta);
  await assert.rejects(promessa, /atalho\.js.*link simbólico/);
  assert.equal(await codigoDe(promessa), 3);
});

test('readWidget recusa link simbólico no topo de src/main/resources', async (t) => {
  const pasta = copiaDaFixture(t);
  const recursos = join(pasta, 'src', 'main', 'resources');
  symlinkSync(join(recursos, 'view.ftl'), join(recursos, 'edit.ftl'));

  assert.equal(await codigoDe(readWidget(pasta)), 3);
});

test('push widget envia o .war com a sessão do login e os campos da extensão', async () => {
  const a = await ambiente();

  try {
    const r = await pushWidget({
      server: a.server,
      senha: 'senha',
      pasta: FIXTURE,
      prompt: async () => '',
    });

    assert.equal(r.nome, 'wdgExemplo');
    assert.equal(r.entradas, Object.keys(ESPERADO).length);

    const [envio] = uploads(a.fluig);
    assert.ok(envio);
    assert.equal(envio.method, 'POST');
    assert.equal(envio.headers.cookie, 'JSESSIONID=abc');
    assert.equal(envio.headers.accept, 'application/json');

    const campos = await new Response(new Uint8Array(envio.corpo), {
      headers: { 'content-type': String(envio.headers['content-type']) },
    }).formData();
    assert.equal(campos.get('fileName'), 'wdgExemplo.war');
    assert.equal(campos.get('fileDescription'), 'WCM Eclipse Plugin Deploy Artifact');

    const anexo = campos.get('attachment');
    assert.ok(anexo instanceof File);
    assert.equal(anexo.name, 'wdgExemplo.war');
    assert.equal(anexo.size, r.bytes);
    assert.equal(Buffer.from(await anexo.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  } finally {
    await a.fluig.close();
  }
});

test('push widget com "message" na resposta falha com código 7 e a mensagem do servidor', async () => {
  const a = await ambiente({ body: JSON.stringify({ message: { message: 'widget inválida' } }) });

  try {
    const promessa = pushWidget({ server: a.server, senha: 's', pasta: FIXTURE, prompt: async () => '' });
    await assert.rejects(promessa, /widget inválida/);
    assert.equal(await codigoDe(promessa), 7);
  } finally {
    await a.fluig.close();
  }
});

test('push widget com HTTP de erro falha com código 7', async () => {
  const a = await ambiente({ status: 500, body: 'erro interno' });

  try {
    assert.equal(
      await codigoDe(pushWidget({ server: a.server, senha: 's', pasta: FIXTURE, prompt: async () => '' })),
      7,
    );
  } finally {
    await a.fluig.close();
  }
});

test('push widget recusa widget com código Java antes de qualquer requisição', async (t) => {
  const a = await ambiente();
  const pasta = copiaDaFixture(t);
  mkdirSync(join(pasta, 'src', 'main', 'java', 'com', 'exemplo'), { recursive: true });
  writeFileSync(join(pasta, 'src', 'main', 'java', 'com', 'exemplo', 'Rest.java'), 'class Rest {}\n');

  try {
    const promessa = pushWidget({ server: a.server, senha: 's', pasta, prompt: async () => '' });
    await assert.rejects(promessa, /Maven/);
    assert.equal(await codigoDe(promessa), 6);
    assert.equal(a.fluig.requests.length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push widget em dry-run monta o pacote e não envia nada', async () => {
  const a = await ambiente();

  try {
    const r = await pushWidget({
      server: a.server,
      senha: 's',
      pasta: FIXTURE,
      dryRun: true,
      prompt: async () => '',
    });

    assert.equal(r.entradas, Object.keys(ESPERADO).length);
    assert.equal(r.url, `${a.fluig.url}${UPLOAD}`);
    assert.equal(a.fluig.requests.length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push widget em produção sem TTY falha com código 5 e não envia', async () => {
  const a = await ambiente();

  try {
    const codigo = await codigoDe(
      pushWidget({
        server: { ...a.server, prod: true },
        senha: 's',
        pasta: FIXTURE,
        prompt: async () => {
          throw new Error('sem TTY');
        },
      }),
    );

    assert.equal(codigo, 5);
    assert.equal(uploads(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});
