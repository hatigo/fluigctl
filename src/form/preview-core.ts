import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import type { Socket } from 'node:net';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { ErroFluigctl } from '../errors.js';
import { CONTEXTO_PADRAO, scriptDaApi, type ContextoPreview } from './frame-api.js';
import { resolverAssetDoCache } from './style-guide.js';

export interface FormSource { root: string; html: string }
export interface RestricaoPreview { campo: string; inicial: string; final: string; tipo: 1 | 2 | 3; like?: boolean }
export interface ConsultaDatasetPreview { nome: string; campos?: string[]; restricoes?: RestricaoPreview[]; ordem?: string[] }
export interface ResultadoDatasetPreview { columns: string[]; values: Record<string, unknown>[] }
export interface PreviewOptions {
  cacheDir?: string;
  watch?: boolean;
  contexto?: ContextoPreview;
  dataset?: (consulta: ConsultaDatasetPreview) => Promise<ResultadoDatasetPreview | undefined>;
}
export interface PreviewCore { url: string; token: string; port: number; recarregar(): void; close(): Promise<void> }
type Message = { v: 1; type: 'ready' | 'diagnostic' | 'unsupported'; id: string; detail?: string };
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
};
const within = (root: string, file: string) => { const r = relative(root, file); return r !== '..' && !r.startsWith('../') && !isAbsolute(r); };

export function resolveFormSource(input: string): FormSource {
  const candidate = resolve(input); let stat: ReturnType<typeof statSync>;
  try { stat = statSync(candidate); } catch { throw new ErroFluigctl(`formulário não encontrado: ${input}`, 2); }
  if (stat.isFile()) { const root = realpathSync(dirname(candidate)); const html = realpathSync(candidate); if (!['.html','.htm'].includes(extname(html).toLowerCase())) throw new ErroFluigctl('o preview espera HTML', 2); if (!within(root, html) || !statSync(html).isFile()) throw new ErroFluigctl('HTML principal fora da pasta declarada', 2); return { root, html }; }
  if (!stat.isDirectory()) throw new ErroFluigctl('entrada de formulário inválida', 2);
  const root = realpathSync(candidate);
  const entries = readdirSync(candidate).filter((n) => ['.html','.htm'].includes(extname(n).toLowerCase()));
  const preferred = `${basename(candidate)}.html`;
  const selected = entries.includes(preferred) ? preferred : entries.length === 1 ? entries[0] : undefined;
  if (!selected) throw new ErroFluigctl(entries.length ? 'pasta de formulário ambígua: informe o HTML' : 'pasta de formulário sem HTML principal', 2);
  let html: string; try { html = realpathSync(resolve(candidate, selected)); } catch { throw new ErroFluigctl('HTML principal inválido', 2); }
  if (!within(root, html) || !statSync(html).isFile()) throw new ErroFluigctl('HTML principal fora da pasta do formulário', 2);
  return { root, html };
}
export function resolveLocalAsset(source: FormSource, input: string): string {
  if (!input || input.includes('\0') || isAbsolute(input) || /%2e|%2f|%5c/i.test(input)) throw new ErroFluigctl('asset local recusado', 2);
  let name: string; try { name = decodeURIComponent(input); } catch { throw new ErroFluigctl('asset local recusado', 2); }
  if (name.includes('\0') || name.split('/').some((p) => !p || p === '.' || p === '..')) throw new ErroFluigctl('asset local recusado', 2);
  let file: string; try { file = realpathSync(resolve(source.root, name)); } catch { throw new ErroFluigctl('asset local não encontrado', 2); }
  if (!within(source.root, file) || !statSync(file).isFile()) throw new ErroFluigctl('asset local recusado', 2); return file;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> | undefined { if (!value || typeof value !== 'object' || Array.isArray(value)) return; const o = value as Record<string,unknown>; return Object.keys(o).length === keys.length && keys.every((k) => k in o) ? o : undefined; }
/** Owns replay state; callers reset it on iframe reload/close. */
export class FrameProtocolOwner {
  #seen = new Set<string>(); #live = false;
  constructor(private readonly expectedSource: unknown, private readonly nonce: string) {}
  acceptHello(source: unknown, value: unknown): { ok: true } | { ok: false; diagnostic: string } {
    const o = exact(value, ['v','type','nonce']);
    if (source !== this.expectedSource) return { ok:false, diagnostic:'fonte de frame recusada' };
    if (!o || o.v !== 1 || o.type !== 'hello' || o.nonce !== this.nonce) return { ok:false, diagnostic:'handshake de frame inválido' };
    this.#live = true; return { ok:true };
  }
  acceptPort(value: unknown): Message | { diagnostic: string } {
    const three = exact(value, ['v','type','id']);
    const o = three ?? exact(value, ['v','type','id','detail']);
    if (!this.#live || !o || o.v !== 1 || typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id) || this.#seen.has(o.id) || !['ready','diagnostic','unsupported'].includes(String(o.type)) || ('detail' in o && (typeof o.detail !== 'string' || o.detail.length > 512))) return { diagnostic:'mensagem de porta inválida' };
    this.#seen.add(o.id); return o as Message;
  }
  reset(): void { this.#live = false; this.#seen.clear(); }
}
function controlHtml(token: string, nonce: string): string { return `<!doctype html><iframe id="frame" sandbox="allow-scripts allow-forms allow-modals" src="/frame?n=${nonce}"></iframe><script>const f=document.querySelector('#frame'),n=${JSON.stringify(nonce)},TOKEN=${JSON.stringify(token)},seen=new Set;try{const sse=new EventSource('/events/'+TOKEN);sse.onmessage=()=>{f.src=f.src}}catch{}let port=null;const detach=()=>{if(port){port.onmessage=null;port.close();port=null}seen.clear()};addEventListener('message',e=>{const d=e.data;if(e.source!==f.contentWindow||port||!d||Object.keys(d).length!==3||d.v!==1||d.type!=='hello'||d.nonce!==n)return;const c=new MessageChannel;port=c.port1;port.onmessage=x=>{const m=x.data;if(m&&typeof m==='object'&&m.v===1&&m.type==='dataset'&&typeof m.id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(m.id)){const d={v:1,type:'dataset',id:m.id,nome:m.nome,campos:m.campos||[],restricoes:m.restricoes||[],ordem:m.ordem||[]};fetch('/dataset/'+TOKEN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(r=>r.json()).then(res=>{if(res&&res.error)port.postMessage({v:1,type:'dataset:error',id:m.id,message:res.error});else port.postMessage({v:1,type:'dataset:ok',id:m.id,columns:(res&&res.columns)||[],values:(res&&res.values)||[]})}).catch(()=>{port.postMessage({v:1,type:'dataset:error',id:m.id,message:'falha ao consultar o dataset no preview'})});return}const k=m&&typeof m==='object'?Object.keys(m):[];if(!m||!([3,4].includes(k.length)&&k.every(q=>['v','type','id','detail'].includes(q))&&m.v===1&&['ready','diagnostic','unsupported'].includes(m.type)&&typeof m.id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(m.id)&&!seen.has(m.id)&&(m.detail===undefined||(typeof m.detail==='string'&&m.detail.length<=512))))console.warn('preview diagnostic: invalid port message');else seen.add(m.id)};e.source.postMessage({v:1,type:'port'},'*',[c.port2])});f.addEventListener('load',detach);addEventListener('pagehide',detach)</script>`; }
function frameHtml(source: FormSource, nonce: string, contexto?: ContextoPreview): string { const html = readFileSync(source.html,'utf8'); const api = `<script>${scriptDaApi(contexto ?? CONTEXTO_PADRAO)}</script>`; const bootstrap = `<script>(function(){const n=${JSON.stringify(nonce)};parent.postMessage({v:1,type:'hello',nonce:n},'*');const receive=e=>{const d=e.data;if(e.source!==parent||!d||Object.keys(d).length!==2||d.v!==1||d.type!=='port'||e.ports.length!==1)return;removeEventListener('message',receive);if(typeof window!=='undefined'&&window.__fluigPreview&&window.__fluigPreview.conectar)window.__fluigPreview.conectar(e.ports[0]);e.ports[0].postMessage({v:1,type:'ready',id:'ready-'+n})};addEventListener('message',receive)})();</script><aside data-fluigctl-preview-diagnostic>Preview local isolado: scripts selecionados são confiados para renderizar/interagir e podem substituir ou navegar seu próprio frame. Não acessam o pai, token de controle ou credenciais e não podem navegar o topo. O contexto Fluig é simulado e eventos de servidor (displayFields, enableFields, validateForm) não são executados; DatasetFactory/datasets e FLUIGC não são suportados nesta fatia.</aside>`; return html.replace(/<head([^>]*)>/i,`<head$1><base href="/asset/"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'self';">${api}`).replace(/<body([^>]*)>/i,`<body$1>${bootstrap}`); }

async function lerCorpo(req: IncomingMessage): Promise<string | undefined> {
  const partes: Buffer[] = [];
  let tamanho = 0;
  let excedeu = false;
  for await (const parte of req) {
    const buffer = Buffer.isBuffer(parte) ? parte : Buffer.from(parte as Uint8Array);
    tamanho += buffer.length;
    if (tamanho > 64 * 1024) { excedeu = true; continue; }
    partes.push(buffer);
  }
  return excedeu ? undefined : Buffer.concat(partes).toString('utf8');
}

function validarConsultaDataset(valor: unknown): ConsultaDatasetPreview | undefined {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return undefined;
  const o = valor as Record<string, unknown>;
  const nome = o['nome'];
  if (typeof nome !== 'string' || nome.length === 0 || nome.length > 128) return undefined;
  const campos = o['campos'];
  if (campos !== undefined) {
    if (!Array.isArray(campos) || campos.length > 64) return undefined;
    if (!campos.every((c) => typeof c === 'string' && c.length <= 128)) return undefined;
  }
  const restricoesValidas: RestricaoPreview[] = [];
  const restricoes = o['restricoes'];
  if (restricoes !== undefined) {
    if (!Array.isArray(restricoes) || restricoes.length > 32) return undefined;
    for (const r of restricoes) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
      const rr = r as Record<string, unknown>;
      const campo = rr['campo']; const inicial = rr['inicial']; const final = rr['final']; const tipo = rr['tipo']; const like = rr['like'];
      if (typeof campo !== 'string' || campo.length > 512) return undefined;
      if (typeof inicial !== 'string' || inicial.length > 512) return undefined;
      if (typeof final !== 'string' || final.length > 512) return undefined;
      if (tipo !== 1 && tipo !== 2 && tipo !== 3) return undefined;
      if (like !== undefined && typeof like !== 'boolean') return undefined;
      restricoesValidas.push({ campo, inicial, final, tipo, ...(like === undefined ? {} : { like }) });
    }
  }
  const ordem = o['ordem'];
  if (ordem !== undefined) {
    if (!Array.isArray(ordem) || ordem.length > 32) return undefined;
    if (!ordem.every((s) => typeof s === 'string' && s.length <= 128)) return undefined;
  }
  return {
    nome,
    ...(campos === undefined ? {} : { campos: campos as string[] }),
    ...(restricoes === undefined ? {} : { restricoes: restricoesValidas }),
    ...(ordem === undefined ? {} : { ordem: ordem as string[] }),
  };
}

async function responderDataset(req: IncomingMessage, res: ServerResponse, backend: PreviewOptions['dataset']): Promise<void> {
  const json = (status: number, corpo: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(corpo));
  };
  const corpo = await lerCorpo(req);
  if (corpo === undefined) { json(400, { error: 'pedido de dataset inválido' }); return; }
  let valor: unknown;
  try { valor = JSON.parse(corpo); } catch { json(400, { error: 'pedido de dataset inválido' }); return; }
  const consulta = validarConsultaDataset(valor);
  if (!consulta) { json(400, { error: 'pedido de dataset inválido' }); return; }
  if (!backend) { json(200, { error: 'sem servidor: rode form open --server <alias> para habilitar datasets' }); return; }
  try {
    const resultado = await backend(consulta);
    if (!resultado) { json(200, { error: `o dataset "${consulta.nome}" não devolveu colunas` }); return; }
    json(200, { columns: resultado.columns, values: resultado.values });
  } catch (erro) {
    json(200, { error: erro instanceof Error ? erro.message : String(erro) });
  }
}

function subdiretorios(dir: string): string[] {
  let entradas;
  try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entradas.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Observa a árvore da pasta do formulário com profundidade limitada. */
function observar(dir: string, profundidade: number, watchers: FSWatcher[], aoMudar: () => void): void {
  if (profundidade > 6) return;
  let watcher: FSWatcher;
  try { watcher = watch(dir, { persistent: true }, () => aoMudar()); } catch { return; }
  watchers.push(watcher);
  for (const nome of subdiretorios(dir)) {
    if (nome.startsWith('.') || nome === 'node_modules') continue;
    observar(join(dir, nome), profundidade + 1, watchers, aoMudar);
  }
}

export async function startPreviewCore(input: string, opcoes: PreviewOptions = {}): Promise<PreviewCore> {
  const source=resolveFormSource(input), token=randomBytes(32).toString('hex'), nonce=randomBytes(24).toString('hex'), sockets=new Set<Socket>();
  const clientes = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const notificar = (): void => { for (const cliente of clientes) { try { cliente.write('data: reload\n\n'); } catch { /* cliente já saiu */ } } };
  const agendar = (): void => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { debounce = undefined; notificar(); }, 150); };
  const server=createServer((req,res)=>{const url=new URL(req.url??'/','http://localhost'), path=url.pathname, deny=()=>{res.writeHead(404);res.end('not found')}; const a=server.address(), origin=a&&typeof a!=='string'?`http://127.0.0.1:${a.port}`:'';
    if(path===`/control/${token}`){if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);return res.end('forbidden')}res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'; connect-src 'self'"});return res.end(controlHtml(token,nonce));}
    if(path===`/state/${token}`){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});return res.end(JSON.stringify({arquivo:source.html,raiz:source.root}));}
    if(path===`/events/${token}`){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store',connection:'keep-alive'});res.write(': conectado\n\n');clientes.add(res);res.once('close',()=>clientes.delete(res));return;}
    if(path===`/dataset/${token}`){if(req.method!=='POST'){res.writeHead(405);return res.end('method not allowed')}void responderDataset(req,res,opcoes.dataset);return;}
    if(path==='/frame'&&url.searchParams.get('n')===nonce){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'self'"});return res.end(frameHtml(source,nonce,opcoes.contexto));}
    if(path.startsWith('/style-guide/')||path.startsWith('/portal/resources/')){if(!opcoes.cacheDir)return deny();const file=resolverAssetDoCache(path,opcoes.cacheDir);if(!file)return deny();const type=contentTypes[extname(file).toLowerCase()];if(!type)return deny();res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff'});return res.end(readFileSync(file));}
    if(path.startsWith('/asset/'))try{const file=resolveLocalAsset(source,path.slice(7)),type=contentTypes[extname(file).toLowerCase()];if(!type)return deny();res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff'});return res.end(readFileSync(file));}catch{return deny()} return deny(); });
  server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s))}); await new Promise<void>((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',()=>ok())}); const a=server.address(); if(!a||typeof a==='string')throw new ErroFluigctl('não consegui iniciar preview local',1);
  if(opcoes.watch!==false) observar(source.root,0,watchers,agendar);
  let fechamento: Promise<void> | undefined;
  const close=():Promise<void>=>{fechamento??=(async()=>{if(debounce){clearTimeout(debounce);debounce=undefined}for(const w of watchers)w.close();for(const c of clientes){try{c.end()}catch{/* já fechou */}}clientes.clear();for(const s of sockets)s.destroy();await new Promise<void>((ok,bad)=>server.close(e=>e?bad(e):ok()))})();return fechamento};
  return {token,port:a.port,url:`http://127.0.0.1:${a.port}/control/${token}`,recarregar:notificar,close};
}
