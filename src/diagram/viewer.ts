import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { ErroFluigctl } from '../errors.js';
import { lerDiagrama, type Diagrama, type Ponto } from '../push/diagram/modelo.js';
import { gerarSvg, pontosDoFluxo } from '../push/diagram/svg.js';

export interface CampoAmigavel {
  rotulo: string;
  valor: string;
}

export interface GeometriaElemento {
  caixa?: { x: number; y: number; largura: number; altura: number };
  pontos?: Ponto[];
}

export interface ElementoVisual {
  id: string;
  tipo: string;
  tipoAmigavel: string;
  nome: string;
  campos: CampoAmigavel[];
  atributos: Record<string, string>;
  geometria: GeometriaElemento;
}

export interface EstadoVisualizador {
  arquivo: string;
  nome: string;
  svg: string;
  elementos: ElementoVisual[];
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

const TIPOS: Record<string, string> = {
  BpmnPool: 'Pool',
  BpmnSwimLane: 'Raia',
  BpmnStartEvent: 'Evento de início',
  BpmnEndEvent: 'Evento de fim',
  BpmnIntermediateEvent: 'Evento intermediário',
  BpmnBoundaryEvent: 'Evento de borda',
  BpmnTask: 'Atividade',
  BpmnSubProcess: 'Subprocesso',
  BpmnGateway: 'Gateway',
  SequenceFlow: 'Fluxo',
  BpmnAnnotation: 'Anotação',
  TextAnnotation: 'Anotação',
  BpmnGroup: 'Grupo',
  BpmnDatabase: 'Banco de dados',
  BpmnDocument: 'Documento',
};

const TIPOS_NUMERICOS: Record<string, string> = {
  '10': 'Início', '32': 'Temporizador', '36': 'Link de saída', '37': 'Sinal de saída',
  '41': 'Sinal de entrada', '42': 'Link de entrada', '43': 'Erro', '60': 'Fim',
  '63': 'Fim com erro', '68': 'Fim terminal', '80': 'Atividade de usuário',
  '81': 'Atividade automática', '82': 'Atividade de serviço', '87': 'Atividade de script',
  '100': 'Subprocesso', '101': 'Subprocesso ad hoc', '120': 'Gateway exclusivo',
  '121': 'Gateway inclusivo', '126': 'Gateway paralelo', '127': 'Junção paralela',
};

const booleano = (valor: string | undefined): string | undefined =>
  valor === undefined || valor === '' ? undefined : valor === 'true' ? 'Sim' : valor === 'false' ? 'Não' : valor;

function referencia(diagrama: Diagrama, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const objeto = diagrama.objetos.find((o) => o.attrs['id'] === id);
  const nome = objeto?.attrs['name'];
  return nome ? `${nome} (${id})` : id;
}

function campo(rotulo: string, valor: string | undefined): CampoAmigavel | undefined {
  return valor === undefined || valor === '' ? undefined : { rotulo, valor };
}

/** Traduz o modelo para o painel sem esconder os atributos crus dos detalhes técnicos. */
export function elementosDoDiagrama(diagrama: Diagrama): ElementoVisual[] {
  const elementos: ElementoVisual[] = [];
  for (const objeto of diagrama.objetos) {
    const id = objeto.attrs['id'];
    if (!id) continue;
    const caixa = diagrama.caixas.get(id);
    const ehFluxo = objeto.tipo === 'SequenceFlow';
    if (!caixa && !ehFluxo) continue; // BpmnProcess e configurações sem desenho não são selecionáveis.

    const seq = /(\d+)$/.exec(id)?.[1];
    const tipoAmigavel = TIPOS_NUMERICOS[objeto.attrs['type'] ?? ''] ?? TIPOS[objeto.tipo] ?? objeto.tipo;
    const blobsXml = Object.values(objeto.attrs).filter((valor) => /^\s*</.test(valor));
    const atributosVisiveis = Object.fromEntries(
      Object.entries(objeto.attrs).filter(([, valor]) => !/^\s*</.test(valor)),
    );
    // O Studio grava <list/> em quase tudo. Vazio não é configuração presente.
    const temConfiguracaoAvancada = blobsXml.some((valor) => !/^\s*<list\s*\/>\s*$/.test(valor));
    const candidatos: (CampoAmigavel | undefined)[] = [
      campo('Nome', objeto.attrs['name']),
      campo('Sequência', seq && Number(seq) > 0 ? seq : undefined),
      campo('Configurações avançadas', temConfiguracaoAvancada ? 'Presentes' : undefined),
    ];
    if (objeto.attrs['managerMechanism']) candidatos.push(campo('Atribuição', objeto.attrs['managerMechanism']));
    if (ehFluxo) {
      candidatos.push(
        campo('Origem', referencia(diagrama, objeto.attrs['sourceRef'])),
        campo('Destino', referencia(diagrama, objeto.attrs['targetRef'])),
        campo('Expressão', objeto.attrs['expression']),
        campo('Título do movimento', objeto.attrs['movementTitle']),
      );
    }
    if (objeto.tipo === 'BpmnSubProcess') {
      candidatos.push(
        campo('Processo chamado', objeto.attrs['process']),
        campo('Transfere anexos', booleano(objeto.attrs['transferAttachments'])),
        campo('Cancela o subprocesso', booleano(objeto.attrs['cancelSubProcess'])),
        campo('Avança após concluir', booleano(objeto.attrs['sendToNextTaskInSubProcess'])),
      );
    }
    if (objeto.tipo === 'BpmnDocument') candidatos.push(campo('Documento', objeto.attrs['documentId']));

    const geometria: GeometriaElemento = {};
    if (caixa) {
      geometria.caixa = { x: caixa.absX, y: caixa.absY, largura: caixa.largura, altura: caixa.altura };
    } else if (ehFluxo) {
      const pontos = pontosDoFluxo(diagrama, objeto);
      if (pontos) geometria.pontos = pontos;
    }
    // Fluxo sem geometria não aparece no SVG e, portanto, não deve entrar no Tab.
    if (!geometria.caixa && !geometria.pontos) continue;
    elementos.push({
      id,
      tipo: objeto.tipo,
      tipoAmigavel,
      nome: objeto.attrs['name'] ?? '',
      campos: candidatos.filter((x): x is CampoAmigavel => x !== undefined),
      // Blobs XML são implementação do Studio, não propriedade legível. Nem são
      // enviados ao navegador: esconder só no CSS ainda os exporia no endpoint.
      atributos: atributosVisiveis,
      geometria,
    });
  }
  return elementos;
}

function renderizar(texto: string): { svg: string; elementos: ElementoVisual[] } {
  const diagrama = lerDiagrama(texto);
  return { svg: gerarSvg(diagrama), elementos: elementosDoDiagrama(diagrama) };
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
    const renderizado = renderizar(texto);
    return {
      arquivo,
      nome: basename(arquivo, '.process'),
      svg: renderizado.svg,
      elementos: renderizado.elementos,
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
header{height:64px;display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 1px 6px #1a29451a;position:relative;z-index:5}
.brand{font-weight:800;color:var(--brand);letter-spacing:.02em}.title{min-width:0;flex:1}.title strong,.title small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.title small{color:var(--muted);margin-top:3px}
.status{display:flex;align-items:center;gap:8px;color:var(--muted);white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:#16a34a}.dot.bad{background:#ea580c}
button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 11px;cursor:pointer;color:var(--ink)}button:hover{border-color:#9aabc5;background:#f8faff}button:focus-visible{outline:3px solid #93b4ff;outline-offset:2px}
.banner{display:none;position:absolute;left:50%;top:76px;transform:translateX(-50%);max-width:min(760px,calc(100% - 32px));padding:10px 14px;border-radius:9px;box-shadow:0 5px 20px #43140720;z-index:6}.banner.show{display:block}
#error{border:1px solid #fdba74;background:#fff7ed;color:var(--warn)}#notice{border:1px solid #bfdbfe;background:#eff6ff;color:#1e40af}
#workspace{height:calc(100% - 64px);display:flex;min-width:0;position:relative}#canvas{height:100%;min-width:0;flex:1;overflow:hidden;cursor:grab;background-color:#f7f9fc;background-image:radial-gradient(#cbd5e1 1px,transparent 1px);background-size:20px 20px}#canvas.drag{cursor:grabbing}#canvas svg{display:block;width:100%;height:100%;user-select:none}.empty{height:100%;display:grid;place-items:center;color:var(--muted)}
#inspector{width:360px;flex:0 0 360px;height:100%;overflow:auto;background:var(--panel);border-left:1px solid var(--line);box-shadow:-3px 0 14px #17203312;padding:18px;display:none;z-index:4}#inspector.open{display:block}.panel-head{display:flex;align-items:flex-start;gap:12px}.panel-head>div{min-width:0;flex:1}.panel-head h2{font-size:18px;line-height:1.25;margin:7px 0 2px;overflow-wrap:anywhere}.badge{display:inline-block;color:#1e40af;background:#dbeafe;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}.id{font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}.close{font-size:18px;line-height:1;padding:6px 9px}dl{margin:22px 0}dt{font-size:12px;color:var(--muted);margin-top:13px}dd{margin:3px 0 0;overflow-wrap:anywhere}details{border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;font-weight:700}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{text-align:left;vertical-align:top;padding:7px 5px;border-bottom:1px solid #edf0f5;overflow-wrap:anywhere;word-break:break-word}th{width:36%;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
.fluig-hit{fill:transparent;stroke:transparent;pointer-events:all;cursor:pointer;vector-effect:non-scaling-stroke}.fluig-hit.flow{fill:none;stroke-width:14}.fluig-hit:focus{outline:none;stroke:#7c3aed;stroke-width:3;stroke-dasharray:5 3}.fluig-hit.selected{stroke:var(--brand);stroke-width:4;stroke-dasharray:none;fill:#2457d619}.fluig-hit.flow.selected{fill:none;stroke-width:6}
@media(max-width:720px){#inspector{position:absolute;right:0;top:0;width:min(360px,92vw);box-shadow:-8px 0 28px #17203333}.status span:last-child{display:none}.title small{max-width:45vw}}
</style></head><body>
<header><div class="brand">fluigctl</div><div class="title"><strong>${titulo}</strong><small>${caminho}</small></div><div class="status"><span id="dot" class="dot"></span><span id="status">carregando…</span></div><button id="fit" type="button" title="Ajustar o diagrama à janela">Ajustar</button></header>
<div id="error" class="banner" role="alert"></div><div id="notice" class="banner" role="status"></div>
<div id="workspace"><main id="canvas"><div class="empty">Carregando diagrama…</div></main><aside id="inspector" aria-label="Propriedades do elemento"><div class="panel-head"><div><span id="kind" class="badge"></span><h2 id="element-name"></h2><div id="element-id" class="id"></div></div><button id="close-panel" class="close" type="button" aria-label="Fechar propriedades">×</button></div><dl id="fields"></dl><details><summary>Detalhes técnicos</summary><table><tbody id="technical"></tbody></table></details></aside></div>
<script>
const NS='http://www.w3.org/2000/svg';
const canvas=document.querySelector('#canvas'), status=document.querySelector('#status'), dot=document.querySelector('#dot'), error=document.querySelector('#error'), notice=document.querySelector('#notice'), inspector=document.querySelector('#inspector');
let svg, original, box, drag, elements=[], selectedId, noticeTimer;
function dimensions(el){const w=Number(el.getAttribute('width'))||1000,h=Number(el.getAttribute('height'))||700;return {x:0,y:0,w,h}}
function apply(){if(svg&&box)svg.setAttribute('viewBox',box.x+' '+box.y+' '+box.w+' '+box.h)}
function fit(){if(svg){box={...original};apply()}}
document.querySelector('#fit').addEventListener('click',fit);
canvas.addEventListener('wheel',e=>{if(!svg)return;e.preventDefault();const r=svg.getBoundingClientRect(),px=box.x+(e.clientX-r.left)/r.width*box.w,py=box.y+(e.clientY-r.top)/r.height*box.h,f=e.deltaY>0?1.12:.89,nw=box.w*f,nh=box.h*f;box={x:px-(px-box.x)*f,y:py-(py-box.y)*f,w:nw,h:nh};apply()},{passive:false});
canvas.addEventListener('pointerdown',e=>{if(!svg||e.button!==0)return;const hit=e.target.closest?.('.fluig-hit');canvas.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY,box:{...box},hitId:hit?.dataset.id,moved:false};canvas.classList.add('drag')});
canvas.addEventListener('pointermove',e=>{if(!drag||!svg)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>3)drag.moved=true;if(!drag.moved)return;const r=svg.getBoundingClientRect();box={...drag.box,x:drag.box.x-dx/r.width*drag.box.w,y:drag.box.y-dy/r.height*drag.box.h};apply()});
canvas.addEventListener('pointerup',()=>{if(!drag)return;if(!drag.moved){if(drag.hitId)select(drag.hitId);else clearSelection()}drag=undefined;canvas.classList.remove('drag')});
canvas.addEventListener('pointercancel',()=>{drag=undefined;canvas.classList.remove('drag')});
function flash(text){clearTimeout(noticeTimer);notice.textContent=text;notice.classList.add('show');noticeTimer=setTimeout(()=>notice.classList.remove('show'),2800)}
function clearSelection(){selectedId=undefined;inspector.classList.remove('open');svg?.querySelectorAll('.fluig-hit.selected').forEach(x=>x.classList.remove('selected'))}
function text(el,value){el.textContent=value}
function renderPanel(element){
  text(document.querySelector('#kind'),element.tipoAmigavel);text(document.querySelector('#element-name'),element.nome||'Sem nome');text(document.querySelector('#element-id'),element.id);
  const fields=document.querySelector('#fields');fields.replaceChildren();
  for(const field of element.campos.filter(x=>x.rotulo!=='Nome')){const dt=document.createElement('dt'),dd=document.createElement('dd');text(dt,field.rotulo);text(dd,field.valor);fields.append(dt,dd)}
  const technical=document.querySelector('#technical');technical.replaceChildren();
  for(const [key,value] of Object.entries(element.atributos).sort(([a],[b])=>a.localeCompare(b))){const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');text(th,key);text(td,value);tr.append(th,td);technical.append(tr)}
  inspector.classList.add('open');
}
function select(id){const element=elements.find(x=>x.id===id);if(!element)return;selectedId=id;svg.querySelectorAll('.fluig-hit').forEach(x=>x.classList.toggle('selected',x.dataset.id===id));renderPanel(element)}
function shape(tag,element){const node=document.createElementNS(NS,tag);node.classList.add('fluig-hit');node.dataset.id=element.id;node.setAttribute('tabindex','0');node.setAttribute('role','button');node.setAttribute('aria-label',(element.nome||'Sem nome')+', '+element.tipoAmigavel);return node}
function addInteractions(){
  const layer=document.createElementNS(NS,'g');layer.setAttribute('data-layer','interaction');
  const byArea=(a,b)=>{const ca=a.geometria.caixa,cb=b.geometria.caixa;return cb.largura*cb.altura-ca.largura*ca.altura};
  const flows=elements.filter(x=>x.geometria.pontos), allBoxes=elements.filter(x=>x.geometria.caixa), containers=allBoxes.filter(x=>x.tipo==='BpmnPool'||x.tipo==='BpmnSwimLane').sort(byArea), boxes=allBoxes.filter(x=>x.tipo!=='BpmnPool'&&x.tipo!=='BpmnSwimLane').sort(byArea);
  function appendBox(element){const c=element.geometria.caixa;let node;if(element.tipo==='BpmnGateway'){node=shape('polygon',element);node.setAttribute('points',c.x+','+(c.y+c.altura/2)+' '+(c.x+c.largura/2)+','+c.y+' '+(c.x+c.largura)+','+(c.y+c.altura/2)+' '+(c.x+c.largura/2)+','+(c.y+c.altura))}else if(/Event$/.test(element.tipo)){node=shape('ellipse',element);node.setAttribute('cx',c.x+c.largura/2);node.setAttribute('cy',c.y+c.altura/2);node.setAttribute('rx',Math.min(c.largura,c.altura)/2);node.setAttribute('ry',Math.min(c.largura,c.altura)/2)}else{node=shape('rect',element);node.setAttribute('x',c.x);node.setAttribute('y',c.y);node.setAttribute('width',c.largura);node.setAttribute('height',c.altura);node.setAttribute('rx','4')}layer.append(node)}
  // Containers embaixo; fluxos sobre eles; nós por cima dos fluxos. Assim uma
  // raia não engole o clique na linha, e a linha não engole o clique na tarefa.
  containers.forEach(appendBox);
  for(const element of flows){const p=shape('path',element);p.classList.add('flow');p.setAttribute('d',element.geometria.pontos.map((x,i)=>(i?'L':'M')+x.x+' '+x.y).join(' '));layer.append(p)}
  boxes.forEach(appendBox);
  layer.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('.fluig-hit')){e.preventDefault();select(e.target.dataset.id)}});
  svg.append(layer);if(selectedId)select(selectedId);
}
document.querySelector('#close-panel').addEventListener('click',clearSelection);document.addEventListener('keydown',e=>{if(e.key==='Escape')clearSelection()});
async function update(){try{const r=await fetch('state',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const s=await r.json();elements=s.elementos||[];if(!svg||Number(svg.dataset.revision)!==s.revisao){const anterior=box,selectionBefore=selectedId;canvas.innerHTML=s.svg;svg=canvas.querySelector('svg');svg.dataset.revision=String(s.revisao);original=dimensions(svg);box=anterior||{...original};addInteractions();apply();if(selectionBefore&&!elements.some(x=>x.id===selectionBefore)){clearSelection();flash('O elemento selecionado foi removido.')}else if(selectionBefore)select(selectionBefore)}const when=new Date(s.atualizadoEm);status.textContent='atualizado às '+when.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});error.textContent=s.erro||'';error.classList.toggle('show',Boolean(s.erro));dot.classList.toggle('bad',Boolean(s.erro))}catch(e){status.textContent='sem conexão';error.textContent='O visualizador perdeu a conexão com o fluigctl.';error.classList.add('show');dot.classList.add('bad')}}
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
      const renderizado = renderizar(texto);
      ultimoTexto = texto;
      estado = {
        arquivo: estado.arquivo,
        nome: estado.nome,
        svg: renderizado.svg,
        elementos: renderizado.elementos,
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
  // Observar o diretório cobre escrita direta, rename atômico, remoção e
  // recriação. Diferente de watchFile, a inscrição já está ativa ao retornar.
  const watcher = watch(dirname(arquivo), { persistent: true }, (_evento, nome) => {
    if (nome === null || nome.toString() === basename(arquivo)) reler();
  });

  const fechar = async () => {
    watcher.close();
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
