import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmProduction } from '../src/guard.js';
import type { Server } from '../src/config.js';

const base: Server = {
  host: 'fluig.cetenco.com.br',
  port: 443,
  ssl: true,
  username: 'thiago.ferreira',
  companyId: 1,
  userCode: 'thiago.ferreira',
  passwordEnv: 'FLUIG_CETENCO_PROD_PASSWORD',
};

const homolog: Server = { ...base, prod: false };
const producao: Server = { ...base, prod: true };

test('servidor de homologação nunca pede senha', async () => {
  let chamadas = 0;
  const prompt = async () => {
    chamadas++;
    return 'qualquer';
  };

  await confirmProduction(homolog, 'senha', 'push dataset dsX', prompt);

  assert.equal(chamadas, 0);
});

test('servidor sem a flag prod nunca pede senha', async () => {
  let chamadas = 0;

  await confirmProduction(base, 'senha', 'push dataset dsX', async () => {
    chamadas++;
    return 'qualquer';
  });

  assert.equal(chamadas, 0);
});

test('produção segue quando a senha digitada bate', async () => {
  await confirmProduction(producao, 'senha-certa', 'push dataset dsX', async () => 'senha-certa');
});

test('produção aborta quando a senha digitada não bate', async () => {
  await assert.rejects(
    () => confirmProduction(producao, 'senha-certa', 'push dataset dsX', async () => 'errada'),
    /não confere/i,
  );
});

test('produção aborta quando as senhas têm comprimentos diferentes', async () => {
  await assert.rejects(
    () => confirmProduction(producao, 'senha-certa', 'push dataset dsX', async () => 'x'),
    /não confere/i,
  );
});

test('produção propaga a falta de TTY como recusa explicada', async () => {
  const semTty = async () => {
    throw new Error('sem TTY');
  };

  await assert.rejects(
    () => confirmProduction(producao, 'senha', 'push dataset dsX', semTty),
    /produção.*interativa/is,
  );
});

test('o prompt mostra o alvo e a operação, não só pede a senha', async () => {
  let visto = '';

  await confirmProduction(producao, 's', 'push dataset dsSTGTEMP', async (msg) => {
    visto = msg;
    return 's';
  });

  assert.match(visto, /fluig\.cetenco\.com\.br/);
  assert.match(visto, /dsSTGTEMP/);
  assert.match(visto, /thiago\.ferreira/);
});
