import { inflateRawSync } from 'node:zlib';

import { ErroFluigctl } from '../errors.js';

/** Uma entrada do pacote, com o nome como veio e os bytes já descomprimidos. */
export interface EntradaDoZip {
  nome: string;
  dados: Buffer;
}

/**
 * Lê um ZIP pelo diretório central (é ele que tem os tamanhos confiáveis) e
 * devolve todas as entradas de arquivo, na ordem do pacote. Aceita "stored" e
 * "deflate", os dois métodos que um ZIP comum usa. Diretório não vira entrada.
 *
 * `descricao` entra nas mensagens inteira, com o artigo: quem chama diz o que
 * era o pacote ("o pacote do processo \"reembolso\""), e o erro sai legível sem
 * este módulo precisar saber de processo nem de widget.
 */
export function entradasDoZip(zip: Buffer, descricao: string): EntradaDoZip[] {
  const fim = procurarAssinatura(zip, 0x06054b50);
  if (fim < 0) throw new ErroFluigctl(`${descricao} não é um ZIP válido`, 7);

  const total = zip.readUInt16LE(fim + 10);
  let p = zip.readUInt32LE(fim + 16);
  const entradas: EntradaDoZip[] = [];

  for (let i = 0; i < total; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = zip.readUInt16LE(p + 10);
    const sinalizadores = zip.readUInt16LE(p + 8);
    const tamanho = zip.readUInt32LE(p + 20);
    const nomeLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const comentarioLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    // Bit 11 é o aviso de que o nome está em UTF-8; sem ele, o ZIP é latin1 por definição.
    const nome = zip.subarray(p + 46, p + 46 + nomeLen).toString((sinalizadores & 0x0800) !== 0 ? 'utf8' : 'latin1');
    p += 46 + nomeLen + extraLen + comentarioLen;

    if (nome.endsWith('/')) continue;

    const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const dados = zip.subarray(inicio, inicio + tamanho);
    if (metodo === 0) entradas.push({ nome, dados: Buffer.from(dados) });
    else if (metodo === 8) entradas.push({ nome, dados: inflateRawSync(dados) });
    else throw new ErroFluigctl(`${descricao} usa compressão ${metodo} em "${nome}", não suportada`, 7);
  }

  return entradas;
}

/** O primeiro `.xml` do pacote — o `exportProcessInZipFormat` traz um só. */
export function primeiroXmlDoZip(zip: Buffer, rotulo: string): Buffer {
  const descricao = `o pacote do processo "${rotulo}"`;
  const xml = entradasDoZip(zip, descricao).find((e) => e.nome.toLowerCase().endsWith('.xml'));
  if (!xml) throw new ErroFluigctl(`${descricao} não contém um .xml`, 7);
  return xml.dados;
}

function procurarAssinatura(b: Buffer, assinatura: number): number {
  for (let i = b.length - 22; i >= 0; i--) {
    if (b.readUInt32LE(i) === assinatura) return i;
  }
  return -1;
}
