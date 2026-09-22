import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFluig } from './helpers/fake-fluig.js';
import { loadDatasetDescription } from '../src/fluig/dataset-service.js';

const LOAD = '/ecm/api/rest/ecm/dataset/loadDataset';

test('lê a descrição quando o servidor devolve o objeto sem envelope', async () => {
  // Formato do CETENCO HML: o dataset vem na raiz, sem "content".
  const fluig = await fakeFluig({
    [LOAD]: {
      body: JSON.stringify({
        datasetPK: { companyId: 1, datasetId: 'dsX' },
        datasetDescription: 'Descrição real',
        datasetImpl: 'function createDataset(){}',
      }),
    },
  });

  try {
    assert.equal(await loadDatasetDescription(fluig.url, 'c', 'dsX'), 'Descrição real');
  } finally {
    await fluig.close();
  }
});

test('lê a descrição quando o servidor devolve dentro de content', async () => {
  const fluig = await fakeFluig({
    [LOAD]: { body: JSON.stringify({ content: { datasetDescription: 'Com envelope' } }) },
  });

  try {
    assert.equal(await loadDatasetDescription(fluig.url, 'c', 'dsX'), 'Com envelope');
  } finally {
    await fluig.close();
  }
});

test('devolve undefined quando o dataset não existe', async () => {
  const fluig = await fakeFluig({ [LOAD]: { body: JSON.stringify({ content: null }) } });

  try {
    assert.equal(await loadDatasetDescription(fluig.url, 'c', 'dsX'), undefined);
  } finally {
    await fluig.close();
  }
});

test('devolve undefined quando a resposta não é JSON', async () => {
  const fluig = await fakeFluig({ [LOAD]: { body: '<html>sessão expirada</html>' } });

  try {
    assert.equal(await loadDatasetDescription(fluig.url, 'c', 'dsX'), undefined);
  } finally {
    await fluig.close();
  }
});
