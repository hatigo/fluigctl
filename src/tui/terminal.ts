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
  tamanho(): Tamanho;
  /** Uma tecla por vez, até o terminal fechar. */
  teclas(): AsyncIterable<Tecla>;
  /** Troca o quadro inteiro. */
  desenhar(quadro: string): void;
  /** Chama quando a janela muda de tamanho. Devolve como parar de ouvir. */
  aoRedimensionar(ouvinte: (t: Tamanho) => void): () => void;
  fechar(): void;
}

export interface Tamanho {
  colunas: number;
  linhas: number;
}

export interface OpcoesTerminal {
  caminho?: string;
  /** Como ler o tamanho da janela. Existe para o teste não precisar de tty. */
  lerTamanho?: () => Tamanho;
  /** Como ouvir o sinal de redimensionamento. Idem. */
  inscrever?: (f: () => void) => () => void;
}

const TELA_ALTERNATIVA = '\x1b[?1049h';
const VOLTA_TELA = '\x1b[?1049l';
const ESCONDE_CURSOR = '\x1b[?25l';
const MOSTRA_CURSOR = '\x1b[?25h';
const INICIO = '\x1b[H';
const LIMPA = '\x1b[2J';

export function abrirTerminal(opcoes: OpcoesTerminal | string = {}): Terminal {
  const config = typeof opcoes === 'string' ? { caminho: opcoes } : opcoes;
  const caminho = config.caminho ?? '/dev/tty';
  let fd: number;
  try {
    fd = openSync(caminho, 'r+');
  } catch (erro) {
    throw new Error(
      `não foi possível abrir o terminal ${caminho}: ${(erro as Error).message}. ` +
        'A tela precisa de um terminal de verdade.',
    );
  }
  if (!isatty(fd)) {
    closeSync(fd);
    throw new Error(`${caminho} não é um terminal. A tela precisa de um terminal de verdade.`);
  }

  const entrada = new ReadStream(fd);
  const saida = new WriteStream(fd);
  let fechado = false;

  /*
   * O tamanho não vem do `WriteStream` guardado: o Node só mantém
   * `columns`/`rows` em dia para `process.stdout`, e num fd próprio ele fica
   * congelado no valor da abertura — medido, com SIGWINCH e tudo. Um
   * `WriteStream` recém-criado, porém, lê o tamanho atual, e `destroy` nele não
   * fecha o fd. É daí que sai o tamanho, uma vez na abertura e outra a cada
   * SIGWINCH.
   */
  const lerTamanho =
    config.lerTamanho ??
    ((): Tamanho => {
      const sonda = new WriteStream(fd);
      const t = { colunas: sonda.columns || saida.columns || 80, linhas: sonda.rows || saida.rows || 24 };
      sonda.destroy();
      return t;
    });

  const inscrever =
    config.inscrever ??
    ((f: () => void) => {
      process.on('SIGWINCH', f);
      return () => process.removeListener('SIGWINCH', f);
    });

  let atual: Tamanho = { colunas: 80, linhas: 24 };
  try {
    atual = lerTamanho();
  } catch {
    /* sem tty legível, fica no padrão */
  }
  const ouvintes = new Set<(t: Tamanho) => void>();
  const paraDeVigiar = vigiarTamanho({
    ler: lerTamanho,
    avisar: (t) => {
      atual = t;
      for (const ouvinte of ouvintes) ouvinte(t);
    },
    inscrever,
    inicial: atual,
  });

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
    tamanho: () => atual,

    aoRedimensionar(ouvinte) {
      ouvintes.add(ouvinte);
      return () => ouvintes.delete(ouvinte);
    },

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
      paraDeVigiar();
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

/**
 * Avisa quando o tamanho da janela muda, comparando com o último visto.
 *
 * Separado de `abrirTerminal` para poder ser testado sem terminal: `inscrever`
 * e `ler` entram por parâmetro, então o teste troca a fonte do sinal e a do
 * tamanho.
 */
export function vigiarTamanho(opcoes: {
  ler: () => Tamanho;
  avisar: (t: Tamanho) => void;
  inscrever: (f: () => void) => () => void;
  inicial?: Tamanho;
}): () => void {
  let ultimo = opcoes.inicial;
  return opcoes.inscrever(() => {
    let lido: Tamanho;
    try {
      lido = opcoes.ler();
    } catch {
      return;
    }
    if (ultimo && lido.colunas === ultimo.colunas && lido.linhas === ultimo.linhas) return;
    ultimo = lido;
    opcoes.avisar(lido);
  });
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
