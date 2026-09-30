import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { fakeFluig } from './helpers/fake-fluig.js';
import { pushForm } from '../src/commands/push-form.js';
import type { Server } from '../src/config.js';

const WSDL = readFileSync(new URL('./fixtures/wsdl/ECMCardIndexService.wsdl', import.meta.url), 'utf8');
const CAMINHO = '/webdesk/ECMCardIndexService';
const NS = 'http://ws.dm.ecm.technology.totvs.com/';

const env = (c: string) =>
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${c}</soap:Body></soap:Envelope>`;

const LISTA = env(
  `<ns:getCardIndexesWithoutApproverResponse xmlns:ns="${NS}"><result>
     <item><documentId>8</documentId><documentDescription>formSolicitacaoCompras</documentDescription><datasetName>dsformSolicitacaoCompras</datasetName></item>
     <item><documentId>902</documentId><documentDescription>formSolicitacaoReembolso</documentDescription><datasetName>dsformSolicitacaoReembolso</datasetName></item>
   </result></ns:getCardIndexesWithoutApproverResponse>`,
);
const okMsg = (op: string, id = 8) =>
  env(`<ns:${op}Response xmlns:ns="${NS}"><result><item><companyId>1</companyId><documentId>${id}</documentId><version>1</version><webServiceMessage>ok</webServiceMessage></item></result></ns:${op}Response>`);

function pasta(nome: string): string {
  return fileURLToPath(new URL(`./fixtures/forms/${nome}`, import.meta.url));
}

async function ambiente() {
  const fluig = await fakeFluig({
    [CAMINHO]: (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL };
      const op = req.body.includes('createSimpleCardIndex')
        ? 'createSimpleCardIndexWithDatasetPersisteType'
        : 'updateSimpleCardIndexWithDatasetAndGeneralInfo';
      return {
        headers: { 'content-type': 'text/xml' },
        body: req.body.includes('getCardIndexes') ? LISTA : okMsg(op, op.startsWith('create') ? 23691 : 8),
      };
    },
  });

  const u = new URL(fluig.url);
  const server: Server = {
    host: u.hostname, port: Number(u.port), ssl: false, username: 'integracao',
    companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
  };

  return { fluig, server };
}

const escritas = (f: Awaited<ReturnType<typeof ambiente>>['fluig']) =>
  f.requests.filter((r) => /SimpleCardIndex/.test(r.body));

test('push form atualiza o formulário que casa pelo nome da pasta', async () => {
  const a = await ambiente();

  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0', prompt: async () => '',
    });

    assert.equal(r.acao, 'update');
    assert.equal(r.documentId, 8);
    assert.equal(r.anexos, 3);
    assert.equal(r.eventos, 2);
    assert.equal(escritas(a.fluig).length, 1);
  } finally {
    await a.fluig.close();
  }
});

test('push form não publica o .metadata junto', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0', prompt: async () => '',
    });

    assert.equal(escritas(a.fluig)[0]!.body.includes('.metadata'), false);
  } finally {
    await a.fluig.close();
  }
});

test('push form em dry-run não envia escrita nenhuma', async () => {
  const a = await ambiente();

  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'),
      versionOption: '0', dryRun: true, prompt: async () => '',
    });

    assert.equal(r.acao, 'update');
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form em produção não escreve quando o gate recusa', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () => pushForm({
        server: { ...a.server, prod: true }, senha: 'certa',
        pasta: pasta('formSolicitacaoCompras'), versionOption: '0', prompt: async () => 'errada',
      }),
      /não confere/i,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form recusa criar sem os parâmetros que não dá para adivinhar', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () => pushForm({
        server: a.server, senha: 's', pasta: pasta('formNovoSimples'),
        create: true, prompt: async () => '',
      }),
      /--parent-id|--dataset-name|--persistence-type/,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form cria e devolve o documentId novo do servidor', async () => {
  const a = await ambiente();

  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formNovoSimples'),
      create: true, parentId: 5, datasetName: 'dsformEditalFiart',
      persistenceType: 'form', prompt: async () => '',
    });

    assert.equal(r.acao, 'create');
    assert.equal(r.documentId, 23691);
  } finally {
    await a.fluig.close();
  }
});

test('push form manda versionOption 2 quando se pede nova versão', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'),
      versionOption: '2', prompt: async () => '',
    });

    assert.match(escritas(a.fluig)[0]!.body, /<versionOption>2<\/versionOption>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form recusa atualizar sem escolha de versão, sem escrever nada', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () => pushForm({
        server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'),
        prompt: async () => '',
      }),
      /--keep-version|--new-version/,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form com --description mantém a descrição do servidor em vez do nome da pasta', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0',
      description: 'outroNome', prompt: async () => '',
    });
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<cardDescription>outroNome<\/cardDescription>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form na atualização mantém o dataset do servidor em vez de ds<pasta>', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), documentId: 902, versionOption: '2',
      prompt: async () => '',
    });
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<datasetName>dsformSolicitacaoReembolso<\/datasetName>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form com --dataset-name na atualização usa o nome informado', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0',
      datasetName: 'dsOutro', prompt: async () => '',
    });
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<datasetName>dsOutro<\/datasetName>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form recusa, sem escrever, dataset que já é de outro formulário', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      pushForm({
        server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), documentId: 902, versionOption: '0',
        datasetName: 'dsformSolicitacaoCompras', prompt: async () => '',
      }),
      (e: Error & { codigo?: number }) => e.codigo === 6 && /dsformSolicitacaoCompras/.test(e.message) && /8/.test(e.message),
    );
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});
