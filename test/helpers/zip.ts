import { deflateRawSync } from 'node:zlib';

/** Monta um ZIP de um arquivo só, como o exportProcessInZipFormat devolve. */
export function zipDeUmArquivo(nome: string, conteudo: Buffer, comprimir = true): Buffer {
  const nomeB = Buffer.from(nome, 'latin1');
  const dados = comprimir ? deflateRawSync(conteudo) : conteudo;
  const metodo = comprimir ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(metodo, 8);
  local.writeUInt32LE(dados.length, 18);
  local.writeUInt32LE(conteudo.length, 22);
  local.writeUInt16LE(nomeB.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(metodo, 10);
  central.writeUInt32LE(dados.length, 20);
  central.writeUInt32LE(conteudo.length, 24);
  central.writeUInt16LE(nomeB.length, 28);
  central.writeUInt32LE(0, 42);

  const inicioCentral = local.length + nomeB.length + dados.length;
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(1, 8);
  fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(central.length + nomeB.length, 12);
  fim.writeUInt32LE(inicioCentral, 16);

  return Buffer.concat([local, nomeB, dados, central, nomeB, fim]);
}
