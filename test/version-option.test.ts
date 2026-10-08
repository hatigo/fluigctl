import test from 'node:test';
import assert from 'node:assert/strict';

import { ErroFluigctl } from '../src/errors.js';
import { decideVersionOption } from '../src/push/form-resolve.js';

test('--keep-version mantém a versão ativa', () => {
  assert.equal(decideVersionOption({ keepVersion: true }), '0');
});

test('--new-version cria a próxima versão', () => {
  assert.equal(decideVersionOption({ newVersion: true }), '2');
});

test('sem nenhuma das duas, o push é recusado', () => {
  // Sobrescrever a versão ativa não pode ser o que acontece por silêncio.
  assert.throws(
    () => decideVersionOption({}),
    /--keep-version.*--new-version.*campo novo/s,
  );
});

test('a recusa por falta de escolha é erro de uso, código 2', () => {
  try {
    decideVersionOption({});
    assert.fail('deveria ter falhado');
  } catch (e) {
    assert.ok(e instanceof ErroFluigctl);
    assert.equal(e.codigo, 2);
  }
});

test('as duas juntas são recusadas', () => {
  assert.throws(
    () => decideVersionOption({ keepVersion: true, newVersion: true }),
    /ao mesmo tempo/i,
  );
});

test('na criação não se escolhe versão, porque ela não existe na operação', () => {
  assert.equal(decideVersionOption({ create: true }), undefined);
});

test('na criação, pedir versão avisa que a flag não se aplica', () => {
  assert.throws(
    () => decideVersionOption({ create: true, newVersion: true }),
    /cria(r|ção)/i,
  );
});
