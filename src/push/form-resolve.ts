import { ErroFluigctl } from '../errors.js';
import type { FormNoServidor } from '../fluig/cardindex-service.js';

export interface EntradaDecisao {
  nome: string;
  catalogo: readonly FormNoServidor[];
  documentId?: number;
  documentIdDaPasta?: number;
  create?: boolean;
}

export type DecisaoForm =
  | { acao: 'update'; documentId: number; avisos: string[] }
  | { acao: 'create'; avisos: string[] };

function listaCandidatos(formularios: readonly FormNoServidor[]): string {
  return formularios
    .map((f) => `    ${f.documentId}  ${f.documentDescription}  (${f.datasetName})`)
    .join('\n');
}

/**
 * Descobre em qual formulário do servidor publicar.
 *
 * Função pura: recebe o catálogo já lido. A regra é resolver sozinha quando
 * houver um único candidato e parar com instrução quando houver dúvida —
 * publicar no documentId errado sobrescreve outro formulário.
 */
export function decideForm(entrada: EntradaDecisao): DecisaoForm {
  const { nome, catalogo, create } = entrada;
  const avisos: string[] = [];

  // 1. Escolha explícita do usuário. Confia, mas confere que existe.
  if (entrada.documentId !== undefined) {
    const alvo = catalogo.find((f) => f.documentId === entrada.documentId);
    if (!alvo) {
      throw new ErroFluigctl(
        `o documentId ${entrada.documentId} não existe neste servidor, ` +
          `ou não é visível para este usuário.`,
        6,
      );
    }
    return { acao: 'update', documentId: alvo.documentId, avisos };
  }

  const exatos = catalogo.filter((f) => f.documentDescription === nome);
  const porCaixa = catalogo.filter(
    (f) => f.documentDescription.toLowerCase() === nome.toLowerCase(),
  );

  // 2. Prefixo numérico da pasta — só vale se a descrição também bater.
  if (entrada.documentIdDaPasta !== undefined) {
    const alvo = catalogo.find((f) => f.documentId === entrada.documentIdDaPasta);

    if (alvo && alvo.documentDescription === nome) {
      return { acao: 'update', documentId: alvo.documentId, avisos };
    }
    if (alvo) {
      throw new ErroFluigctl(
        `o prefixo da pasta aponta para o documentId ${alvo.documentId}, que no ` +
          `servidor se chama "${alvo.documentDescription}" — mas a pasta é ` +
          `"${nome}". Provavelmente a pasta foi copiada de outro projeto. ` +
          `Use --document-id para confirmar o alvo.`,
        6,
      );
    }
    avisos.push(
      `o prefixo da pasta indica documentId ${entrada.documentIdDaPasta}, ` +
        `que não existe neste servidor — pode ser id de outro ambiente. ` +
        `Resolvendo pelo nome.`,
    );
  }

  // 3. Casamento por nome.
  if (exatos.length === 1) {
    if (create) {
      throw new ErroFluigctl(
        `--create foi pedido, mas o formulário "${nome}" já existe ` +
          `(documentId ${exatos[0]!.documentId}). Remova --create para atualizá-lo.`,
        6,
      );
    }
    return { acao: 'update', documentId: exatos[0]!.documentId, avisos };
  }

  if (exatos.length > 1) {
    throw new ErroFluigctl(
      `há ${exatos.length} formulários chamados "${nome}" neste servidor. ` +
        `Escolha com --document-id:\n${listaCandidatos(exatos)}`,
      6,
    );
  }

  if (porCaixa.length === 1) {
    if (create) {
      throw new ErroFluigctl(
        `--create foi pedido, mas já existe "${porCaixa[0]!.documentDescription}" ` +
          `(documentId ${porCaixa[0]!.documentId}), que difere só na capitalização.`,
        6,
      );
    }
    avisos.push(
      `a pasta chama-se "${nome}" e o formulário no servidor, ` +
        `"${porCaixa[0]!.documentDescription}" — difere só na capitalização.`,
    );
    return { acao: 'update', documentId: porCaixa[0]!.documentId, avisos };
  }

  if (porCaixa.length > 1) {
    throw new ErroFluigctl(
      `há ${porCaixa.length} formulários cujo nome difere de "${nome}" só na ` +
        `capitalização. Escolha com --document-id:\n${listaCandidatos(porCaixa)}`,
      6,
    );
  }

  if (create) return { acao: 'create', avisos };

  throw new ErroFluigctl(
    `o formulário "${nome}" não existe neste servidor. ` +
      `Para criá-lo: --create --parent-id <pasta> --dataset-name <ds> ` +
      `--persistence-type form|list`,
    6,
  );
}
