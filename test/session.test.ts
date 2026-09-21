import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeFluig } from './helpers/fake-fluig.js';
import { findUserByLogin, login, ping } from '../src/fluig/session.js';

const LOGIN = '/portal/api/servlet/login.do';
const PING = '/portal/p/api/servlet/ping';
const USER = '/portal/api/rest/wcmservice/rest/user/findUserByLogin';

test('login envia j_username e j_password como form-urlencoded', async () => {
  const fluig = await fakeFluig({
    [LOGIN]: { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } },
  });

  try {
    await login(fluig.url, 'thiago.ferreira', 'senha secreta');

    const req = fluig.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(req.body, 'j_username=thiago.ferreira&j_password=senha+secreta');
  } finally {
    await fluig.close();
  }
});

test('login junta múltiplos Set-Cookie numa string de Cookie', async () => {
  const fluig = await fakeFluig({
    [LOGIN]: {
      headers: {
        'set-cookie': [
          'JSESSIONID=abc123; Path=/; HttpOnly',
          'redirect_url="/portal"; Version=1; Path=/',
        ],
      },
    },
  });

  try {
    const cookie = await login(fluig.url, 'u', 'p');

    assert.equal(cookie, 'JSESSIONID=abc123; redirect_url="/portal"');
  } finally {
    await fluig.close();
  }
});

test('login falha quando o servidor não devolve cookie nenhum', async () => {
  const fluig = await fakeFluig({ [LOGIN]: { body: '<html>login</html>' } });

  try {
    await assert.rejects(() => login(fluig.url, 'u', 'senha-errada'), /credenciais/i);
  } finally {
    await fluig.close();
  }
});

test('ping só aceita o corpo "pong", não o status 200', async () => {
  const fluig = await fakeFluig({
    [PING]: { status: 200, body: '<html>tela de login</html>' },
  });

  try {
    assert.equal(await ping(fluig.url, 'JSESSIONID=abc'), false);
  } finally {
    await fluig.close();
  }
});

test('ping aceita pong com espaços em volta', async () => {
  const fluig = await fakeFluig({ [PING]: { body: 'pong\n' } });

  try {
    assert.equal(await ping(fluig.url, 'JSESSIONID=abc'), true);
  } finally {
    await fluig.close();
  }
});

test('findUserByLogin extrai companyId de tenantId e userCode', async () => {
  const fluig = await fakeFluig({
    [USER]: {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: { tenantId: 1, userCode: 'Integracao.Fluig', login: 'integracao' },
      }),
    },
  });

  try {
    const usuario = await findUserByLogin(fluig.url, 'JSESSIONID=abc', 'integracao');

    assert.deepEqual(usuario, { companyId: 1, userCode: 'Integracao.Fluig' });
  } finally {
    await fluig.close();
  }
});

test('findUserByLogin manda o cookie de sessão', async () => {
  const fluig = await fakeFluig({
    [USER]: { body: JSON.stringify({ content: { tenantId: 1, userCode: 'x' } }) },
  });

  try {
    await findUserByLogin(fluig.url, 'JSESSIONID=abc', 'integracao');

    assert.equal(fluig.requests[0]!.headers['cookie'], 'JSESSIONID=abc');
  } finally {
    await fluig.close();
  }
});

test('findUserByLogin falha com mensagem útil quando o usuário não existe', async () => {
  const fluig = await fakeFluig({ [USER]: { body: JSON.stringify({ content: null }) } });

  try {
    await assert.rejects(
      () => findUserByLogin(fluig.url, 'JSESSIONID=abc', 'ninguem'),
      /ninguem/,
    );
  } finally {
    await fluig.close();
  }
});
