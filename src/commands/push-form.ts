import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { cardIndexClient } from '../fluig/cardindex-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decideForm } from '../push/form-resolve.js';
import { readForm } from '../push/form-source.js';
import { lerMetadataStudio } from '../push/studio-metadata.js';
import { versaoAtiva } from '../fluig/document-service.js';
import { login } from '../fluig/session.js';
import { camposDoHtml } from './changed.js';

/**
 * Tipo de persistência na criação do formulário.
 *
 * A documentação SOAP da TOTVS diz 0 = Formulário e 1 = Lista; o swagger da API
 * REST diz o inverso. Como aqui falamos SOAP, seguimos a documentação SOAP.
 * Conferido no localdev (2026-10-07) para o 0: o formulário criado fica como o
 * que o Studio cria (metaListId 0, tipo 4) e serve de formulário de processo,
 * com dataset e validateForm funcionando. O 1 (lista) não foi testado. Escolher
 * errado não é corrigível por update — `persistenceType` não existe na operação
 * de atualização.
 */
const PERSISTENCE_TYPE = { form: 0, list: 1 } as const;

export interface OpcoesPushForm {
  server: Server;
  senha: string;
  pasta: string;
  documentId?: number;
  create?: boolean;
  parentId?: number;
  datasetName?: string;
  persistenceType?: 'form' | 'list';
  descriptionField?: string;
  /**
   * Descrição (nome) do formulário no servidor. Num update, sem ela vale a que o
   * servidor já tem — mandar o nome da pasta renomeava o formulário (o 902 do HML
   * da Cetenco virou "formReembolso"). Na criação, sem ela vale o nome da pasta.
   */
  description?: string;
  principal?: string;
  versionOption?: '0' | '2';
  dryRun?: boolean;
  prompt: PromptSenha;
  /** Para testes: o HTML principal do formulário publicado (undefined: não deu para ler). */
  htmlPublicado?: () => Promise<string | undefined>;
}

export interface ResultadoPushForm {
  nome: string;
  acao: 'create' | 'update';
  documentId?: number;
  anexos: number;
  eventos: number;
  avisos: string[];
  /** Num update: o nome e o campo descritor que vão (ou foram) para o servidor. */
  nomeEnviado?: string;
  descritorEnviado?: string;
  /** Numa criação: onde e como o formulário é (ou seria) criado. */
  criacao?: { pasta: number; dataset: string; persistencia: 'form' | 'list' };
  /** Num update: os campos do HTML local que o formulário publicado não tem. */
  camposNovos?: string[];
}

/**
 * A pasta dos formulários deste servidor: a única em que eles estão. Com mais de
 * uma, não se escolhe (um formulário na pasta errada não se move por update).
 */
function pastaDosFormularios(catalogo: readonly { pasta?: number }[], nome: string): number {
  const contagem = new Map<number, number>();
  for (const f of catalogo) if (f.pasta !== undefined) contagem.set(f.pasta, (contagem.get(f.pasta) ?? 0) + 1);
  if (contagem.size === 1) return [...contagem.keys()][0]!;
  const lista = [...contagem].sort((a, b) => b[1] - a[1]).map(([p, n]) => `pasta ${p} (${n} formulário(s))`).join(', ');
  throw new ErroFluigctl(
    contagem.size === 0
      ? `criar o formulário "${nome}" exige --parent-id <documentId da pasta>: o servidor não informou onde estão os outros formulários`
      : `criar o formulário "${nome}" exige --parent-id: os formulários deste servidor estão em mais de uma pasta — ${lista}`,
    6,
  );
}

export async function pushForm(opcoes: OpcoesPushForm): Promise<ResultadoPushForm> {
  const { server, senha } = opcoes;

  const fonte = await readForm(
    opcoes.pasta,
    opcoes.principal === undefined ? {} : { principal: opcoes.principal },
  );

  const cliente = await cardIndexClient(
    serverUrl(server),
    server.companyId,
    server.username,
    senha,
    server.userCode,
  );

  const catalogo = await cliente.listForms();
  const studio = lerMetadataStudio(
    await readFile(join(opcoes.pasta, '.metadata')).catch(() => undefined),
  );
  const decisao = decideForm({
    nome: fonte.nome,
    catalogo,
    ...(studio === undefined ? {} : { studio }),
    ...(opcoes.documentId === undefined ? {} : { documentId: opcoes.documentId }),
    ...(fonte.documentIdDaPasta === undefined
      ? {}
      : { documentIdDaPasta: fonte.documentIdDaPasta }),
    ...(opcoes.create === undefined ? {} : { create: opcoes.create }),
  });

  const base = {
    nome: fonte.nome,
    anexos: fonte.anexos.length,
    eventos: fonte.eventos.length,
    avisos: decisao.avisos,
  };

  /*
   * O servidor grava cada anexo em disco com o nome do arquivo, e há servidor que
   * não aceita nome fora do ASCII: o Fluig local recusou a criação de um
   * formulário com "Requisitos Formulário gestão….md" ("Malformed input or input
   * contains unmappable characters"). Não se sabe se todos recusam, então avisa
   * antes e, se o servidor recusar, diz qual arquivo renomear.
   */
  const foraDoAscii = fonte.anexos.map((a) => a.fileName).filter((n) => /[^\x20-\x7e]/.test(n));
  if (foraDoAscii.length > 0) {
    base.avisos.push(
      `anexo com nome fora do ASCII (${foraDoAscii.join(', ')}): há servidor que recusa o formulário inteiro ` +
        'por isso. Se for o caso, renomeie sem acento ou tire o arquivo da pasta.',
    );
  }
  const traduzir = (erro: unknown): never => {
    if (foraDoAscii.length > 0 && erro instanceof ErroFluigctl && /unmappable characters|Malformed input/i.test(erro.message)) {
      throw new ErroFluigctl(
        `o servidor não aceitou anexo com nome fora do ASCII: ${foraDoAscii.join(', ')}. ` +
          'Renomeie sem acento ou tire o arquivo da pasta do formulário e publique de novo.',
        7,
      );
    }
    throw erro;
  };

  // Na criação, errar a pasta-mãe ou o tipo de persistência produz um formulário
  // que não dá para consertar por update. Sem a flag, vale o que não tem dúvida:
  // a pasta onde estão todos os formulários do servidor (só se for uma), o
  // dataset ds<nome> (a convenção do Studio) e a persistência do Studio (form).
  let criacao: ResultadoPushForm['criacao'];
  if (decisao.acao === 'create') {
    const dataset = opcoes.datasetName ?? `ds${fonte.nome}`;
    const dono = catalogo.find((f) => f.datasetName === dataset);
    if (dono) {
      throw new ErroFluigctl(
        `o dataset "${dataset}" já é do formulário ${dono.documentId} ("${dono.documentDescription}"); use --dataset-name com outro nome`,
        6,
      );
    }
    criacao = {
      pasta: opcoes.parentId ?? pastaDosFormularios(catalogo, fonte.nome),
      dataset,
      persistencia: opcoes.persistenceType ?? 'form',
    };
    const assumidos = [
      opcoes.parentId === undefined ? `pasta ${criacao.pasta} (a dos formulários do servidor)` : '',
      opcoes.datasetName === undefined ? `dataset ${dataset}` : '',
      opcoes.persistenceType === undefined ? 'persistência form (a do Studio)' : '',
    ].filter(Boolean);
    if (assumidos.length) decisao.avisos.push(`sem flag, vale: ${assumidos.join(', ')}`);
  }

  // Nome e campo descritor num update: os do servidor, a menos que o usuário peça outro. O web
  // service grava o que receber, e o default antigo (nome da pasta, descritor vazio) apagava os do
  // cliente.
  const noServidor =
    decisao.acao === 'update' ? catalogo.find((f) => f.documentId === decisao.documentId) : undefined;
  const nomeEnviado =
    decisao.acao === 'update'
      ? opcoes.description ?? (noServidor?.documentDescription || fonte.nome)
      : undefined;
  const descritorEnviado =
    decisao.acao === 'update'
      ? opcoes.descriptionField ?? noServidor?.descriptionField ?? ''
      : undefined;
  if (
    decisao.acao === 'update' &&
    opcoes.descriptionField === undefined &&
    noServidor?.descriptionField === undefined
  ) {
    base.avisos.push(
      'o servidor não informou o campo descritor do formulário; ele vai vazio. ' +
        'Use --description-field para definir.',
    );
  }

  // Campo novo é coluna nova na tabela do formulário: o Fluig só o aceita numa
  // versão nova ("O formulário possui alterações na estrutura e precisa ter a
  // versão alterada"). Compara com o publicado, não com o git: é o que o
  // servidor tem que decide. Sem campo novo, manter a versão é o normal.
  let camposNovos: string[] | undefined;
  if (decisao.acao === 'update') {
    const principal = fonte.anexos.find((a) => a.principal);
    const publicado = await (opcoes.htmlPublicado ?? (async () => {
      const url = serverUrl(server);
      const versao = await versaoAtiva(url, await login(url, server.username, senha), decisao.documentId);
      const nome = noServidor?.arquivoPrincipal ?? principal?.fileName;
      return nome ? (await cliente.attachmentContent(decisao.documentId, versao, nome)).toString('latin1') : undefined;
    }))().catch(() => undefined);
    if (publicado === undefined || !principal) {
      base.avisos.push('não deu para ler o formulário publicado e comparar os campos: com campo novo, use --new-version');
    } else {
      const doServidor = camposDoHtml(publicado);
      camposNovos = [...camposDoHtml(Buffer.from(principal.filecontent, 'base64').toString('latin1'))].filter((c) => !doServidor.has(c)).sort();
      if (camposNovos.length && opcoes.versionOption === '0') {
        throw new ErroFluigctl(
          `campo(s) novo(s) em ${fonte.nome}: ${camposNovos.join(', ')}. Cada campo é uma coluna na tabela do formulário, ` +
            'e o Fluig só aceita campo novo numa versão nova: use --new-version (--keep-version só serve para mudança sem campo novo).',
          2,
        );
      }
    }
  }

  if (opcoes.dryRun) {
    return decisao.acao === 'update'
      ? {
          ...base,
          acao: 'update',
          documentId: decisao.documentId,
          nomeEnviado: nomeEnviado!,
          descritorEnviado: descritorEnviado!,
          ...(camposNovos === undefined ? {} : { camposNovos }),
        }
      : { ...base, acao: 'create', criacao: criacao! };
  }

  const alvo =
    decisao.acao === 'update'
      ? `documentId ${decisao.documentId}`
      : `novo, na pasta ${criacao!.pasta}`;
  await confirmProduction(server, senha, `push form ${fonte.nome} (${alvo})`, opcoes.prompt);

  if (decisao.acao === 'update') {
    const versionOption = opcoes.versionOption;
    if (versionOption === undefined) {
      throw new ErroFluigctl(
        'atualizar um formulário exige --keep-version ou --new-version',
        2,
      );
    }

    // Sem --dataset-name vale o dataset que o formulário já tem no servidor: um form criado com
    // outro nome (ex.: pelo Studio) é recusado com ds<pasta> se esse nome já for de outro form.

    // O servidor recusa um nome de dataset que já é de outro formulário, mas só depois de desativar
    // o dataset atual deste (visto no HML: dsformSolicitacaoReembolso ficou inativo). Recusar aqui.
    if (opcoes.datasetName !== undefined) {
      const dono = catalogo.find(
        (f) => f.datasetName === opcoes.datasetName && f.documentId !== decisao.documentId,
      );
      if (dono) {
        throw new ErroFluigctl(
          `o dataset "${opcoes.datasetName}" já é do formulário ${dono.documentId} ` +
            `("${dono.documentDescription}"). Mandar esse nome desativa o dataset atual do ` +
            `formulário ${decisao.documentId} antes de o servidor recusar.`,
          6,
        );
      }
    }

    await cliente.updateForm({
      documentId: decisao.documentId,
      cardDescription: nomeEnviado!,
      descriptionField: descritorEnviado!,
      datasetName: opcoes.datasetName ?? (noServidor?.datasetName || `ds${fonte.nome}`),
      anexos: fonte.anexos,
      eventos: fonte.eventos,
      versionOption,
    }).catch(traduzir);

    return {
      ...base,
      acao: 'update',
      documentId: decisao.documentId,
      nomeEnviado: nomeEnviado!,
      descritorEnviado: descritorEnviado!,
      ...(camposNovos === undefined ? {} : { camposNovos }),
    };
  }

  const documentId = await cliente.createForm({
    parentDocumentId: criacao!.pasta,
    documentDescription: fonte.nome,
    cardDescription: opcoes.description ?? fonte.nome,
    datasetName: criacao!.dataset,
    anexos: fonte.anexos,
    eventos: fonte.eventos,
    persistenceType: PERSISTENCE_TYPE[criacao!.persistencia],
  }).catch(traduzir);

  return { ...base, acao: 'create', documentId, criacao: criacao! };
}
