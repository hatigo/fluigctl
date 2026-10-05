import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, watchFile, unwatchFile } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { ErroFluigctl } from '../errors.js';
import { lerDiagrama } from '../push/diagram/modelo.js';
import { gerarSvg } from '../push/diagram/svg.js';

export interface EstadoVisualizador {
  arquivo: string;
  nome: string;
  svg: string;
  atualizadoEm: string;
  erro?: string;
  revisao: number;
}

export interface RegistroVisualizador {
  version: 1;
  arquivo: string;
  pid: number;
  port: number;
  token: string;
  iniciadoEm: string;
}

export interface InstanciaVisualizador {
  registro: RegistroVisualizador;
  url: string;
  reutilizada: boolean;
}

export interface ServidorVisualizador {
  server: Server;
  registro: RegistroVisualizador;
  url: string;
  estado(): EstadoVisualizador;
  fechar(): Promise<void>;
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/** Lê e renderiza antes de abrir qualquer porta. Arquivo inicial inválido é erro de uso. */
export function lerEstadoInicial(arquivo: string): EstadoVisualizador {
  if (!arquivo.toLowerCase().endsWith('.process')) {
    throw new ErroFluigctl(`o visualizador abre um arquivo .process: ${arquivo}`, 3);
  }
  let texto: string;
  try {
    texto = readFileSync(arquivo, 'utf8');
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ErroFluigctl(`diagrama não encontrado: ${arquivo}`, 3);
    }
    throw new ErroFluigctl(`não consegui ler ${arquivo}: ${mensagem(erro)}`, 3);
  }
  try {
    return {
      arquivo,
      nome: basename(arquivo, '.process'),
      svg: gerarSvg(lerDiagrama(texto)),
      atualizadoEm: new Date().toISOString(),
      revisao: 1,
    };
  } catch (erro) {
    throw new ErroFluigctl(`não consegui abrir ${arquivo}: ${mensagem(erro)}`, 6);
  }
}

function diretorioDeEstado(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'fluigctl', 'diagramas');
}

export function arquivoDoRegistro(arquivo: string, dir = diretorioDeEstado()): string {
  const id = createHash('sha256').update(resolve(arquivo)).digest('hex').slice(0, 24);
  return join(dir, `${id}.json`);
}

function salvarRegistro(registro: RegistroVisualizador, caminho = arquivoDoRegistro(registro.arquivo)): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const temporario = `${caminho}.${process.pid}.tmp`;
  writeFileSync(temporario, `${JSON.stringify(registro, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // O rename atômico evita que outro `open` leia metade do JSON.
  renameSync(temporario, caminho);
}

export function lerRegistro(arquivo: string, dir?: string): RegistroVisualizador | undefined {
  const caminho = arquivoDoRegistro(arquivo, dir);
  try {
    const registro = JSON.parse(readFileSync(caminho, 'utf8')) as RegistroVisualizador;
    if (registro.version !== 1 || resolve(registro.arquivo) !== resolve(arquivo)) return undefined;
    return registro;
  } catch {
    return undefined;
  }
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Confirma pelo token e pelo arquivo antes de confiar num PID persistido. */
async function registroAtivo(registro: RegistroVisualizador): Promise<boolean> {
  if (!processoVivo(registro.pid)) return false;
  try {
    const resposta = await fetch(`${urlDoRegistro(registro)}state`, { signal: AbortSignal.timeout(600) });
    if (!resposta.ok) return false;
    const estado = (await resposta.json()) as Partial<EstadoVisualizador>;
    return typeof estado.arquivo === 'string' && resolve(estado.arquivo) === resolve(registro.arquivo);
  } catch {
    return false;
  }
}

export function urlDoRegistro(r: RegistroVisualizador): string {
  return `http://127.0.0.1:${r.port}/${r.token}/`;
}

function responder(res: ServerResponse, status: number, tipo: string, corpo: string): void {
  res.writeHead(status, {
    'content-type': `${tipo}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(corpo);
}

function pagina(nome: string, arquivo: string): string {
  const titulo = nome.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const caminho = arquivo.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} · fluigctl</title><style>
:root{color-scheme:light;--ink:#172033;--muted:#68738a;--line:#dce2ec;--panel:#fff;--bg:#f4f6fa;--brand:#2457d6;--warn:#9a3412}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{font:14px system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg);overflow:hidden}
header{height:64px;display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 1px 6px #1a29451a;position:relative;z-index:2}
.brand{font-weight:800;color:var(--brand);letter-spacing:.02em}.title{min-width:0;flex:1}.title strong,.title small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.title small{color:var(--muted);margin-top:3px}
.status{display:flex;align-items:center;gap:8px;color:var(--muted);white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:#16a34a}.dot.bad{background:#ea580c}
button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 11px;cursor:pointer;color:var(--ink)}button:hover{border-color:#9aabc5;background:#f8faff}
#error{display:none;position:absolute;left:50%;top:76px;transform:translateX(-50%);max-width:min(760px,calc(100% - 32px));padding:10px 14px;border:1px solid #fdba74;border-radius:9px;background:#fff7ed;color:var(--warn);box-shadow:0 5px 20px #43140720;z-index:3}#error.show{display:block}
#canvas{height:calc(100% - 64px);width:100%;overflow:hidden;cursor:grab;background-color:#f7f9fc;background-image:radial-gradient(#cbd5e1 1px,transparent 1px);background-size:20px 20px}#canvas.drag{cursor:grabbing}#canvas svg{display:block;width:100%;height:100%;user-select:none}
.empty{height:100%;display:grid;place-items:center;color:var(--muted)}
</style></head><body>
<header><div class="brand">fluigctl</div><div class="title"><strong>${titulo}</strong><small>${caminho}</small></div><div class="status"><span id="dot" class="dot"></span><span id="status">carregando…</span></div><button id="fit" type="button" title="Ajustar o diagrama à janela">Ajustar</button></header>
<div id="error" role="alert"></div><main id="canvas"><div class="empty">Carregando diagrama…</div></main>
<script>
const canvas=document.querySelector('#canvas'), status=document.querySelector('#status'), dot=document.querySelector('#dot'), error=document.querySelector('#error');
let svg, original, box, drag;
function dimensions(el){const w=Number(el.getAttribute('width'))||1000,h=Number(el.getAttribute('height'))||700;return {x:0,y:0,w,h}}
function apply(){if(svg&&box)svg.setAttribute('viewBox',box.x+' '+box.y+' '+box.w+' '+box.h)}
function fit(){if(svg){box={...original};apply()}}
document.querySelector('#fit').addEventListener('click',fit);
canvas.addEventListener('wheel',e=>{if(!svg)return;e.preventDefault();const r=svg.getBoundingClientRect(),px=box.x+(e.clientX-r.left)/r.width*box.w,py=box.y+(e.clientY-r.top)/r.height*box.h,f=e.deltaY>0?1.12:.89,nw=box.w*f,nh=box.h*f;box={x:px-(px-box.x)*f,y:py-(py-box.y)*f,w:nw,h:nh};apply()},{passive:false});
canvas.addEventListener('pointerdown',e=>{if(!svg||e.button!==0)return;canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,box:{...box}};canvas.classList.add('drag')});
canvas.addEventListener('pointermove',e=>{if(!drag||!svg)return;const r=svg.getBoundingClientRect();box={...drag.box,x:drag.box.x-(e.clientX-drag.x)/r.width*drag.box.w,y:drag.box.y-(e.clientY-drag.y)/r.height*drag.box.h};apply()});
function end(){drag=undefined;canvas.classList.remove('drag')}canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
async function update(){try{const r=await fetch('state',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const s=await r.json();if(!svg||Number(svg.dataset.revision)!==s.revisao){const anterior=box;canvas.innerHTML=s.svg;svg=canvas.querySelector('svg');svg.dataset.revision=String(s.revisao);original=dimensions(svg);box=anterior||{...original};apply()}const when=new Date(s.atualizadoEm);status.textContent='atualizado às '+when.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});error.textContent=s.erro||'';error.classList.toggle('show',Boolean(s.erro));dot.classList.toggle('bad',Boolean(s.erro))}catch(e){status.textContent='sem conexão';error.textContent='O visualizador perdeu a conexão com o fluigctl.';error.classList.add('show');dot.classList.add('bad')}}
update();const events=new EventSource('events');events.addEventListener('change',update);events.onerror=()=>{dot.classList.add('bad');status.textContent='reconectando…'};
</script></body></html>`;
}

export interface OpcoesServidor {
  arquivo: string;
  token?: string;
  port?: number;
  registroDir?: string;
  pid?: number;
}

/**
 * Abre o visualizador completo. HTTP, relógio e filesystem ficam atrás desta
 * interface pequena; os testes usam uma porta real e arquivos temporários.
 */
export async function servirDiagrama(opcoes: OpcoesServidor): Promise<ServidorVisualizador> {
  const arquivo = resolve(opcoes.arquivo);
  let estado = lerEstadoInicial(arquivo);
  const token = opcoes.token ?? randomBytes(24).toString('hex');
  const clientes = new Set<ServerResponse>();
  let ultimoTexto = readFileSync(arquivo, 'utf8');

  const avisar = () => {
    for (const res of clientes) res.write(`event: change\ndata: ${estado.revisao}\n\n`);
  };
  const reler = () => {
    try {
      const texto = readFileSync(arquivo, 'utf8');
      if (texto === ultimoTexto && estado.erro === undefined) return;
      const svg = gerarSvg(lerDiagrama(texto));
      ultimoTexto = texto;
      estado = {
        arquivo: estado.arquivo,
        nome: estado.nome,
        svg,
        atualizadoEm: new Date().toISOString(),
        revisao: estado.revisao + 1,
      }; 
    } catch (erro) {
      // O último SVG válido fica na tela; só a faixa de erro muda.
      const detalhe = (erro as NodeJS.ErrnoException).code === 'ENOENT' ? 'arquivo não encontrado' : mensagem(erro);
      if (estado.erro === detalhe) return;
      estado = { ...estado, erro: detalhe, atualizadoEm: new Date().toISOString() };
    }
    avisar();
  };

  const prefixo = `/${token}/`;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method !== 'GET' || !url.startsWith(prefixo)) {
      responder(res, 404, 'text/plain', 'não encontrado');
      return;
    }
    const rota = url.slice(prefixo.length).split('?')[0];
    if (rota === '') {
      responder(res, 200, 'text/html', pagina(estado.nome, arquivo));
      return;
    }
    if (rota === 'state') {
      responder(res, 200, 'application/json', JSON.stringify(estado));
      return;
    }
    if (rota === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      });
      res.write(': conectado\n\n');
      clientes.add(res);
      req.on('close', () => clientes.delete(res));
      return;
    }
    responder(res, 404, 'text/plain', 'não encontrado');
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opcoes.port ?? 0, '127.0.0.1', () => resolvePromise());
  });
  const endereco = server.address();
  if (!endereco || typeof endereco === 'string') throw new ErroFluigctl('não consegui escolher a porta do visualizador', 1);
  const registro: RegistroVisualizador = {
    version: 1,
    arquivo,
    pid: opcoes.pid ?? process.pid,
    port: endereco.port,
    token,
    iniciadoEm: new Date().toISOString(),
  };
  salvarRegistro(registro, arquivoDoRegistro(arquivo, opcoes.registroDir));
  watchFile(arquivo, { interval: 250, persistent: true }, reler);

  const fechar = async () => {
    unwatchFile(arquivo, reler);
    for (const cliente of clientes) cliente.end();
    await new Promise<void>((ok) => server.close(() => ok()));
    rmSync(arquivoDoRegistro(arquivo, opcoes.registroDir), { force: true });
  };
  return { server, registro, url: urlDoRegistro(registro), estado: () => estado, fechar };
}

function abrirNavegador(url: string): void {
  const sistema = platform();
  const comando = sistema === 'darwin' ? 'open' : sistema === 'win32' ? 'cmd' : 'xdg-open';
  const args = sistema === 'win32' ? ['/c', 'start', '', url] : [url];
  const filho = spawn(comando, args, { detached: true, stdio: 'ignore' });
  filho.on('error', (erro) => console.error(`aviso: não consegui abrir o navegador: ${mensagem(erro)}. Abra ${url}`));
  filho.unref();
}

export interface OpcoesAbrir {
  arquivo: string;
  abrirNavegador?: boolean;
  foreground?: boolean;
  registroDir?: string;
  /** Entrada executável do fluigctl; injetável nos testes. */
  cli?: string;
}

export async function abrirVisualizador(opcoes: OpcoesAbrir): Promise<InstanciaVisualizador> {
  const arquivo = resolve(opcoes.arquivo);
  // Valida antes de criar o processo: erro de caminho ou XML volta imediatamente ao agente.
  lerEstadoInicial(arquivo);
  const anterior = lerRegistro(arquivo, opcoes.registroDir);
  if (anterior && await registroAtivo(anterior)) {
    const url = urlDoRegistro(anterior);
    if (opcoes.abrirNavegador !== false) abrirNavegador(url);
    return { registro: anterior, url, reutilizada: true };
  }
  if (anterior) rmSync(arquivoDoRegistro(arquivo, opcoes.registroDir), { force: true });

  if (opcoes.foreground) {
    const instancia = await servirDiagrama({
      arquivo,
      ...(opcoes.registroDir === undefined ? {} : { registroDir: opcoes.registroDir }),
    });
    const encerrar = async () => {
      await instancia.fechar();
      process.exit(0);
    };
    process.once('SIGTERM', () => void encerrar());
    process.once('SIGINT', () => void encerrar());
    if (opcoes.abrirNavegador !== false) abrirNavegador(instancia.url);
    return { registro: instancia.registro, url: instancia.url, reutilizada: false };
  }

  const token = randomBytes(24).toString('hex');
  const cli = opcoes.cli ?? process.argv[1];
  if (!cli) throw new ErroFluigctl('não consegui localizar o executável do fluigctl para iniciar o visualizador', 1);
  const args = [cli, 'diagram', 'serve', arquivo, '--token', token];
  if (opcoes.registroDir) args.push('--registry-dir', opcoes.registroDir);
  const filho = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  filho.unref();

  const limite = Date.now() + 5_000;
  let registro: RegistroVisualizador | undefined;
  while (Date.now() < limite) {
    await new Promise((ok) => setTimeout(ok, 40));
    registro = lerRegistro(arquivo, opcoes.registroDir);
    if (registro && registro.pid === filho.pid) break;
    if (filho.exitCode !== null) break;
  }
  if (!registro || registro.pid !== filho.pid) {
    try { process.kill(filho.pid!, 'SIGTERM'); } catch { /* já terminou */ }
    throw new ErroFluigctl('o visualizador não iniciou em 5 segundos', 1);
  }
  const url = urlDoRegistro(registro);
  if (opcoes.abrirNavegador !== false) abrirNavegador(url);
  return { registro, url, reutilizada: false };
}

export async function fecharVisualizador(arquivoInformado: string, registroDir?: string): Promise<RegistroVisualizador | undefined> {
  const arquivo = resolve(arquivoInformado);
  const registro = lerRegistro(arquivo, registroDir);
  if (!registro) return undefined;
  // Um PID pode ser reciclado pelo sistema. Só o mata depois que o endpoint com
  // token confirmou que ele serve exatamente o arquivo deste registro.
  if (await registroAtivo(registro)) {
    try { process.kill(registro.pid, 'SIGTERM'); } catch { /* corrida: ele já saiu */ }
  }
  rmSync(arquivoDoRegistro(arquivo, registroDir), { force: true });
  return registro;
}

/** Só o subcomando interno usa: mantém o filho vivo e limpa o registro ao sair. */
export async function executarServidor(opcoes: OpcoesServidor): Promise<never> {
  const instancia = await servirDiagrama(opcoes);
  const encerrar = async () => {
    await instancia.fechar();
    process.exit(0);
  };
  process.once('SIGTERM', () => void encerrar());
  process.once('SIGINT', () => void encerrar());
  return new Promise<never>(() => undefined);
}
