import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { ErroFluigctl } from '../errors.js';

export interface FormSource { root: string; html: string }
export interface PreviewCore { url: string; token: string; port: number; close(): Promise<void> }
type Message = { v: 1; type: 'ready' | 'diagnostic' | 'unsupported'; id: string; detail?: string };
const contentTypes: Record<string, string> = { '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2' };
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
function controlHtml(nonce: string): string { return `<!doctype html><iframe id="frame" sandbox="allow-scripts allow-forms allow-modals" src="/frame?n=${nonce}"></iframe><script>const f=document.querySelector('#frame'),n=${JSON.stringify(nonce)},seen=new Set;let port=null;const detach=()=>{if(port){port.onmessage=null;port.close();port=null}seen.clear()};addEventListener('message',e=>{const d=e.data;if(e.source!==f.contentWindow||port||!d||Object.keys(d).length!==3||d.v!==1||d.type!=='hello'||d.nonce!==n)return;const c=new MessageChannel;port=c.port1;port.onmessage=x=>{const m=x.data,k=m&&typeof m==='object'?Object.keys(m):[];if(!m||!([3,4].includes(k.length)&&k.every(q=>['v','type','id','detail'].includes(q))&&m.v===1&&['ready','diagnostic','unsupported'].includes(m.type)&&typeof m.id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(m.id)&&!seen.has(m.id)&&(m.detail===undefined||(typeof m.detail==='string'&&m.detail.length<=512))))console.warn('preview diagnostic: invalid port message');else seen.add(m.id)};e.source.postMessage({v:1,type:'port'},'*',[c.port2])});f.addEventListener('load',detach);addEventListener('pagehide',detach)</script>`; }
function frameHtml(source: FormSource, nonce: string): string { const html = readFileSync(source.html,'utf8'); const bootstrap = `<script>(function(){const n=${JSON.stringify(nonce)};parent.postMessage({v:1,type:'hello',nonce:n},'*');const receive=e=>{const d=e.data;if(e.source!==parent||!d||Object.keys(d).length!==2||d.v!==1||d.type!=='port'||e.ports.length!==1)return;removeEventListener('message',receive);e.ports[0].postMessage({v:1,type:'ready',id:'ready-'+n})};addEventListener('message',receive)})();</script><aside data-fluigctl-preview-diagnostic>Preview local isolado: scripts selecionados são confiados para renderizar/interagir e podem substituir ou navegar seu próprio frame. Não acessam o pai, token de controle ou credenciais e não podem navegar o topo. Recursos Fluig remotos, DatasetFactory e FLUIGC não são suportados nesta fatia.</aside>`; return html.replace(/<head([^>]*)>/i,`<head$1><base href="/asset/"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'self';">`).replace(/<body([^>]*)>/i,`<body$1>${bootstrap}`); }
export async function startPreviewCore(input: string): Promise<PreviewCore> {
  const source=resolveFormSource(input), token=randomBytes(32).toString('hex'), nonce=randomBytes(24).toString('hex'), sockets=new Set<Socket>();
  const server=createServer((req,res)=>{const path=new URL(req.url??'/','http://localhost').pathname, deny=()=>{res.writeHead(404);res.end('not found')}; const a=server.address(), origin=a&&typeof a!=='string'?`http://127.0.0.1:${a.port}`:'';
    if(path===`/control/${token}`){if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);return res.end('forbidden')}res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; frame-src 'self'; script-src 'unsafe-inline'"});return res.end(controlHtml(nonce));}
    if(path==='/frame'&&new URL(req.url??'/','http://localhost').searchParams.get('n')===nonce){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'self'"});return res.end(frameHtml(source,nonce));}
    if(path.startsWith('/asset/'))try{const file=resolveLocalAsset(source,path.slice(7)),type=contentTypes[extname(file).toLowerCase()];if(!type)return deny();res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff'});return res.end(readFileSync(file));}catch{return deny()} return deny(); });
  server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s))}); await new Promise<void>((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',()=>ok())}); const a=server.address(); if(!a||typeof a==='string')throw new ErroFluigctl('não consegui iniciar preview local',1);
  return {token,port:a.port,url:`http://127.0.0.1:${a.port}/control/${token}`,close:()=>{for(const s of sockets)s.destroy();return new Promise((ok,bad)=>server.close(e=>e?bad(e):ok()) )}};
}
