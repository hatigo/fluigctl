import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { cardIndexClient } from '../fluig/cardindex-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decideForm } from '../push/form-resolve.js';
import { readForm } from '../push/form-source.js';
import { lerMetadataStudio } from '../push/studio-metadata.js';

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

  // Na criação, nada é adivinhado: errar a pasta-mãe ou o tipo de persistência
  // produz um formulário que não dá para consertar por update.
  if (decisao.acao === 'create') {
    const faltando: string[] = [];
    if (opcoes.parentId === undefined) faltando.push('--parent-id <documentId da pasta>');
    if (!opcoes.datasetName) faltando.push('--dataset-name <nome do dataset>');
    if (!opcoes.persistenceType) faltando.push('--persistence-type form|list');

    if (faltando.length > 0) {
      throw new ErroFluigctl(
        `criar o formulário "${fonte.nome}" exige informação que não dá para ` +
          `adivinhar:\n  ${faltando.join('\n  ')}\n` +
          `Sugestão de dataset pela convenção: ds${fonte.nome}`,
        6,
      );
    }
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

  if (opcoes.dryRun) {
    return decisao.acao === 'update'
      ? {
          ...base,
          acao: 'update',
          documentId: decisao.documentId,
          nomeEnviado: nomeEnviado!,
          descritorEnviado: descritorEnviado!,
        }
      : { ...base, acao: 'create' };
  }

  const alvo =
    decisao.acao === 'update'
      ? `documentId ${decisao.documentId}`
      : `novo, na pasta ${opcoes.parentId}`;
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
    };
  }

  const documentId = await cliente.createForm({
    parentDocumentId: opcoes.parentId!,
    documentDescription: fonte.nome,
    cardDescription: opcoes.description ?? fonte.nome,
    datasetName: opcoes.datasetName!,
    anexos: fonte.anexos,
    eventos: fonte.eventos,
    persistenceType: PERSISTENCE_TYPE[opcoes.persistenceType!],
  }).catch(traduzir);

  return { ...base, acao: 'create', documentId };
}
