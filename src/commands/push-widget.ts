import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { login } from '../fluig/session.js';
import { montarZip } from '../push/war.js';
import { readWidget } from '../push/widget-source.js';

export interface OpcoesPushWidget {
  server: Server;
  senha: string;
  pasta: string;
  dryRun?: boolean;
  prompt: PromptSenha;
}

export interface ResultadoPushWidget {
  nome: string;
  entradas: number;
  bytes: number;
  url: string;
}

const CAMINHO_UPLOAD = '/portal/api/rest/wcmservice/rest/product/uploadfile';

/**
 * Sobe uma widget, empacotada como `.war` em memória, pelo mesmo endpoint da
 * extensão Fluiggers. O servidor instala ou atualiza conforme o nome — não há
 * `--create`.
 *
 * A ordem importa: lê a pasta e monta o pacote (qualquer recusa local sai
 * aqui), devolve no dry-run sem nem abrir sessão, passa pelo gate de produção
 * e só então envia. A instalação no servidor é assíncrona: uma resposta de
 * sucesso quer dizer que o `.war` foi aceito, não que a widget já está no ar.
 */
export async function pushWidget(opcoes: OpcoesPushWidget): Promise<ResultadoPushWidget> {
  const { server, senha } = opcoes;

  const { nome, entradas } = await readWidget(opcoes.pasta);
  const war = montarZip(entradas);
  const base = serverUrl(server);
  const resultado = { nome, entradas: entradas.length, bytes: war.length, url: base + CAMINHO_UPLOAD };

  if (opcoes.dryRun) return resultado;

  await confirmProduction(server, senha, `push widget ${nome}`, opcoes.prompt);

  const cookie = await login(base, server.username, senha);
  const arquivo = `${nome}.war`;
  const corpo = new FormData();
  corpo.append('fileName', arquivo);
  corpo.append('fileDescription', 'WCM Eclipse Plugin Deploy Artifact');
  corpo.append('attachment', new Blob([new Uint8Array(war)]), arquivo);

  const resposta = await fetch(resultado.url, {
    method: 'POST',
    headers: { accept: 'application/json', cookie },
    body: corpo,
    redirect: 'manual',
  });
  const texto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroFluigctl(
      `o servidor recusou a widget "${nome}" (HTTP ${resposta.status}): ${texto.slice(0, 300)}`,
      7,
    );
  }

  let conteudo: { message?: string | { message?: string } } | null;
  try {
    conteudo = JSON.parse(texto) as typeof conteudo;
  } catch {
    throw new ErroFluigctl(
      `resposta inesperada ao enviar a widget "${nome}" (HTTP ${resposta.status}): não é JSON`,
      7,
    );
  }

  if (conteudo?.message) {
    const mensagem =
      typeof conteudo.message === 'string' ? conteudo.message : conteudo.message.message;
    throw new ErroFluigctl(
      `o servidor recusou a widget "${nome}": ${mensagem ?? JSON.stringify(conteudo.message)}`,
      7,
    );
  }

  return resultado;
}
