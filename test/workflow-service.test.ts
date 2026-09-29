import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fakeFluig } from './helpers/fake-fluig.js';
import { zipDeUmArquivo } from './helpers/zip.js';
import { workflowEngineClient } from '../src/fluig/workflow-service.js';

const WSDL = readFileSync(new URL('./fixtures/wsdl/ECMWorkflowEngineService.wsdl', import.meta.url), 'utf8');
const CAMINHO = '/webdesk/ECMWorkflowEngineService';

const env = (c: string) =>
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${c}</soap:Body></soap:Envelope>`;
const resposta = (op: string, corpo: string) =>
  env(`<ns1:${op}Response xmlns:ns1="http://ws.workflow.ecm.technology.totvs.com/">${corpo}</ns1:${op}Response>`);

const XML = Buffer.from('<list><stateName>Aprovação</stateName></list>', 'latin1');

async function ambiente() {
  const fluig = await fakeFluig({
    [CAMINHO]: (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL };
      const b = req.body;
      const corpo = b.includes('getAllProcessAvailableToExport')
        ? resposta('getAllProcessAvailableToExport', '<result><item><processId>reembolso</processId></item><item><processId>outro</processId></item></result>')
        : b.includes('exportProcessInZipFormat')
          ? resposta('exportProcessInZipFormat', `<result>${zipDeUmArquivo('reembolso.xml', XML).toString('base64')}</result>`)
          : b.includes('releaseProcess')
            ? resposta('releaseProcess', '<result>ok=true</result>')
            : b.includes('importProcess')
              ? resposta('importProcess', '<result>Processo importado</result>')
              : resposta('createWorkFlowProcessVersion', '<result>ok</result>');
      return { headers: { 'content-type': 'text/xml' }, body: corpo };
    },
  });
  const cliente = await workflowEngineClient(fluig.url, 1, 'integracao', 'segredo', 'Integracao.Fluig');
  return { fluig, cliente };
}

test('lista, exporta pelo ZIP e libera', async () => {
  const a = await ambiente();
  try {
    assert.deepEqual(await a.cliente.listProcessIds(), ['reembolso', 'outro']);
    assert.deepEqual(await a.cliente.exportProcess('reembolso'), XML);
    assert.deepEqual(await a.cliente.releaseProcess('reembolso'), { ok: true, mensagem: 'ok=true' });
  } finally {
    await a.fluig.close();
  }
});

test('o import manda a definição em base64 como anexo principal, sobrescrevendo', async () => {
  const a = await ambiente();
  try {
    assert.equal(await a.cliente.importProcess('reembolso', XML), 'Processo importado');
    const corpo = a.fluig.requests.find((r) => r.body.includes('importProcess'))!.body;
    assert.match(corpo, /<fileName>reembolso\.xml<\/fileName>/);
    assert.ok(corpo.includes(`<filecontent>${XML.toString('base64')}</filecontent>`), 'conteúdo em base64 do buffer latin1');
    assert.match(corpo, /<principal>true<\/principal>/);
    assert.match(corpo, /<newProcess>false<\/newProcess>/);
    assert.match(corpo, /<overWrite>true<\/overWrite>/);
    assert.match(corpo, /<colleagueId>Integracao\.Fluig<\/colleagueId>/);
  } finally {
    await a.fluig.close();
  }
});
