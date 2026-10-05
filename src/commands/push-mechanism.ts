import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import {
  mecanismoAtualizado,
  mecanismoNovo,
  mechanismClient,
  type MechanismClient,
} from '../fluig/mechanism-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';

export interface OpcoesPushMecanismo {
  server: Server;
  senha: string;
  arquivo: string;
  /** Nome do mecanismo; sem ele, no create vale o id, e no update o do servidor. */
  nome?: string;
  /** Descrição; sem ela, no create vale o nome, e no update a do servidor. */
  descricao?: string;
  /** Publicar um mecanismo que ainda não existe é sempre explícito. */
  criar?: boolean;
  dryRun?: boolean;
  prompt: PromptSenha;
  /** Para testes. */
  cliente?: MechanismClient;
}

export interface ResultadoPushMecanismo {
  mecanismoId: string;
  acao: 'create' | 'update';
  nome: string;
  descricao: string;
  bytes: number;
  /** O código do servidor já era o local, antes de enviar. */
  jaIgual?: boolean;
  /** Depois de enviar: o servidor devolve exatamente o código local. */
  conferido?: boolean;
}

const normaliza = (codigo: string) => codigo.replace(/\r\n/g, '\n');

/** O `attributionMecanismId` sai do nome do arquivo, como no `mechanisms/<id>.js` do Studio. */
export function mecanismoIdDoArquivo(caminho: string): string {
  const nome = basename(caminho);
  const id = nome.replace(/\.js$/, '');
  if (nome === id || id === '') {
    throw new ErroFluigctl(`o mecanismo de atribuição precisa ser um arquivo .js: ${caminho}`, 6);
  }
  return id;
}

/**
 * Publica um mecanismo de atribuição customizado.
 *
 * No update, o corpo é o objeto que o servidor devolveu com só o código trocado:
 * `controlClass`, `assignmentType`, `configurationClass`, `name` e `description`
 * não vêm de arquivo nenhum e mandar outro valor os apagaria. `--name` e
 * `--description` são a exceção explícita.
 *
 * Criar é `--create`, como no dataset e no formulário: o id é uma chave que o
 * servidor recusa repetida ("Código do mecanismo de atribuição já cadastrado"),
 * e criar no lugar errado não tem desfazer por esta via.
 */
export async function pushMechanism(opcoes: OpcoesPushMecanismo): Promise<ResultadoPushMecanismo> {
  const { server, senha, arquivo } = opcoes;
  const mecanismoId = mecanismoIdDoArquivo(arquivo);

  let codigo: string;
  try {
    codigo = readFileSync(arquivo, 'utf8');
  } catch {
    throw new ErroFluigctl(`não consegui ler o mecanismo em ${arquivo}`, 3);
  }
  const bytes = Buffer.byteLength(codigo, 'utf8');

  const url = serverUrl(server);
  const cliente =
    opcoes.cliente ?? (await mechanismClient(url, server.companyId, server.username, senha));

  const atual = (await cliente.listar()).find((m) => m.mecanismoId === mecanismoId);
  if (!atual && !opcoes.criar) {
    throw new ErroFluigctl(
      `o mecanismo de atribuição "${mecanismoId}" não existe em ${url}. ` +
        'Para criá-lo, repita com --create' +
        (opcoes.nome === undefined ? ' --name <nome>' : '') +
        '.',
      6,
    );
  }

  const acao: 'create' | 'update' = atual ? 'update' : 'create';
  const nome = opcoes.nome ?? atual?.nome ?? mecanismoId;
  const descricao = opcoes.descricao ?? atual?.descricao ?? nome;
  const jaIgual = atual === undefined ? undefined : normaliza(atual.codigo) === normaliza(codigo);

  if (opcoes.dryRun) return { mecanismoId, acao, nome, descricao, bytes, ...(jaIgual === undefined ? {} : { jaIgual }) };

  await confirmProduction(server, senha, `push mechanism ${mecanismoId} (${acao})`, opcoes.prompt);

  if (atual) {
    await cliente.atualizar(mecanismoAtualizado(atual, { ...(opcoes.nome === undefined ? {} : { nome: opcoes.nome }), ...(opcoes.descricao === undefined ? {} : { descricao: opcoes.descricao }), codigo }));
  } else {
    await cliente.criar(mecanismoNovo(server.companyId, mecanismoId, nome, descricao, codigo));
  }

  const depois = (await cliente.listar()).find((m) => m.mecanismoId === mecanismoId);
  const conferido = depois === undefined ? false : normaliza(depois.codigo) === normaliza(codigo);

  return {
    mecanismoId,
    acao,
    nome,
    descricao,
    bytes,
    ...(jaIgual === undefined ? {} : { jaIgual }),
    conferido,
  };
}
