import { basename, extname } from 'node:path';

import { ErroFluigctl } from '../errors.js';

export interface DecisaoDataset {
  acao: 'create' | 'update';
}

export function datasetNameFromFile(caminho: string): string {
  if (extname(caminho) !== '.js') {
    throw new ErroFluigctl(`um dataset é um arquivo .js — recebi "${caminho}"`, 6);
  }
  return basename(caminho, '.js');
}

/**
 * Decide entre criar e atualizar.
 *
 * A comparação com o catálogo do servidor é sensível à caixa, porque para o
 * Fluig `dsX` e `dsx` são datasets diferentes: tratar como iguais faria um
 * update sobrescrever o artefato errado. Quando a única diferença é a caixa,
 * a recusa diz isso, em vez de mandar criar um quase-duplicado.
 */
export function decideDataset(
  nome: string,
  existentes: readonly string[],
  create: boolean,
): DecisaoDataset {
  const existe = existentes.includes(nome);

  if (existe && create) {
    throw new ErroFluigctl(
      `--create foi pedido, mas o dataset "${nome}" já existe no servidor. ` +
        `Remova --create para atualizá-lo.`,
      6,
    );
  }
  if (existe) return { acao: 'update' };
  if (create) return { acao: 'create' };

  const parecido = existentes.find((e) => e.toLowerCase() === nome.toLowerCase());
  const dica = parecido
    ? ` Existe "${parecido}", que difere só na capitalização — ` +
      `renomeie o arquivo se era esse que você queria.`
    : '';

  throw new ErroFluigctl(
    `o dataset "${nome}" não existe no servidor. ` +
      `Use --create --description "..." para criá-lo.${dica}`,
    6,
  );
}
