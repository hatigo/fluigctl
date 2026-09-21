import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fakeFluig } from './helpers/fake-fluig.js';
import { datasetClient } from '../src/fluig/dataset-service.js';

const WSDL = readFileSync(new URL('./fixtures/wsdl/ECMDatasetService.wsdl', import.meta.url), 'utf8');
const CAMINHO = '/webdesk/ECMDatasetService';

function envelope(corpo: string): string {
  return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${corpo}</soap:Body></soap:Envelope>`;
}

const RESPOSTA_LISTA = envelope(
  `<ns:findAllFormulariesDatasetsResponse xmlns:ns="http://ws.dataservice.ecm.technology.totvs.com/">
     <dataset><item><datasetId>dsSTGTEMP</datasetId><type>CUSTOM</type></item>
              <item><datasetId>colleague</datasetId><type>DEFAULT</type></item>
              <item><datasetId>dsSTGObterProjetos</datasetId><type>CUSTOM</type></item></dataset>
   </ns:findAllFormulariesDatasetsResponse>`,
);

const RESPOSTA_UPDATE = envelope(
  `<ns:updateDatasetResponse xmlns:ns="http://ws.dataservice.ecm.technology.totvs.com/"><dataset>ok</dataset></ns:updateDatasetResponse>`,
);

async function servidorSoap(resposta: string) {
  return fakeFluig({
    [CAMINHO]: (req) =>
      req.method === 'GET'
        ? { headers: { 'content-type': 'text/xml' }, body: WSDL }
        : { headers: { 'content-type': 'text/xml' }, body: resposta },
  });
}

test('listCustom devolve só os datasets CUSTOM, pelo campo datasetId', async () => {
  const fluig = await servidorSoap(RESPOSTA_LISTA);

  try {
    const cliente = await datasetClient(fluig.url, 1, 'integracao', 'senha');

    assert.deepEqual(await cliente.listCustom(), ['dsSTGTEMP', 'dsSTGObterProjetos']);
  } finally {
    await fluig.close();
  }
});

test('o endpoint usado é o do servidor alvo, não o do soap:address do WSDL', async () => {
  // O WSDL de fixture aponta para 4.201.225.233. Se o cliente respeitasse esse
  // endereço, um push num servidor escreveria em outro.
  const fluig = await servidorSoap(RESPOSTA_LISTA);

  try {
    const cliente = await datasetClient(fluig.url, 1, 'integracao', 'senha');
    await cliente.listCustom();

    const post = fluig.requests.find((r) => r.method === 'POST');
    assert.ok(post, 'nenhum POST chegou ao servidor alvo');
  } finally {
    await fluig.close();
  }
});

test('update envia os parâmetros na ordem e com os nomes do WSDL', async () => {
  const fluig = await servidorSoap(RESPOSTA_UPDATE);

  try {
    const cliente = await datasetClient(fluig.url, 7, 'integracao', 'senha');
    await cliente.update('dsSTGTEMP', 'Temporário', 'function createDataset(){}');

    const xml = fluig.requests.find((r) => r.method === 'POST')!.body;

    assert.match(xml, /<companyId>7<\/companyId>/);
    assert.match(xml, /<username>integracao<\/username>/);
    assert.match(xml, /<name>dsSTGTEMP<\/name>/);
    assert.match(xml, /<impl>function createDataset\(\)\{\}<\/impl>/);

    const ordem = ['companyId', 'username', 'password', 'name', 'description', 'impl']
      .map((p) => xml.indexOf(`<${p}>`));
    assert.deepEqual(ordem, [...ordem].sort((a, b) => a - b), 'ordem dos parts divergiu do WSDL');
  } finally {
    await fluig.close();
  }
});

test('a senha não aparece em nenhuma mensagem de erro do cliente', async () => {
  const fluig = await fakeFluig({
    [CAMINHO]: (req) =>
      req.method === 'GET'
        ? { headers: { 'content-type': 'text/xml' }, body: WSDL }
        : { status: 500, body: envelope('<soap:Fault><faultstring>erro interno</faultstring></soap:Fault>') },
  });

  try {
    const cliente = await datasetClient(fluig.url, 1, 'integracao', 'senha-secretissima');
    const erro = await cliente.update('dsX', 'd', 'i').catch((e: Error) => e);

    assert.ok(erro instanceof Error);
    assert.equal(erro.message.includes('senha-secretissima'), false);
  } finally {
    await fluig.close();
  }
});

test('listCustom lida com o caso de um único item, que não vem como array', async () => {
  // node-soap desembrulha <item> repetido em array, mas um <item> sozinho vira
  // objeto. Sem normalizar, um servidor com um só dataset custom quebra o push.
  const UM = envelope(
    `<ns:findAllFormulariesDatasetsResponse xmlns:ns="http://ws.dataservice.ecm.technology.totvs.com/">
       <dataset><item><datasetId>dsUnico</datasetId><type>CUSTOM</type></item></dataset>
     </ns:findAllFormulariesDatasetsResponse>`,
  );
  const fluig = await servidorSoap(UM);

  try {
    const cliente = await datasetClient(fluig.url, 1, 'integracao', 'senha');

    assert.deepEqual(await cliente.listCustom(), ['dsUnico']);
  } finally {
    await fluig.close();
  }
});

test('listCustom devolve lista vazia quando o servidor não tem dataset custom', async () => {
  const VAZIO = envelope(
    `<ns:findAllFormulariesDatasetsResponse xmlns:ns="http://ws.dataservice.ecm.technology.totvs.com/"></ns:findAllFormulariesDatasetsResponse>`,
  );
  const fluig = await servidorSoap(VAZIO);

  try {
    const cliente = await datasetClient(fluig.url, 1, 'integracao', 'senha');

    assert.deepEqual(await cliente.listCustom(), []);
  } finally {
    await fluig.close();
  }
});
