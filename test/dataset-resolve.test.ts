import test from 'node:test';
import assert from 'node:assert/strict';

import { decideDataset, datasetNameFromFile } from '../src/push/dataset-resolve.js';

const existentes = ['dsSTGTEMP', 'dsSTGObterProjetos', 'dsformSolicitacaoCompras'];

test('datasetNameFromFile tira o .js e ignora o diretório', () => {
  assert.equal(
    datasetNameFromFile('datasets/solicitação de compras/dsSTGObterProjetos.js'),
    'dsSTGObterProjetos',
  );
  assert.equal(datasetNameFromFile('/abs/dsSTGTEMP.js'), 'dsSTGTEMP');
});

test('datasetNameFromFile recusa arquivo que não é .js', () => {
  assert.throws(() => datasetNameFromFile('datasets/dsX.txt'), /\.js/);
});

test('dataset que existe no servidor vira update', () => {
  assert.deepEqual(decideDataset('dsSTGTEMP', existentes, false), { acao: 'update' });
});

test('dataset que não existe sem --create é recusado', () => {
  assert.throws(() => decideDataset('dsNovo', existentes, false), /--create/);
});

test('dataset que não existe com --create vira create', () => {
  assert.deepEqual(decideDataset('dsNovo', existentes, true), { acao: 'create' });
});

test('--create num dataset que já existe é recusado', () => {
  assert.throws(() => decideDataset('dsSTGTEMP', existentes, true), /já existe/);
});

test('a recusa aponta o vizinho que difere só na capitalização', () => {
  assert.throws(
    () => decideDataset('dsstgtemp', existentes, false),
    /dsSTGTEMP.*capitaliza/is,
  );
});

test('a comparação com o servidor é sensível à caixa', () => {
  // "dsstgtemp" não pode virar update de "dsSTGTEMP": são datasets distintos
  // para o Fluig, e um update no nome errado sobrescreveria outro artefato.
  assert.throws(() => decideDataset('dsstgtemp', existentes, false), /não existe/);
});
