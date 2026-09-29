import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aplicarScripts,
  eventosDoProcesso,
  removerIdsDasEntidadesFilhas,
  semDeclaracaoXml,
} from '../src/push/process-events.js';
import { primeiroXmlDoZip } from '../src/push/zip.js';
import { zipDeUmArquivo } from './helpers/zip.js';

const evento = (id: string, codigo: string) => `
    <WorkflowProcessEvent>
      <workflowProcessEventPK>
        <companyId>1</companyId>
        <eventId>${id}</eventId>
        <processId>reembolso</processId>
        <version>6</version>
      </workflowProcessEventPK>
      <eventDescription>${codigo}</eventDescription>
    </WorkflowProcessEvent>`;

const DEFINICAO = `<?xml version="1.0" encoding="ISO-8859-1"?><list><ProcessDefinition>
  <ConditionProcessAutomaticRules>
      <id>4711</id>
      <field>comprovantesValidos</field>
  </ConditionProcessAutomaticRules>
  <ProcessStateService>
    <id>12</id>
    <serviceName></serviceName>
  </ProcessStateService>
  ${evento('servicetask13', 'function servicetask13() {\n\tif (a &amp;&amp; b &lt; 2) { return &quot;x&quot;; }\n}')}
  ${evento('servicetask27', 'function servicetask27() {}')}
  ${evento('beforeStateEntry', 'function beforeStateEntry(s) {}')}
</ProcessDefinition></list>`;

test('lê os eventos decodificando as entidades do XML', () => {
  const eventos = eventosDoProcesso(DEFINICAO);
  assert.deepEqual(eventos.map((e) => e.eventId), ['servicetask13', 'servicetask27', 'beforeStateEntry']);
  assert.equal(eventos[0]?.codigo, 'function servicetask13() {\n\tif (a && b < 2) { return "x"; }\n}');
});

test('troca só o evento que mudou e classifica os demais', () => {
  const scripts = new Map([
    ['servicetask13', 'function servicetask13() {\n\tif (a && b < 2) { return "x"; }\n}\n'], // igual (só o \n final)
    ['servicetask27', 'function servicetask27() { return "nº 5"; }'],
    ['servicetask99', 'function servicetask99() {}'],
  ]);

  const r = aplicarScripts(DEFINICAO, scripts);

  assert.deepEqual(r.alterados, ['servicetask27']);
  assert.deepEqual(r.iguais, ['servicetask13']);
  assert.deepEqual(r.semScriptLocal, ['beforeStateEntry']);
  assert.deepEqual(r.semEventoNoServidor, ['servicetask99']);
  assert.equal(eventosDoProcesso(r.xml)[1]?.codigo, 'function servicetask27() { return "nº 5"; }');
  // O resto da definição fica byte a byte igual.
  assert.equal(r.xml.replace(/servicetask27\(\) \{[^<]*/, ''), DEFINICAO.replace(/servicetask27\(\) \{[^<]*/, ''));
});

test('escapa o código para XML e o que não cabe em latin1 vira referência numérica', () => {
  const r = aplicarScripts(DEFINICAO, new Map([['servicetask27', 'if (a && b < c > d) { log("ok ✅"); }\r\n']]));
  const bloco = /<eventId>servicetask27<\/eventId>[\s\S]*?<eventDescription>([\s\S]*?)<\/eventDescription>/.exec(r.xml)?.[1];

  assert.equal(bloco, 'if (a &amp;&amp; b &lt; c &gt; d) { log(&quot;ok &#9989;&quot;); }\n');
  assert.equal(eventosDoProcesso(r.xml)[1]?.codigo, 'if (a && b < c > d) { log("ok ✅"); }\n');
  assert.ok(Buffer.from(r.xml, 'latin1').toString('latin1') === r.xml, 'a definição continua representável em latin1');
});

test('caractere fora do latin1 que o Studio gravou como "?" não conta como alteração', () => {
  const noServidor = aplicarScripts(DEFINICAO, new Map([['servicetask27', 'function servicetask27() {}']])).xml
    .replace('function servicetask27() {}', '// ajuste ? comentário\nfunction servicetask27() {}');
  const r = aplicarScripts(noServidor, new Map([['servicetask27', '// ajuste — comentário\nfunction servicetask27() {}']]));
  assert.deepEqual(r.iguais.includes('servicetask27'), true);
  assert.deepEqual(r.alterados, []);
});

test('código com "$&" não é interpretado como padrão de substituição', () => {
  const r = aplicarScripts(DEFINICAO, new Map([['servicetask27', 'x.replace(/a/, "$&$1");']]));
  assert.equal(eventosDoProcesso(r.xml)[1]?.codigo, 'x.replace(/a/, "$&$1");');
});

test('remove o <id> das entidades filhas e a declaração <?xml?>', () => {
  const limpo = removerIdsDasEntidadesFilhas(semDeclaracaoXml(DEFINICAO));
  assert.ok(limpo.startsWith('<list>'));
  assert.doesNotMatch(limpo, /<id>4711<\/id>|<id>12<\/id>/);
  assert.match(limpo, /<field>comprovantesValidos<\/field>/);
});

test('abre o ZIP do export, comprimido ou não, preservando os bytes latin1', () => {
  const xml = Buffer.from('<list>Solicitação nº 1</list>', 'latin1');
  assert.deepEqual(primeiroXmlDoZip(zipDeUmArquivo('reembolso.xml', xml), 'reembolso'), xml);
  assert.deepEqual(primeiroXmlDoZip(zipDeUmArquivo('reembolso.xml', xml, false), 'reembolso'), xml);
  assert.throws(() => primeiroXmlDoZip(Buffer.from('nao e zip'), 'reembolso'), /não é um ZIP/);
  assert.throws(() => primeiroXmlDoZip(zipDeUmArquivo('leia.txt', xml), 'reembolso'), /não contém um \.xml/);
});
