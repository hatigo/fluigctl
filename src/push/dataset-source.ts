import { readFileSync } from 'node:fs';

import { ErroFluigctl } from '../errors.js';

/** Lê o código-fonte do dataset, traduzindo erro de disco em mensagem útil. */
export function readDatasetFile(caminho: string): string {
  try {
    return readFileSync(caminho, 'utf8');
  } catch (erro) {
    const e = erro as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ErroFluigctl(`não encontrei o arquivo de dataset: ${caminho}`, 3);
    }
    if (e.code === 'EISDIR') {
      throw new ErroFluigctl(
        `${caminho} é um diretório — aponte para o arquivo .js do dataset`,
        3,
      );
    }
    throw new ErroFluigctl(`não consegui ler ${caminho}: ${e.message}`, 3);
  }
}
