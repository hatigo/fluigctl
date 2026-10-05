import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { cardIndexClient, type CardIndexClient } from '../fluig/cardindex-service.js';
import { loadDataset, type DatasetNoServidor } from '../fluig/dataset-service.js';
import { versaoAtiva } from '../fluig/document-service.js';
import { login } from '../fluig/session.js';
import { workflowEngineClient, type WorkflowEngineClient } from '../fluig/workflow-service.js';
import { decideForm } from '../push/form-resolve.js';
import { arquivosDaPasta, nomeDaPasta } from '../push/form-source.js';
import { eventosDoProcesso, normalizar } from '../push/process-events.js';
import { prefixoDosScripts } from '../push/process-source.js';
import { lerMetadataStudio } from '../push/studio-metadata.js';

/**
 * Baixa do servidor o que está publicado — o caminho inverso do push. Nunca
 * sobrescreve em silêncio: arquivo novo é gravado, igual fica como está, e
 * arquivo local diferente do servidor só é trocado com `--overwrite`. Sem ele, se
 * algum diferir, nada é gravado (código 6): gravar parte e parar deixaria a
 * pasta numa mistura difícil de entender. Só lê do servidor.
 */

export interface ArquivoBaixado {
  /** Caminho relativo à pasta de trabalho. */
  caminho: string;
  /** Texto (script: comparado como no push) ou bytes (anexo de formulário: comparado byte a byte e gravado como veio). */
  conteudo: string | Buffer;
}

export interface ResultadoPull {
  novos: string[];
  iguais: string[];
  /** Locais diferentes do servidor: sobrescritos só com `--overwrite`. */
  diferentes: string[];
  gravados: string[];
}

/** Compara com o disco e, se puder, grava. A comparação é a do push (fim de linha, "?" fora do latin1). */
export function aplicarPull(
  raiz: string,
  arquivos: readonly ArquivoBaixado[],
  opcoes: { dryRun?: boolean; sobrescrever?: boolean },
): ResultadoPull {
  const novos: string[] = [];
  const iguais: string[] = [];
  const diferentes: string[] = [];
  for (const a of arquivos) {
    const caminho = resolve(raiz, a.caminho);
    if (!existsSync(caminho)) novos.push(a.caminho);
    else if (igual(readFileSync(caminho), a.conteudo)) iguais.push(a.caminho);
    else diferentes.push(a.caminho);
  }

  const gravados: string[] = [];
  if (opcoes.dryRun) return { novos, iguais, diferentes, gravados };
  if (diferentes.length > 0 && !opcoes.sobrescrever) {
    throw new ErroFluigctl(
      `estes arquivos locais diferem do servidor e não foram tocados — nada foi gravado:\n  ` +
        diferentes.join('\n  ') +
        '\nConfira a diferença (o --dry-run lista) e rode de novo com --overwrite para trazer a versão do servidor.',
      6,
    );
  }
  for (const a of arquivos) {
    if (iguais.includes(a.caminho)) continue;
    const caminho = resolve(raiz, a.caminho);
    mkdirSync(dirname(caminho), { recursive: true });
    if (Buffer.isBuffer(a.conteudo)) writeFileSync(caminho, a.conteudo);
    else writeFileSync(caminho, a.conteudo.endsWith('\n') ? a.conteudo : `${a.conteudo}\n`, 'utf8');
    gravados.push(a.caminho);
  }
  return { novos, iguais, diferentes, gravados };
}

function igual(local: Buffer, doServidor: string | Buffer): boolean {
  return Buffer.isBuffer(doServidor)
    ? local.equals(doServidor)
    : normalizar(local.toString('utf8')) === normalizar(doServidor);
}

export interface OpcoesPullProcess {
  server: Server;
  senha: string;
  processId: string;
  /** Pasta `workflow` do repositório (padrão: `workflow`). */
  pastaWorkflow: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: WorkflowEngineClient;
}

/**
 * Scripts de um processo: os `WorkflowProcessEvent` da definição publicada, em
 * `<workflow>/scripts/<prefixo>.<eventId>.js` — com o prefixo do push process (o
 * nome do `.process` local com este id, ou o próprio id).
 */
export async function pullProcess(opcoes: OpcoesPullProcess): Promise<ResultadoPull & { prefixo: string }> {
  const { server, senha, processId } = opcoes;
  const cliente =
    opcoes.cliente ??
    (await workflowEngineClient(serverUrl(server), server.companyId, server.username, senha, server.userCode));
  if (!(await cliente.listProcessIds()).includes(processId)) {
    throw new ErroFluigctl(`o processo "${processId}" não existe em ${serverUrl(server)}`, 3);
  }
  const definicao = (await cliente.exportProcess(processId)).toString('latin1');
  const { prefixo } = await prefixoDosScripts(opcoes.pastaWorkflow, processId);
  const pastaScripts = join(opcoes.pastaWorkflow, 'scripts');
  const arquivos = eventosDoProcesso(definicao)
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    .map((e) => ({ caminho: join(pastaScripts, `${prefixo}.${e.eventId}.js`), conteudo: e.codigo }));
  return { ...aplicarPull('.', arquivos, opcoes), prefixo };
}

export interface OpcoesPullDataset {
  server: Server;
  senha: string;
  nome: string;
  /** Raiz do repositório (padrão: a pasta atual). */
  raiz?: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  carregar?: (nome: string) => Promise<DatasetNoServidor>;
}

/** Os `datasets/**\/<nome>.js` do repositório. */
function datasetsLocais(raiz: string, nome: string): string[] {
  const achados: string[] = [];
  const visitar = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const caminho = join(dir, entrada);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (entrada === `${nome}.js`) achados.push(relative(raiz, caminho));
    }
  };
  if (existsSync(join(raiz, 'datasets'))) visitar(join(raiz, 'datasets'));
  return achados.sort();
}

/**
 * Código de um dataset, no arquivo que o repositório já tem para ele
 * (`datasets/**\/<nome>.js`) ou, sem nenhum, em `datasets/<nome>.js`. Dois
 * arquivos com o nome: recusa, por não saber qual é.
 */
export async function pullDataset(opcoes: OpcoesPullDataset): Promise<ResultadoPull & { arquivo: string }> {
  const raiz = opcoes.raiz ?? '.';
  const locais = datasetsLocais(raiz, opcoes.nome);
  if (locais.length > 1) {
    throw new ErroFluigctl(`mais de um arquivo para o dataset "${opcoes.nome}": ${locais.join(', ')}`, 6);
  }
  const carregar =
    opcoes.carregar ??
    (async (nome: string) => {
      const url = serverUrl(opcoes.server);
      return loadDataset(url, await login(url, opcoes.server.username, opcoes.senha), nome);
    });
  const noServidor = await carregar(opcoes.nome);
  if (noServidor.impl === undefined) {
    throw new ErroFluigctl(`o dataset "${opcoes.nome}" não existe em ${serverUrl(opcoes.server)} (ou não é customizado)`, 3);
  }
  if (noServidor.tipo !== undefined && noServidor.tipo !== 'CUSTOM') {
    throw new ErroFluigctl(`o dataset "${opcoes.nome}" é ${noServidor.tipo}, não customizado: não tem código JavaScript para baixar`, 6);
  }
  const arquivo = locais[0] ?? join('datasets', `${opcoes.nome}.js`);
  return { ...aplicarPull(raiz, [{ caminho: arquivo, conteudo: noServidor.impl }], opcoes), arquivo };
}

export interface OpcoesPullForm {
  server: Server;
  senha: string;
  /** Pasta do formulário no repositório; se ainda não existir, é criada (o alvo sai do nome dela ou do `documentId`). */
  pasta: string;
  documentId?: number;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: CardIndexClient;
  versao?: (documentId: number) => Promise<number>;
}

export interface ResultadoPullForm extends ResultadoPull {
  documentId: number;
  versao: number;
  avisos: string[];
  /** Arquivos da pasta local que o servidor não tem (ficam como estão). */
  soLocais: string[];
}

/**
 * Anexos e eventos de um formulário publicado, na pasta dele. O alvo é
 * resolvido como no push form (`--document-id`, prefixo da pasta, `.metadata`
 * do Studio, nome). O servidor guarda os anexos só pelo nome, então cada um vai
 * para o arquivo local de mesmo nome, em qualquer subpasta (`libs/x.js`), ou
 * para a raiz da pasta; os eventos vão para `events/<evento>.js`.
 */
export async function pullForm(opcoes: OpcoesPullForm): Promise<ResultadoPullForm> {
  const { server, senha, pasta } = opcoes;
  const url = serverUrl(server);
  const existe = existsSync(pasta);

  const cliente =
    opcoes.cliente ?? (await cardIndexClient(url, server.companyId, server.username, senha, server.userCode));
  const { nome, documentIdDaPasta } = nomeDaPasta(pasta);
  const metadata = join(pasta, '.metadata');
  const studio = existsSync(metadata) ? lerMetadataStudio(readFileSync(metadata)) : undefined;
  let decisao;
  try {
    decisao = decideForm({
      nome,
      catalogo: await cliente.listForms(),
      ...(studio === undefined ? {} : { studio }),
      ...(opcoes.documentId === undefined ? {} : { documentId: opcoes.documentId }),
      ...(documentIdDaPasta === undefined ? {} : { documentIdDaPasta }),
    });
  } catch (erro) {
    // A recusa do push ensina a criar o formulário; no pull, só não há o que baixar.
    if (erro instanceof ErroFluigctl && /não existe neste servidor\. Para criá-lo/.test(erro.message)) {
      throw new ErroFluigctl(`o formulário "${nome}" não existe em ${url}; se tem outro nome lá, use --document-id`, 3);
    }
    throw erro;
  }
  if (decisao.acao !== 'update') throw new ErroFluigctl(`o formulário "${nome}" não existe em ${url}`, 3);
  const { documentId } = decisao;

  const versao = await (opcoes.versao ?? (async (id: number) => versaoAtiva(url, await login(url, server.username, senha), id)))(documentId);

  const locais = existe ? await arquivosDaPasta(pasta) : [];
  const porNome = new Map<string, string[]>();
  for (const local of locais) {
    const n = local.split('/').pop()!;
    porNome.set(n, [...(porNome.get(n) ?? []), local]);
  }

  const arquivos: ArquivoBaixado[] = [];
  const doServidor = new Set<string>();
  for (const anexo of (await cliente.listAttachments(documentId)).sort()) {
    const candidatos = porNome.get(anexo) ?? [];
    if (candidatos.length > 1) {
      throw new ErroFluigctl(
        `o anexo "${anexo}" do servidor tem mais de um arquivo local com o nome: ${candidatos.join(', ')}. ` +
          'O push também recusa esta pasta; renomeie um deles.',
        6,
      );
    }
    const relativo = candidatos[0] ?? anexo;
    doServidor.add(relativo);
    arquivos.push({ caminho: join(pasta, relativo), conteudo: await cliente.attachmentContent(documentId, versao, anexo) });
  }
  for (const e of (await cliente.events(documentId)).sort((a, b) => (a.eventId < b.eventId ? -1 : 1))) {
    arquivos.push({ caminho: join(pasta, 'events', `${e.eventId}.js`), conteudo: e.eventDescription });
  }

  return {
    ...aplicarPull('.', arquivos, opcoes),
    documentId,
    versao,
    avisos: decisao.avisos,
    soLocais: locais.filter((l) => !doServidor.has(l)),
  };
}
