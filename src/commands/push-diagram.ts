import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { gerarEcm30, type ResultadoConversao } from '../push/diagram/ecm30.js';
import { lerDiagrama } from '../push/diagram/modelo.js';
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
}

/**
 * Converte o `.process` no XML que o servidor importa.
 *
 * Fase 1 do docs/plano-push-diagrama.md: só `--dry-run`, sem sessão e sem
 * rede. O `companyId` vem do cadastro do servidor; o `formId`, do `cardIndex`
 * numérico — um nome fica 0, com aviso, para ser resolvido no destino quando a
 * publicação existir. Os scripts vêm de `workflow/scripts/<processId>.*.js`,
 * ao lado de `workflow/diagrams/`, como o Studio: sem a pasta, o XML sai sem
 * eles e com aviso.
 */
export async function pushDiagram(opcoes: OpcoesPushDiagram): Promise<ResultadoConversao> {
  if (!opcoes.dryRun) {
    throw new ErroFluigctl('publicação do diagrama ainda não implementada (fase 3); use --dry-run', 2);
  }

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

  const r = gerarEcm30(diagrama, { companyId: opcoes.server.companyId, ...(scripts ? { scripts } : {}) });
  if (semScripts) r.avisos.push(`${semScripts}; o XML sai sem os scripts do processo (WorkflowProcessEvent)`);
  if (opcoes.salvarXml) await writeFile(opcoes.salvarXml, r.xml, 'utf8');
  return r;
}
