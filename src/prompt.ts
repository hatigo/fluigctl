import { closeSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ReadStream } from 'node:tty';
import { isatty } from 'node:tty';

/**
 * Lê uma senha do terminal, sem eco.
 *
 * Abre `/dev/tty` diretamente em vez de usar `process.stdin`, e exige que o
 * descritor seja mesmo um terminal. Sem isso, rodar o comando com stdin vindo
 * de pipe ou arquivo passaria pelo gate de produção.
 */
export async function promptPassword(
  mensagem: string,
  ttyPath = '/dev/tty',
): Promise<string> {
  let fd: number;
  try {
    fd = openSync(ttyPath, 'r+');
  } catch (erro) {
    throw new Error(
      `não foi possível abrir o tty ${ttyPath}: ${(erro as Error).message}`,
    );
  }

  try {
    if (!isatty(fd)) {
      throw new Error(`${ttyPath} não é um terminal`);
    }

    writeSync(fd, mensagem);

    const entrada = new ReadStream(fd);
    entrada.setRawMode(true);

    const rl = createInterface({ input: entrada, terminal: true });
    try {
      const senha = await new Promise<string>((resolve) => {
        const teclas: string[] = [];
        entrada.on('data', (bloco: Buffer) => {
          for (const byte of bloco) {
            if (byte === 0x0d || byte === 0x0a) {
              resolve(teclas.join(''));
              return;
            }
            if (byte === 0x03) {
              resolve('');
              return;
            }
            if (byte === 0x7f || byte === 0x08) {
              teclas.pop();
              continue;
            }
            teclas.push(String.fromCharCode(byte));
          }
        });
      });
      writeSync(fd, '\n');
      return senha;
    } finally {
      rl.close();
      entrada.setRawMode(false);
      entrada.destroy();
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* já fechado pelo ReadStream */
    }
  }
}
