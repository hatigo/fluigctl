import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { groupClient, type GroupClient, type Grupo } from '../fluig/group-service.js';
import { findUserByLogin, login } from '../fluig/session.js';
import { confirmProduction, type PromptSenha } from '../guard.js';

/**
 * Grupos sem o painel de administração: listar, ver os membros, criar e pôr
 * alguém. Criar e pôr passam pelo mesmo porteiro de produção dos pushes, e cada
 * escrita é conferida relendo o servidor (a resposta do Fluig é um XML livre).
 */

export interface OpcoesGrupo {
  server: Server;
  senha: string;
  prompt: PromptSenha;
  /** Para testes. */
  cliente?: GroupClient;
  /** Para testes: login → colleagueId sem abrir sessão. */
  colleagueIdDe?: (login: string) => Promise<string>;
}

const ID_GRUPO = /^[\w.-]{1,40}$/;

async function cliente(o: OpcoesGrupo): Promise<GroupClient> {
  return o.cliente ?? (await groupClient(serverUrl(o.server), o.server.companyId, o.server.username, o.senha));
}

export async function listarGrupos(o: OpcoesGrupo): Promise<Grupo[]> {
  return (await cliente(o)).list();
}

export async function verGrupo(o: OpcoesGrupo, groupId: string): Promise<{ grupo: Grupo; membros: string[] }> {
  const c = await cliente(o);
  const grupo = (await c.list()).find((g) => g.groupId === groupId);
  if (!grupo) throw new ErroFluigctl(`o grupo "${groupId}" não existe em ${serverUrl(o.server)}`, 6);
  return { grupo, membros: await c.members(groupId) };
}

export async function criarGrupo(
  o: OpcoesGrupo,
  groupId: string,
  descricao: string,
  dryRun = false,
): Promise<{ criado: boolean; jaExistia: boolean }> {
  if (!ID_GRUPO.test(groupId)) throw new ErroFluigctl(`código de grupo inválido: "${groupId}" (letras, números, _ . -; até 40)`, 2);
  const c = await cliente(o);
  if ((await c.list()).some((g) => g.groupId === groupId)) return { criado: false, jaExistia: true };
  if (dryRun) return { criado: false, jaExistia: false };
  await confirmProduction(o.server, o.senha, `criar o grupo ${groupId}`, o.prompt);
  const resposta = await c.create(groupId, descricao || groupId);
  if (!(await c.list()).some((g) => g.groupId === groupId)) {
    throw new ErroFluigctl(`o servidor respondeu "${resposta.slice(0, 200)}", mas o grupo "${groupId}" não apareceu na lista`, 7);
  }
  return { criado: true, jaExistia: false };
}

export async function adicionarMembro(
  o: OpcoesGrupo,
  groupId: string,
  usuario: string,
  dryRun = false,
): Promise<{ colleagueId: string; adicionado: boolean; jaEstava: boolean }> {
  const c = await cliente(o);
  if (!(await c.list()).some((g) => g.groupId === groupId)) {
    throw new ErroFluigctl(`o grupo "${groupId}" não existe em ${serverUrl(o.server)}; crie com: fluigctl group add ${groupId}`, 6);
  }
  const colleagueId = o.colleagueIdDe
    ? await o.colleagueIdDe(usuario)
    : (await findUserByLogin(serverUrl(o.server), await login(serverUrl(o.server), o.server.username, o.senha), usuario)).userCode;
  if ((await c.members(groupId)).includes(colleagueId)) return { colleagueId, adicionado: false, jaEstava: true };
  if (dryRun) return { colleagueId, adicionado: false, jaEstava: false };
  await confirmProduction(o.server, o.senha, `pôr ${usuario} no grupo ${groupId}`, o.prompt);
  const resposta = await c.addMember(groupId, colleagueId);
  if (!(await c.members(groupId)).includes(colleagueId)) {
    throw new ErroFluigctl(`o servidor respondeu "${resposta.slice(0, 200)}", mas ${usuario} não apareceu no grupo "${groupId}"`, 7);
  }
  return { colleagueId, adicionado: true, jaEstava: false };
}
