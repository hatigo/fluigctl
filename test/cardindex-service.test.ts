import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fakeFluig } from './helpers/fake-fluig.js';
import { cardIndexClient } from '../src/fluig/cardindex-service.js';

const WSDL = readFileSync(
  new URL('./fixtures/wsdl/ECMCardIndexService.wsdl', import.meta.url),
  'utf8',
);
const CAMINHO = '/webdesk/ECMCardIndexService';
const NS = 'http://ws.dm.ecm.technology.totvs.com/';

const env = (c: string) =>
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${c}</soap:Body></soap:Envelope>`;

const LISTA = env(
  `<ns:getCardIndexesWithoutApproverResponse xmlns:ns="${NS}"><result>
     <item><documentId>8</documentId><documentDescription>formSolicitacaoCompras</documentDescription><datasetName>dsformSolicitacaoCompras</datasetName></item>
     <item><documentId>721291</documentId><documentDescription>Aprovadores</documentDescription><datasetName>dsAprovadores</datasetName></item>
   </result></ns:getCardIndexesWithoutApproverResponse>`,
);

const okMsg = (op: string, documentId = 8) =>
  env(
    `<ns:${op}Response xmlns:ns="${NS}"><result><item>
       <companyId>1</companyId><documentId>${documentId}</documentId>
       <version>1</version><webServiceMessage>ok</webServiceMessage>
     </item></result></ns:${op}Response>`,
  );

async function servidor(resposta: (body: string) => string) {
  return fakeFluig({
    [CAMINHO]: (req) =>
      req.method === 'GET'
        ? { headers: { 'content-type': 'text/xml' }, body: WSDL }
        : { headers: { 'content-type': 'text/xml' }, body: resposta(req.body) },
  });
}

const anexos = [
  { fileName: 'f.html', fileSize: 14, filecontent: Buffer.from('<html></html>').toString('base64'), principal: true },
  { fileName: 'js/main.js', fileSize: 5, filecontent: Buffer.from('var x').toString('base64'), principal: false },
];
const eventos = [
  { eventId: 'displayFields', eventDescription: 'function displayFields(){}', eventVersAnt: false as const },
];

test('listForms devolve documentId, descrição e dataset', async () => {
  const f = await servidor(() => LISTA);

  try {
    const c = await cardIndexClient(f.url, 1, 'u', 'p', 'colaborador');

    assert.deepEqual(await c.listForms(), [
      { documentId: 8, documentDescription: 'formSolicitacaoCompras', datasetName: 'dsformSolicitacaoCompras' },
      { documentId: 721291, documentDescription: 'Aprovadores', datasetName: 'dsAprovadores' },
    ]);
  } finally {
    await f.close();
  }
});

test('update envia os anexos com Attachments maiúsculo e fileSize em bytes', async () => {
  const f = await servidor((b) => (b.includes('getCardIndexes') ? LISTA : okMsg('updateSimpleCardIndexWithDatasetAndGeneralInfo')));

  try {
    const c = await cardIndexClient(f.url, 1, 'u', 'p', 'colaborador');
    await c.updateForm({
      documentId: 8,
      cardDescription: 'formX',
      descriptionField: '',
      datasetName: 'dsformX',
      anexos,
      eventos,
      versionOption: '0',
    });

    const xml = f.requests.find((r) => r.method === 'POST')!.body;

    assert.match(xml, /<Attachments>/, 'o part é Attachments, com A maiúsculo');
    assert.match(xml, /<fileSize>14<\/fileSize>/);
    assert.match(xml, /<fileName>js\/main\.js<\/fileName>/);
    assert.match(xml, /<principal>true<\/principal>/);
    assert.match(xml, /<generalInfo><versionOption>0<\/versionOption><\/generalInfo>/);
  } finally {
    await f.close();
  }
});

test('update manda os eventos em texto puro, não em base64', async () => {
  const f = await servidor(() => okMsg('updateSimpleCardIndexWithDatasetAndGeneralInfo'));

  try {
    const c = await cardIndexClient(f.url, 1, 'u', 'p', 'colaborador');
    await c.updateForm({
      documentId: 8, cardDescription: 'x', descriptionField: '', datasetName: 'ds',
      anexos, eventos, versionOption: '0',
    });

    const xml = f.requests.find((r) => r.method === 'POST')!.body;

    assert.match(xml, /<eventDescription>function displayFields\(\)\{\}<\/eventDescription>/);
    assert.match(xml, /<eventId>displayFields<\/eventId>/);
  } finally {
    await f.close();
  }
});

test('create devolve o documentId novo que o servidor atribuiu', async () => {
  const f = await servidor(() => okMsg('createSimpleCardIndexWithDatasetPersisteType', 23691));

  try {
    const c = await cardIndexClient(f.url, 1, 'u', 'p', 'colaborador');

    const id = await c.createForm({
      parentDocumentId: 5, documentDescription: 'formNovo', cardDescription: 'formNovo',
      datasetName: 'dsformNovo', anexos, eventos, persistenceType: 1,
    });

    assert.equal(id, 23691);
  } finally {
    await f.close();
  }
});

test('o servidor recusando com mensagem diferente de ok vira erro', async () => {
  const recusa = env(
    `<ns:updateSimpleCardIndexWithDatasetAndGeneralInfoResponse xmlns:ns="${NS}"><result><item>
       <companyId>1</companyId><documentId>8</documentId><version>1</version>
       <webServiceMessage>Erro: usuário sem permissão</webServiceMessage>
     </item></result></ns:updateSimpleCardIndexWithDatasetAndGeneralInfoResponse>`,
  );
  const f = await servidor(() => recusa);

  try {
    const c = await cardIndexClient(f.url, 1, 'u', 'p', 'colaborador');

    await assert.rejects(
      () => c.updateForm({
        documentId: 8, cardDescription: 'x', descriptionField: '', datasetName: 'ds',
        anexos, eventos, versionOption: '0',
      }),
      /sem permissão/,
    );
  } finally {
    await f.close();
  }
});
