import { posix } from 'node:path';

import { ErroFluigctl } from '../errors.js';
import type { EntradaDoZip } from '../push/zip.js';

export interface ArquivoDaWidget {
  /** Caminho relativo à pasta da widget, com `/`. */
  caminho: string;
  dados: Buffer;
}

export interface WarDesmontado {
  arquivos: ArquivoDaWidget[];
  /** Entradas do `.war` que não têm lugar na pasta da widget (manifesto, selos). */
  ignorados: string[];
  /**
   * Entradas que só existem compiladas (`WEB-INF/classes/<pacote>/...`). Vão
   * para `src/main/java`, como faz a extensão Fluiggers, mas o `push widget`
   * recusa essa pasta: sem o código-fonte, publicar de novo sairia quebrado.
   */
  compilados: string[];
}

/** O `pom.xml` de um pacote com Java; a extensão Fluiggers também o restaura na raiz. */
const POM = 'pom.xml';
const CLASSES = 'WEB-INF/classes/';
const WEB_INF = 'WEB-INF/';
const RECURSOS = 'resources/';

const partes = (caminho: string) => caminho.split('/').filter((p) => p !== '');

/**
 * Desmonta o `.war` de uma widget na árvore de arquivos que o `push widget` sabe
 * empacotar de volta — o inverso exato de `lerWcm`, e o mesmo mapeamento da
 * extensão Fluiggers:
 *
 *   WEB-INF/<arq>.xml        → src/main/webapp/WEB-INF/<arq>.xml
 *   WEB-INF/classes/<arq>    → src/main/resources/<arq>
 *   resources/<caminho>      → src/main/webapp/resources/<caminho>
 *   WEB-INF/classes/<dir>/…  → src/main/java/<dir>/…
 *   pom.xml                  → pom.xml
 *
 * O que não casa com nenhuma regra não é jogado fora: volta em `ignorados` e é
 * dito no terminal. Caminho que escaparia da pasta da widget (`..`, `.`) é
 * recusado, e não normalizado — o pacote vem do servidor e não tem por que
 * mandar para fora.
 */
export function desmontarWar(entradas: readonly EntradaDoZip[], nome: string): WarDesmontado {
  const arquivos: ArquivoDaWidget[] = [];
  const ignorados: string[] = [];
  const compilados: string[] = [];
  const vistos = new Set<string>();

  for (const entrada of entradas) {
    const destino = destinoDe(entrada.nome, nome);
    if (destino === undefined) {
      ignorados.push(entrada.nome);
      continue;
    }
    if (vistos.has(destino)) {
      throw new ErroFluigctl(
        `o .war da widget "${nome}" tem dois arquivos para o mesmo destino: ${destino}`,
        6,
      );
    }
    vistos.add(destino);
    if (destino.startsWith('src/main/java/')) compilados.push(destino);
    arquivos.push({ caminho: destino, dados: entrada.dados });
  }

  return { arquivos, ignorados, compilados };
}

function destinoDe(nome: string, widget: string): string | undefined {
  const p = partes(nome);
  if (p.length === 0 || p.some((x) => x === '..' || x === '.')) {
    throw new ErroFluigctl(
      `o .war da widget "${widget}" tem o caminho "${nome}", que sairia da pasta da widget`,
      6,
    );
  }

  if (nome.startsWith(CLASSES)) {
    const resto = p.slice(2);
    // Um nível é o `src/main/resources` que o push lê de volta; mais fundo é
    // pacote compilado, que só existe como classe.
    if (resto.length === 1 && resto[0]!.includes('.')) return `src/main/resources/${resto[0]}`;
    if (resto.length > 1) return posix.join('src/main/java', ...resto);
    return undefined;
  }
  if (nome === POM) return POM;
  if (nome.startsWith(WEB_INF) && p.length === 2 && p[1]!.endsWith('.xml')) {
    return posix.join('src/main/webapp/WEB-INF', p[1]!);
  }
  if (nome.startsWith(RECURSOS) && p.length > 1) return posix.join('src/main/webapp', ...p);
  return undefined;
}
