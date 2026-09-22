import { ErroFluigctl } from '../errors.js';

export interface UsuarioFluig {
  companyId: number;
  userCode: string;
}

/**
 * Autentica no portal e devolve a string de Cookie da sessão.
 *
 * O Fluig responde 200 com a tela de login quando a credencial está errada,
 * então a ausência de Set-Cookie é o único sinal confiável de falha.
 */
export async function login(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const corpo = new URLSearchParams({
    j_username: username,
    j_password: password,
  });

  const resposta = await fetch(`${baseUrl}/portal/api/servlet/login.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: corpo.toString(),
    redirect: 'manual',
  });

  const cookies = resposta.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]?.trim())
    .filter((c): c is string => Boolean(c));

  if (cookies.length === 0) {
    throw new ErroFluigctl(
      `o servidor não abriu sessão para "${username}" — credenciais recusadas ` +
        `(HTTP ${resposta.status}, nenhum Set-Cookie na resposta)`,
      4,
    );
  }

  return cookies.join('; ');
}

/**
 * Revalida a sessão.
 *
 * O endpoint responde 200 mesmo sem sessão válida, devolvendo a tela de login,
 * então a checagem é do corpo e nunca do status. O formato do corpo varia: o
 * Fluig 1.8 do CETENCO devolve `{"response":"pong"}`, e há servidores que
 * devolvem só o texto `pong`. Os dois valem.
 */
export async function ping(baseUrl: string, cookie: string): Promise<boolean> {
  const resposta = await fetch(`${baseUrl}/portal/p/api/servlet/ping`, {
    method: 'POST',
    headers: { cookie },
    redirect: 'manual',
  });

  const corpo = (await resposta.text()).trim();
  if (corpo === 'pong') return true;

  try {
    return (JSON.parse(corpo) as { response?: string }).response === 'pong';
  } catch {
    return false;
  }
}

export async function findUserByLogin(
  baseUrl: string,
  cookie: string,
  login: string,
): Promise<UsuarioFluig> {
  const url =
    `${baseUrl}/portal/api/rest/wcmservice/rest/user/findUserByLogin` +
    `?login=${encodeURIComponent(login)}`;

  const resposta = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  const texto = await resposta.text();

  let conteudo: { content?: { tenantId?: number; userCode?: string } | null };
  try {
    conteudo = JSON.parse(texto) as typeof conteudo;
  } catch {
    throw new Error(
      `resposta inesperada ao consultar o usuário "${login}" ` +
        `(HTTP ${resposta.status}): não é JSON`,
    );
  }

  const content = conteudo.content;
  if (!content || content.tenantId === undefined || content.userCode === undefined) {
    throw new ErroFluigctl(
      `o servidor não reconheceu o usuário "${login}" — ` +
        `confira o login cadastrado para este servidor`,
      4,
    );
  }

  return { companyId: content.tenantId, userCode: content.userCode };
}
