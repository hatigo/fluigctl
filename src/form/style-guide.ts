import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErroFluigctl } from '../errors.js';

/** Caminhos absolutos que o gerador de formulários emite para o navegador. */
export const ASSETS_STYLE_GUIDE: readonly string[] = [
  '/style-guide/css/fluig-style-guide.min.css',
  '/portal/resources/js/jquery/jquery.js',
  '/style-guide/js/fluig-style-guide.min.js',
];

/**
 * Candidatos ordenados por caminho de navegador. O primeiro que responder OK
 * vira a fonte do asset; o corpo é sempre gravado sob o caminho de navegador.
 */
export const CANDIDATOS_STYLE_GUIDE: Record<string, readonly string[]> = {
  '/style-guide/css/fluig-style-guide.min.css': [
    '/style-guide/css/fluig-style-guide-flat.min.css',
    '/style-guide/css/fluig-style-guide.min.css',
  ],
  '/portal/resources/js/jquery/jquery.js': ['/portal/resources/js/jquery/jquery.js'],
  '/style-guide/js/fluig-style-guide.min.js': ['/style-guide/js/fluig-style-guide.min.js'],
};

export interface ArquivoCache {
  tamanho: number;
  sha256: string;
}

export interface ManifestoStyleGuide {
  versao: 1;
  origem: string;
  criadoEm: string;
  arquivos: Record<string, ArquivoCache>;
  /** caminho de navegador -> URL efetivamente usada no download */
  fontes: Record<string, string>;
  /** caminhos de referências url() do CSS que não puderam ser baixados */
  ignorados: readonly string[];
}

/** <XDG_STATE_HOME or ~/.local/state>/fluigctl/form/styleguide */
export function diretorioDoCache(estadoDir?: string): string {
  const base = estadoDir && estadoDir.length > 0
    ? estadoDir
    : process.env['XDG_STATE_HOME'] && process.env['XDG_STATE_HOME'].length > 0
      ? process.env['XDG_STATE_HOME']!
      : join(homedir(), '.local', 'state');
  return join(base, 'fluigctl', 'form', 'styleguide');
}

/** Instrução exibida quando `form open` não encontra cache. */
export function mensagemCacheAusente(alias?: string): string {
  const alvo = alias && alias.length > 0 ? alias : '<alias>';
  return `Cache do Style Guide ausente ou inválido. Rode "fluigctl form bootstrap --server ${alvo}" uma vez para baixá-lo.`;
}

const chavesManifesto = ['versao', 'origem', 'criadoEm', 'arquivos', 'fontes', 'ignorados'] as const;

function manifestoValido(valor: unknown): valor is ManifestoStyleGuide {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false;
  const o = valor as Record<string, unknown>;
  if (Object.keys(o).length !== chavesManifesto.length) return false;
  if (!chavesManifesto.every((k) => k in o)) return false;
  if (o['versao'] !== 1) return false;
  if (typeof o['origem'] !== 'string' || typeof o['criadoEm'] !== 'string') return false;
  const arquivos = o['arquivos'];
  if (!arquivos || typeof arquivos !== 'object' || Array.isArray(arquivos)) return false;
  for (const [caminho, cache] of Object.entries(arquivos as Record<string, unknown>)) {
    if (!caminho.startsWith('/')) return false;
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return false;
    const c = cache as Record<string, unknown>;
    if (Object.keys(c).length !== 2 || !('tamanho' in c) || !('sha256' in c)) return false;
    if (typeof c['tamanho'] !== 'number' || !Number.isFinite(c['tamanho']) || c['tamanho'] < 0) return false;
    if (typeof c['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(c['sha256'])) return false;
  }
  const fontes = o['fontes'];
  if (!fontes || typeof fontes !== 'object' || Array.isArray(fontes)) return false;
  for (const [caminho, origem] of Object.entries(fontes as Record<string, unknown>)) {
    if (!caminho.startsWith('/') || typeof origem !== 'string') return false;
  }
  const ignorados = o['ignorados'];
  if (!Array.isArray(ignorados)) return false;
  if (!ignorados.every((caminho) => typeof caminho === 'string' && caminho.startsWith('/'))) return false;
  return true;
}

/** Reads <cacheDir>/manifesto.json; undefined if absent/invalid. */
export function lerManifesto(cacheDir?: string): ManifestoStyleGuide | undefined {
  const dir = cacheDir ?? diretorioDoCache();
  let bruto: string;
  try {
    bruto = readFileSync(join(dir, 'manifesto.json'), 'utf8');
  } catch {
    return undefined;
  }
  let valor: unknown;
  try {
    valor = JSON.parse(bruto);
  } catch {
    return undefined;
  }
  return manifestoValido(valor) ? valor : undefined;
}

function dentro(raiz: string, alvo: string): boolean {
  const r = relative(raiz, alvo);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Recusa traversal literal/codificado, NUL, barra invertida e caminhos não absolutos. */
function caminhoBrowserSeguro(caminho: string): string | undefined {
  if (!caminho.startsWith('/')) return undefined;
  if (caminho.includes('\0') || caminho.includes('\\')) return undefined;
  if (/%2e|%2f|%5c/i.test(caminho)) return undefined;
  const rel = caminho.replace(/^\/+/, '');
  const partes = rel.split('/');
  if (partes.some((p) => p === '' || p === '.' || p === '..')) return undefined;
  return rel;
}

/** Maps a browser path to a real cached file, or undefined if unusable/unsafe. */
export function resolverAssetDoCache(caminhoBrowser: string, cacheDir?: string): string | undefined {
  const dir = cacheDir ?? diretorioDoCache();
  const manifesto = lerManifesto(dir);
  if (!manifesto || !(caminhoBrowser in manifesto.arquivos)) return undefined;
  const rel = caminhoBrowserSeguro(caminhoBrowser);
  if (rel === undefined) return undefined;
  const raiz = resolve(dir);
  const alvo = resolve(raiz, rel);
  if (alvo === raiz || !dentro(raiz, alvo)) return undefined;
  let raizReal: string;
  let alvoReal: string;
  try {
    raizReal = realpathSync(raiz);
    alvoReal = realpathSync(alvo);
  } catch {
    return undefined;
  }
  if (!dentro(raizReal, alvoReal)) return undefined;
  try {
    if (!statSync(alvoReal).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return alvoReal;
}

const urlCss = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s]*))\s*\)/gi;
const esquema = /^[a-z][a-z0-9+.-]*:/i;

/** Same-origin CSS url() references resolved against the CSS browser path. */
export function urlsDoCss(css: string, cssBrowserPath: string): string[] {
  const base = `http://local${cssBrowserPath.startsWith('/') ? cssBrowserPath : `/${cssBrowserPath}`}`;
  const vistos = new Set<string>();
  let m: RegExpExecArray | null;
  urlCss.lastIndex = 0;
  while ((m = urlCss.exec(css)) !== null) {
    const bruto = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!bruto) continue;
    if (bruto.startsWith('#')) continue;
    if (bruto.startsWith('//')) continue;
    if (esquema.test(bruto)) continue;
    let resolvido: string;
    try {
      resolvido = new URL(bruto, base).pathname;
    } catch {
      continue;
    }
    if (!resolvido.startsWith('/') || resolvido === cssBrowserPath) continue;
    vistos.add(resolvido);
  }
  return [...vistos];
}

function alvoDeEscrita(cacheDir: string, caminhoBrowser: string): string {
  const rel = caminhoBrowserSeguro(caminhoBrowser);
  if (rel === undefined) throw new ErroFluigctl(`caminho de asset recusado: ${caminhoBrowser}`, 3);
  const raiz = resolve(cacheDir);
  const alvo = resolve(raiz, rel);
  if (alvo === raiz || !dentro(raiz, alvo)) throw new ErroFluigctl(`asset fora do cache: ${caminhoBrowser}`, 3);
  mkdirSync(dirname(alvo), { recursive: true });
  const raizReal = realpathSync(raiz);
  const paiReal = realpathSync(dirname(alvo));
  if (!dentro(raizReal, paiReal)) throw new ErroFluigctl(`asset fora do cache: ${caminhoBrowser}`, 3);
  return alvo;
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/** Downloads the style guide once and writes the manifest atomically. */
export async function baixarStyleGuide(opcoes: {
  baseUrl: string;
  cookie: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  assets?: readonly string[];
  candidatos?: Record<string, readonly string[]>;
}): Promise<ManifestoStyleGuide> {
  const cacheDir = opcoes.cacheDir ?? diretorioDoCache();
  const usarFetch = opcoes.fetchImpl ?? fetch;
  const base = opcoes.baseUrl.replace(/\/+$/, '');
  const candidatos = opcoes.candidatos ?? CANDIDATOS_STYLE_GUIDE;
  const fila = [...(opcoes.assets ?? ASSETS_STYLE_GUIDE)];
  const deTopo = new Set(fila);
  const vistos = new Set<string>();
  const baixados: { caminho: string; candidato: string; corpo: Buffer }[] = [];
  const fontes: Record<string, string> = {};
  const ignorados: string[] = [];

  while (fila.length > 0) {
    const caminho = fila.shift()!;
    if (vistos.has(caminho)) continue;
    vistos.add(caminho);

    // Referências url() do CSS são best-effort: se faltarem (404/rede), entram
    // em `ignorados` e o bootstrap segue; só os assets de topo são fatais.
    if (!deTopo.has(caminho)) {
      let resposta: Response | undefined;
      try {
        resposta = await usarFetch(`${base}${caminho}`, { headers: { cookie: opcoes.cookie }, redirect: 'follow' });
      } catch {
        ignorados.push(caminho);
        continue;
      }
      if (!resposta.ok) {
        ignorados.push(caminho);
        continue;
      }
      let corpo: Buffer;
      try {
        corpo = Buffer.from(await resposta.arrayBuffer());
      } catch {
        ignorados.push(caminho);
        continue;
      }
      baixados.push({ caminho, candidato: caminho, corpo });
      fontes[caminho] = caminho;
      if (/\.css$/i.test(caminho)) {
        for (const ref of urlsDoCss(corpo.toString('utf8'), caminho)) {
          if (!vistos.has(ref)) fila.push(ref);
        }
      }
      continue;
    }

    // Tenta os candidatos em ordem; o primeiro 200 vence. Sem candidato, é o
    // próprio caminho e a falta de todos é fatal (topo).
    const lista = candidatos[caminho] ?? [caminho];
    const tentativas: string[] = [];
    let escolhido: string | undefined;
    let corpo: Buffer | undefined;
    for (const candidato of lista) {
      let resposta: Response;
      try {
        resposta = await usarFetch(`${base}${candidato}`, { headers: { cookie: opcoes.cookie }, redirect: 'follow' });
      } catch (erro) {
        throw new ErroFluigctl(`não consegui baixar ${caminho}: ${mensagemDe(erro)}`, 3);
      }
      if (resposta.ok) {
        try {
          corpo = Buffer.from(await resposta.arrayBuffer());
        } catch (erro) {
          throw new ErroFluigctl(`não consegui ler ${caminho}: ${mensagemDe(erro)}`, 3);
        }
        escolhido = candidato;
        break;
      }
      tentativas.push(`${candidato} (HTTP ${resposta.status})`);
    }
    if (escolhido === undefined || corpo === undefined) {
      throw new ErroFluigctl(`não consegui baixar ${caminho}; tentei: ${tentativas.join(', ')}`, 3);
    }
    baixados.push({ caminho, candidato: escolhido, corpo });
    fontes[caminho] = escolhido;

    if (/\.css$/i.test(caminho)) {
      for (const ref of urlsDoCss(corpo.toString('utf8'), caminho)) {
        if (!vistos.has(ref)) fila.push(ref);
      }
    }
  }

  mkdirSync(cacheDir, { recursive: true });
  const arquivos: Record<string, ArquivoCache> = {};
  for (const { caminho, corpo } of baixados) {
    const alvo = alvoDeEscrita(cacheDir, caminho);
    writeFileSync(alvo, corpo);
    arquivos[caminho] = {
      tamanho: corpo.length,
      sha256: createHash('sha256').update(corpo).digest('hex'),
    };
  }

  const manifesto: ManifestoStyleGuide = {
    versao: 1,
    origem: base,
    criadoEm: new Date().toISOString(),
    arquivos,
    fontes,
    ignorados,
  };
  const destino = join(cacheDir, 'manifesto.json');
  const temporario = `${destino}.${process.pid}.tmp`;
  writeFileSync(temporario, `${JSON.stringify(manifesto, null, 2)}\n`);
  renameSync(temporario, destino);
  return manifesto;
}
