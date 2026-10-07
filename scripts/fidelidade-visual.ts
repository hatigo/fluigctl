/**
 * Fidelidade do visual que o fluigctl desenha ao que o Studio grava.
 *
 *   npm run fidelidade-visual -- [raiz...] [--tipo <tipo>] [--exemplos <n>]
 *
 * Cada `.process` sob a raiz (padrão ~/fluig/workspaces) perde os estilos, passa
 * pelo garantirVisual e cada forma e ligação é comparada com a original do
 * Studio (veja src/diagram/fidelidade.ts). Só lê: nada é escrito.
 *
 * Sai uma tabela por tipo de objeto (iguais, diferentes, não redesenhados) e,
 * para cada tipo com diferença, as diferenças mais comuns, contadas por forma.
 * `--tipo` mostra só aquele tipo, com `--exemplos` diferenças completas.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { compararComStudio, type Comparacao } from '../src/diagram/fidelidade.js';

const args = process.argv.slice(2);
const opcao = (nome: string) => {
  const i = args.indexOf(nome);
  if (i < 0) return undefined;
  const valor = args[i + 1];
  args.splice(i, 2);
  return valor;
};
const soTipo = opcao('--tipo');
const exemplos = Number(opcao('--exemplos') ?? 0);
const raizes = args.length ? args.map((a) => resolve(a)) : [join(homedir(), 'fluig', 'workspaces')];

const arquivos: string[] = [];
const visitar = (pasta: string) => {
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) visitar(caminho);
    else if (nome.endsWith('.process')) arquivos.push(caminho);
  }
};
raizes.forEach(visitar);

interface PorTipo {
  igual: number;
  diferente: number;
  naoRedesenhado: number;
  /** Diferença (as linhas, sem o recuo) → em quantas formas aparece. */
  assinaturas: Map<string, number>;
  exemplos: { arquivo: string; c: Comparacao }[];
}

const tipos = new Map<string, PorTipo>();
let ilegiveis = 0;
for (const arquivo of arquivos.sort()) {
  let comparacoes: Comparacao[];
  try {
    comparacoes = compararComStudio(readFileSync(arquivo, 'latin1'));
  } catch {
    ilegiveis++;
    continue;
  }
  for (const c of comparacoes) {
    if (soTipo && c.tipo !== soTipo) continue;
    let t = tipos.get(c.tipo);
    if (!t) tipos.set(c.tipo, (t = { igual: 0, diferente: 0, naoRedesenhado: 0, assinaturas: new Map(), exemplos: [] }));
    if (c.situacao === 'igual') t.igual++;
    else if (c.situacao === 'nao-redesenhado') t.naoRedesenhado++;
    else {
      t.diferente++;
      // Cada linha diferente conta uma vez por forma.
      for (const linha of new Set(c.diferencas.map((d) => d.replace(/^([+-]) \s*/, '$1 ')))) t.assinaturas.set(linha, (t.assinaturas.get(linha) ?? 0) + 1);
      if (t.exemplos.length < exemplos) t.exemplos.push({ arquivo, c });
    }
  }
}

const linhasTabela = [...tipos].sort((a, b) => b[1].igual + b[1].diferente + b[1].naoRedesenhado - (a[1].igual + a[1].diferente + a[1].naoRedesenhado));
console.log(`${arquivos.length - ilegiveis} diagramas (${ilegiveis} ilegíveis)\n`);
console.log('tipo                          total   iguais  diferentes  não redesenhados');
for (const [tipo, t] of linhasTabela) {
  const total = t.igual + t.diferente + t.naoRedesenhado;
  console.log(`${tipo.padEnd(28)} ${String(total).padStart(6)} ${String(t.igual).padStart(8)} ${String(t.diferente).padStart(11)} ${String(t.naoRedesenhado).padStart(17)}`);
}
for (const [tipo, t] of linhasTabela) {
  if (!t.diferente) continue;
  console.log(`\n== ${tipo}: ${t.diferente} diferente(s)`);
  for (const [linha, n] of [...t.assinaturas].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${String(n).padStart(6)}  ${linha.slice(0, 220)}`);
  for (const { arquivo, c } of t.exemplos) console.log(`\n-- ${arquivo} ${c.id}\n${c.diferencas.join('\n')}`);
}
