/**
 * Qualidade do Organizar nos diagramas de uma pasta.
 *
 *   npm run medir-organizar -- [raiz...] [--original] [--piores <n>]
 *
 * Cada `.process` sob a raiz (padrão ~/fluig/workspaces) passa pelo Organizar
 * e as ligações são medidas (veja src/diagram/layout-medida.ts): quantas passam
 * por cima de uma forma, quantos pares correm um em cima do outro e quantos se
 * cruzam. --original mede os diagramas como estão, para comparar com o desenho
 * feito à mão. Só lê: nada é escrito.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { organizarNoXml } from '../src/diagram/layout.js';
import { medirLayout, type MedidaLayout } from '../src/diagram/layout-medida.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

const args = process.argv.slice(2);
const original = args.includes('--original');
const i = args.indexOf('--piores');
const piores = i >= 0 ? Number(args[i + 1]) : 10;
const raizes = args.filter((a, j) => !a.startsWith('--') && args[j - 1] !== '--piores').map((a) => resolve(a));
const arquivos: string[] = [];
const visitar = (pasta: string) => {
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) visitar(caminho);
    else if (nome.endsWith('.process')) arquivos.push(caminho);
  }
};
(raizes.length ? raizes : [join(homedir(), 'fluig', 'workspaces')]).forEach(visitar);

const total: MedidaLayout & { diagramas: number; falhas: number } = { diagramas: 0, falhas: 0, ligacoes: 0, cards: 0, sobrepostas: 0, cruzamentos: 0, mistos: 0 };
const porDiagrama: (MedidaLayout & { arquivo: string })[] = [];
for (const arquivo of arquivos.sort()) {
  let xml: string;
  try {
    xml = readFileSync(arquivo, 'latin1');
    lerDiagrama(xml);
  } catch {
    continue;
  }
  try {
    const m = medirLayout(original ? xml : organizarNoXml(xml).xml);
    total.diagramas++;
    for (const k of ['ligacoes', 'cards', 'sobrepostas', 'cruzamentos', 'mistos'] as const) total[k] += m[k];
    porDiagrama.push({ arquivo, ...m });
  } catch (e) {
    total.falhas++;
    console.log(`falhou   ${arquivo}: ${(e as Error).message}`);
  }
}
console.log(`${total.diagramas} diagramas${total.falhas ? `, ${total.falhas} com falha` : ''}, ${total.ligacoes} ligações`);
console.log(`  por cima de forma   ${total.cards}`);
console.log(`  sobrepostas         ${total.sobrepostas}`);
console.log(`  cruzamentos         ${total.cruzamentos}`);
console.log(`  entra e sai no mesmo ponto   ${total.mistos}`);
const peso = (m: MedidaLayout) => m.cards * 10 + m.sobrepostas * 3 + m.mistos * 3 + m.cruzamentos;
for (const m of porDiagrama.sort((a, b) => peso(b) - peso(a)).slice(0, piores)) {
  if (peso(m)) console.log(`  ${String(m.cards).padStart(3)} ${String(m.sobrepostas).padStart(3)} ${String(m.cruzamentos).padStart(4)} ${String(m.mistos).padStart(3)}  ${basename(m.arquivo)} (${m.ligacoes} ligações)`);
}
