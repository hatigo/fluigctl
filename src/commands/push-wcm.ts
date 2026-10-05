import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { login } from '../fluig/session.js';
import { montarZip } from '../push/war.js';
import { lerWcm, type TipoWcm } from '../push/wcm-source.js';

/**
 * Sobe uma aplicação WCM — widget ou layout — empacotada como `.war` em memória,
 * pelo mesmo endpoint da extensão Fluiggers. O servidor instala ou atualiza
 * conforme o nome; não há `--create`.
 *
 * Widget e layout são a mesma coisa para o servidor: estrutura Maven idêntica,
 * mesmo pacote, mesma rota. O que os separa é o `application.type` do
 * `application.info`, e é ele que o `lerWcm` confere contra o comando pedido —
 * sem isso, `push widget` numa pasta de layout publicaria o layout como widget,
 * e o servidor aceita (medido no fluig-localdev).
 *
 * A ordem importa: lê a pasta e monta o pacote (qualquer recusa local sai
 * aqui), devolve no dry-run sem nem abrir sessão, passa pelo gate de produção
 * e só então envia. A instalação no servidor é assíncrona: uma resposta de
 * sucesso quer dizer que o `.war` foi aceito, não que já está no ar.
 */

export interface OpcoesPushWcm {
  server: Server;
  senha: string;
  pasta: string;
  tipo: TipoWcm;
  dryRun?: boolean;
  prompt: PromptSenha;
}

export interface ResultadoPushWcm {
  /** A pasta publicada. */
  pasta: string;
  /** O alvo de verdade: o `application.code`, que é como o servidor registra. */
  codigo: string;
  tipo: TipoWcm;
  entradas: number;
  bytes: number;
  url: string;
  /** A pasta tem outro nome que o `application.code`; o alvo é o código. */
  aviso?: string;
}

const CAMINHO_UPLOAD = '/portal/api/rest/wcmservice/rest/product/uploadfile';

export async function pushWcm(opcoes: OpcoesPushWcm): Promise<ResultadoPushWcm> {
  const { server, senha, tipo } = opcoes;

  const { nome, codigo, entradas } = await lerWcm(opcoes.pasta, tipo);
  const war = montarZip(entradas);
  const base = serverUrl(server);
  const resultado: ResultadoPushWcm = {
    pasta: nome,
    codigo,
    tipo,
    entradas: entradas.length,
    bytes: war.length,
    url: base + CAMINHO_UPLOAD,
  };
  // O nome do .war não escolhe o alvo (o servidor usa o application.code), mas
  // pasta e código diferentes costumam ser engano de quem renomeou uma ou outro.
  if (nome !== codigo) {
    resultado.aviso = `a pasta se chama "${nome}" e o application.code é "${codigo}": o push publica "${codigo}".`;
  }

  if (opcoes.dryRun) return resultado;

  await confirmProduction(server, senha, `push ${tipo} ${codigo}`, opcoes.prompt);

  const cookie = await login(base, server.username, senha);
  const arquivo = `${codigo}.war`;
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
      `o servidor recusou o ${tipo} "${codigo}" (HTTP ${resposta.status}): ${texto.slice(0, 300)}`,
      7,
    );
  }

  let conteudo: { message?: string | { message?: string } } | null;
  try {
    conteudo = JSON.parse(texto) as typeof conteudo;
  } catch {
    throw new ErroFluigctl(
      `resposta inesperada ao enviar o ${tipo} "${codigo}" (HTTP ${resposta.status}): não é JSON`,
      7,
    );
  }

  if (conteudo?.message) {
    const mensagem =
      typeof conteudo.message === 'string' ? conteudo.message : conteudo.message.message;
    throw new ErroFluigctl(
      `o servidor recusou o ${tipo} "${codigo}": ${mensagem ?? JSON.stringify(conteudo.message)}`,
      7,
    );
  }

  return resultado;
}
