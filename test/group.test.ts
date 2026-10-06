import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fakeFluig } from './helpers/fake-fluig.js';
import { adicionarMembro, criarGrupo, verGrupo } from '../src/commands/group.js';
import { liberarVersao, versoesDoProcesso } from '../src/commands/process-versions.js';
import type { Server } from '../src/config.js';
import { ErroFluigctl } from '../src/errors.js';
import { groupClient, type GroupClient } from '../src/fluig/group-service.js';

/**
 * Grupos e versões sem o painel do Fluig. Cada escrita é conferida relendo o
 * servidor, e as de produção passam pelo porteiro de sempre.
 */

const WSDL_GRUPO = readFileSync(new URL('./fixtures/wsdl/ECMGroupService.wsdl', import.meta.url), 'utf8');
const WSDL_MEMBRO = readFileSync(new URL('./fixtures/wsdl/ECMColleagueGroupService.wsdl', import.meta.url), 'utf8');
const env = (c: string) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${c}</soap:Body></soap:Envelope>`;

const SERVER: Server = { host: 'fluig.local', port: 8080, ssl: false, username: 'admin', companyId: 1, userCode: 'admin', passwordEnv: 'X' };
const PROD: Server = { ...SERVER, prod: true };

test('o cliente SOAP lê e escreve grupos e membros no formato do WSDL', async () => {
  const fluig = await fakeFluig({
    '/webdesk/ECMGroupService': (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL_GRUPO };
      const corpo = req.body.includes('createGroup')
        ? env('<ns1:createGroupResponse xmlns:ns1="http://ws.foundation.ecm.technology.totvs.com/"><resultXML>ok</resultXML></ns1:createGroupResponse>')
        : env('<ns1:getGroupsResponse xmlns:ns1="http://ws.foundation.ecm.technology.totvs.com/"><result><item><companyId>1</companyId><groupDescription>Suporte</groupDescription><groupId>suporte_processos</groupId></item></result></ns1:getGroupsResponse>');
      return { headers: { 'content-type': 'text/xml' }, body: corpo };
    },
    '/webdesk/ECMColleagueGroupService': (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL_MEMBRO };
      const corpo = req.body.includes('createColleagueGroup')
        ? env('<ns1:createColleagueGroupResponse xmlns:ns1="http://ws.foundation.ecm.technology.totvs.com/"><resultXML>ok</resultXML></ns1:createColleagueGroupResponse>')
        : env('<ns1:getColleagueGroupsByGroupIdResponse xmlns:ns1="http://ws.foundation.ecm.technology.totvs.com/"><result><item><colleagueId>admin</colleagueId><companyId>1</companyId><groupId>suporte_processos</groupId></item></result></ns1:getColleagueGroupsByGroupIdResponse>');
      return { headers: { 'content-type': 'text/xml' }, body: corpo };
    },
  });
  try {
    const c = await groupClient(fluig.url, 1, 'admin', 'segredo');
    assert.deepEqual(await c.list(), [{ groupId: 'suporte_processos', descricao: 'Suporte' }]);
    assert.deepEqual(await c.members('suporte_processos'), ['admin']);
    await c.create('novo', 'Novo grupo');
    const pedido = fluig.requests.find((r) => r.body.includes('createGroup'))!.body;
    assert.match(pedido, /<groupId>novo<\/groupId>/);
    assert.match(pedido, /<groupDescription>Novo grupo<\/groupDescription>/);
    await c.addMember('suporte_processos', 'joao');
    assert.match(fluig.requests.find((r) => r.body.includes('createColleagueGroup'))!.body, /<colleagueId>joao<\/colleagueId>/);
  } finally {
    await fluig.close();
  }
});

/** Grupo em memória: o que se cria aparece na lista (ou não, se `ignorar`). */
function emMemoria(opcoes: { ignorar?: boolean } = {}): GroupClient & { chamadas: string[] } {
  const grupos = new Map<string, string[]>([['existente', ['admin']]]);
  const chamadas: string[] = [];
  return {
    chamadas,
    async list() { return [...grupos.keys()].map((groupId) => ({ groupId, descricao: groupId })); },
    async create(id) { chamadas.push(`create ${id}`); if (!opcoes.ignorar) grupos.set(id, []); return 'ok'; },
    async members(id) { return grupos.get(id) ?? []; },
    async addMember(id, c) { chamadas.push(`add ${id} ${c}`); if (!opcoes.ignorar) grupos.get(id)!.push(c); return 'ok'; },
  };
}
const base = (cliente: GroupClient, server = SERVER, prompt = async () => 's') => ({ server, senha: 's', prompt, cliente, colleagueIdDe: async (l: string) => l.toUpperCase() });

test('criar grupo: confere na lista, não duplica, e dry-run não escreve', async () => {
  const c = emMemoria();
  assert.deepEqual(await criarGrupo(base(c), 'suporte_processos', 'Suporte', true), { criado: false, jaExistia: false });
  assert.deepEqual(c.chamadas, []);
  assert.deepEqual(await criarGrupo(base(c), 'suporte_processos', 'Suporte'), { criado: true, jaExistia: false });
  assert.deepEqual(await criarGrupo(base(c), 'suporte_processos', 'Suporte'), { criado: false, jaExistia: true });
  assert.equal(c.chamadas.length, 1);
  await assert.rejects(criarGrupo(base(c), 'com espaço', ''), /código de grupo inválido/);
});

test('servidor que aceita mas não cria é erro, e não sucesso', async () => {
  await assert.rejects(criarGrupo(base(emMemoria({ ignorar: true })), 'novo', ''), (e: unknown) => e instanceof ErroFluigctl && e.codigo === 7);
});

test('pôr membro: pelo login, conferindo, e recusa grupo inexistente', async () => {
  const c = emMemoria();
  assert.deepEqual(await adicionarMembro(base(c), 'existente', 'joao'), { colleagueId: 'JOAO', adicionado: true, jaEstava: false });
  assert.deepEqual(await adicionarMembro(base(c), 'existente', 'admin'.toLowerCase()), { colleagueId: 'ADMIN', adicionado: true, jaEstava: false });
  assert.equal((await adicionarMembro(base(c), 'existente', 'joao')).jaEstava, true);
  await assert.rejects(adicionarMembro(base(c), 'nao_existe', 'joao'), /fluigctl group add nao_existe/);
  assert.deepEqual((await verGrupo(base(c), 'existente')).membros, ['admin', 'JOAO', 'ADMIN']);
});

test('em produção, criar exige a senha digitada; sem ela, nada é escrito', async () => {
  const c = emMemoria();
  await assert.rejects(criarGrupo(base(c, PROD, async () => 'errada'), 'novo', ''), (e: unknown) => e instanceof ErroFluigctl && e.codigo === 5);
  assert.deepEqual(c.chamadas, []);
});

const LINHAS = [1, 2, 3, 4, 5].map((v) => ({
  'processDefinitionVersionPK.processId': 'contratacao',
  'processDefinitionVersionPK.version': v,
  active: v >= 4,
  editionMode: v === 2 || v === 5,
  blockedVersion: false,
}));

test('versões: a que roda é a maior liberada fora de edição; as em edição aparecem', async () => {
  const v = await versoesDoProcesso({ server: SERVER, senha: 's', prompt: async () => 's', linhas: LINHAS }, 'contratacao');
  assert.deepEqual(v.filter((x) => x.emUso).map((x) => x.versao), [4]);
  assert.deepEqual(v.filter((x) => x.emEdicao).map((x) => x.versao), [2, 5]);
});

test('liberar: a mais nova em edição, conferindo a resposta; nada a liberar é erro', async () => {
  const liberados: string[] = [];
  const o = { server: SERVER, senha: 's', prompt: async () => 's', linhas: LINHAS, liberar: async (id: string) => { liberados.push(id); return { ok: true, mensagem: 'ok=true' }; } };
  assert.deepEqual(await liberarVersao(o, 'contratacao', true), { versao: 5, liberada: false });
  assert.deepEqual(liberados, []);
  assert.equal((await liberarVersao(o, 'contratacao')).liberada, true);
  const semEdicao = LINHAS.map((l) => ({ ...l, editionMode: false }));
  await assert.rejects(liberarVersao({ ...o, linhas: semEdicao }, 'contratacao'), /não está em edição/);
  await assert.rejects(liberarVersao({ ...o, liberar: async () => ({ ok: false, mensagem: 'Grupo suporte_processos não encontrado' }) }, 'contratacao'), /não liberou a versão 5.*Grupo suporte_processos/);
  await assert.rejects(liberarVersao({ ...o, linhas: [] }, 'nada'), /não existe/);
});
