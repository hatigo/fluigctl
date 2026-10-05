import { closeSync, openSync, writeSync } from 'node:fs';
import { ReadStream, WriteStream, isatty } from 'node:tty';
/**
 * O terminal cru: modo raw, tela alternativa, leitura de tecla e desenho de um
 * quadro. Sem biblioteca — o fluigctl tem uma dependência só e o TUI não é
 * motivo para a segunda.
 *
 * Tudo passa por `/dev/tty`, como o `promptPassword`: a entrada e a saída do
 * TUI são o terminal, mesmo que stdin ou stdout estejam redirecionados. Sem um
 * terminal de verdade não há TUI, e a recusa é explicada.
 */

/** Uma tecla já decodificada. */
export type Tecla =
  | { tipo: 'caractere'; valor: string }
  | { tipo: 'cima' }
  | { tipo: 'baixo' }
  | { tipo: 'esquerda' }
  | { tipo: 'direita' }
  | { tipo: 'enter' }
  | { tipo: 'tab' }
  | { tipo: 'backspace' }
  | { tipo: 'escape' }
  | { tipo: 'ctrl-c' };

export interface Terminal {
  /** Tamanho atual, atualizado a cada mudança de janela. */
  tamanho(): { colunas: number; linhas: number };
  /** Uma tecla por vez, até o terminal fechar. */
  teclas(): AsyncIterable<Tecla>;
  /** Troca o quadro inteiro. */
  desenhar(quadro: string): void;
  fechar(): void;
}

const TELA_ALTERNATIVA = '\x1b[?1049h';
const VOLTA_TELA = '\x1b[?1049l';
const ESCONDE_CURSOR = '\x1b[?25l';
const MOSTRA_CURSOR = '\x1b[?25h';
const INICIO = '\x1b[H';
const LIMPA = '\x1b[2J';

export function abrirTerminal(caminho = '/dev/tty'): Terminal {
  let fd: number;
  try {
    fd = openSync(caminho, 'r+');
  } catch (erro) {
    throw new Error(
      `não foi possível abrir o terminal ${caminho}: ${(erro as Error).message}. ` +
        'O TUI precisa de um terminal de verdade.',
    );
  }
  if (!isatty(fd)) {
    closeSync(fd);
    throw new Error(`${caminho} não é um terminal. O TUI precisa de um terminal de verdade.`);
  }

  const entrada = new ReadStream(fd);
  const saida = new WriteStream(fd);
  let fechado = false;

  const limpar = () => {
    if (fechado) return;
    writeSync(fd, MOSTRA_CURSOR + VOLTA_TELA);
  };

  writeSync(fd, TELA_ALTERNATIVA + ESCONDE_CURSOR);
  if (entrada.isTTY) entrada.setRawMode(true);
  // Se o processo morrer por sinal, a tela alternativa não pode ficar presa.
  process.once('exit', limpar);
  process.once('SIGTERM', () => {
    limpar();
    process.exit(143);
  });

  return {
    tamanho: () => ({
      colunas: saida.columns || 80,
      linhas: saida.rows || 24,
    }),

    desenhar(quadro: string) {
      // Um write só, com limpeza: menos piscada que escrever linha a linha.
      writeSync(fd, INICIO + LIMPA + quadro);
    },

    async *teclas(): AsyncIterable<Tecla> {
      let pendente: Buffer = Buffer.alloc(0);
      const fila: Tecla[] = [];
      let acordar: (() => void) | undefined;
      let relogioEsc: NodeJS.Timeout | undefined;
      let fim = false;

      const acorda = () => {
        acordar?.();
        acordar = undefined;
      };

      const limpaRelogio = () => {
        if (relogioEsc) clearTimeout(relogioEsc);
        relogioEsc = undefined;
      };

      const consome = () => {
        limpaRelogio();
        const { teclas, resto, incompleto } = decodificar(pendente);
        pendente = resto;
        fila.push(...teclas);
        if (incompleto) {
          // Se o resto não chegar, o que ficou pendente é o que é de verdade:
          // ESC sozinho vira cancelar, e o pedaço de seta vira caractere.
          relogioEsc = setTimeout(() => {
            fila.push(...desistir(pendente));
            pendente = Buffer.alloc(0);
            acorda();
          }, ESPERA_ESC_MS);
        }
        acorda();
      };

      entrada.on('data', (bloco: Buffer) => {
        pendente = Buffer.concat([pendente, bloco]);
        consome();
      });
      entrada.on('end', () => {
        fim = true;
        acorda();
      });

      try {
        while (!fim || fila.length > 0) {
          if (fila.length === 0) {
            await new Promise<void>((resolve) => (acordar = resolve));
            continue;
          }
          const tecla = fila.shift()!;
          yield tecla;
          if (tecla.tipo === 'ctrl-c') return;
        }
      } finally {
        limpaRelogio();
        if (entrada.isTTY) entrada.setRawMode(false);
        entrada.destroy();
        saida.destroy();
      }
    },

    fechar() {
      if (fechado) return;
      fechado = true;
      limpar();
      process.removeListener('exit', limpar);
      try {
        closeSync(fd);
      } catch {
        /* já fechado pelo WriteStream */
      }
    },
  };
}

const SETAS: Record<string, Tecla> = {
  '\x1b[A': { tipo: 'cima' },
  '\x1b[B': { tipo: 'baixo' },
  '\x1b[C': { tipo: 'direita' },
  '\x1b[D': { tipo: 'esquerda' },
};

/** Quanto esperar por uma seta que veio partida em dois blocos. */
export const ESPERA_ESC_MS = 30;

export interface Decodificado {
  teclas: Tecla[];
  /** O que não deu para decidir ainda (seta ou caractere partido). */
  resto: Buffer;
  /**
   * O buffer terminou numa sequência de escape começada mas incompleta: pode
   * ser uma seta partida em dois blocos, ou um ESC sozinho. Quem lê decide pelo
   * tempo, com `ESPERA_ESC_MS`.
   */
  incompleto: boolean;
}

/** O resto é prefixo de uma sequência conhecida e ainda não a completou? */
function faltaCompletar(resto: Buffer): boolean {
  const texto = resto.toString('latin1');
  return Object.keys(SETAS).some((s) => s.startsWith(texto) && texto.length < s.length);
}

/**
 * Consome o que já está completo no buffer.
 *
 * Sequência de escape partida em dois blocos é o caso chato: o pedaço fica no
 * `resto` e completa no próximo `data` — inclusive o `\x1b[` sem a letra, que
 * sem isso viraria "cancelar" mais o caractere `[`. Se a sequência não chegar,
 * quem lê usa `desistir`.
 */
export function decodificar(buffer: Buffer): Decodificado {
  const teclas: Tecla[] = [];
  let i = 0;

  while (i < buffer.length) {
    const byte = buffer[i]!;

    if (byte === 0x1b) {
      const resto = buffer.subarray(i);
      const tecla = SETAS[resto.subarray(0, 3).toString('latin1')];
      if (tecla) {
        teclas.push(tecla);
        i += 3;
        continue;
      }
      // Pode ser o começo de uma seta; espera o resto chegar.
      if (faltaCompletar(resto)) break;
      // ESC seguido de outra coisa é cancelar seguido da outra coisa.
      teclas.push({ tipo: 'escape' });
      i += 1;
      continue;
    }

    if (byte === 0x0d || byte === 0x0a) { teclas.push({ tipo: 'enter' }); i += 1; continue; }
    if (byte === 0x09) { teclas.push({ tipo: 'tab' }); i += 1; continue; }
    if (byte === 0x7f || byte === 0x08) { teclas.push({ tipo: 'backspace' }); i += 1; continue; }
    if (byte === 0x03) { teclas.push({ tipo: 'ctrl-c' }); i += 1; continue; }
    // Outro controle (Ctrl+letra) não tem uso aqui: ignorar é melhor que
    // transformar em letra e disparar um atalho sem querer.
    if (byte < 0x20) { i += 1; continue; }

    const tamanho = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (i + tamanho > buffer.length) break; // caractere partido no fim do bloco.
    const fatia = buffer.subarray(i, i + tamanho);
    teclas.push({ tipo: 'caractere', valor: fatia.toString('utf8') });
    i += tamanho;
  }

  const resto = Buffer.from(buffer.subarray(i));
  return { teclas, resto, incompleto: resto.length > 0 && resto[0] === 0x1b };
}

/**
 * A sequência incompleta não veio: trata o que sobrou como teclas de verdade —
 * o ESC como cancelar, o resto como caracteres.
 */
export function desistir(resto: Buffer): Tecla[] {
  if (resto.length === 0) return [];
  if (resto[0] !== 0x1b) return decodificar(resto).teclas;
  return [{ tipo: 'escape' }, ...decodificar(resto.subarray(1)).teclas];
}

/**
 * Quebra um texto em linhas de no máximo `largura`, sem cortar palavra quando
 * ela cabe. Usado pelos avisos, que podem ser longos.
 */
export function quebrar(texto: string, largura: number): string[] {
  const linhas: string[] = [];
  let atual = '';
  for (const palavra of texto.split(/\s+/).filter(Boolean)) {
    if (atual === '') atual = palavra;
    else if (atual.length + 1 + palavra.length <= largura) atual += ` ${palavra}`;
    else {
      linhas.push(atual);
      atual = palavra;
    }
  }
  if (atual !== '') linhas.push(atual);
  return linhas.length === 0 ? [''] : linhas;
}
