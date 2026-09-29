import { readFile, writeFile } from 'node:fs/promises';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { workflowEngineClient, type WorkflowEngineClient } from '../fluig/workflow-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import {
  aplicarScripts,
  removerIdsDasEntidadesFilhas,
  semDeclaracaoXml,
} from '../push/process-events.js';
import { lerScriptsDoProcesso } from '../push/process-source.js';

export interface OpcoesPushProcess {
  server: Server;
  senha: string;
  processId: string;
  /** Pasta `workflow/` do projeto (a que tem `scripts/`). */
  pastaWorkflow: string;
  dryRun?: boolean;
  /** false = importa e deixa a versão nova em edição, sem liberar. */
  liberar?: boolean;
  /** Grava a definição que o servidor devolveu, para inspeção. */
  salvarExport?: string;
  /**
   * Usa esta definição (um export salvo antes) como base em vez da atual do
   * servidor — para refazer uma publicação a partir de uma versão conhecida boa.
   */
  base?: string;
  prompt: PromptSenha;
  /** Injeção para teste. */
  cliente?: WorkflowEngineClient;
}

export interface ResultadoPushProcess {
  processId: string;
  alterados: string[];
  iguais: string[];
  semScriptLocal: string[];
  semEventoNoServidor: string[];
  publicado: boolean;
  liberado: boolean | null;
  mensagemImport?: string;
  mensagemLiberacao?: string;
}

/**
 * Publica os SCRIPTS de um processo que já existe no servidor.
 *
 * A base é a definição que o próprio servidor devolve (exportProcessInZipFormat),
 * e não o `.ecm30.xml` local: esse só é regerado quando alguém exporta pelo
 * Studio, e reenviá-lo desfaria o que foi publicado depois. Diagrama, atividades
 * e atribuições continuam sendo publicados pelo Studio — aqui só muda o código
 * dos eventos que já existem.
 */
export async function pushProcess(opcoes: OpcoesPushProcess): Promise<ResultadoPushProcess> {
  const { server, senha, processId } = opcoes;

  const scripts = await lerScriptsDoProcesso(opcoes.pastaWorkflow, processId);
  const cliente =
    opcoes.cliente ??
    (await workflowEngineClient(serverUrl(server), server.companyId, server.username, senha, server.userCode));

  const existentes = await cliente.listProcessIds();
  if (!existentes.includes(processId)) {
    throw new ErroFluigctl(
      `o processo "${processId}" não existe em ${serverUrl(server)}. ` +
        `Criar processo exige o diagrama convertido — publique a primeira versão pelo Fluig Studio.`,
      3,
    );
  }

  const exportado = opcoes.base ? await readFile(opcoes.base) : await cliente.exportProcess(processId);
  if (opcoes.salvarExport) await writeFile(opcoes.salvarExport, exportado);

  const eventos = aplicarScripts(exportado.toString('latin1'), scripts);
  const base = {
    processId,
    alterados: eventos.alterados,
    iguais: eventos.iguais,
    semScriptLocal: eventos.semScriptLocal,
    semEventoNoServidor: eventos.semEventoNoServidor,
  };

  if (opcoes.dryRun || (eventos.alterados.length === 0 && !opcoes.base)) {
    return { ...base, publicado: false, liberado: null };
  }

  await confirmProduction(
    server,
    senha,
    `push process ${processId} (${eventos.alterados.join(', ')})`,
    opcoes.prompt,
  );

  /*
   * O export chega em latin1, mas o import do servidor LÊ UTF-8 — é como o Studio
   * envia (o .ecm30.xml é UTF-8). Mandar os bytes latin1 de volta trocou cada
   * acento por "?" nas versões 7 do reembolso e 85 do aprovacao_movimento do HML
   * (29/09/2026), inclusive o nome dos mecanismos de atribuição ("Usu?rio").
   */
  const definicao = Buffer.from(removerIdsDasEntidadesFilhas(semDeclaracaoXml(eventos.xml)), 'utf8');

  // Versão liberada não é editável: a nova nasce em edição e é ela que o import sobrescreve.
  await cliente.createVersion(processId);
  const mensagemImport = await cliente.importProcess(processId, definicao);

  if (!/sucesso/i.test(mensagemImport)) {
    throw new ErroFluigctl(
      `o servidor não confirmou o import do processo "${processId}": ${mensagemImport || 'resposta vazia'}. ` +
        `A versão nova pode ter ficado em edição.`,
      7,
    );
  }

  let liberado: boolean | null = null;
  let mensagemLiberacao: string | undefined;
  if (opcoes.liberar !== false) {
    const r = await cliente.releaseProcess(processId);
    liberado = r.ok;
    mensagemLiberacao = r.mensagem;
    if (!r.ok) {
      throw new ErroFluigctl(
        `o processo "${processId}" foi importado, mas o servidor não liberou a versão: ${r.mensagem || 'sem mensagem'}. ` +
          `A versão nova ficou em edição.`,
        7,
      );
    }
  }

  /*
   * Não dá para conferir pelo export: no HML da Cetenco (29/09/2026) o
   * exportProcessInZipFormat logo depois do import devolveu a versão nova com os
   * eventos ANTIGOS, enquanto o banco (EVENT_PROCES da versão 7) já tinha o código
   * novo. O veredito fica com a resposta do import e com a liberação.
   */
  return {
    ...base,
    publicado: true,
    liberado,
    mensagemImport,
    ...(mensagemLiberacao === undefined ? {} : { mensagemLiberacao }),
  };
}
