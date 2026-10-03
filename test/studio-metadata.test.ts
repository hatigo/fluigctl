import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lerMetadataStudio, parseMetadataStudio } from '../src/push/studio-metadata.js';
import { decideForm } from '../src/push/form-resolve.js';
import type { FormNoServidor } from '../src/fluig/cardindex-service.js';

const fixture = (nome: string) => readFileSync(new URL(`./fixtures/studio/${nome}`, import.meta.url));

// O .metadata real de forms/formReembolso do workspace da Cetenco: exportado para o
// 676 ("Homologacao") e depois para o 902 ("homolog"), o que o processo usa.
const REEMBOLSO = parseMetadataStudio(fixture('formReembolso.metadata'));

// Como o HML da Cetenco estava: o 676 casa com o nome da pasta, o 902 não.
const HML: FormNoServidor[] = [
  { documentId: 676, documentDescription: 'formReembolso', datasetName: 'dsformReembolso' },
  { documentId: 902, documentDescription: 'formSolicitacaoReembolso', datasetName: 'dsformSolicitacaoReembolso' },
  { documentId: 677, documentDescription: 'formInternoRestricoesReembolso', datasetName: 'dsformInternoRestricoesReembolso' },
];

test('lê as exportações, o servidor da última e o arquivo principal', () => {
  assert.deepEqual(REEMBOLSO, {
    exportacoes: [
      { documentId: 676, documentDescription: 'formReembolso', cardDescription: '', serverName: 'Homologacao', serviceName: 'dsformReembolso' },
      { documentId: 902, documentDescription: 'formSolicitacaoReembolso', cardDescription: '', serverName: 'homolog', serviceName: 'dsformSolicitacaoReembolso' },
    ],
    lastServerName: 'homolog',
    principalFileName: 'formReembolso.html',
  });
});

test('lê nome de servidor com acento (homologação/produção)', () => {
  const m = parseMetadataStudio(fixture('formAprovacaoMovimento.metadata'));
  assert.deepEqual(
    m.exportacoes.map((e) => [e.documentId, e.serverName]),
    [[7, 'homologação'], [6, 'produção']],
  );
  assert.equal(m.lastServerName, 'produção');
});

test('arquivo que não é serialização Java vira "sem metadata", não erro', () => {
  assert.equal(lerMetadataStudio(Buffer.from('{"nao":"java"}')), undefined);
  assert.equal(lerMetadataStudio(Buffer.alloc(0)), undefined);
  assert.equal(lerMetadataStudio(undefined), undefined);
  assert.equal(lerMetadataStudio(fixture('formReembolso.metadata').subarray(0, 200)), undefined);
});

test('o .metadata vence o nome da pasta: formReembolso vai para o 902, não para o 676', () => {
  const d = decideForm({ nome: 'formReembolso', catalogo: HML, studio: REEMBOLSO });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 902);
  assert.match(d.avisos.join('\n'), /última exportação \("homolog"\)/);
  assert.match(d.avisos.join('\n'), /pelo nome da pasta seria o 676/);
});

test('com uma exportação só que confere, usa ela', () => {
  const studio = { ...REEMBOLSO, exportacoes: [REEMBOLSO.exportacoes[1]!] };
  const d = decideForm({ nome: 'formReembolso', catalogo: HML, studio });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 902);
});

test('documentId do .metadata que aqui é outro formulário não conta', () => {
  // Em produção o 6 é o formAprovacaoMovimento; num servidor onde o 6 é outro form, ignora.
  const m = parseMetadataStudio(fixture('formAprovacaoMovimento.metadata'));
  const catalogo: FormNoServidor[] = [
    { documentId: 6, documentDescription: 'formOutraCoisa', datasetName: 'dsformOutraCoisa' },
    { documentId: 7, documentDescription: 'formAprovacaoMovimento', datasetName: 'dsformAprovacaoMovimento' },
  ];
  const d = decideForm({ nome: 'formAprovacaoMovimento', catalogo, studio: m });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 7);
});

test('nenhum documentId do .metadata aqui: avisa e resolve pelo nome', () => {
  const catalogo: FormNoServidor[] = [
    { documentId: 50, documentDescription: 'formReembolso', datasetName: 'dsformReembolso' },
  ];
  const d = decideForm({ nome: 'formReembolso', catalogo, studio: REEMBOLSO });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 50);
  assert.match(d.avisos.join('\n'), /outro ambiente/);
});

test('duas exportações que conferem e sem desempate: para e lista', () => {
  const studio = { ...REEMBOLSO, lastServerName: 'servidor-que-nao-esta-na-lista' };
  assert.throws(
    () => decideForm({ nome: 'formReembolso', catalogo: HML, studio }),
    /nenhum desempate.*676.*902/s,
  );
});

test('--document-id continua mandando sobre o .metadata', () => {
  const d = decideForm({ nome: 'formReembolso', catalogo: HML, studio: REEMBOLSO, documentId: 676 });
  assert.deepEqual(d, { acao: 'update', documentId: 676, avisos: [] });
});

test('--create com a pasta já publicada segundo o .metadata é recusado', () => {
  assert.throws(
    () => decideForm({ nome: 'formReembolso', catalogo: HML, studio: REEMBOLSO, create: true }),
    /--create.*902/s,
  );
});
