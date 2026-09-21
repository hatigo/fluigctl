import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { importCandidates, slugServidor } from '../src/import.js';

function fixture(nome: string): string {
  return readFileSync(new URL(`./fixtures/vscode/${nome}.json`, import.meta.url), 'utf8');
}

const cetenco = {
  path: '/ws/cetenco/fluigCetencoSC/.vscode/servers.json',
  conteudo: fixture('completo'),
};
const outro = {
  path: '/ws/doisa/fluigdoisa/.vscode/servers.json',
  conteudo: fixture('colide'),
};

test('slugServidor tira acento, espaço e caixa', () => {
  assert.equal(slugServidor('CETENCO HML'), 'cetenco-hml');
  assert.equal(slugServidor('Produção'), 'producao');
  assert.equal(slugServidor('Homologação 2'), 'homologacao-2');
});

test('importCandidates lê host, porta, ssl, usuário e identidade', () => {
  const r = importCandidates([cetenco]);

  const hml = r.candidatos.find((c) => c.nome === 'cetenco-hml')!;
  assert.equal(hml.servidor.host, 'homolog.exemplo.com.br');
  assert.equal(hml.servidor.port, 8021);
  assert.equal(hml.servidor.ssl, false);
  assert.equal(hml.servidor.username, 'integracao.fluig');
  assert.equal(hml.servidor.companyId, 1);
  assert.equal(hml.servidor.userCode, 'Integracao.Fluig');
});

test('importCandidates NUNCA traz a senha, nem cifrada', () => {
  const r = importCandidates([cetenco, outro]);

  const serializado = JSON.stringify(r);
  // `passwordEnv` contém a substring "password" de propósito — o que não pode
  // existir é a chave `password` nem o blob cifrado da extensão.
  assert.equal(serializado.includes('"password"'), false);
  assert.equal(serializado.includes('eyJpdiI'), false);
  for (const c of r.candidatos) {
    assert.equal('password' in c.servidor, false);
  }
});

test('importCandidates deriva a variável de ambiente de cada servidor', () => {
  const r = importCandidates([cetenco]);

  assert.equal(
    r.candidatos.find((c) => c.nome === 'cetenco-hml')!.servidor.passwordEnv,
    'FLUIG_CETENCO_HML_PASSWORD',
  );
});

test('importCandidates marca como produção quem tem nome de produção', () => {
  const r = importCandidates([cetenco]);

  assert.equal(r.candidatos.find((c) => c.nome === 'producao')!.servidor.prod, true);
  assert.equal(r.candidatos.find((c) => c.nome === 'cetenco-hml')!.servidor.prod, undefined);
});

test('importCandidates ignora arquivo sem nenhuma configuração', () => {
  const r = importCandidates([
    { path: '/ws/x/.vscode/servers.json', conteudo: fixture('vazio') },
  ]);

  assert.deepEqual(r.candidatos, []);
  assert.equal(r.ignorados.length, 1);
  assert.match(r.ignorados[0]!, /nenhum servidor/i);
});

test('importCandidates qualifica pelo workspace quando dois nomes colidem', () => {
  const r = importCandidates([cetenco, outro]);

  const nomes = r.candidatos.map((c) => c.nome).sort();
  assert.ok(nomes.includes('fluigcetencosc-producao'), `nomes: ${nomes.join(', ')}`);
  assert.ok(nomes.includes('fluigdoisa-producao'), `nomes: ${nomes.join(', ')}`);
  assert.equal(nomes.includes('producao'), false);
});

test('importCandidates não qualifica quem não colide', () => {
  const r = importCandidates([cetenco, outro]);

  assert.ok(r.candidatos.some((c) => c.nome === 'cetenco-hml'));
});

test('importCandidates separa quem veio sem companyId ou userCode', () => {
  const r = importCandidates([
    { path: '/ws/sebraeam/.vscode/servers.json', conteudo: fixture('incompleto') },
  ]);

  assert.equal(r.candidatos.length, 1);
  assert.equal(r.candidatos[0]!.precisaIdentidade, true);
});

test('importCandidates registra de onde cada servidor veio', () => {
  const r = importCandidates([cetenco]);

  assert.equal(r.candidatos[0]!.origem, '/ws/cetenco/fluigCetencoSC/.vscode/servers.json');
});

test('importCandidates ignora arquivo corrompido sem derrubar os outros', () => {
  const r = importCandidates([
    { path: '/ws/ruim/.vscode/servers.json', conteudo: '{ quebrado' },
    cetenco,
  ]);

  assert.equal(r.candidatos.length, 2);
  assert.equal(r.ignorados.length, 1);
  assert.match(r.ignorados[0]!, /ruim/);
});

test('produção é detectada também quando o nome está abreviado', () => {
  // "prd" é um servidor de produção real nos workspaces. Sem a marca, ele não
  // teria gate — que é o furo mais grave que este projeto pode ter.
  for (const nome of ['prd', 'PRD', 'Produção', 'PROD', 'proddd', 'Prod Cliente']) {
    const r = importCandidates([
      {
        path: `/ws/x/proj/.vscode/servers.json`,
        conteudo: JSON.stringify({
          configurations: [
            { name: nome, host: 'h', ssl: true, port: 443, username: 'u', companyId: 1, userCode: 'u' },
          ],
        }),
      },
    ]);

    assert.equal(r.candidatos[0]!.servidor.prod, true, `"${nome}" deveria ser produção`);
  }
});

test('homologação não é marcada como produção', () => {
  for (const nome of ['Homologação', 'HML', 'homolog', 'dev', 'Teste']) {
    const r = importCandidates([
      {
        path: `/ws/x/proj/.vscode/servers.json`,
        conteudo: JSON.stringify({
          configurations: [
            { name: nome, host: 'h', ssl: false, port: 80, username: 'u', companyId: 1, userCode: 'u' },
          ],
        }),
      },
    ]);

    assert.equal(r.candidatos[0]!.servidor.prod, undefined, `"${nome}" não é produção`);
  }
});

function entrada(nome: string, host: string, username = 'integracao.fluig') {
  return { name: nome, host, ssl: false, port: 8021, username, companyId: 1, userCode: 'x' };
}

test('o mesmo servidor referenciado por vários projetos vira um candidato só', () => {
  const arquivos = ['fluigCetencoSC', 'fluigCetencoMedicao', 'fluigCetencoMinutas'].map(
    (proj) => ({
      path: `/ws/cetenco/${proj}/.vscode/servers.json`,
      conteudo: JSON.stringify({ configurations: [entrada('CETENCO HML', '4.201.225.233')] }),
    }),
  );

  const r = importCandidates(arquivos);

  assert.equal(r.candidatos.length, 1);
  assert.equal(r.candidatos[0]!.nome, 'cetenco-hml');
});

test('candidato repetido registra todos os projetos que o referenciam', () => {
  const arquivos = ['a', 'b'].map((proj) => ({
    path: `/ws/cli/${proj}/.vscode/servers.json`,
    conteudo: JSON.stringify({ configurations: [entrada('HML', 'h1')] }),
  }));

  const r = importCandidates(arquivos);

  assert.equal(r.candidatos[0]!.referencias, 2);
});

test('nomes diferentes para o mesmo host e usuário também são deduplicados', () => {
  const r = importCandidates([
    {
      path: '/ws/bn/fluigbn/.vscode/servers.json',
      conteudo: JSON.stringify({
        configurations: [entrada('Prod', 'bn.fluig.com', 'admin'), entrada('Produção', 'bn.fluig.com', 'admin')],
      }),
    },
  ]);

  assert.equal(r.candidatos.length, 1);
});

test('hosts diferentes com o mesmo nome continuam sendo dois candidatos', () => {
  const r = importCandidates([
    {
      path: '/ws/a/proj-a/.vscode/servers.json',
      conteudo: JSON.stringify({ configurations: [entrada('Produção', 'a.fluig.com')] }),
    },
    {
      path: '/ws/b/proj-b/.vscode/servers.json',
      conteudo: JSON.stringify({ configurations: [entrada('Produção', 'b.fluig.com')] }),
    },
  ]);

  assert.equal(r.candidatos.length, 2);
  assert.deepEqual(
    r.candidatos.map((c) => c.nome).sort(),
    ['proj-a-producao', 'proj-b-producao'],
  );
});

test('usuários diferentes no mesmo host são servidores distintos', () => {
  const r = importCandidates([
    {
      path: '/ws/a/proj/.vscode/servers.json',
      conteudo: JSON.stringify({
        configurations: [entrada('HML', 'h', 'usuario.um'), entrada('HML2', 'h', 'usuario.dois')],
      }),
    },
  ]);

  assert.equal(r.candidatos.length, 2);
});
