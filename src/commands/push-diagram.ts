import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { cardIndexClient, type FormNoServidor } from '../fluig/cardindex-service.js';
import { workflowEngineClient, type WorkflowEngineClient } from '../fluig/workflow-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { gerarEcm30, type ResultadoConversao } from '../push/diagram/ecm30.js';
import { lerDiagrama, type Diagrama } from '../push/diagram/modelo.js';
import { gerarSvg, sequenciasDoSvg } from '../push/diagram/svg.js';
import { lerXml } from '../push/diagram/xml.js';
import { semDeclaracaoXml } from '../push/process-events.js';
import { lerScriptsDoProcesso } from '../push/process-source.js';

/**
 * O Studio grava o `.process` em ASCII, com acento como referência numérica
 * (255/255 medidos). Um byte acima de 0x7F quer dizer que alguém editou o
 * arquivo noutra codificação, e adivinhar qual trocaria acento em silêncio.
 */
export function textoAscii(bytes: Buffer, arquivo: string): string {
  const posicao = bytes.findIndex((b) => b > 0x7f);
  if (posicao !== -1) {
    const linha = bytes.subarray(0, posicao).toString('latin1').split('\n').length;
    throw new ErroFluigctl(
      `${arquivo} não é ASCII: byte 0x${bytes[posicao]!.toString(16)} na posição ${posicao} (linha ${linha}). ` +
        'O Studio grava acentos como referência numérica (&#xe7;)',
      6,
    );
  }
  return bytes.toString('latin1');
}

export interface OpcoesPushDiagram {
  server: Server;
  arquivo: string;
  dryRun?: boolean;
  /** Grava o XML gerado, para inspeção ou comparação com o `.ecm30.xml`. */
  salvarXml?: string;
  /** Senha do servidor; obrigatória para publicar. O dry-run não abre sessão. */
  senha?: string;
  prompt?: PromptSenha;
  /** Cria o processo quando ele não existe no destino. Sem isso, processo ausente é recusado. */
  criar?: boolean;
  /** Libera a versão importada (padrão). Com `false`, ela fica em edição. */
  liberar?: boolean;
  /** Para testes: clientes do servidor já prontos. */
  cliente?: WorkflowEngineClient;
  formularios?: () => Promise<FormNoServidor[]>;
}

export interface ResultadoPushDiagram extends ResultadoConversao {
  /** De onde veio a imagem do diagrama que vai (ou iria) no import. */
  imagem: { origem: 'studio' | 'gerada'; nome: string; bytes: number };
  publicado: boolean;
  criado: boolean;
  liberado: boolean | null;
  mensagemImport?: string;
  mensagemLiberacao?: string;
}

async function lerConvertivel(opcoes: OpcoesPushDiagram): Promise<{
  diagrama: Diagrama;
  processId: string;
  scripts: Map<string, string> | undefined;
  semScripts: string | undefined;
}> {
  let bytes: Buffer;
  try {
    bytes = await readFile(opcoes.arquivo);
  } catch (erro) {
    throw new ErroFluigctl(`não consegui ler ${opcoes.arquivo}: ${(erro as Error).message}`, 3);
  }

  const diagrama = lerDiagrama(textoAscii(bytes, opcoes.arquivo));
  const processId = diagrama.objetos.find((o) => o.tipo === 'BpmnProcess')?.attrs['id'] ?? '';
  let scripts: Map<string, string> | undefined;
  let semScripts: string | undefined;
  if (basename(dirname(opcoes.arquivo)) !== 'diagrams') {
    semScripts = `${opcoes.arquivo} não está em workflow/diagrams/, então não há onde procurar os scripts`;
  } else {
    try {
      scripts = await lerScriptsDoProcesso(dirname(dirname(opcoes.arquivo)), processId);
    } catch (erro) {
      if (!(erro instanceof ErroFluigctl) || erro.codigo !== 3) throw erro;
      semScripts = erro.message;
    }
  }
  return { diagrama, processId, scripts, semScripts };
}

/**
 * O formulário do processo no destino. `cardIndex` numérico tem de existir; um
 * nome tem de casar com exatamente um formulário; vazio é processo sem
 * formulário (formId 0). Qualquer dúvida recusa antes de escrever — um formId
 * errado liga o processo ao formulário de outra pessoa.
 */
export function resolverFormId(cardIndex: string, catalogo: readonly FormNoServidor[]): number {
  if (cardIndex === '') return 0;
  if (/^\d+$/.test(cardIndex)) {
    const id = Number(cardIndex);
    if (!catalogo.some((f) => f.documentId === id)) {
      throw new ErroFluigctl(`o processo usa o formulário ${id} (cardIndex), que não existe neste servidor`, 6);
    }
    return id;
  }
  const porNome = catalogo.filter((f) => f.documentDescription === cardIndex);
  if (porNome.length !== 1) {
    throw new ErroFluigctl(
      `o processo usa o formulário "${cardIndex}" pelo nome, e ${porNome.length === 0 ? 'nenhum' : porNome.length} ` +
        `formulário deste servidor tem esse nome` +
        (porNome.length > 1 ? `: ${porNome.map((f) => f.documentId).join(', ')}` : ''),
      6,
    );
  }
  return porNome[0]!.documentId;
}

/**
 * A imagem do diagrama que vai no import. O `.processimage.svg` do Studio ao lado
 * (`workflow/.resources/<nome>.processimage.svg`) é o melhor desenho, mas só vale
 * se desenha exatamente os estados do `.process` — senão é de outra versão do
 * diagrama e mostraria o fluxo antigo. Fora isso, gera uma a partir da geometria.
 * O conteúdo vai como o Studio manda: linhas juntadas com "\n", em UTF-8.
 */
async function imagemDoDiagrama(arquivo: string, diagrama: Diagrama, avisos: string[]): Promise<{
  origem: 'studio' | 'gerada';
  nome: string;
  svg: Buffer;
}> {
  const base = basename(arquivo, '.process');
  const nome = `${base}.processimage.svg`;
  const gerada = gerarSvg(diagrama);
  const doStudio = await readFile(join(dirname(dirname(arquivo)), '.resources', nome), 'utf8').catch(() => undefined);
  if (doStudio !== undefined) {
    const esperado = sequenciasDoSvg(gerada);
    const desenhado = sequenciasDoSvg(doStudio);
    if (esperado.size === desenhado.size && [...esperado].every((n) => desenhado.has(n))) {
      return { origem: 'studio', nome, svg: Buffer.from(doStudio.split(/\r?\n/).join('\n'), 'utf8') };
    }
    avisos.push(`${nome} do Studio não desenha os mesmos estados do .process (é de outra versão); vai uma imagem gerada`);
  } else {
    avisos.push(`sem ${nome} do Studio em workflow/.resources; vai uma imagem gerada a partir do .process`);
  }
  return { origem: 'gerada', nome, svg: Buffer.from(gerada, 'utf8') };
}

const resumo = (i: { origem: 'studio' | 'gerada'; nome: string; svg: Buffer }) => ({ origem: i.origem, nome: i.nome, bytes: i.svg.length });

/** `bpmnVersion` da definição atual do processo no servidor. */
export function bpmnVersionDe(exportado: Buffer): number | undefined {
  try {
    const raiz = lerXml(semDeclaracaoXml(exportado.toString('latin1'))).filhos[0];
    const pdv = raiz?.filhos[1];
    const valor = pdv?.filhos.find((f) => f.nome === 'bpmnVersion')?.texto;
    return valor && /^\d+$/.test(valor) ? Number(valor) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Converte o `.process` no XML que o servidor importa e, sem `--dry-run`, publica.
 *
 * O dry-run é offline: o `companyId` vem do cadastro, o `formId` do `cardIndex`
 * numérico (um nome fica 0, com aviso). Os scripts vêm de
 * `workflow/scripts/<processId>.*.js`, ao lado de `workflow/diagrams/`.
 *
 * Publicar (fase 3 do docs/plano-push-diagrama.md) converte primeiro — toda
 * recusa acontece antes de abrir sessão —, confere o destino (o processo existe,
 * ou `--create`; o formulário existe) e lê dele o que não está no `.process`
 * (`bpmnVersion`). Processo existente: nova versão → import → liberação, como o
 * `push process`. Processo novo: import com `newProcess` → liberação, como o
 * fluig-cd.
 */
export async function pushDiagram(opcoes: OpcoesPushDiagram): Promise<ResultadoPushDiagram> {
  const { diagrama, processId, scripts, semScripts } = await lerConvertivel(opcoes);
  const comum = { companyId: opcoes.server.companyId, ...(scripts ? { scripts } : {}) };

  // Sempre converte offline primeiro: um diagrama que não converte nem abre sessão.
  const previa = gerarEcm30(diagrama, comum);
  const avisoScripts = semScripts ? `${semScripts}; o XML sai sem os scripts do processo (WorkflowProcessEvent)` : undefined;

  if (opcoes.dryRun) {
    if (avisoScripts) previa.avisos.push(avisoScripts);
    const imagem = await imagemDoDiagrama(opcoes.arquivo, diagrama, previa.avisos);
    if (opcoes.salvarXml) await writeFile(opcoes.salvarXml, previa.xml, 'utf8');
    return { ...previa, imagem: resumo(imagem), publicado: false, criado: false, liberado: null };
  }

  if (!opcoes.senha || !opcoes.prompt) {
    throw new ErroFluigctl('publicar o diagrama exige a senha do servidor', 4);
  }
  if (!processId) throw new ErroFluigctl('o .process não tem o id do processo (BpmnProcess)', 6);

  const url = serverUrl(opcoes.server);
  const cliente =
    opcoes.cliente ??
    (await workflowEngineClient(url, opcoes.server.companyId, opcoes.server.username, opcoes.senha, opcoes.server.userCode));
  const listarFormularios =
    opcoes.formularios ??
    (async () =>
      (await cardIndexClient(url, opcoes.server.companyId, opcoes.server.username, opcoes.senha!, opcoes.server.userCode)).listForms());

  const existe = (await cliente.listProcessIds()).includes(processId);
  if (!existe && !opcoes.criar) {
    throw new ErroFluigctl(
      `o processo "${processId}" não existe em ${url}. Para criá-lo a partir do .process, use --create.`,
      3,
    );
  }
  if (existe && opcoes.criar) {
    throw new ErroFluigctl(`--create foi pedido, mas o processo "${processId}" já existe em ${url}. Remova --create.`, 6);
  }

  const formId = resolverFormId(previa.cardIndex, await listarFormularios());
  const bpmnVersion = existe ? bpmnVersionDe(await cliente.exportProcess(processId)) : undefined;
  const r = gerarEcm30(diagrama, { ...comum, formId, ...(bpmnVersion === undefined ? {} : { bpmnVersion }) });
  if (avisoScripts) r.avisos.push(avisoScripts);
  if (existe && bpmnVersion === undefined) {
    r.avisos.push('não consegui ler o bpmnVersion da definição atual no servidor; vai o padrão, 2');
  }
  if (opcoes.salvarXml) await writeFile(opcoes.salvarXml, r.xml, 'utf8');
  const imagem = await imagemDoDiagrama(opcoes.arquivo, diagrama, r.avisos);

  await confirmProduction(
    opcoes.server,
    opcoes.senha,
    `push diagram ${processId} (${existe ? 'nova versão' : 'processo novo'})`,
    opcoes.prompt,
  );

  // O import lê UTF-8 (ver push-process: bytes latin1 viraram "?" nos acentos).
  const definicao = Buffer.from(semDeclaracaoXml(r.xml), 'utf8');
  if (existe) await cliente.createVersion(processId);
  const mensagemImport = await cliente.importProcess(processId, definicao, !existe, { nome: imagem.nome, svg: imagem.svg });
  if (!/sucesso/i.test(mensagemImport)) {
    throw new ErroFluigctl(
      `o servidor não confirmou o import do processo "${processId}": ${mensagemImport || 'resposta vazia'}.` +
        (existe ? ' A versão nova pode ter ficado em edição.' : ''),
      7,
    );
  }

  const base = { ...r, imagem: resumo(imagem), publicado: true, criado: !existe, mensagemImport };
  if (opcoes.liberar === false) return { ...base, liberado: null };

  const liberacao = await cliente.releaseProcess(processId);
  if (!liberacao.ok) {
    throw new ErroFluigctl(
      `o processo "${processId}" foi importado, mas o servidor não liberou a versão: ${liberacao.mensagem || 'sem mensagem'}. ` +
        'A versão ficou em edição.',
      7,
    );
  }
  return { ...base, liberado: true, mensagemLiberacao: liberacao.mensagem };
}
