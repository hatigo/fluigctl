import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, posix, relative, sep } from 'node:path';

import { ErroFluigctl } from '../errors.js';

export interface AnexoForm {
  fileName: string;
  fileSize: number;
  filecontent: string;
  principal: boolean;
}

export interface EventoForm {
  eventId: string;
  eventDescription: string;
  eventVersAnt: false;
}

export interface FonteForm {
  nome: string;
  documentIdDaPasta?: number;
  anexos: AnexoForm[];
  eventos: EventoForm[];
}

export interface OpcoesLeitura {
  principal?: string;
  tamanhoMaximo?: number;
  permitirSubpastas?: boolean;
}

/** A TOTVS desaconselha base64 em filecontent para arquivos grandes. */
const TAMANHO_MAXIMO = 5 * 1024 * 1024;

const PREFIXO_DOCUMENT_ID = /^(\d+)\s*-\s*(.+)$/;
const EH_HTML = /\.html?$/i;

/**
 * Lê uma pasta de formulário e monta o que vai no SOAP.
 *
 * `events/` sai dos anexos porque vira `customEvents`, em texto puro. O
 * `.metadata` e os dotfiles ficam de fora porque são arquivos da IDE, não do
 * formulário — publicá-los junto é um efeito colateral que não queremos.
 */
export async function readForm(
  pasta: string,
  opcoes: OpcoesLeitura = {},
): Promise<FonteForm> {
  try {
    if (!(await stat(pasta)).isDirectory()) {
      throw new ErroFluigctl(`${pasta} não é uma pasta de formulário`, 3);
    }
  } catch (erro) {
    if (erro instanceof ErroFluigctl) throw erro;
    throw new ErroFluigctl(`não encontrei a pasta do formulário: ${pasta}`, 3);
  }

  const pastaNome = basename(pasta.replace(/[/\\]+$/, ''));
  const prefixo = PREFIXO_DOCUMENT_ID.exec(pastaNome);
  const nome = prefixo ? prefixo[2]! : pastaNome;
  const documentIdDaPasta = prefixo ? Number(prefixo[1]) : undefined;

  const caminhos = await coletaArquivos(pasta, pasta);
  const maximo = opcoes.tamanhoMaximo ?? TAMANHO_MAXIMO;

  const anexos: AnexoForm[] = [];
  for (const relativo of caminhos.sort()) {
    const conteudo = await readFile(join(pasta, relativo));
    if (conteudo.byteLength > maximo) {
      throw new ErroFluigctl(
        `${relativo} tem ${conteudo.byteLength} bytes, acima do limite de ${maximo}. ` +
          `A TOTVS desaconselha enviar arquivos grandes em base64 pelo web service.`,
        6,
      );
    }
    anexos.push({
      fileName: relativo,
      fileSize: conteudo.byteLength,
      filecontent: conteudo.toString('base64'),
      principal: false,
    });
  }

  if (!opcoes.permitirSubpastas) {
    const emSubpasta = anexos.filter((a) => a.fileName.includes('/'));
    if (emSubpasta.length > 0) {
      throw new ErroFluigctl(
        `o servidor recusa anexo em subpasta ("O sistema não pode encontrar o ` +
          `caminho especificado"). Achate estes arquivos na raiz da pasta e ` +
          `ajuste as referências no HTML:\n  ` +
          emSubpasta.map((a) => a.fileName).join('\n  '),
        6,
      );
    }
  }

  marcaPrincipal(anexos, nome, opcoes.principal);
  exigeTagForm(anexos);

  return {
    nome,
    ...(documentIdDaPasta === undefined ? {} : { documentIdDaPasta }),
    anexos,
    eventos: await leEventos(pasta),
  };
}

/** Caminhos relativos em POSIX, ignorando `events/`, `.metadata` e dotfiles. */
async function coletaArquivos(raiz: string, dir: string): Promise<string[]> {
  const entradas = await readdir(dir, { withFileTypes: true });
  const arquivos: string[] = [];

  for (const entrada of entradas) {
    if (entrada.name.startsWith('.')) continue;
    const caminho = join(dir, entrada.name);

    if (entrada.isDirectory()) {
      if (dir === raiz && entrada.name === 'events') continue;
      arquivos.push(...(await coletaArquivos(raiz, caminho)));
      continue;
    }
    if (entrada.isFile()) {
      arquivos.push(relative(raiz, caminho).split(sep).join(posix.sep));
    }
  }

  return arquivos;
}

/**
 * Escolhe o arquivo principal — o HTML que o Fluig lê para montar os campos.
 *
 * Não adivinha quando há mais de um candidato: publicar o HTML errado como
 * principal reescreve a estrutura do formulário no servidor.
 */
function marcaPrincipal(anexos: AnexoForm[], nome: string, pedido?: string): void {
  if (pedido) {
    const escolhido = anexos.find((a) => a.fileName === pedido);
    if (!escolhido) {
      throw new ErroFluigctl(
        `--principal ${pedido} não existe na pasta. Arquivos: ` +
          anexos.map((a) => a.fileName).join(', '),
        6,
      );
    }
    escolhido.principal = true;
    return;
  }

  const htmlsNaRaiz = anexos.filter((a) => !a.fileName.includes('/') && EH_HTML.test(a.fileName));

  if (htmlsNaRaiz.length === 1) {
    htmlsNaRaiz[0]!.principal = true;
    return;
  }

  if (htmlsNaRaiz.length === 0) {
    const emSubpasta = anexos.filter(
      (a) => a.fileName.includes('/') && EH_HTML.test(a.fileName),
    );
    const dica =
      emSubpasta.length > 0
        ? `. Há .html em subpasta: ${emSubpasta.map((a) => a.fileName).join(', ')}` +
          ` — use --principal para escolher um deles`
        : '';

    throw new ErroFluigctl(
      `nenhum arquivo .html na raiz de "${nome}" — ` +
        `não há o que publicar como principal${dica}`,
      6,
    );
  }

  const peloNome = htmlsNaRaiz.find((a) => a.fileName.replace(EH_HTML, '') === nome);
  if (peloNome) {
    peloNome.principal = true;
    return;
  }

  throw new ErroFluigctl(
    `"${nome}" tem mais de um .html na raiz e nenhum com o nome da pasta. ` +
      `Escolha com --principal <arquivo>: ` +
      htmlsNaRaiz.map((a) => a.fileName).join(', '),
    6,
  );
}

/**
 * O Fluig lê o HTML principal para montar os campos e recusa a publicação com
 * "Formulário não possui tag form" se não houver uma. Checar aqui evita a
 * viagem e coloca a mensagem perto da causa.
 */
function exigeTagForm(anexos: AnexoForm[]): void {
  const principal = anexos.find((a) => a.principal);
  if (!principal) return;

  const html = Buffer.from(principal.filecontent, 'base64').toString('utf8');
  if (!/<form[\s>]/i.test(html)) {
    throw new ErroFluigctl(
      `${principal.fileName} não tem a tag <form> — o Fluig a exige para montar ` +
        `os campos do formulário e recusa a publicação sem ela`,
      6,
    );
  }
}

async function leEventos(pasta: string): Promise<EventoForm[]> {
  const dir = join(pasta, 'events');
  const entradas = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entradas) return [];

  const eventos: EventoForm[] = [];
  for (const entrada of entradas) {
    if (!entrada.isFile() || !entrada.name.endsWith('.js')) continue;
    eventos.push({
      eventId: basename(entrada.name, '.js'),
      eventDescription: await readFile(join(dir, entrada.name), 'utf8'),
      eventVersAnt: false,
    });
  }

  return eventos.sort((a, b) => a.eventId.localeCompare(b.eventId));
}
