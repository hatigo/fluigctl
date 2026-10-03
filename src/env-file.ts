import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ErroFluigctl } from './errors.js';

/**
 * Grava `export NOME='valor'` no arquivo de senhas do fluigctl.
 *
 * Substitui a linha da variável se ela já existir, preserva o resto e deixa o
 * arquivo com permissão 600 (e a pasta com 700). A escrita é atômica: um arquivo
 * de senhas pela metade é pior que nenhum.
 *
 * O valor vai entre aspas simples, ou duplas se tiver aspa simples — o leitor
 * (`leDoArquivo`, em config.ts) não interpreta escapes, então senha com os dois
 * tipos de aspa é recusada em vez de gravada errada.
 */
export function gravarNoEnv(caminho: string, nome: string, valor: string): 'nova' | 'atualizada' | 'igual' {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(nome)) {
    throw new ErroFluigctl(`nome de variável inválido: ${nome}`, 2);
  }
  if (/[\r\n]/.test(valor)) {
    throw new ErroFluigctl(`a senha de ${nome} tem quebra de linha; não dá para gravá-la no arquivo`, 2);
  }

  let linha: string;
  if (!valor.includes("'")) linha = `export ${nome}='${valor}'`;
  else if (!valor.includes('"')) linha = `export ${nome}="${valor}"`;
  else {
    throw new ErroFluigctl(
      `a senha de ${nome} tem aspas simples e duplas; defina a variável de ambiente em vez do arquivo`,
      2,
    );
  }

  let linhas: string[] = [];
  try {
    linhas = readFileSync(caminho, 'utf8').split('\n');
    if (linhas.at(-1) === '') linhas.pop();
  } catch {
    // arquivo ainda não existe
  }

  const padrao = new RegExp(`^\\s*(export\\s+)?${nome}\\s*=`);
  const indice = linhas.findIndex((l) => padrao.test(l));
  let resultado: 'nova' | 'atualizada' | 'igual';
  if (indice === -1) {
    linhas.push(linha);
    resultado = 'nova';
  } else if (linhas[indice] === linha) {
    resultado = 'igual';
  } else {
    linhas[indice] = linha;
    resultado = 'atualizada';
  }

  mkdirSync(dirname(caminho), { recursive: true, mode: 0o700 });
  const tmp = `${caminho}.tmp`;
  writeFileSync(tmp, linhas.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, caminho);
  return resultado;
}
