import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { lerDiagrama } from '../push/diagram/modelo.js';
import { decodificarEntidades, escaparTexto } from '../push/diagram/xml.js';

export type MotivoConflito = 'elemento-removido' | 'nome-alterado' | 'arquivo-alterado' | 'sem-desfazer';

export class ConflitoEdicao extends Error {
  constructor(
    readonly motivo: MotivoConflito,
    message: string,
    readonly atual?: string,
  ) {
    super(message);
    this.name = 'ConflitoEdicao';
  }
}

export class EdicaoInvalida extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdicaoInvalida';
  }
}

interface RegistroDesfazer {
  version: 1;
  arquivo: string;
  hashDepois: string;
  antes: string;
}

const hash = (texto: string): string => createHash('sha256').update(texto).digest('hex');

/** XML 1.0: permite tab, LF e CR; rejeita controles, não caracteres Unicode normais. */
export function validarNome(nome: string): void {
  for (const caractere of nome) {
    const cp = caractere.codePointAt(0)!;
    if (cp === 0 || (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) {
      throw new EdicaoInvalida(`o nome contém o caractere inválido U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
}

function escaparAtributoProcess(valor: string): string {
  // O Studio grava o .process em ASCII com referências numéricas. Manter isso
  // evita que o push diagram recuse bytes não ASCII depois de uma edição visual.
  return [...valor].map((caractere) => {
    const cp = caractere.codePointAt(0)!;
    return cp < 0x20 || cp > 0x7e ? `&#x${cp.toString(16)};` : escaparTexto(caractere);
  }).join('');
}

/**
 * Troca somente o valor de `name` na tag BPMN cujo `id` casa. Não reserializa o
 * XML: espaços, ordem, entidades, blobs e geometria ficam byte a byte iguais.
 */
export function trocarNomeNoXml(xml: string, id: string, nomeEsperado: string, nomeNovo: string): string {
  validarNome(nomeNovo);
  const tag = /<(?<tipo>bpmn2:[\w.-]+)(?<attrs>(?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(?<vazia>\/?)>/g;
  const atributo = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let encontrada: RegExpExecArray | undefined;

  for (const candidata of xml.matchAll(tag)) {
    const attrs = candidata.groups?.['attrs'] ?? '';
    const valores = new Map<string, string>();
    for (const a of attrs.matchAll(atributo)) valores.set(a[1]!, decodificarEntidades(a[2]!));
    if (valores.get('id') !== id) continue;
    if (encontrada) throw new EdicaoInvalida(`o .process tem mais de um objeto com id ${id}`);
    encontrada = candidata;
  }
  if (!encontrada) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);

  const attrs = encontrada.groups?.['attrs'] ?? '';
  const nome = /(?<inicio>\s+name\s*=\s*")(?<valor>[^"]*)(?<fim>")/.exec(attrs);
  if (!nome?.groups) throw new EdicaoInvalida(`o elemento ${id} não possui atributo name`);
  const atual = decodificarEntidades(nome.groups['valor']!);
  if (atual !== nomeEsperado) {
    throw new ConflitoEdicao('nome-alterado', `o nome de ${id} mudou enquanto você editava`, atual);
  }

  const attrsNovos = attrs.slice(0, nome.index) + nome.groups['inicio'] + escaparAtributoProcess(nomeNovo) + nome.groups['fim'] + attrs.slice(nome.index + nome[0].length);
  const inicio = encontrada.index;
  const tagNova = encontrada[0].replace(attrs, attrsNovos);
  return xml.slice(0, inicio) + tagNova + xml.slice(inicio + encontrada[0].length);
}

/**
 * Segue link simbólico antes de gravar. Sem isso, o `rename` da escrita atômica
 * trocaria o link por um arquivo comum, e quem compartilha o `.process` por
 * link passaria a ter duas cópias divergindo em silêncio.
 */
function caminhoReal(arquivo: string): string {
  try {
    return realpathSync(arquivo);
  } catch {
    return resolve(arquivo);
  }
}

function gravarAtomico(arquivo: string, conteudo: string, modo: number): void {
  const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, conteudo, { encoding: 'utf8', mode: modo });
    renameSync(tmp, arquivo);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function caminhoDesfazer(arquivo: string, dir: string): string {
  return join(dir, `${createHash('sha256').update(resolve(arquivo)).digest('hex').slice(0, 24)}.undo.json`);
}

function salvarDesfazer(registro: RegistroDesfazer, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caminho = caminhoDesfazer(registro.arquivo, dir);
  const tmp = `${caminho}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registro)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, caminho);
}

export interface PedidoRenomear {
  arquivo: string;
  id: string;
  nomeOriginal: string;
  nomeNovo: string;
  undoDir: string;
}

export interface ResultadoEdicao {
  arquivo: string;
  id: string;
  nome: string;
  hash: string;
}

export function renomearElemento(pedido: PedidoRenomear): ResultadoEdicao {
  const arquivo = caminhoReal(pedido.arquivo);
  const antes = readFileSync(arquivo, 'utf8');
  // A leitura completa valida a estrutura e garante que o id é um objeto BPMN,
  // não um id homônimo de estilo ou Graphiti.
  const diagrama = lerDiagrama(antes);
  const objeto = diagrama.objetos.find((o) => o.attrs['id'] === pedido.id);
  if (!objeto) throw new ConflitoEdicao('elemento-removido', `o elemento ${pedido.id} não existe mais`);
  if (!Object.prototype.hasOwnProperty.call(objeto.attrs, 'name')) {
    throw new EdicaoInvalida(`o elemento ${pedido.id} não possui atributo name`);
  }
  if (objeto.attrs['name'] !== pedido.nomeOriginal) {
    throw new ConflitoEdicao('nome-alterado', `o nome de ${pedido.id} mudou enquanto você editava`, objeto.attrs['name']);
  }

  const depois = trocarNomeNoXml(antes, pedido.id, pedido.nomeOriginal, pedido.nomeNovo);
  lerDiagrama(depois); // nunca grava um XML que o próprio visualizador não consiga reler
  if (readFileSync(arquivo, 'utf8') !== antes) {
    throw new ConflitoEdicao('arquivo-alterado', 'o arquivo mudou durante o salvamento; tente novamente');
  }

  salvarDesfazer({ version: 1, arquivo, hashDepois: hash(depois), antes }, pedido.undoDir);
  gravarAtomico(arquivo, depois, statSync(arquivo).mode);
  return { arquivo, id: pedido.id, nome: pedido.nomeNovo, hash: hash(depois) };
}

export function desfazerUltimaEdicao(arquivoInformado: string, undoDir: string): ResultadoEdicao {
  const arquivo = caminhoReal(arquivoInformado);
  const caminho = caminhoDesfazer(arquivo, undoDir);
  let registro: RegistroDesfazer;
  try {
    registro = JSON.parse(readFileSync(caminho, 'utf8')) as RegistroDesfazer;
  } catch {
    throw new ConflitoEdicao('sem-desfazer', 'não há edição do visualizador para desfazer');
  }
  if (registro.version !== 1 || resolve(registro.arquivo) !== arquivo) {
    throw new ConflitoEdicao('sem-desfazer', 'o registro de desfazer não pertence a este arquivo');
  }
  const atual = readFileSync(arquivo, 'utf8');
  if (hash(atual) !== registro.hashDepois) {
    throw new ConflitoEdicao('arquivo-alterado', 'o arquivo mudou depois da edição; desfazer apagaria essas mudanças');
  }
  lerDiagrama(registro.antes);
  gravarAtomico(arquivo, registro.antes, statSync(arquivo).mode);
  rmSync(caminho, { force: true });
  return { arquivo, id: '', nome: '', hash: hash(registro.antes) };
}
