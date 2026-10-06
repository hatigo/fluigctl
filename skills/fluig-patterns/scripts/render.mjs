// Desenha um .process em SVG com o mesmo gerador do visualizador e do push.
// Uso: node render.mjs <arquivo.process> <saida.svg>
// Depois: rsvg-convert -b white -w 2400 saida.svg -o saida.png
// Precisa do build (npm run build); FLUIGCTL_DIR aponta para outro checkout.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const raiz = process.env.FLUIGCTL_DIR ?? fileURLToPath(new URL('../../..', import.meta.url));
const { lerDiagrama } = await import(pathToFileURL(join(raiz, 'dist/src/push/diagram/modelo.js')).href);
const { gerarSvg } = await import(pathToFileURL(join(raiz, 'dist/src/push/diagram/svg.js')).href);

const [entrada, saida] = process.argv.slice(2);
if (!entrada || !saida) {
  console.error('uso: node render.mjs <arquivo.process> <saida.svg>');
  process.exit(2);
}
writeFileSync(saida, gerarSvg(lerDiagrama(readFileSync(entrada, 'utf8'))));
