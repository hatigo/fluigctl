import { fluigSoapClient, invoke, itens } from './soap.js';

/**
 * Grupos do Fluig (ECMGroupService) e quem está em cada um (ECMColleagueGroupService).
 *
 * Existir é decidido pela lista, e não pela falha de getGroup: ela vem como
 * "Grupo não encontrado." no idioma do servidor, e casar texto de erro quebraria
 * num Fluig em inglês.
 */

export interface Grupo {
  groupId: string;
  descricao: string;
}

export interface GroupClient {
  list(): Promise<Grupo[]>;
  create(groupId: string, descricao: string): Promise<string>;
  /** Os colleagueId (matrículas) de quem está no grupo. */
  members(groupId: string): Promise<string[]>;
  addMember(groupId: string, colleagueId: string): Promise<string>;
}

interface GroupDto {
  groupId?: string;
  groupDescription?: string;
}

interface ColleagueGroupDto {
  colleagueId?: string;
}

export async function groupClient(baseUrl: string, companyId: number, username: string, password: string): Promise<GroupClient> {
  const grupos = await fluigSoapClient(baseUrl, 'ECMGroupService');
  const membros = await fluigSoapClient(baseUrl, 'ECMColleagueGroupService');
  const credencial = { username, password, companyId };

  return {
    async list() {
      const r = await invoke<{ result?: { item?: GroupDto | GroupDto[] } | null }>(grupos, 'getGroups', credencial);
      return itens<GroupDto>(r?.result ?? undefined)
        .filter((g) => typeof g.groupId === 'string')
        .map((g) => ({ groupId: g.groupId!, descricao: g.groupDescription ?? '' }));
    },

    async create(groupId, descricao) {
      const r = await invoke<{ resultXML?: string }>(grupos, 'createGroup', {
        ...credencial,
        groups: { item: [{ companyId, groupId, groupDescription: descricao }] },
      });
      return r?.resultXML ?? '';
    },

    async members(groupId) {
      const r = await invoke<{ result?: { item?: ColleagueGroupDto | ColleagueGroupDto[] } | null }>(membros, 'getColleagueGroupsByGroupId', {
        ...credencial,
        groupId,
      });
      return itens<ColleagueGroupDto>(r?.result ?? undefined)
        .map((m) => m.colleagueId)
        .filter((c): c is string => typeof c === 'string');
    },

    async addMember(groupId, colleagueId) {
      const r = await invoke<{ resultXML?: string }>(membros, 'createColleagueGroup', {
        ...credencial,
        ColleagueGroups: { item: [{ colleagueId, companyId, groupId, writeAllowed: false }] },
      });
      return r?.resultXML ?? '';
    },
  };
}
