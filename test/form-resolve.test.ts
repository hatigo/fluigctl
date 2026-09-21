import test from 'node:test';
import assert from 'node:assert/strict';

import { decideForm } from '../src/push/form-resolve.js';
import type { FormNoServidor } from '../src/fluig/cardindex-service.js';

const catalogo: FormNoServidor[] = [
  { documentId: 8, documentDescription: 'formSolicitacaoCompras', datasetName: 'dsformSolicitacaoCompras' },
  { documentId: 721291, documentDescription: 'Aprovadores', datasetName: 'dsAprovadores' },
  { documentId: 900, documentDescription: 'formCotacao', datasetName: 'dsformCotacao' },
  { documentId: 901, documentDescription: 'FormCotacao', datasetName: 'dsOutro' },
];

test('--document-id manda, quando o id existe no servidor', () => {
  const d = decideForm({ nome: 'qualquer', catalogo, documentId: 8 });

  assert.deepEqual(d, { acao: 'update', documentId: 8, avisos: [] });
});

test('--document-id que não existe no servidor é recusado', () => {
  assert.throws(
    () => decideForm({ nome: 'x', catalogo, documentId: 4242 }),
    /4242.*não existe/s,
  );
});

test('nome que casa exatamente com um formulário vira update', () => {
  const d = decideForm({ nome: 'formSolicitacaoCompras', catalogo });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 8);
});

test('o prefixo da pasta é aceito quando o id e a descrição conferem', () => {
  const d = decideForm({ nome: 'Aprovadores', catalogo, documentIdDaPasta: 721291 });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 721291);
});

test('prefixo da pasta apontando para outro formulário é recusado', () => {
  // Pasta copiada de outro projeto: o prefixo ficou para trás. Aceitar isso
  // publicaria em cima do formulário errado.
  assert.throws(
    () => decideForm({ nome: 'formSolicitacaoCompras', catalogo, documentIdDaPasta: 721291 }),
    /Aprovadores.*formSolicitacaoCompras/s,
  );
});

test('prefixo da pasta com id inexistente no servidor é ignorado, não fatal', () => {
  // O id pode ser de outro ambiente. Cai para o casamento por nome.
  const d = decideForm({ nome: 'formSolicitacaoCompras', catalogo, documentIdDaPasta: 55555 });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 8);
  assert.ok(d.avisos.some((a) => /55555/.test(a)));
});

test('nome sem correspondência é recusado com instrução de criar', () => {
  assert.throws(() => decideForm({ nome: 'formNovo', catalogo }), /--create/);
});

test('nome sem correspondência com --create vira create', () => {
  const d = decideForm({ nome: 'formNovo', catalogo, create: true });

  assert.deepEqual(d, { acao: 'create', avisos: [] });
});

test('--create num formulário que já existe é recusado', () => {
  assert.throws(
    () => decideForm({ nome: 'formSolicitacaoCompras', catalogo, create: true }),
    /já existe/,
  );
});

test('duas correspondências exigem --document-id e listam as opções', () => {
  const ambiguo: FormNoServidor[] = [
    { documentId: 10, documentDescription: 'dup', datasetName: 'a' },
    { documentId: 11, documentDescription: 'dup', datasetName: 'b' },
  ];

  assert.throws(() => decideForm({ nome: 'dup', catalogo: ambiguo }), /--document-id.*10.*11/s);
});

test('casamento por caixa diferente funciona mas avisa', () => {
  const unico: FormNoServidor[] = [
    { documentId: 8, documentDescription: 'formSolicitacaoCompras', datasetName: 'ds' },
  ];

  const d = decideForm({ nome: 'formsolicitacaocompras', catalogo: unico });

  assert.ok(d.acao === 'update');
  assert.equal(d.documentId, 8);
  assert.ok(d.avisos.some((a) => /capitaliza/i.test(a)));
});

test('duas correspondências que só diferem na caixa são recusadas', () => {
  const d = () => decideForm({ nome: 'FORMCOTACAO', catalogo });

  assert.throws(d, /--document-id/);
});
