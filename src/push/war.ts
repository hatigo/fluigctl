import { crc32 } from 'node:zlib';

import { ErroFluigctl } from '../errors.js';

export interface EntradaZip {
  /** Caminho dentro do pacote, com `/`. */
  nome: string;
  dados: Buffer;
}

/** Bit 11 do general purpose flag: nome da entrada em UTF-8. */
const NOME_UTF8 = 0x0800;
const VERSAO = 20;
const LIMITE = 0xffffffff;

/**
 * Monta um ZIP com as entradas "stored", sem compressão — o mesmo que a
 * extensão Fluiggers gera para o `.war` da widget. Sem ZIP64: uma widget que
 * passe de 4 GiB ou de 65535 arquivos é recusada, não truncada.
 */
export function montarZip(entradas: EntradaZip[], quando: Date = new Date()): Buffer {
  if (entradas.length > 0xffff) {
    throw new ErroFluigctl(`o pacote teria ${entradas.length} arquivos, acima do que um ZIP comum aceita`, 6);
  }

  const { hora, data } = dataDos(quando);
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;

  for (const entrada of entradas) {
    const nome = Buffer.from(entrada.nome, 'utf8');
    const crc = crc32(entrada.dados);
    const tamanho = entrada.dados.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSAO, 4);
    local.writeUInt16LE(NOME_UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(tamanho, 18);
    local.writeUInt32LE(tamanho, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSAO, 4);
    central.writeUInt16LE(VERSAO, 6);
    central.writeUInt16LE(NOME_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(tamanho, 20);
    central.writeUInt32LE(tamanho, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);

    locais.push(local, nome, entrada.dados);
    centrais.push(central, nome);
    deslocamento += local.length + nome.length + tamanho;
    if (deslocamento > LIMITE) {
      throw new ErroFluigctl('o pacote passaria de 4 GiB, acima do que um ZIP comum aceita', 6);
    }
  }

  const tamanhoCentral = centrais.reduce((soma, b) => soma + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...locais, ...centrais, fim]);
}

/** Data e hora no formato do MS-DOS, que é o que o ZIP guarda. */
function dataDos(d: Date): { hora: number; data: number } {
  const ano = Math.max(d.getFullYear(), 1980);
  return {
    hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    data: ((ano - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
