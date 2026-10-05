import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ErroFluigctl } from '../errors.js';

/**
 * Scripts do processo no layout do Fluig Studio:
 * `<workflow>/scripts/<prefixo>.<eventId>.js` — por exemplo
 * `reembolso.servicetask13.js` ou `reembolso.beforeStateEntry.js`. O prefixo é o
 * nome do arquivo `.process` sem a extensão, como no Studio
 * (`ProjectUtils.getScriptFiles`); veja `prefixoDosScripts`.
 */
export async function lerScriptsDoProcesso(pastaWorkflow: string, processId: string): Promise<Map<string, string>> {
  const pasta = join(pastaWorkflow, 'scripts');
  let arquivos: string[];
  try {
    arquivos = await readdir(pasta);
  } catch {
    throw new ErroFluigctl(`pasta de scripts não encontrada: ${pasta}`, 3);
  }

  const prefixo = `${processId}.`;
  const scripts = new Map<string, string>();
  for (const arquivo of arquivos.sort()) {
    if (!arquivo.startsWith(prefixo) || !arquivo.endsWith('.js')) continue;
    const eventId = arquivo.slice(prefixo.length, -'.js'.length);
    // "reembolso.x.y.js" não é um evento do Studio: o eventId não tem ponto.
    if (!eventId || eventId.includes('.')) continue;
    scripts.set(eventId, await readFile(join(pasta, arquivo), 'utf8'));
  }

  if (scripts.size === 0) {
    throw new ErroFluigctl(`nenhum script "${prefixo}*.js" em ${pasta}`, 3);
  }
  return scripts;
}

/**
 * O prefixo dos scripts de um processo, dado o id dele. O Studio nomeia os
 * scripts pelo nome do arquivo `.process`, que diverge do id quando o processo foi
 * renomeado depois de criado (`AdiantamentoRessarcimento.process` com id
 * `Ressarcimento_v2`). Procura em `<workflow>/diagrams` o `.process` com esse id e
 * usa o nome dele; sem nenhum, usa o próprio id. Dois com o mesmo id: recusa.
 */
export async function prefixoDosScripts(
  pastaWorkflow: string,
  processId: string,
): Promise<{ prefixo: string; diagrama?: string }> {
  const pasta = join(pastaWorkflow, 'diagrams');
  let arquivos: string[];
  try {
    arquivos = (await readdir(pasta)).filter((a) => a.endsWith('.process'));
  } catch {
    return { prefixo: processId };
  }
  const comEsseId: string[] = [];
  for (const arquivo of arquivos.sort()) {
    const texto = await readFile(join(pasta, arquivo), 'latin1');
    const id = /<bpmn2:BpmnProcess id="([^"]*)"/.exec(texto)?.[1];
    if (id === processId) comEsseId.push(arquivo);
  }
  if (comEsseId.length > 1) {
    throw new ErroFluigctl(
      `mais de um diagrama em ${pasta} tem o id "${processId}" (${comEsseId.join(', ')}): ` +
        'não dá para saber de qual são os scripts',
      6,
    );
  }
  if (comEsseId.length === 0) return { prefixo: processId };
  const diagrama = join(pasta, comEsseId[0]!);
  return { prefixo: basename(comEsseId[0]!, '.process'), diagrama };
}
