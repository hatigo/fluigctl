import { inflateRawSync } from 'node:zlib';

import { ErroFluigctl } from '../errors.js';

/**
 * Extrai o primeiro `.xml` de um ZIP — o pacote do `exportProcessInZipFormat` traz
 * um só. Lê o diretório central (é ele que tem os tamanhos confiáveis) e aceita
 * "stored" e "deflate", os dois métodos que um ZIP comum usa. Evita uma
 * dependência inteira para abrir um arquivo de um único item.
 */
export function primeiroXmlDoZip(zip: Buffer, rotulo: string): Buffer {
  const fim = procurarAssinatura(zip, 0x06054b50);
  if (fim < 0) throw new ErroFluigctl(`o pacote do processo "${rotulo}" não é um ZIP válido`, 7);

  const entradas = zip.readUInt16LE(fim + 10);
  let p = zip.readUInt32LE(fim + 16);

  for (let i = 0; i < entradas; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = zip.readUInt16LE(p + 10);
    const tamanho = zip.readUInt32LE(p + 20);
    const nomeLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const comentarioLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const nome = zip.subarray(p + 46, p + 46 + nomeLen).toString('latin1');
    p += 46 + nomeLen + extraLen + comentarioLen;

    if (!nome.toLowerCase().endsWith('.xml')) continue;

    const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const dados = zip.subarray(inicio, inicio + tamanho);
    if (metodo === 0) return Buffer.from(dados);
    if (metodo === 8) return inflateRawSync(dados);
    throw new ErroFluigctl(`o pacote do processo "${rotulo}" usa compressão ${metodo}, não suportada`, 7);
  }

  throw new ErroFluigctl(`o pacote do processo "${rotulo}" não contém um .xml`, 7);
}

function procurarAssinatura(b: Buffer, assinatura: number): number {
  for (let i = b.length - 22; i >= 0; i--) {
    if (b.readUInt32LE(i) === assinatura) return i;
  }
  return -1;
}
