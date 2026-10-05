import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listarWidgets, pullWidget } from '../src/commands/pull.js';
import type { WidgetHelperClient } from '../src/fluig/widget-helper.js';
import { ErroFluigctl } from '../src/errors.js';
import { entradasDoZip } from '../src/push/zip.js';
import { montarZip } from '../src/push/war.js';
import { lerWcm } from '../src/push/wcm-source.js';
import { desmontarWar } from '../src/pull/widget-war.js';
import type { Server } from '../src/config.js';

const SERVER: Server = {
  host: 'fluig.local', port: 8080, ssl: false, username: 'integracao',
  companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
};

const codigoDe = (erro: unknown) => (erro as ErroFluigctl).codigo;

/** Um `.war` de widget com as entradas que o Studio costuma gerar. */
function warDaWidget(): Buffer {
  return montarZip([
    { nome: 'META-INF/MANIFEST.MF', dados: Buffer.from('Manifest-Version: 1.0\n') },
    { nome: 'WEB-INF/web.xml', dados: Buffer.from('<web-app/>\n') },
    { nome: 'WEB-INF/jboss-web.xml', dados: Buffer.from('<jboss-web/>\n') },
    { nome: 'WEB-INF/classes/application.info', dados: Buffer.from('application.type=widget\napplication.code=wdgX\n', 'latin1') },
    { nome: 'WEB-INF/classes/view.ftl', dados: Buffer.from('<#-- view -->\n') },
    { nome: 'resources/js/wdgX.js', dados: Buffer.from('function wdgX() {}\n') },
    { nome: 'resources/css/wdgX.css', dados: Buffer.from('.wdgX {}\n') },
  ]);
}

function fakeHelper(war: Buffer, lista?: { code: string; title: string; description: string; filename: string }[]) {
  const widget = { code: 'wdgX', title: 'Widget X', description: 'Teste', filename: 'wdgX.war' };
  return {
    instalada: async () => true,
    listar: async () => lista ?? [widget],
    baixar: async () => war,
  } satisfies WidgetHelperClient;
}

test('desmontarWar põe cada entrada no mesmo lugar que o push widget lê de volta', () => {
  const { arquivos, ignorados, compilados } = desmontarWar(entradasDoZip(warDaWidget(), 'o pacote'), 'wdgX');

  assert.deepEqual(
    arquivos.map((a) => a.caminho),
    [
      'src/main/webapp/WEB-INF/web.xml',
      'src/main/webapp/WEB-INF/jboss-web.xml',
      'src/main/resources/application.info',
      'src/main/resources/view.ftl',
      'src/main/webapp/resources/js/wdgX.js',
      'src/main/webapp/resources/css/wdgX.css',
    ],
  );
  // O manifesto é do empacotamento, não do código: fica de fora, mas é dito.
  assert.deepEqual(ignorados, ['META-INF/MANIFEST.MF']);
  assert.deepEqual(compilados, []);
});

test('desmontarWar guarda as classes em src/main/java e diz que o push recusa a pasta', () => {
  const war = montarZip([
    { nome: 'WEB-INF/classes/application.info', dados: Buffer.from('application.type=widget\na=1') },
    { nome: 'WEB-INF/classes/com/acme/wdg/Service.class', dados: Buffer.from([0xca, 0xfe, 0xba, 0xbe]) },
    { nome: 'pom.xml', dados: Buffer.from('<project/>') },
  ]);
  const { arquivos, compilados } = desmontarWar(entradasDoZip(war, 'o pacote'), 'wdgX');

  assert.deepEqual(compilados, ['src/main/java/com/acme/wdg/Service.class']);
  assert.equal(arquivos.find((a) => a.caminho === 'pom.xml')?.dados.toString(), '<project/>');
});

test('desmontarWar recusa caminho que sairia da pasta da widget, em vez de normalizar', () => {
  const war = montarZip([{ nome: 'resources/../../fora.js', dados: Buffer.from('x') }]);
  assert.throws(
    () => desmontarWar(entradasDoZip(war, 'o pacote'), 'wdgX'),
    (e) => codigoDe(e) === 6 && /sairia da pasta da widget/.test((e as Error).message),
  );
});

test('desmontarWar recusa duas entradas para o mesmo destino', () => {
  const war = montarZip([
    { nome: 'WEB-INF/classes/a.info', dados: Buffer.from('1') },
    { nome: 'WEB-INF/classes/./a.info', dados: Buffer.from('2') },
  ]);
  assert.throws(() => desmontarWar(entradasDoZip(war, 'o pacote'), 'wdgX'), (e) => codigoDe(e) === 6);
});

test('pull widget grava a árvore da widget em wcm/widget/<code>, byte a byte', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  const r = await pullWidget({
    server: SERVER, senha: 's', nome: 'wdgX', raiz,
    cliente: fakeHelper(warDaWidget()),
  });

  assert.equal(r.code, 'wdgX');
  assert.equal(
    readFileSync(join(raiz, 'wcm/widget/wdgX/src/main/resources/application.info'), 'latin1'),
    'application.type=widget\napplication.code=wdgX\n',
  );
  assert.equal(
    readFileSync(join(raiz, 'wcm/widget/wdgX/src/main/webapp/resources/js/wdgX.js'), 'utf8'),
    'function wdgX() {}\n',
  );
  assert.deepEqual(r.ignorados, ['META-INF/MANIFEST.MF']);
  assert.deepEqual(r.gravados.length, 6);
});

test('pull widget: igual fica, diferente não é tocado sem --overwrite e nada é gravado', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  const pasta = join(raiz, 'wcm/widget/wdgX');
  mkdirSync(join(pasta, 'src/main/webapp/resources/js'), { recursive: true });
  writeFileSync(join(pasta, 'src/main/webapp/resources/js/wdgX.js'), 'function wdgX() { antigo(); }\n');

  const cliente = fakeHelper(warDaWidget());
  const previa = await pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, dryRun: true, cliente });
  assert.deepEqual(previa.diferentes, ['wcm/widget/wdgX/src/main/webapp/resources/js/wdgX.js']);
  assert.deepEqual(previa.gravados, []);

  await assert.rejects(
    pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, cliente }),
    (e) => codigoDe(e) === 6,
  );
  assert.equal(readFileSync(join(pasta, 'src/main/webapp/resources/js/wdgX.js'), 'utf8'), 'function wdgX() { antigo(); }\n');

  const r = await pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, sobrescrever: true, cliente });
  // Os cinco que faltavam nascem agora, e o único diferente é trocado pelo do servidor.
  assert.equal(r.gravados.length, 6);
  assert.ok(r.gravados.includes('wcm/widget/wdgX/src/main/webapp/resources/js/wdgX.js'));
  assert.equal(readFileSync(join(pasta, 'src/main/webapp/resources/js/wdgX.js'), 'utf8'), 'function wdgX() {}\n');
});

test('pull widget lista o que só existe no local, sem apagar nada', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  const pasta = join(raiz, 'wcm/widget/wdgX');
  mkdirSync(join(pasta, 'src/main/java/com/acme'), { recursive: true });
  writeFileSync(join(pasta, 'src/main/java/com/acme/MeuService.java'), 'class MeuService {}\n');

  const r = await pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, cliente: fakeHelper(warDaWidget()) });

  assert.deepEqual(r.soLocais, ['src/main/java/com/acme/MeuService.java']);
  assert.equal(readFileSync(join(pasta, 'src/main/java/com/acme/MeuService.java'), 'utf8'), 'class MeuService {}\n');
});

test('pull widget avisa quando o pacote tem classe compilada, que o push não republica', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  const war = montarZip([
    { nome: 'WEB-INF/classes/application.info', dados: Buffer.from('application.type=widget\na=1') },
    { nome: 'WEB-INF/classes/com/acme/S.class', dados: Buffer.from([0xca]) },
  ]);
  const r = await pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, cliente: fakeHelper(war) });
  assert.match(r.avisos.join(' '), /compilado\(s\).*src\/main\/java/);
});

test('pull widget de uma widget inexistente lista as instaladas: código 3', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  await assert.rejects(
    pullWidget({ server: SERVER, senha: 's', nome: 'wdgNaoExiste', raiz, cliente: fakeHelper(warDaWidget()) }),
    (e) => codigoDe(e) === 3 && /wdgX/.test((e as Error).message),
  );
});

test('pull widget sem a auxiliar no servidor recusa apontando o --instalar-helper', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  const semAuxiliar: WidgetHelperClient = {
    instalada: async () => false,
    listar: async () => [],
    baixar: async () => Buffer.alloc(0),
  };
  await assert.rejects(
    pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, cliente: semAuxiliar }),
    (e) => codigoDe(e) === 3 && /--instalar-helper/.test((e as Error).message),
  );
});

test('o que o pull grava volta pelo push widget: só o que o empacotamento gera fica de fora', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-rt-'));
  const original = warDaWidget();
  await pullWidget({ server: SERVER, senha: 's', nome: 'wdgX', raiz, cliente: fakeHelper(original) });

  const fonte = await lerWcm(join(raiz, 'wcm/widget/wdgX'), 'widget');
  const deVolta = entradasDoZip(montarZip(fonte.entradas), 'o pacote').map((e) => e.nome);
  const deIda = entradasDoZip(original, 'o pacote').map((e) => e.nome);

  // A ordem das entradas no .war não importa: o lerWcm ordena ao empacotar.
  assert.deepEqual(deVolta.sort(), deIda.filter((n) => n !== 'META-INF/MANIFEST.MF').sort());
});

test('pull widget com --instalar-helper em dry-run recusa, porque publicar contraria o dry-run', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-pull-widget-'));
  const semAuxiliar: WidgetHelperClient = {
    instalada: async () => false,
    listar: async () => [],
    baixar: async () => Buffer.alloc(0),
  };
  await assert.rejects(
    pullWidget({
      server: SERVER, senha: 's', nome: 'wdgX', raiz, dryRun: true, instalarHelper: true,
      cliente: semAuxiliar,
    }),
    (e) => codigoDe(e) === 3 && /dry-run não publica nada/.test((e as Error).message),
  );
});

test('listarWidgets devolve o que a auxiliar informa, sem tocar no disco', async () => {
  const lista = await listarWidgets({
    server: SERVER, senha: 's',
    cliente: fakeHelper(warDaWidget(), [
      { code: 'wdgX', title: 'Widget X', description: 'Teste', filename: 'wdgX.war' },
      { code: 'wdgY', title: 'Widget Y', description: '', filename: 'wdgY.war' },
    ]),
  });
  assert.deepEqual(lista, [
    { code: 'wdgX', title: 'Widget X', description: 'Teste' },
    { code: 'wdgY', title: 'Widget Y', description: '' },
  ]);
});

test('entradasDoZip lê o .war gerado pelo push widget — ida e volta do mesmo pacote', () => {
  const entradas = entradasDoZip(warDaWidget(), 'o pacote');
  assert.deepEqual(
    entradas.map((e) => e.nome),
    ['META-INF/MANIFEST.MF', 'WEB-INF/web.xml', 'WEB-INF/jboss-web.xml', 'WEB-INF/classes/application.info',
     'WEB-INF/classes/view.ftl', 'resources/js/wdgX.js', 'resources/css/wdgX.css'],
  );
  assert.equal(entradas[3]!.dados.toString('latin1'), 'application.type=widget\napplication.code=wdgX\n');
});
