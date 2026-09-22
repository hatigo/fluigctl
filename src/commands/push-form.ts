import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { cardIndexClient } from '../fluig/cardindex-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { decideForm } from '../push/form-resolve.js';
import { readForm } from '../push/form-source.js';

/**
 * Tipo de persistência na criação do formulário.
 *
 * A documentação SOAP da TOTVS diz 0 = Formulário e 1 = Lista; o swagger da API
 * REST diz o inverso. Como aqui falamos SOAP, seguimos a documentação SOAP.
 * NÃO VERIFICADO contra um servidor: confirmar em homologação criando um de
 * cada. Escolher errado não é corrigível por update — `persistenceType` não
 * existe na operação de atualização.
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

  const decisao = decideForm({
    nome: fonte.nome,
    catalogo: await cliente.listForms(),
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

  if (opcoes.dryRun) {
    return decisao.acao === 'update'
      ? { ...base, acao: 'update', documentId: decisao.documentId }
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

    await cliente.updateForm({
      documentId: decisao.documentId,
      cardDescription: fonte.nome,
      descriptionField: opcoes.descriptionField ?? '',
      datasetName: opcoes.datasetName ?? `ds${fonte.nome}`,
      anexos: fonte.anexos,
      eventos: fonte.eventos,
      versionOption,
    });

    return { ...base, acao: 'update', documentId: decisao.documentId };
  }

  const documentId = await cliente.createForm({
    parentDocumentId: opcoes.parentId!,
    documentDescription: fonte.nome,
    cardDescription: fonte.nome,
    datasetName: opcoes.datasetName!,
    anexos: fonte.anexos,
    eventos: fonte.eventos,
    persistenceType: PERSISTENCE_TYPE[opcoes.persistenceType!],
  });

  return { ...base, acao: 'create', documentId };
}
