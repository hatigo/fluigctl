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

function envelope(corpo: string): string {
  return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${corpo}</soap:Body></soap:Envelope>`;
}

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
