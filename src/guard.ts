import { timingSafeEqual } from 'node:crypto';

import { serverUrl, type Server } from './config.js';
import { ErroFluigctl } from './errors.js';

export type PromptSenha = (mensagem: string) => Promise<string>;

function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Porteiro de produção.
 *
 * Em servidor marcado `prod`, exige que a senha seja digitada no terminal e
 * confira com a da variável de ambiente. A senha digitada é só autorização —
 * quem vai no SOAP é sempre a do ambiente.
 *
 * Sem TTY o push é recusado. Isso é proposital: processos não interativos,
 * incluindo agentes, não sobem em produção.
 */
export async function confirmProduction(
  server: Server,
  senhaEsperada: string,
  operacao: string,
  prompt: PromptSenha,
): Promise<void> {
  if (!server.prod) return;

  const alvo = `${serverUrl(server)} como ${server.username}`;
  const mensagem =
    `PRODUÇÃO — ${operacao}\n` +
    `  alvo: ${alvo}\n` +
    `  Digite a senha para confirmar: `;

  let digitada: string;
  try {
    digitada = await prompt(mensagem);
  } catch (erro) {
    throw new ErroFluigctl(
      `este servidor está marcado como produção e exige confirmação ` +
        `interativa no terminal, que não está disponível ` +
        `(${(erro as Error).message}). ` +
        `Isto é intencional: pushes em produção não podem ser feitos por ` +
        `processos não interativos.`,
      5,
    );
  }

  if (!iguais(digitada, senhaEsperada)) {
    throw new ErroFluigctl(
      `a senha digitada não confere com ${server.passwordEnv}. ` +
        `Nada foi enviado para ${alvo}.`,
      5,
    );
  }
}
