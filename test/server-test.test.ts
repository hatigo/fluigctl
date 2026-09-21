import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFluig } from './helpers/fake-fluig.js';
import { testServer } from '../src/commands/server-test.js';
import type { Server } from '../src/config.js';

const LOGIN = '/portal/api/servlet/login.do';
const PING = '/portal/p/api/servlet/ping';
const USER = '/portal/api/rest/wcmservice/rest/user/findUserByLogin';

function servidorEm(url: string, extras: Partial<Server> = {}): Server {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port),
    ssl: false,
    username: 'integracao',
    companyId: 1,
    userCode: 'Integracao.Fluig',
    passwordEnv: 'FLUIG_TESTE_PASSWORD',
    ...extras,
  };
}

const rotasOk = {
  [LOGIN]: { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } },
  [PING]: { body: 'pong' },
  [USER]: {
    body: JSON.stringify({ content: { tenantId: 1, userCode: 'Integracao.Fluig' } }),
  },
};

test('testServer confirma login, ping e identidade do usuário', async () => {
  const fluig = await fakeFluig(rotasOk);

  try {
    const r = await testServer(servidorEm(fluig.url), 'senha');

    assert.equal(r.pingOk, true);
    assert.equal(r.companyId, 1);
    assert.equal(r.userCode, 'Integracao.Fluig');
    assert.deepEqual(r.divergencias, []);
  } finally {
    await fluig.close();
  }
});

test('testServer aponta quando o companyId do config diverge do servidor', async () => {
  const fluig = await fakeFluig(rotasOk);

  try {
    const r = await testServer(servidorEm(fluig.url, { companyId: 9 }), 'senha');

    assert.equal(r.divergencias.length, 1);
    assert.match(r.divergencias[0]!, /companyId.*9.*1/);
  } finally {
    await fluig.close();
  }
});

test('testServer aponta quando o userCode do config diverge do servidor', async () => {
  const fluig = await fakeFluig(rotasOk);

  try {
    const r = await testServer(servidorEm(fluig.url, { userCode: 'errado' }), 'senha');

    assert.equal(r.divergencias.length, 1);
    assert.match(r.divergencias[0]!, /userCode/);
  } finally {
    await fluig.close();
  }
});

test('testServer não consulta o usuário quando o login falha', async () => {
  const fluig = await fakeFluig({ [LOGIN]: { body: '<html>login</html>' } });

  try {
    await assert.rejects(() => testServer(servidorEm(fluig.url), 'errada'), /credenciais/i);
    assert.equal(fluig.requests.length, 1);
  } finally {
    await fluig.close();
  }
});
