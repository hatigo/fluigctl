import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ErroFluigctl } from '../errors.js';

/**
 * Scripts do processo no layout do Fluig Studio:
 * `<workflow>/scripts/<processId>.<eventId>.js` — por exemplo
 * `reembolso.servicetask13.js` ou `reembolso.beforeStateEntry.js`.
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
