import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, posix, relative, resolve, sep } from 'node:path';

import { ErroFluigctl } from '../errors.js';
import type { EntradaZip } from './war.js';

export interface FonteWcm {
  nome: string;
  /** O `application.type` do `application.info`: `widget` ou `layout`. */
  tipo: string;
  entradas: EntradaZip[];
}

/** O que o `application.type` declara; é ele que diz se a pasta é widget ou layout. */
export type TipoWcm = 'widget' | 'layout';

/**
 * Lê a pasta de uma aplicação WCM (`wcm/widget/<nome>`) e monta as entradas do `.war`
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
 * Widget com código Java precisa do build do Maven, que compila as classes — e
 * nem assim o fluigctl publica: a rota de upload do WCM **recusa** um `.war` com
 * classes, com "Existe uma declaração de componente repetida na lista de recursos
 * da widget" (medido no fluig-localdev; o mesmo pacote sem as classes sobe com
 * 200). Vale para classe solta em `WEB-INF/classes`, para pacote renomeado e
 * para `.jar` em `WEB-INF/lib`. Java só pelo Fluig Studio.
 *
 * `tipoEsperado` não é decoração: widget e layout são a mesma estrutura e o
 * mesmo pacote, e o que os separa é o `application.type`. Sem a conferência,
 * `push widget` numa pasta de layout sobe o layout como se fosse widget —
 * medido no fluig-localdev, onde o servidor aceitou sem reclamar.
 */
export async function lerWcm(pasta: string, tipoEsperado: TipoWcm): Promise<FonteWcm> {
  const raiz = resolve(pasta);
  const nome = basename(raiz);
  if (nome === '' || nome.startsWith('.')) {
    throw new ErroFluigctl(`não consigo tirar o nome da aplicação de ${pasta}`, 3);
  }

  const webInf = join(raiz, 'src', 'main', 'webapp', 'WEB-INF');
  const recursos = join(raiz, 'src', 'main', 'resources');
  if (!(await ehPasta(webInf)) || !(await ehArquivo(join(recursos, 'application.info')))) {
    throw new ErroFluigctl(
      `${pasta} não é uma pasta de ${tipoEsperado}: faltam src/main/webapp/WEB-INF ` +
        `ou src/main/resources/application.info`,
      3,
    );
  }

  const tipo = await lerTipo(join(recursos, 'application.info'), pasta, tipoEsperado);
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

  /*
   * Qualquer arquivo em `src/main/java` recusa o pacote, compilado ou não: a
   * rota do WCM não aceita widget com Java. Recusar aqui, antes da rede, é
   * melhor do que deixar o servidor responder "declaração de componente
   * repetida" — e muito melhor do que empacotar sem as classes, que é o que a
   * extensão Fluiggers faz (ela mapeia `WEB-INF/classes/<dir>/…` para
   * `src/main/java` no import e não empacota `src/main/java` no export).
   */
  const java = join(raiz, 'src', 'main', 'java');
  if (await ehPasta(java)) {
    const arquivos = await coletaArquivos(java, java);
    if (arquivos.length > 0) {
      const fontes = arquivos.filter((a) => a.endsWith('.java')).length;
      throw new ErroFluigctl(
        `a ${tipoEsperado} "${nome}" tem ${arquivos.length} arquivo(s) Java em ` +
          `src/main/java (${fontes} deles .java), e o fluigctl não publica ${tipoEsperado} com ` +
          'Java: a rota de upload do WCM recusa o pacote ("Existe uma declaração de ' +
          'componente repetida na lista de recursos da widget"). Publique esta pelo ' +
          'Fluig Studio, ou tire o Java dela.',
        6,
      );
    }
  }

  const estaticos = join(raiz, 'src', 'main', 'webapp', 'resources');
  if (await ehPasta(estaticos)) {
    for (const relativo of (await coletaArquivos(estaticos, estaticos)).sort()) {
      entradas.push({ nome: `resources/${relativo}`, dados: await readFile(join(estaticos, relativo)) });
    }
  }

  return { nome, tipo, entradas };
}

/**
 * O `application.type` do `application.info`, conferido contra o que o comando
 * publica. O arquivo é lido como latin1 pelo mesmo motivo do pacote: é um
 * `.properties` do Fluig, e a extensão o estraga lendo como UTF-8.
 */
async function lerTipo(caminho: string, pasta: string, tipoEsperado: TipoWcm): Promise<string> {
  const info = await readFile(caminho, 'latin1');
  const linha = /^[ \t]*application\.type[ \t]*=[ \t]*(.*?)[ \t\r]*$/m.exec(info);
  const tipo = linha?.[1] ?? '';
  if (tipo === '') {
    throw new ErroFluigctl(
      `o application.info de ${pasta} não declara application.type, então não sei se é ` +
        `widget ou layout; para publicar como ${tipoEsperado}, acrescente ` +
        `"application.type=${tipoEsperado}".`,
      3,
    );
  }
  if (tipo !== tipoEsperado) {
    throw new ErroFluigctl(
      `${pasta} é um ${tipo} (application.type=${tipo}), não um ${tipoEsperado}. ` +
        `Use push ${tipo}.`,
      6,
    );
  }
  return tipo;
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
