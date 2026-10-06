import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { lerDiagrama, type Caixa, type Ponto } from '../push/diagram/modelo.js';
import { decodificarEntidades, escaparTexto } from '../push/diagram/xml.js';
import { checarDiagrama, type Achado } from './check.js';
import { rotaOrtogonal } from './route.js';

export type MotivoConflito = 'elemento-removido' | 'nome-alterado' | 'arquivo-alterado' | 'sem-desfazer' | 'sem-refazer';

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

/**
 * Histórico de edições do visualizador, por arquivo, fora do workspace.
 *
 * Desfazer guarda o texto de antes e o hash de depois: só desfaz enquanto o
 * arquivo for exatamente o que a edição deixou. Refazer é o espelho. Uma edição
 * nova esvazia o refazer, como em qualquer editor.
 */
interface Historico {
  version: 2;
  arquivo: string;
  desfazer: { antes: string; hashDepois: string }[];
  refazer: { depois: string; hashAntes: string }[];
}

/** A versão 1 guardava um único desfazer. */
interface HistoricoV1 {
  version: 1;
  arquivo: string;
  hashDepois: string;
  antes: string;
}

/** Arquivos grandes chegam a ~370 KB; 30 níveis cabem sem pesar no disco. */
const NIVEIS = 30;

export const hash = (texto: string): string => createHash('sha256').update(texto).digest('hex');

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

function salvarHistorico(registro: Historico, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caminho = caminhoDesfazer(registro.arquivo, dir);
  const tmp = `${caminho}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registro)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, caminho);
}

function lerHistorico(arquivo: string, dir: string): Historico {
  const vazio: Historico = { version: 2, arquivo, desfazer: [], refazer: [] };
  let bruto: Historico | HistoricoV1;
  try {
    bruto = JSON.parse(readFileSync(caminhoDesfazer(arquivo, dir), 'utf8')) as Historico | HistoricoV1;
  } catch {
    return vazio;
  }
  if (resolve(bruto.arquivo) !== arquivo) return vazio;
  if (bruto.version === 1) return { ...vazio, desfazer: [{ antes: bruto.antes, hashDepois: bruto.hashDepois }] };
  if (bruto.version !== 2 || !Array.isArray(bruto.desfazer) || !Array.isArray(bruto.refazer)) return vazio;
  return bruto;
}

/** Erros de estrutura de um texto, como chaves comparáveis. */
function errosDeEstrutura(texto: string): Set<string> {
  return new Set(
    checarDiagrama(texto)
      .filter((a) => a.grupo === 'estrutura' && a.nivel === 'erro')
      .map((a) => `${a.onde}: ${a.mensagem}`),
  );
}

const chave = (a: Achado) => `${a.nivel} ${a.grupo} ${a.onde}: ${a.mensagem}`;

export interface ResultadoAplicacao {
  arquivo: string;
  hash: string;
  /** Achados do diagram check que a edição fez aparecer (desenho fora da receita, raia trocada...). */
  avisos: Achado[];
}

/**
 * O caminho de toda edição do visualizador.
 *
 * 1. Com `hashBase`, o arquivo tem de ser o que a tela mostrava; senão é conflito.
 * 2. A edição é uma troca de texto: nada é reserializado.
 * 3. O resultado precisa ser relido, e não pode ter erro de estrutura que o
 *    arquivo não tinha antes (o `diagram check`); senão nada é gravado.
 * 4. O arquivo é conferido de novo logo antes da escrita atômica, e a versão de
 *    antes vai para o histórico.
 */
export function aplicarEdicao(
  arquivoInformado: string,
  undoDir: string,
  transformar: (texto: string) => string,
  hashBase?: string,
): ResultadoAplicacao {
  const arquivo = caminhoReal(arquivoInformado);
  const antes = readFileSync(arquivo, 'utf8');
  if (hashBase !== undefined && hash(antes) !== hashBase) {
    throw new ConflitoEdicao('arquivo-alterado', 'o arquivo mudou desde que a tela foi desenhada; a tela já foi atualizada, tente de novo');
  }
  const depois = transformar(antes);
  lerDiagrama(depois); // nunca grava um XML que o próprio visualizador não consiga reler

  const errosAntes = errosDeEstrutura(antes);
  const novos = [...errosDeEstrutura(depois)].filter((e) => !errosAntes.has(e));
  if (novos.length > 0) {
    throw new EdicaoInvalida(`a edição deixaria o arquivo inconsistente, e nada foi gravado: ${novos.slice(0, 3).join('; ')}`);
  }
  const achadosAntes = new Set(checarDiagrama(antes).map(chave));
  const avisos = checarDiagrama(depois).filter((a) => a.grupo === 'padrao' && !achadosAntes.has(chave(a)));

  if (readFileSync(arquivo, 'utf8') !== antes) {
    throw new ConflitoEdicao('arquivo-alterado', 'o arquivo mudou durante o salvamento; tente novamente');
  }
  const historico = lerHistorico(arquivo, undoDir);
  historico.desfazer = [...historico.desfazer, { antes, hashDepois: hash(depois) }].slice(-NIVEIS);
  historico.refazer = [];
  salvarHistorico(historico, undoDir);
  gravarAtomico(arquivo, depois, statSync(arquivo).mode);
  return { arquivo, hash: hash(depois), avisos };
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
  avisos: Achado[];
}

export function renomearElemento(pedido: PedidoRenomear): ResultadoEdicao {
  // A leitura completa valida a estrutura e garante que o id é um objeto BPMN,
  // não um id homônimo de estilo ou Graphiti.
  const verificar = (texto: string) => {
    const objeto = lerDiagrama(texto).objetos.find((o) => o.attrs['id'] === pedido.id);
    if (!objeto) throw new ConflitoEdicao('elemento-removido', `o elemento ${pedido.id} não existe mais`);
    if (!Object.prototype.hasOwnProperty.call(objeto.attrs, 'name')) {
      throw new EdicaoInvalida(`o elemento ${pedido.id} não possui atributo name`);
    }
    if (objeto.attrs['name'] !== pedido.nomeOriginal) {
      throw new ConflitoEdicao('nome-alterado', `o nome de ${pedido.id} mudou enquanto você editava`, objeto.attrs['name']);
    }
    return trocarNomeNoXml(texto, pedido.id, pedido.nomeOriginal, pedido.nomeNovo);
  };
  const r = aplicarEdicao(pedido.arquivo, pedido.undoDir, verificar);
  return { arquivo: r.arquivo, id: pedido.id, nome: pedido.nomeNovo, hash: r.hash, avisos: r.avisos };
}

export function desfazerUltimaEdicao(arquivoInformado: string, undoDir: string): ResultadoEdicao {
  const arquivo = caminhoReal(arquivoInformado);
  const historico = lerHistorico(arquivo, undoDir);
  const passo = historico.desfazer.at(-1);
  if (!passo) throw new ConflitoEdicao('sem-desfazer', 'não há edição do visualizador para desfazer');
  const atual = readFileSync(arquivo, 'utf8');
  if (hash(atual) !== passo.hashDepois) {
    throw new ConflitoEdicao('arquivo-alterado', 'o arquivo mudou depois da edição; desfazer apagaria essas mudanças');
  }
  lerDiagrama(passo.antes);
  historico.desfazer.pop();
  historico.refazer.push({ depois: atual, hashAntes: hash(passo.antes) });
  salvarHistorico(historico, undoDir);
  gravarAtomico(arquivo, passo.antes, statSync(arquivo).mode);
  return { arquivo, id: '', nome: '', hash: hash(passo.antes), avisos: [] };
}

export function refazerEdicao(arquivoInformado: string, undoDir: string): ResultadoEdicao {
  const arquivo = caminhoReal(arquivoInformado);
  const historico = lerHistorico(arquivo, undoDir);
  const passo = historico.refazer.at(-1);
  if (!passo) throw new ConflitoEdicao('sem-refazer', 'não há edição desfeita para refazer');
  const atual = readFileSync(arquivo, 'utf8');
  if (hash(atual) !== passo.hashAntes) {
    throw new ConflitoEdicao('arquivo-alterado', 'o arquivo mudou depois do desfazer; refazer apagaria essas mudanças');
  }
  lerDiagrama(passo.depois);
  historico.refazer.pop();
  historico.desfazer.push({ antes: atual, hashDepois: hash(passo.depois) });
  salvarHistorico(historico, undoDir);
  gravarAtomico(arquivo, passo.depois, statSync(arquivo).mode);
  return { arquivo, id: '', nome: '', hash: hash(passo.depois), avisos: [] };
}

/** Uma forma de topo do pictograma: onde está a tag do seu primeiro graphicsAlgorithm. */
interface FormaNoTexto {
  inicio: number;
  tag: string;
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;

/**
 * Acha, sem reserializar, a tag `graphicsAlgorithm` de cada forma de topo do
 * `pi:Diagram` (filho direto), pelo id do objeto no `<link>`. Formas aninhadas
 * (raias dentro da pool) ficam de fora: as coordenadas delas são relativas.
 */
export function formasDeTopo(xml: string): Map<string, FormaNoTexto> {
  const formas = new Map<string, FormaNoTexto>();
  const pilha: string[] = [];
  let nivelDiagrama = -1;
  let atual: { ga?: FormaNoTexto; id?: string | undefined } | undefined;
  for (const m of xml.matchAll(TOKEN)) {
    const [inteiro, fecha, nome] = m;
    if (nome === undefined) continue; // comentário ou declaração
    const vazia = m[4] === '/';
    if (fecha) {
      pilha.pop();
      if (atual && nome === 'children' && pilha.length === nivelDiagrama + 1) {
        if (atual.id && atual.ga) formas.set(atual.id, atual.ga);
        atual = undefined;
      }
      if (nome === 'pi:Diagram') nivelDiagrama = -1;
      continue;
    }
    const profundidade = pilha.length;
    if (nome === 'pi:Diagram') nivelDiagrama = profundidade;
    else if (nivelDiagrama >= 0 && profundidade === nivelDiagrama + 1 && nome === 'children') atual = {};
    else if (atual && profundidade === nivelDiagrama + 2) {
      if (nome === 'graphicsAlgorithm' && !atual.ga) atual.ga = { inicio: m.index, tag: inteiro };
      if (nome === 'link') atual.id = /\sbusinessObjects="([^"]*)"/.exec(inteiro)?.[1];
    }
    if (!vazia) pilha.push(nome);
  }
  return formas;
}

/** O Studio omite x/y quando valem 0; o resto vai logo depois de height. */
function trocarCoordenada(tag: string, attr: 'x' | 'y', valor: number): string {
  const existente = new RegExp(`\\s${attr}="-?\\d+"`);
  if (valor === 0) return tag.replace(existente, '');
  if (existente.test(tag)) return tag.replace(existente, ` ${attr}="${valor}"`);
  if (attr === 'y' && / x="-?\d+"/.test(tag)) return tag.replace(/( x="-?\d+")/, `$1 y="${valor}"`);
  if (/ height="\d+"/.test(tag)) return tag.replace(/( height="\d+")/, `$1 ${attr}="${valor}"`);
  return tag.replace(/\s*(\/?)>$/, ` ${attr}="${valor}"$1>`);
}

const TIPOS_FIXOS = new Set(['BpmnPool', 'BpmnSwimLane']);

export interface PedidoMover {
  arquivo: string;
  id: string;
  dx: number;
  dy: number;
  /** Hash do texto que a tela mostrava. */
  hashBase: string;
  undoDir: string;
}

export interface ResultadoMover extends ResultadoAplicacao {
  /** Ids que andaram: o elemento e os eventos de erro presos a ele. */
  movidos: string[];
  raiaAntes?: string | undefined;
  raiaDepois?: string | undefined;
}

function raiaEm(caixas: Map<string, Caixa>, raias: string[], c: Caixa): string | undefined {
  const cy = c.absY + c.altura / 2;
  return raias.find((r) => {
    const l = caixas.get(r);
    return l !== undefined && cy >= l.absY && cy < l.absY + l.altura;
  });
}

/** Desloca uma forma de topo (e os eventos de erro anexados a ela) por dx/dy, sem tocar no resto. */
export function moverNoXml(xml: string, id: string, dx: number, dy: number): { xml: string; movidos: string[] } {
  if (![dx, dy].every((d) => Number.isInteger(d) && Math.abs(d) <= 20000)) {
    throw new EdicaoInvalida('o deslocamento precisa ser um número inteiro de pixels');
  }
  const diagrama = lerDiagrama(xml);
  const objeto = diagrama.objetos.find((o) => o.attrs['id'] === id);
  if (!objeto) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  if (TIPOS_FIXOS.has(objeto.tipo)) throw new EdicaoInvalida('pool e raias não se movem por aqui');
  const formas = formasDeTopo(xml);
  if (!formas.has(id)) throw new EdicaoInvalida(`o elemento ${id} não é uma forma solta no diagrama, e não se move por aqui`);

  const anexados = diagrama.objetos
    .filter((o) => o.tipo === 'BpmnIntermediateEvent' && o.attrs['parentTask'] === id && o.attrs['id'] && formas.has(o.attrs['id']))
    .map((o) => o.attrs['id']!);
  const movidos = [id, ...anexados];

  const pool = diagrama.objetos.find((o) => o.tipo === 'BpmnPool')?.attrs['id'];
  const limites = pool ? diagrama.caixas.get(pool) : undefined;
  for (const m of movidos) {
    const c = diagrama.caixas.get(m)!;
    const x = c.absX + dx;
    const y = c.absY + dy;
    if (x < 0 || y < 0) throw new EdicaoInvalida('o elemento sairia da área do diagrama');
    // Evento de erro pode sobrar para fora da borda do card; o card em si fica dentro da pool.
    if (limites && m === id && (x < limites.absX || y < limites.absY || x + c.largura > limites.absX + limites.largura || y + c.altura > limites.absY + limites.altura)) {
      throw new EdicaoInvalida('o elemento sairia da pool; aumente a pool ou escolha outra posição');
    }
  }

  // Do fim para o começo, para os índices do texto continuarem válidos.
  const trocas = movidos
    .map((m) => ({ forma: formas.get(m)!, caixa: diagrama.caixas.get(m)! }))
    .sort((a, b) => b.forma.inicio - a.forma.inicio);
  let novo = xml;
  for (const { forma, caixa } of trocas) {
    const tag = trocarCoordenada(trocarCoordenada(forma.tag, 'x', caixa.x + dx), 'y', caixa.y + dy);
    novo = novo.slice(0, forma.inicio) + tag + novo.slice(forma.inicio + forma.tag.length);
  }
  return { xml: novo, movidos };
}

export function moverElemento(pedido: PedidoMover): ResultadoMover {
  let movidos: string[] = [];
  let raiaAntes: string | undefined;
  let raiaDepois: string | undefined;
  const r = aplicarEdicao(pedido.arquivo, pedido.undoDir, (texto) => {
    const feito = moverNoXml(texto, pedido.id, pedido.dx, pedido.dy);
    movidos = feito.movidos;
    const raias = (t: string) => {
      const d = lerDiagrama(t);
      const ids = d.objetos.filter((o) => o.tipo === 'BpmnSwimLane').map((o) => o.attrs['id']!).filter(Boolean);
      const c = d.caixas.get(pedido.id);
      const nome = (rid: string | undefined) => (rid ? d.objetos.find((o) => o.attrs['id'] === rid)?.attrs['name'] ?? rid : undefined);
      return c ? nome(raiaEm(d.caixas, ids, c)) : undefined;
    };
    raiaAntes = raias(texto);
    raiaDepois = raias(feito.xml);
    return feito.xml;
  }, pedido.hashBase);
  return { ...r, movidos, raiaAntes, raiaDepois };
}

/** A conexão de um fluxo no texto: onde estão as dobras e onde ela fecha. */
interface ConexaoNoTexto {
  /** Trechos `[inicio, fim)` de cada `<bendpoints .../>`, com o recuo da linha. */
  dobras: [number, number][];
  /** Início da linha do `</connections>`. */
  fechamento: number;
  recuo: string;
}

/** Acha as conexões diretas do `pi:Diagram` pelo fluxo do `<link>`, sem reserializar. */
export function conexoesNoTexto(xml: string): Map<string, ConexaoNoTexto> {
  const conexoes = new Map<string, ConexaoNoTexto>();
  const pilha: string[] = [];
  let nivelDiagrama = -1;
  let atual: { id?: string | undefined; dobras: [number, number][]; recuo: string } | undefined;
  const inicioDaLinha = (i: number) => xml.lastIndexOf('\n', i - 1) + 1;
  for (const m of xml.matchAll(TOKEN)) {
    const [inteiro, fecha, nome] = m;
    if (nome === undefined) continue;
    const vazia = m[4] === '/';
    if (fecha) {
      pilha.pop();
      if (atual && nome === 'connections' && pilha.length === nivelDiagrama + 1) {
        const linha = inicioDaLinha(m.index);
        if (atual.id) conexoes.set(atual.id, { dobras: atual.dobras, fechamento: linha, recuo: atual.recuo });
        atual = undefined;
      }
      if (nome === 'pi:Diagram') nivelDiagrama = -1;
      continue;
    }
    const profundidade = pilha.length;
    if (nome === 'pi:Diagram') nivelDiagrama = profundidade;
    else if (nivelDiagrama >= 0 && profundidade === nivelDiagrama + 1 && nome === 'connections' && !vazia) {
      atual = { dobras: [], recuo: '' };
    } else if (atual && profundidade === nivelDiagrama + 2) {
      const linha = inicioDaLinha(m.index);
      if (nome === 'link') {
        atual.id = /\sbusinessObjects="([^"]*)"/.exec(inteiro)?.[1];
        atual.recuo = xml.slice(linha, m.index);
      }
      if (nome === 'bendpoints') {
        // A linha inteira sai, com a quebra que a precede.
        const fim = m.index + inteiro.length;
        atual.dobras.push(/^\s*$/.test(xml.slice(linha, m.index)) ? [linha - 1, fim] : [m.index, fim]);
      }
    }
    if (!vazia) pilha.push(nome);
  }
  return conexoes;
}

const MAX_DOBRAS = 50;

/** Troca as dobras de um fluxo. Sem dobras, a linha vai reta de ponta a ponta. */
export function trocarDobrasNoXml(xml: string, fluxoId: string, pontos: Ponto[]): string {
  if (!Array.isArray(pontos) || pontos.length > MAX_DOBRAS) throw new EdicaoInvalida(`um fluxo leva de 0 a ${MAX_DOBRAS} dobras`);
  for (const p of pontos) {
    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x > 100000 || p.y > 100000) {
      throw new EdicaoInvalida('cada dobra precisa de x e y inteiros, não negativos');
    }
  }
  const objeto = lerDiagrama(xml).objetos.find((o) => o.attrs['id'] === fluxoId);
  if (!objeto) throw new ConflitoEdicao('elemento-removido', `o fluxo ${fluxoId} não existe mais`);
  if (objeto.tipo !== 'SequenceFlow') throw new EdicaoInvalida(`${fluxoId} não é um fluxo`);
  const conexao = conexoesNoTexto(xml).get(fluxoId);
  if (!conexao) throw new EdicaoInvalida(`o fluxo ${fluxoId} não está desenhado no diagrama`);

  // Como o Studio: coordenada 0 não é gravada (`<bendpoints y="236"/>`).
  const coordenadas = (p: Ponto) => `${p.x === 0 ? '' : ` x="${p.x}"`}${p.y === 0 ? '' : ` y="${p.y}"`}`;
  const novas = pontos.map((p) => `${conexao.recuo}<bendpoints${coordenadas(p)}/>\n`).join('');
  // Do fim para o começo: primeiro entram as novas antes do fechamento, depois saem as velhas.
  let texto = xml.slice(0, conexao.fechamento) + novas + xml.slice(conexao.fechamento);
  for (const [inicio, fim] of [...conexao.dobras].reverse()) texto = texto.slice(0, inicio) + texto.slice(fim);
  return texto;
}

export interface PedidoDobras {
  arquivo: string;
  id: string;
  pontos: Ponto[];
  hashBase: string;
  undoDir: string;
}

export function trocarDobras(pedido: PedidoDobras): ResultadoAplicacao {
  return aplicarEdicao(pedido.arquivo, pedido.undoDir, (t) => trocarDobrasNoXml(t, pedido.id, pedido.pontos), pedido.hashBase);
}

export interface PedidoEndireitar {
  arquivo: string;
  /** Um fluxo (endireita ele) ou um elemento (endireita todas as ligações dele). */
  id: string;
  hashBase: string;
  undoDir: string;
}

export interface ResultadoEndireitar extends ResultadoAplicacao {
  fluxos: string[];
}

/** Os fluxos que um endireitar alcança: o próprio fluxo, ou todos os que entram e saem do elemento. */
function fluxosDe(xml: string, id: string): string[] {
  const d = lerDiagrama(xml);
  const o = d.objetos.find((x) => x.attrs['id'] === id);
  if (!o) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  if (o.tipo === 'SequenceFlow') return [id];
  return d.objetos
    .filter((x) => x.tipo === 'SequenceFlow' && (x.attrs['sourceRef'] === id || x.attrs['targetRef'] === id))
    .map((x) => x.attrs['id']!)
    .filter((f) => d.dobras.has(f));
}

export function endireitar(pedido: PedidoEndireitar): ResultadoEndireitar {
  let fluxos: string[] = [];
  const r = aplicarEdicao(pedido.arquivo, pedido.undoDir, (texto) => {
    fluxos = fluxosDe(texto, pedido.id);
    if (fluxos.length === 0) throw new EdicaoInvalida('este elemento não tem ligações para endireitar');
    let novo = texto;
    for (const f of fluxos) novo = trocarDobrasNoXml(novo, f, rotaOrtogonal(lerDiagrama(novo), f));
    if (novo === texto) throw new EdicaoInvalida('as ligações já estão retas');
    return novo;
  }, pedido.hashBase);
  return { ...r, fluxos };
}
