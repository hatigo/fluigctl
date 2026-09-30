import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, posix, relative, resolve, sep } from 'node:path';

import { ErroFluigctl } from '../errors.js';
import type { EntradaZip } from './war.js';

export interface FonteWidget {
  nome: string;
  entradas: EntradaZip[];
}

/**
 * Lê a pasta de uma widget (`wcm/widget/<nome>`) e monta as entradas do `.war`
 * no mesmo mapeamento da extensão Fluiggers:
 *
 *   src/main/webapp/WEB-INF/*.xml    → WEB-INF/<arquivo>
 *   src/main/resources/*.*           → WEB-INF/classes/<arquivo>
 *   src/main/webapp/resources/**     → resources/<caminho>
 *
 * Duas diferenças de propósito. Tudo é lido em bytes crus — a extensão lê
 * `src/main/resources` como UTF-8, o que corrompe `.properties` em latin1. E
 * `.metadata` e dotfiles ficam de fora, como no push form. Link simbólico
 * recusa o pacote em vez de ser seguido ou omitido em silêncio.
 *
 * Widget com código em `src/main/java` precisa do build do Maven, que compila
 * as classes; empacotar sem elas publicaria uma widget quebrada.
 */
export async function readWidget(pasta: string): Promise<FonteWidget> {
  const raiz = resolve(pasta);
  const nome = basename(raiz);
  if (nome === '' || nome.startsWith('.')) {
    throw new ErroFluigctl(`não consigo tirar o nome da widget de ${pasta}`, 3);
  }

  const webInf = join(raiz, 'src', 'main', 'webapp', 'WEB-INF');
  const recursos = join(raiz, 'src', 'main', 'resources');
  if (!(await ehPasta(webInf)) || !(await ehArquivo(join(recursos, 'application.info')))) {
    throw new ErroFluigctl(
      `${pasta} não é uma pasta de widget: faltam src/main/webapp/WEB-INF ` +
        `ou src/main/resources/application.info`,
      3,
    );
  }

  const java = join(raiz, 'src', 'main', 'java');
  if ((await ehPasta(java)) && (await coletaArquivos(java, java)).length > 0) {
    throw new ErroFluigctl(
      `a widget "${nome}" tem código Java em src/main/java, que precisa do build ` +
        `do Maven — o fluigctl não compila Java. Publique esta pelo Fluig Studio ou Maven.`,
      6,
    );
  }

  const entradas: EntradaZip[] = [];

  for (const arquivo of await arquivosDoTopo(webInf, (n) => n.endsWith('.xml'))) {
    entradas.push({ nome: `WEB-INF/${arquivo}`, dados: await readFile(join(webInf, arquivo)) });
  }
  for (const arquivo of await arquivosDoTopo(recursos, (n) => n.includes('.'))) {
    entradas.push({
      nome: `WEB-INF/classes/${arquivo}`,
      dados: await readFile(join(recursos, arquivo)),
    });
  }

  const estaticos = join(raiz, 'src', 'main', 'webapp', 'resources');
  if (await ehPasta(estaticos)) {
    for (const relativo of (await coletaArquivos(estaticos, estaticos)).sort()) {
      entradas.push({ nome: `resources/${relativo}`, dados: await readFile(join(estaticos, relativo)) });
    }
  }

  return { nome, entradas };
}

async function arquivosDoTopo(dir: string, aceita: (nome: string) => boolean): Promise<string[]> {
  const entradas = (await readdir(dir, { withFileTypes: true })).filter(
    (e) => !e.name.startsWith('.'),
  );
  const link = entradas.find((e) => e.isSymbolicLink());
  if (link) recusaLink(join(dir, link.name));
  return entradas
    .filter((e) => e.isFile() && aceita(e.name))
    .map((e) => e.name)
    .sort();
}

/** Caminhos relativos em POSIX, ignorando `.metadata` e dotfiles; recusa links. */
async function coletaArquivos(raiz: string, dir: string): Promise<string[]> {
  const entradas = await readdir(dir, { withFileTypes: true });
  const arquivos: string[] = [];

  for (const entrada of entradas) {
    if (entrada.name.startsWith('.')) continue;
    const caminho = join(dir, entrada.name);

    if (entrada.isSymbolicLink()) recusaLink(caminho);
    if (entrada.isDirectory()) {
      arquivos.push(...(await coletaArquivos(raiz, caminho)));
      continue;
    }
    if (entrada.isFile()) {
      arquivos.push(relative(raiz, caminho).split(sep).join(posix.sep));
    }
  }

  return arquivos;
}

function recusaLink(caminho: string): never {
  throw new ErroFluigctl(
    `${caminho} é um link simbólico — o fluigctl não segue links ao montar o .war. ` +
      `Troque pelo arquivo de verdade antes de publicar.`,
    3,
  );
}

async function ehPasta(caminho: string): Promise<boolean> {
  return (await stat(caminho).catch(() => null))?.isDirectory() ?? false;
}

async function ehArquivo(caminho: string): Promise<boolean> {
  return (await stat(caminho).catch(() => null))?.isFile() ?? false;
}
