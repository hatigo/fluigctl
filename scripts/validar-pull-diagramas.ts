import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { gerarProcess } from '../src/pull/process-diagram.js';
import { gerarEcm30 } from '../src/push/diagram/ecm30.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';
import { filhos, lerXml } from '../src/push/diagram/xml.js';

const raiz = resolve(process.argv[2] ?? '.');
const arquivos: string[] = [];
const visitar = (pasta: string) => {
  for (const nome of readdirSync(pasta)) {
    const caminho = resolve(pasta, nome);
    if (statSync(caminho).isDirectory()) visitar(caminho);
    else if (nome.endsWith('.xml')) arquivos.push(caminho);
  }
};
visitar(raiz);

let convertidos = 0;
let recusados = 0;
for (const arquivo of arquivos.sort()) {
  try {
    const exportado = readFileSync(arquivo).toString('latin1');
    const documento = lerXml(exportado).filhos[0];
    if (documento?.nome !== 'list' || filhos(documento, 'ProcessDefinition').length !== 1) continue;
    const pk = filhos(filhos(documento, 'ProcessDefinition')[0]!, 'processDefinitionPK')[0];
    const companyId = Number(filhos(pk!, 'companyId')[0]?.texto ?? 1);
    const convertido = gerarProcess(exportado);
    gerarEcm30(lerDiagrama(convertido.process), { companyId });
    console.log(`ok       ${arquivo}`);
    convertidos++;
  } catch (erro) {
    console.log(`recusado ${arquivo}\n         ${(erro as Error).message}`);
    recusados++;
  }
}
console.log(`\n${convertidos} convertidos; ${recusados} recusados; ${arquivos.length} XML encontrados.`);
if (recusados) process.exitCode = 1;
