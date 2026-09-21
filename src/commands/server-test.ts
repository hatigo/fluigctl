import { serverUrl, type Server } from '../config.js';
import { findUserByLogin, login, ping } from '../fluig/session.js';

export interface ResultadoTeste {
  pingOk: boolean;
  companyId: number;
  userCode: string;
  divergencias: string[];
}

/**
 * Prova que a credencial funciona e que o cadastro bate com o servidor.
 * Só leitura — nenhum artefato é tocado.
 */
export async function testServer(
  server: Server,
  senha: string,
): Promise<ResultadoTeste> {
  const url = serverUrl(server);

  const cookie = await login(url, server.username, senha);
  const pingOk = await ping(url, cookie);
  const usuario = await findUserByLogin(url, cookie, server.username);

  const divergencias: string[] = [];
  if (usuario.companyId !== server.companyId) {
    divergencias.push(
      `companyId cadastrado é ${server.companyId}, mas o servidor diz ${usuario.companyId}`,
    );
  }
  if (usuario.userCode !== server.userCode) {
    divergencias.push(
      `userCode cadastrado é "${server.userCode}", mas o servidor diz "${usuario.userCode}"`,
    );
  }

  return { pingOk, companyId: usuario.companyId, userCode: usuario.userCode, divergencias };
}
