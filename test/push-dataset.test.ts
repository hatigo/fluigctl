import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeFluig } from './helpers/fake-fluig.js';
import { pushDataset } from '../src/commands/push-dataset.js';
import type { Server } from '../src/config.js';

const WSDL = readFileSync(new URL('./fixtures/wsdl/ECMDatasetService.wsdl', import.meta.url), 'utf8');
const CAMINHO = '/webdesk/ECMDatasetService';
const IMPL = 'function createDataset(fields, constraints, sorts) { return null; }\n';

// As cópias de segurança de cada update vão para cá, nunca para o ~/.local/state real.
const ESTADO = mkdtempSync(join(tmpdir(), 'fluigctl-estado-'));
process.env['XDG_STATE_HOME'] = ESTADO;

function envelope(corpo: string): string {
  return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${corpo}</soap:Body></soap:Envelope>`;
}

const LOGIN = '/portal/api/servlet/login.do';
const LOAD = '/ecm/api/rest/ecm/dataset/loadDataset';

const LISTA = envelope(
  `<ns:findAllFormulariesDatasetsResponse xmlns:ns="http://ws.dataservice.ecm.technology.totvs.com/">
     <dataset><item><datasetId>dsSTGTEMP</datasetId><type>CUSTOM</type></item></dataset>
   </ns:findAllFormulariesDatasetsResponse>`,
);
const OK = envelope(
  `<ns:updateDatasetResponse xmlns:ns="http://ws.dataservice.ecm.technology.totvs.com/"><dataset>ok</dataset></ns:updateDatasetResponse>`,
);

async function ambiente() {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-ds-'));
  const arquivo = join(dir, 'dsSTGTEMP.js');
  writeFileSync(arquivo, IMPL);

  const fluig = await fakeFluig({
    [LOGIN]: { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } },
    [LOAD]: {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: {
          datasetPK: { datasetId: 'dsSTGTEMP' },
          datasetDescription: 'Descrição que já existia no servidor',
          datasetImpl: 'antigo',
        },
      }),
    },
    [CAMINHO]: (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL };
      return {
        headers: { 'content-type': 'text/xml' },
        body: req.body.includes('findAllFormulariesDatasets') ? LISTA : OK,
      };
    },
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

  return { fluig, arquivo, server, dir };
}

const escritas = (f: Awaited<ReturnType<typeof ambiente>>['fluig']) =>
  f.requests.filter((r) => /updateDataset|addDataset/.test(r.body));

test('push dataset atualiza o dataset existente e envia o código do arquivo', async () => {
  const a = await ambiente();

  try {
    const r = await pushDataset({
      server: a.server,
      senha: 'senha',
      arquivo: a.arquivo,
      prompt: async () => '',
    });

    assert.equal(r.acao, 'update');
    assert.equal(r.nome, 'dsSTGTEMP');
    assert.equal(escritas(a.fluig).length, 1);
    assert.match(escritas(a.fluig)[0]!.body, /createDataset/);
  } finally {
    await a.fluig.close();
  }
});

test('push dataset em dry-run não envia escrita nenhuma', async () => {
  const a = await ambiente();

  try {
    const r = await pushDataset({
      server: a.server,
      senha: 'senha',
      arquivo: a.arquivo,
      dryRun: true,
      prompt: async () => '',
    });

    assert.equal(r.acao, 'update');
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push dataset em produção não escreve quando o gate recusa', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () =>
        pushDataset({
          server: { ...a.server, prod: true },
          senha: 'senha-certa',
          arquivo: a.arquivo,
          prompt: async () => 'senha-errada',
        }),
      /não confere/i,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push dataset em produção não escreve quando não há TTY', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () =>
        pushDataset({
          server: { ...a.server, prod: true },
          senha: 'senha',
          arquivo: a.arquivo,
          prompt: async () => {
            throw new Error('sem TTY');
          },
        }),
      /interativa/i,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push dataset recusa arquivo cujo dataset não existe no servidor', async () => {
  const a = await ambiente();
  const outro = join(a.dir, 'dsNaoExiste.js');
  writeFileSync(outro, IMPL);

  try {
    await assert.rejects(
      () => pushDataset({ server: a.server, senha: 's', arquivo: outro, prompt: async () => '' }),
      /--create/,
    );
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('update sem --description preserva a descrição que está no servidor', async () => {
  // Medido no homolog da CETENCO: mandar a descrição errada a sobrescreve.
  // Sem isso, todo push apagaria a descrição do dataset do cliente.
  const a = await ambiente();

  try {
    await pushDataset({
      server: a.server, senha: 'senha', arquivo: a.arquivo, prompt: async () => '',
    });

    assert.match(
      escritas(a.fluig)[0]!.body,
      /<description>Descrição que já existia no servidor<\/description>/,
    );
  } finally {
    await a.fluig.close();
  }
});

test('update com --description explícita usa a que foi passada', async () => {
  const a = await ambiente();

  try {
    await pushDataset({
      server: a.server, senha: 'senha', arquivo: a.arquivo,
      description: 'nova descrição', prompt: async () => '',
    });

    assert.match(escritas(a.fluig)[0]!.body, /<description>nova descrição<\/description>/);
  } finally {
    await a.fluig.close();
  }
});

test('create usa a descrição passada, sem consultar o servidor', async () => {
  const a = await ambiente();
  const novo = join(a.dir, 'dsInedito.js');
  writeFileSync(novo, IMPL);

  try {
    await pushDataset({
      server: a.server, senha: 'senha', arquivo: novo, create: true,
      description: 'dataset novo', prompt: async () => '',
    });

    assert.match(escritas(a.fluig)[0]!.body, /<description>dataset novo<\/description>/);
  } finally {
    await a.fluig.close();
  }
});

/** Servidor cujo loadDataset devolve `antes` até o update e, depois, o que foi enviado. */
async function ambienteQueGrava(antes: string, gravaDiferente = false) {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-ds-'));
  const arquivo = join(dir, 'dsSTGTEMP.js');
  writeFileSync(arquivo, IMPL);
  let noServidor = antes;

  const fluig = await fakeFluig({
    [LOGIN]: { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } },
    [LOAD]: () => ({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetPK: { datasetId: 'dsSTGTEMP' }, datasetDescription: 'desc', datasetImpl: noServidor }),
    }),
    [CAMINHO]: (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL };
      if (req.body.includes('updateDataset')) noServidor = gravaDiferente ? 'outra coisa' : IMPL;
      return {
        headers: { 'content-type': 'text/xml' },
        body: req.body.includes('findAllFormulariesDatasets') ? LISTA : OK,
      };
    },
  });

  const u = new URL(fluig.url);
  const server: Server = {
    host: u.hostname, port: Number(u.port), ssl: false, username: 'integracao',
    companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_TESTE_PASSWORD',
  };
  return { fluig, arquivo, server };
}

test('update guarda cópia do que estava no servidor e confere o que ficou', async () => {
  const a = await ambienteQueGrava('codigo antigo do servidor');
  try {
    const r = await pushDataset({ server: a.server, senha: 's', arquivo: a.arquivo, prompt: async () => '' });

    assert.equal(r.jaIgual, false);
    assert.equal(r.conferido, true);
    assert.ok(r.backup?.startsWith(ESTADO), `cópia fora da pasta de estado: ${r.backup}`);
    assert.equal(readFileSync(r.backup!, 'utf8'), 'codigo antigo do servidor');
  } finally {
    await a.fluig.close();
  }
});

test('servidor que grava outra coisa sai como não conferido', async () => {
  const a = await ambienteQueGrava('antigo', true);
  try {
    const r = await pushDataset({ server: a.server, senha: 's', arquivo: a.arquivo, prompt: async () => '' });
    assert.equal(r.conferido, false);
  } finally {
    await a.fluig.close();
  }
});

test('dry-run diz quando o servidor já tem o mesmo código, sem escrever nem copiar', async () => {
  const a = await ambienteQueGrava(IMPL.replace(/\n/g, '\r\n'));
  try {
    const r = await pushDataset({ server: a.server, senha: 's', arquivo: a.arquivo, dryRun: true, prompt: async () => '' });

    assert.equal(r.jaIgual, true);
    assert.equal(r.backup, undefined);
    assert.equal(a.fluig.requests.filter((q) => /updateDataset/.test(q.body)).length, 0);
  } finally {
    await a.fluig.close();
  }
});
