import test from 'node:test';
import assert from 'node:assert/strict';

import { formatarTabela, lerRestricao, rodarDataset } from '../src/commands/dataset-run.js';
import type { Server } from '../src/config.js';

const SERVIDOR: Server = { host: 'fluig.exemplo', port: 8080, ssl: false, username: 'admin', companyId: 1, userCode: 'admin', passwordEnv: 'X' };

test('as restrições da linha de comando viram as do DatasetFactory', () => {
  assert.deepEqual(lerRestricao('LOGIN=admin'), { campo: 'LOGIN', inicial: 'admin', final: 'admin', tipo: 1 });
  assert.deepEqual(lerRestricao('status!=ERROR'), { campo: 'status', inicial: 'ERROR', final: 'ERROR', tipo: 3 });
  assert.deepEqual(lerRestricao('login~adm%'), { campo: 'login', inicial: 'adm%', final: 'adm%', tipo: 1, like: true });
  assert.deepEqual(lerRestricao('VALOR=100..900'), { campo: 'VALOR', inicial: '100', final: '900', tipo: 1 });
  assert.deepEqual(lerRestricao('URL=http://x?a=b'), { campo: 'URL', inicial: 'http://x?a=b', final: 'http://x?a=b', tipo: 1 }, 'só o primeiro = separa');
  assert.deepEqual(lerRestricao('VAZIO='), { campo: 'VAZIO', inicial: '', final: '', tipo: 1 });
  assert.throws(() => lerRestricao('semoperador'), /campo=valor/);
  assert.throws(() => lerRestricao('=valor'), /campo=valor/);
});

test('content vazio: diz se o dataset não existe ou se o script falhou', async () => {
  const base = { server: SERVIDOR, senha: 's', consultar: async () => undefined };
  await assert.rejects(rodarDataset({ ...base, customizados: async () => ['dsContratacaoCadastro'] }, 'dsContratacaoCadastro'), /existe.*não devolveu colunas.*log do servidor/);
  await assert.rejects(
    rodarDataset({ ...base, customizados: async () => ['dsContratacaoCadastro'] }, 'dsContratacao'),
    (e: Error & { codigo?: number }) => /não existe.*parecidos: dsContratacaoCadastro/.test(e.message) && e.codigo === 3,
  );
});

test('dataset que existe e não responde à consulta: diz qual campo pedido não é coluna dele', async () => {
  // Os internos (colleague) não estão na lista dos customizados: antes, isso virava "não existe".
  const colleague = { colunas: ['login', 'colleagueName', 'active'], linhas: [{ login: 'admin', colleagueName: 'admin', active: true }] };
  await assert.rejects(
    rodarDataset({ server: SERVIDOR, senha: 's', campos: ['login', 'naoExiste'], consultar: async () => undefined, sondar: async () => colleague, customizados: async () => [] }, 'colleague'),
    (e: Error & { codigo?: number }) => /"colleague" existe.*naoExiste \(--fields\) não é coluna dele.*Colunas: login, colleagueName, active/.test(e.message) && e.codigo === 2,
  );
});

test('--where e --order numa coluna que não existe viram aviso, sem falso aviso quando --fields corta as colunas', async () => {
  const completo = { colunas: ['login', 'active'], linhas: [] };
  const r = await rodarDataset({ server: SERVIDOR, senha: 's', restricoes: [lerRestricao('naoExiste=1')], ordem: ['outro'], consultar: async () => completo }, 'colleague');
  assert.deepEqual(r.avisos, ['naoExiste (--where) não é coluna do dataset: confira o nome', 'outro (--order) não é coluna do dataset: confira o nome']);
  // Com --fields login a resposta só traz login; active existe, e a sonda confirma.
  const soLogin = { colunas: ['login'], linhas: [{ login: 'admin' }] };
  const r2 = await rodarDataset(
    { server: SERVIDOR, senha: 's', campos: ['login'], restricoes: [lerRestricao('active=true')], consultar: async () => soLogin, sondar: async () => completo },
    'colleague',
  );
  assert.deepEqual(r2.avisos, []);
});

test('--limit corta as linhas, e a tabela alinha e encurta valores longos', async () => {
  const linhas = [{ A: 'um', B: 'x'.repeat(80) }, { A: 'dois', B: null }, { A: 'três', B: 3 }];
  const r = await rodarDataset({ server: SERVIDOR, senha: 's', limite: 2, consultar: async () => ({ colunas: ['A', 'B'], linhas }) }, 'ds');
  assert.equal(r.linhas.length, 2);
  const tabela = formatarTabela(r).split('\n');
  assert.equal(tabela[0], `A     B`);
  assert.equal(tabela[2], `um    ${'x'.repeat(59)}…`);
  assert.equal(tabela[3], 'dois');
});
