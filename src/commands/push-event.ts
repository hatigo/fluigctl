import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import {
  comEvento,
  globalEventClient,
  type GlobalEventClient,
} from '../fluig/global-event-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';

export interface OpcoesPushEvento {
  server: Server;
  senha: string;
  arquivo: string;
  dryRun?: boolean;
  prompt: PromptSenha;
  /** Para testes. */
  cliente?: GlobalEventClient;
}

export interface ResultadoPushEvento {
  eventId: string;
  /** O evento não existia no servidor. */
  novo: boolean;
  /** O código do servidor já era o local, antes de enviar. */
  jaIgual: boolean;
  bytes: number;
  /** Quantos eventos ficam no servidor depois; o `saveEventList` grava a lista toda. */
  eventos: number;
  /** Depois de enviar: o servidor devolve exatamente o código local. */
  conferido?: boolean;
}

const normaliza = (codigo: string) => codigo.replace(/\r\n/g, '\n');

/** O `eventId` sai do nome do arquivo, como na extensão (`events/<id>.js`). */
export function eventIdDoArquivo(caminho: string): string {
  const nome = basename(caminho);
  const id = nome.replace(/\.js$/, '');
  if (nome === id || id === '') {
    throw new ErroFluigctl(`o evento global precisa ser um arquivo .js: ${caminho}`, 6);
  }
  return id;
}

/**
 * Publica um evento global.
 *
 * O `saveEventList` do Fluig **substitui a lista inteira** (medido: mandar um
 * evento apagou o outro), então a escrita é sempre ler a lista, trocar a nossa
 * entrada e mandar tudo de volta. Nada que já estava no servidor é removido por
 * uma publicação local, e uma leitura que falha recusa em vez de virar lista
 * vazia — que apagaria todos os eventos do cliente.
 */
export async function pushEvent(opcoes: OpcoesPushEvento): Promise<ResultadoPushEvento> {
  const { server, senha, arquivo } = opcoes;
  const eventId = eventIdDoArquivo(arquivo);

  let codigo: string;
  try {
    codigo = readFileSync(arquivo, 'utf8');
  } catch {
    throw new ErroFluigctl(`não consegui ler o evento global em ${arquivo}`, 3);
  }
  const bytes = Buffer.byteLength(codigo, 'utf8');

  const url = serverUrl(server);
  const cliente =
    opcoes.cliente ??
    (await globalEventClient(url, server.companyId, server.username, senha));

  const lista = await cliente.listar();
  const { lista: novaLista, novo } = comEvento(lista, { eventId, codigo });
  const atual = lista.find((e) => e.eventId === eventId);
  const jaIgual = atual !== undefined && normaliza(atual.codigo) === normaliza(codigo);

  if (opcoes.dryRun) return { eventId, novo, jaIgual, bytes, eventos: novaLista.length };

  await confirmProduction(server, senha, `push event ${eventId} (${novo ? 'novo' : 'update'})`, opcoes.prompt);

  await cliente.gravar(novaLista);
  const depois = await cliente.listar();
  const gravado = depois.find((e) => e.eventId === eventId);
  const conferido = gravado === undefined ? false : normaliza(gravado.codigo) === normaliza(codigo);

  return { eventId, novo, jaIgual, bytes, eventos: depois.length, conferido };
}
