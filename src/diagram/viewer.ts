import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { ErroFluigctl } from '../errors.js';
import { lerDiagrama, type Diagrama, type Ponto } from '../push/diagram/modelo.js';
import { gerarSvg, pontosDoFluxo } from '../push/diagram/svg.js';
import { adicionarNoXml, ligarNoXml, scriptsDasCriadas, type TipoNovo } from './add.js';
import { rotaOrtogonal } from './route.js';
import { ConflitoEdicao, EdicaoInvalida, aplicarEdicao, desfazerUltimaEdicao, endireitar, hash, moverElemento, refazerEdicao, renomearElemento, trocarDobras, trocarDobrasNoXml } from './edit.js';
import {
  MECANISMOS,
  lerAtribuicao,
  lerCondicoes,
  tornarAutomaticaNoXml,
  trocarAtribuicaoNoXml,
  trocarCondicoesNoXml,
  type Atribuicao,
  type Condicao,
  type CondicoesGateway,
} from './props.js';

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
  podeRenomear: boolean;
  /** Forma solta no diagrama (não pool nem raia): o modo de edição a arrasta. */
  podeMover: boolean;
  /** Eventos de erro presos a esta tarefa: andam junto quando ela se move. */
  anexados: string[];
  /** Dobras gravadas do fluxo (sem as pontas): o modo de edição as arrasta. */
  dobras?: Ponto[];
  /** Quantos fluxos entram ou saem: o "endireitar ligações" só aparece com ligação. */
  ligacoes: number;
  /** O que o painel edita no modo de edição. */
  propriedades?: Propriedades;
  geometria: GeometriaElemento;
}

export interface Saida {
  fluxo: string;
  destino: string;
  nomeDestino: string;
  rotulo: string;
}

export interface Propriedades {
  /** Service task: o executionType gravado. */
  execucao?: string;
  /** Tarefa humana. */
  atribuicao?: Atribuicao;
  /** Gateway: as condições e as saídas a que elas podem apontar. */
  condicoes?: CondicoesGateway;
  saidas?: Saida[];
}

export interface EstadoVisualizador {
  arquivo: string;
  nome: string;
  svg: string;
  elementos: ElementoVisual[];
  atualizadoEm: string;
  erro?: string;
  revisao: number;
  /** Hash do texto desenhado: a edição só vale sobre o que a tela mostra. */
  hash: string;
  /** Sugestões para o painel: atividades (Executor Atividade), mecanismos customizados e grupos já usados. */
  sugestoes: Sugestoes;
}

export interface Sugestoes {
  atividades: { id: string; nome: string }[];
  mecanismos: string[];
  grupos: string[];
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

    let propriedades: Propriedades | undefined;
    const nomeDe = (alvo: string | undefined) => diagrama.objetos.find((o) => o.attrs['id'] === alvo)?.attrs['name'] || alvo || '';
    if (objeto.tipo === 'BpmnTask' && objeto.attrs['type'] === '82') {
      propriedades = { execucao: objeto.attrs['executionType'] ?? '' };
      candidatos.push(campo('Execução', objeto.attrs['executionType'] === '1' ? 'Automática' : `executionType ${objeto.attrs['executionType'] ?? 'ausente'} (fora do padrão)`));
    }
    if (objeto.tipo === 'BpmnTask' && objeto.attrs['type'] === '80') {
      const atribuicao = lerAtribuicao(objeto);
      propriedades = { atribuicao };
      const detalhe = Object.entries(atribuicao.campos)
        .map(([k, v]) => (k === 'idNode' ? nomeDe(v) : k === 'returns' ? ({ '0': 'primeiro executor', '1': 'último executor', '2': 'todos' })[v] ?? v : v))
        .filter(Boolean)
        .join(', ');
      if (detalhe) candidatos.push(campo('Atribuído a', detalhe));
    }
    if (objeto.tipo === 'BpmnGateway') {
      const saidas: Saida[] = diagrama.objetos
        .filter((f) => f.tipo === 'SequenceFlow' && f.attrs['sourceRef'] === id)
        .map((f) => ({ fluxo: f.attrs['id'] ?? '', destino: f.attrs['targetRef'] ?? '', nomeDestino: nomeDe(f.attrs['targetRef']), rotulo: f.attrs['name'] ?? '' }));
      const condicoes = lerCondicoes(objeto);
      propriedades = { condicoes, saidas };
      const operador = (o: string) => ({ '1': '=', '2': '≠' })[o] ?? `operador ${o}`;
      for (const c of condicoes.condicoes) {
        const regra = c.tipo === 'regra' ? c.regras.map((r) => `${r.campo} ${operador(r.operador)} "${r.valor}"`).join(' e ') : c.expressao;
        candidatos.push(campo(`Para ${nomeDe(c.destino)}`, regra));
      }
    }

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
      podeRenomear: Object.prototype.hasOwnProperty.call(objeto.attrs, 'name'),
      podeMover: Boolean(caixa && caixa.pai === undefined && objeto.tipo !== 'BpmnPool' && objeto.tipo !== 'BpmnSwimLane'),
      anexados: diagrama.objetos
        .filter((o) => o.tipo === 'BpmnIntermediateEvent' && o.attrs['parentTask'] === id && o.attrs['id'])
        .map((o) => o.attrs['id']!),
      ...(ehFluxo ? { dobras: diagrama.dobras.get(id) ?? [] } : {}),
      ...(propriedades ? { propriedades } : {}),
      ligacoes: diagrama.objetos.filter((o) => o.tipo === 'SequenceFlow' && (o.attrs['sourceRef'] === id || o.attrs['targetRef'] === id)).length,
      geometria,
    });
  }
  return elementos;
}

/** Mecanismos customizados do workspace: os `.js` de `mechanisms/` ao lado de `workflow/`. */
function mecanismosDoWorkspace(arquivo: string): string[] {
  let dir = dirname(resolve(arquivo));
  for (let i = 0; i < 5; i++) {
    const pasta = join(dir, 'mechanisms');
    if (existsSync(pasta) && existsSync(join(dir, 'workflow'))) {
      try {
        return readdirSync(pasta).filter((n) => n.endsWith('.js')).map((n) => n.slice(0, -3));
      } catch {
        return [];
      }
    }
    const pai = dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }
  return [];
}

export function sugestoesDoDiagrama(diagrama: Diagrama, arquivo: string): Sugestoes {
  const atividades = diagrama.objetos
    .filter((o) => (o.tipo === 'BpmnTask' && o.attrs['type'] === '80') || o.tipo === 'BpmnStartEvent')
    .map((o) => ({ id: o.attrs['id'] ?? '', nome: o.attrs['name'] ?? '' }))
    .filter((a) => a.id);
  const usados = diagrama.objetos.filter((o) => o.tipo === 'BpmnTask').map(lerAtribuicao);
  const mecanismos = [...new Set([...mecanismosDoWorkspace(arquivo), ...usados.filter((a) => a.customizado).map((a) => a.mecanismo)])].sort();
  const grupos = [...new Set(usados.flatMap((a) => (a.campos['groupId'] ? [a.campos['groupId']] : [])).concat('suporte_processos'))].sort();
  return { atividades, mecanismos, grupos };
}

function renderizar(texto: string, arquivo: string): { svg: string; elementos: ElementoVisual[]; sugestoes: Sugestoes } {
  const diagrama = lerDiagrama(texto);
  return { svg: gerarSvg(diagrama), elementos: elementosDoDiagrama(diagrama), sugestoes: sugestoesDoDiagrama(diagrama, arquivo) };
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
    const renderizado = renderizar(texto, arquivo);
    return {
      arquivo,
      nome: basename(arquivo, '.process'),
      svg: renderizado.svg,
      elementos: renderizado.elementos,
      atualizadoEm: new Date().toISOString(),
      revisao: 1,
      hash: hash(texto),
      sugestoes: renderizado.sugestoes,
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

async function lerJson(req: IncomingMessage): Promise<unknown> {
  const tipo = req.headers['content-type'] ?? '';
  if (!tipo.toLowerCase().startsWith('application/json')) throw new EdicaoInvalida('a edição exige Content-Type application/json');
  const partes: Buffer[] = [];
  let tamanho = 0;
  for await (const parte of req) {
    const buffer = Buffer.isBuffer(parte) ? parte : Buffer.from(parte);
    tamanho += buffer.length;
    if (tamanho > 64 * 1024) throw new EdicaoInvalida('pedido de edição maior que 64 KiB');
    partes.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8')) as unknown;
  } catch {
    throw new EdicaoInvalida('pedido de edição não é JSON válido');
  }
}

/** O token basta contra outras abas, mas escrita também confere a origem. */
function origemLocal(req: IncomingMessage, porta: number): boolean {
  if ((req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false;
  const origem = req.headers['origin'];
  if (origem === undefined) return true; // fetch same-origin sem Origin em alguns navegadores
  try {
    const u = new URL(origem);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(porta) && u.protocol === 'http:';
  } catch {
    return false;
  }
}

function respostaJson(res: ServerResponse, status: number, corpo: unknown): void {
  responder(res, status, 'application/json', JSON.stringify(corpo));
}

async function tratarEdicao(
  req: IncomingMessage,
  res: ServerResponse,
  rota: string,
  arquivo: string,
  undoDir: string,
  porta: number,
): Promise<void> {
  if (!origemLocal(req, porta)) {
    respostaJson(res, 403, { ok: false, mensagem: 'edição recusada: a origem do pedido não é esta página' });
    return;
  }
  try {
    const corpo = (await lerJson(req)) as Record<string, unknown>;
    const texto = (chave: string): string => {
      const valor = corpo[chave];
      if (typeof valor !== 'string') throw new EdicaoInvalida(`o campo ${chave} é obrigatório`);
      return valor;
    };
    if (rota === 'rename') {
      const resultado = renomearElemento({
        arquivo,
        id: texto('id'),
        nomeOriginal: texto('nomeOriginal'),
        nomeNovo: texto('nomeNovo'),
        undoDir,
      });
      respostaJson(res, 200, { ok: true, nome: resultado.nome, avisos: resultado.avisos });
      return;
    }
    if (rota === 'move') {
      const numero = (chave: string): number => {
        const valor = corpo[chave];
        if (typeof valor !== 'number') throw new EdicaoInvalida(`o campo ${chave} é obrigatório`);
        return valor;
      };
      const resultado = moverElemento({ arquivo, id: texto('id'), dx: numero('dx'), dy: numero('dy'), hashBase: texto('hash'), undoDir });
      respostaJson(res, 200, {
        ok: true,
        movidos: resultado.movidos,
        avisos: resultado.avisos,
        ...(resultado.raiaAntes === resultado.raiaDepois ? {} : { raiaAntes: resultado.raiaAntes, raiaDepois: resultado.raiaDepois }),
      });
      return;
    }
    if (rota === 'bends') {
      const pontos = corpo['pontos'];
      if (!Array.isArray(pontos)) throw new EdicaoInvalida('o campo pontos é obrigatório');
      const resultado = trocarDobras({ arquivo, id: texto('id'), pontos: pontos as Ponto[], hashBase: texto('hash'), undoDir });
      respostaJson(res, 200, { ok: true, avisos: resultado.avisos });
      return;
    }
    if (rota === 'straighten-all') {
      const resultado = endireitar({ arquivo, hashBase: texto('hash'), undoDir });
      respostaJson(res, 200, { ok: true, fluxos: resultado.fluxos, avisos: resultado.avisos });
      return;
    }
    if (rota === 'straighten') {
      const resultado = endireitar({ arquivo, id: texto('id'), hashBase: texto('hash'), undoDir });
      respostaJson(res, 200, { ok: true, fluxos: resultado.fluxos, avisos: resultado.avisos });
      return;
    }
    if (rota === 'add') {
      const numero = (chave: string): number => {
        const valor = corpo[chave];
        if (typeof valor !== 'number') throw new EdicaoInvalida(`o campo ${chave} é obrigatório`);
        return valor;
      };
      const tipo = texto('tipo') as TipoNovo;
      const x = numero('x');
      const y = numero('y');
      const nome = typeof corpo['nome'] === 'string' ? corpo['nome'] : undefined;
      const grupo = typeof corpo['grupo'] === 'string' ? corpo['grupo'] : undefined;
      let criados: string[] = [];
      let xmlNovo = '';
      const r = aplicarEdicao(arquivo, undoDir, (t) => {
        const feito = adicionarNoXml(t, { tipo, x, y, ...(nome === undefined ? {} : { nome }), ...(grupo === undefined ? {} : { grupo }) });
        criados = feito.criados;
        xmlNovo = feito.xml;
        return feito.xml;
      }, texto('hash'), () => scriptsDasCriadas(arquivo, xmlNovo, criados));
      const relativo = (c: string) => c.slice(dirname(dirname(dirname(arquivo))).length + 1);
      respostaJson(res, 200, {
        ok: true,
        criados,
        avisos: r.avisos,
        scripts: (r.criados ?? []).map(relativo),
        scriptsExistentes: (r.existentes ?? []).map(relativo),
      });
      return;
    }
    if (rota === 'connect') {
      const origem = texto('origem');
      const destino = texto('destino');
      let id = '';
      const r = aplicarEdicao(arquivo, undoDir, (t) => {
        const feito = ligarNoXml(t, origem, destino);
        id = feito.id;
        // A ligação nova já nasce traçada pela receita.
        return trocarDobrasNoXml(feito.xml, feito.id, rotaOrtogonal(lerDiagrama(feito.xml), feito.id));
      }, texto('hash'));
      const tipoOrigem = lerDiagrama(readFileSync(arquivo, 'utf8')).objetos.find((o) => o.attrs['id'] === origem)?.tipo;
      respostaJson(res, 200, { ok: true, criados: [id], avisos: r.avisos, deGateway: tipoOrigem === 'BpmnGateway' });
      return;
    }
    if (rota === 'execution') {
      const id = texto('id');
      const r = aplicarEdicao(arquivo, undoDir, (t) => tornarAutomaticaNoXml(t, id), texto('hash'));
      respostaJson(res, 200, { ok: true, avisos: r.avisos });
      return;
    }
    if (rota === 'assignment') {
      const id = texto('id');
      const mecanismo = texto('mecanismo');
      const campos = corpo['campos'];
      if (typeof campos !== 'object' || campos === null || Array.isArray(campos)) throw new EdicaoInvalida('o campo campos é obrigatório');
      const limpos: Record<string, string> = {};
      for (const [k, v] of Object.entries(campos)) {
        if (typeof v !== 'string') throw new EdicaoInvalida(`campo ${k} inválido`);
        limpos[k] = v;
      }
      const customizado = corpo['customizado'] === true;
      const r = aplicarEdicao(arquivo, undoDir, (t) => trocarAtribuicaoNoXml(t, id, { mecanismo, customizado, campos: limpos }), texto('hash'));
      respostaJson(res, 200, { ok: true, avisos: r.avisos });
      return;
    }
    if (rota === 'conditions') {
      const id = texto('id');
      const condicoes = corpo['condicoes'];
      if (!Array.isArray(condicoes)) throw new EdicaoInvalida('o campo condicoes é obrigatório');
      const r = aplicarEdicao(arquivo, undoDir, (t) => trocarCondicoesNoXml(t, id, condicoes as Condicao[]), texto('hash'));
      respostaJson(res, 200, { ok: true, avisos: r.avisos });
      return;
    }
    if (rota === 'undo') {
      const r = desfazerUltimaEdicao(arquivo, undoDir);
      respostaJson(res, 200, { ok: true, ...(r.apagados ? { apagados: r.apagados.map((c) => basename(c)), mantidos: (r.mantidos ?? []).map((c) => basename(c)) } : {}) });
      return;
    }
    if (rota === 'redo') {
      const r = refazerEdicao(arquivo, undoDir);
      respostaJson(res, 200, { ok: true, ...(r.recriados ? { recriados: r.recriados.map((c) => basename(c)) } : {}) });
      return;
    }
    respostaJson(res, 404, { ok: false, mensagem: 'não encontrado' });
  } catch (erro) {
    if (erro instanceof ConflitoEdicao) {
      respostaJson(res, 409, {
        ok: false,
        motivo: erro.motivo,
        mensagem: erro.message,
        ...(erro.atual === undefined ? {} : { atual: erro.atual }),
      });
      return;
    }
    if (erro instanceof EdicaoInvalida) {
      respostaJson(res, 400, { ok: false, motivo: 'invalido', mensagem: erro.message });
      return;
    }
    respostaJson(res, 500, { ok: false, motivo: 'erro', mensagem: mensagem(erro) });
  }
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
.name-form{margin:20px 0 0;border-top:1px solid var(--line);padding-top:14px}.name-form label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
#name-input{width:100%;padding:8px 10px;border:1px solid #c3cddd;border-radius:8px;font:14px system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:#fff}
#name-input:focus{outline:3px solid #93b4ff;outline-offset:1px;border-color:var(--brand)}.name-form .row{display:flex;align-items:center;gap:8px;margin-top:9px}
.dirty{font-size:12px;color:#b45309;font-weight:700;margin-left:auto}.hint{font-size:12px;color:var(--muted);margin:9px 0 0}
.conflict{margin-top:12px;padding:11px 12px;border:1px solid #fca5a5;background:#fef2f2;border-radius:9px;color:#991b1b;font-size:13px}
.conflict dl{margin:8px 0 0}.conflict dt{color:#b91c1c}.conflict .row{display:flex;gap:8px;margin-top:11px}
#notice .row{display:flex;align-items:center;gap:10px;justify-content:space-between}#notice button{padding:4px 9px}
#add-menu{border:1px solid var(--brand);color:var(--brand);background:#fff;border-radius:8px;padding:6px 8px;font:inherit;font-weight:600;cursor:pointer}body.colocando #canvas{cursor:crosshair}body.colocando .fluig-hit{cursor:crosshair}
.save{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap;padding:4px 9px;border-radius:999px;border:1px solid transparent}
.save::before{content:"";width:8px;height:8px;border-radius:50%;background:#94a3b8}.save.ok{color:#15803d;background:#f0fdf4;border-color:#bbf7d0}.save.ok::before{background:#16a34a}
.save.busy{color:#1e40af;background:#eff6ff}.save.busy::before{background:transparent;border:2px solid #93c5fd;border-top-color:#1d4ed8;width:6px;height:6px;animation:gira .7s linear infinite}
.save.pending{color:#b45309;background:#fffbeb;border-color:#fde68a}.save.pending::before{background:#f59e0b}.save.err{color:#b91c1c;background:#fef2f2;border-color:#fecaca}.save.err::before{background:#dc2626}
.save.pulso{animation:pulso .9s ease-out}@keyframes gira{to{transform:rotate(360deg)}}@keyframes pulso{0%{box-shadow:0 0 0 0 #16a34a66}100%{box-shadow:0 0 0 10px #16a34a00}}
.edit-toggle[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:#fff}.edit-toggle[aria-pressed="true"]:hover{background:#1d47b3}
#edit-tools{display:flex;gap:6px}#edit-tools[hidden]{display:none}.mode{font-size:12px;font-weight:700;color:#1e40af;background:#dbeafe;border-radius:999px;padding:4px 9px;white-space:nowrap}
body.editing #canvas{background-color:#f3f6ff}body.editing .fluig-hit.movable{cursor:move}.fluig-hit.moving{fill:#2457d61f;stroke:var(--brand);stroke-width:2;stroke-dasharray:6 4;pointer-events:none}
.fluig-hit.flow.moving{fill:none;stroke-width:3}.conector{fill:var(--brand);stroke:#fff;stroke-width:2;cursor:crosshair;vector-effect:non-scaling-stroke}.conector:hover{fill:#1d47b3}.previa-ligacao{stroke:var(--brand);stroke-width:2;stroke-dasharray:6 4;fill:none;pointer-events:none;vector-effect:non-scaling-stroke}
.handle{fill:#fff;stroke:var(--brand);stroke-width:2;cursor:move;vector-effect:non-scaling-stroke}.handle:hover{fill:#dbeafe}
#edit-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}#edit-actions[hidden]{display:none}
.props{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}.props[hidden]{display:none}.props h3{font-size:13px;margin:12px 0 8px}.props label{display:block;font-size:12px;color:var(--muted);margin:9px 0 4px}
.props input,.props select,.props textarea{width:100%;padding:7px 9px;border:1px solid #c3cddd;border-radius:8px;font:13px system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:#fff}.props textarea{min-height:64px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.props .row{display:flex;gap:8px;align-items:center;margin-top:10px}.cond{border:1px solid var(--line);border-radius:9px;padding:9px 10px;margin-top:10px}.cond strong{display:block;font-size:13px}.regra{display:grid;grid-template-columns:104px 1fr auto;gap:6px;margin-top:8px}.regra input:first-child{grid-column:1/-1}.regra button{padding:5px 8px}.note{font-size:12px;color:var(--muted);margin:6px 0 0}.warn{color:var(--warn)}
@media(max-width:720px){#inspector{position:absolute;right:0;top:0;width:min(360px,92vw);box-shadow:-8px 0 28px #17203333}.status span:last-child{display:none}.title small{max-width:45vw}}
</style></head><body>
<header><div class="brand">fluigctl</div><div class="title"><strong>${titulo}</strong><small>${caminho}</small></div><div class="status"><span id="dot" class="dot"></span><span id="status">carregando…</span></div><span id="edit-tools" hidden><span class="mode">Modo de edição</span><span id="save-state" class="save" role="status" aria-live="polite" title="As edições são gravadas no .process assim que você as faz">Tudo salvo</span><select id="add-menu" aria-label="Adicionar elemento" title="Escolha o tipo e clique no diagrama onde ele vai ficar"><option value="">+ Adicionar…</option><option value="humana">Tarefa humana</option><option value="recuperacao">Service task com recuperação</option><option value="servico">Service task sozinha</option><option value="gateway">Gateway</option><option value="fim">Fim</option></select><button id="straighten-all" type="button" title="Traça todas as ligações do diagrama em ângulos retos, pela receita de layout (desfaz numa vez só)">Endireitar todas</button><button id="undo" type="button" title="Desfazer (Ctrl+Z)">Desfazer</button><button id="redo" type="button" title="Refazer (Ctrl+Shift+Z)">Refazer</button></span><button id="edit-toggle" class="edit-toggle" type="button" aria-pressed="false" title="Ligar o modo de edição">Editar</button><button id="fit" type="button" title="Ajustar o diagrama à janela">Ajustar</button></header>
<div id="error" class="banner" role="alert"></div><div id="notice" class="banner" role="status"></div>
<div id="workspace"><main id="canvas"><div class="empty">Carregando diagrama…</div></main><aside id="inspector" aria-label="Propriedades do elemento"><div class="panel-head"><div><span id="kind" class="badge"></span><h2 id="element-name"></h2><div id="element-id" class="id"></div></div><button id="close-panel" class="close" type="button" aria-label="Fechar propriedades">×</button></div>
<form id="name-form" class="name-form" hidden><label for="name-input">Nome</label><input id="name-input" type="text" autocomplete="off" spellcheck="false" maxlength="200"><div class="row"><button id="save-name" type="submit">Salvar</button><button id="cancel-name" type="button">Cancelar</button><span id="dirty" class="dirty" hidden>Alteração não salva</span></div><p class="hint">Vazio deixa o elemento <strong>Sem nome</strong>. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> salva.</p></form>
<p id="move-hint" class="hint" hidden>Arraste no diagrama para mover, ou use as setas (10 px; com <kbd>Shift</kbd>, 50 px). Os eventos de erro presos à tarefa vão junto.</p>
<div id="edit-actions" hidden></div>
<section id="props" class="props" hidden></section>
<div id="conflict" class="conflict" role="alert" hidden></div>
<dl id="fields"></dl><details><summary>Detalhes técnicos</summary><table><tbody id="technical"></tbody></table></details></aside></div>
<script>
const NS='http://www.w3.org/2000/svg';
const canvas=document.querySelector('#canvas'), status=document.querySelector('#status'), dot=document.querySelector('#dot'), error=document.querySelector('#error'), notice=document.querySelector('#notice'), inspector=document.querySelector('#inspector');
const form=document.querySelector('#name-form'), input=document.querySelector('#name-input'), dirty=document.querySelector('#dirty'), conflict=document.querySelector('#conflict');
let svg, original, box, drag, elements=[], selectedId, editando, noticeTimer, editMode=false, hashAtual, ocupado=false;
const moveHint=document.querySelector('#move-hint'), editTools=document.querySelector('#edit-tools'), editToggle=document.querySelector('#edit-toggle');
function setEditMode(on){if(!on&&typeof pararDeColocar==='function'){pararDeColocar();pararDeLigar()}editMode=on;document.body.classList.toggle('editing',on);editToggle.setAttribute('aria-pressed',String(on));editToggle.textContent=on?'Sair da edição':'Editar';editToggle.title=on?'Voltar ao modo somente leitura':'Ligar o modo de edição';editTools.hidden=!on;try{localStorage.setItem('fluigctl-edicao',on?'1':'0')}catch{}if(!on&&editando&&sujo())cancelarEdicao();if(selectedId)select(selectedId)}
editToggle.addEventListener('click',()=>setEditMode(!editMode));
function dimensions(el){const w=Number(el.getAttribute('width'))||1000,h=Number(el.getAttribute('height'))||700;return {x:0,y:0,w,h}}
function apply(){if(svg&&box)svg.setAttribute('viewBox',box.x+' '+box.y+' '+box.w+' '+box.h)}
function fit(){if(svg){box={...original};apply()}}
document.querySelector('#fit').addEventListener('click',fit);
canvas.addEventListener('wheel',e=>{if(!svg)return;e.preventDefault();const r=svg.getBoundingClientRect(),px=box.x+(e.clientX-r.left)/r.width*box.w,py=box.y+(e.clientY-r.top)/r.height*box.h,f=e.deltaY>0?1.12:.89,nw=box.w*f,nh=box.h*f;box={x:px-(px-box.x)*f,y:py-(py-box.y)*f,w:nw,h:nh};apply()},{passive:false});
// Pixels da tela para unidades do diagrama (o SVG usa preserveAspectRatio meet).
function escala(){const r=svg.getBoundingClientRect();return Math.max(box.w/r.width,box.h/r.height)}
function hitsDe(ids){return [...svg.querySelectorAll('.fluig-hit')].filter(n=>ids.includes(n.dataset.id))}
function soltarPrevia(){svg?.querySelectorAll('.fluig-hit.moving').forEach(n=>{n.classList.remove('moving');n.removeAttribute('transform')})}
canvas.addEventListener('pointerdown',e=>{if(!svg||e.button!==0)return;if(editMode&&colocando){e.preventDefault();void colocarEm(e);return}
  if(editMode&&ligando){e.preventDefault();const alvo=alvoSob(e),origem=ligando.origem;pararDeLigar();if(!alvo||alvo.id===origem){flash('Ligação cancelada: clique numa tarefa, evento ou gateway diferente da origem.');return}void ligar(origem,alvo.id);return}
  if(editMode&&e.target.closest?.('.conector')&&!ocupado){const el=elements.find(x=>x.id===selectedId);if(el){canvas.setPointerCapture(e.pointerId);const c=el.geometria.caixa;const linha=document.createElementNS(NS,'line');linha.classList.add('previa-ligacao');const cx=c.x+c.largura/2,cy=c.y+(el.tipo==='BpmnGateway'?Math.min(c.largura,c.altura):c.altura)/2;linha.setAttribute('x1',cx);linha.setAttribute('y1',cy);linha.setAttribute('x2',cx);linha.setAttribute('y2',cy);svg.append(linha);drag={modo:'ligar',origem:el.id,linha,x:e.clientX,y:e.clientY,moved:false};return}}const hit=e.target.closest?.('.fluig-hit');const el=hit&&elements.find(x=>x.id===hit.dataset.id);canvas.setPointerCapture(e.pointerId);
  const alca=e.target.closest?.('.handle');
  if(editMode&&alca&&!ocupado){const fl=elements.find(x=>x.id===selectedId);if(fl&&fl.dobras){drag={modo:'dobra',x:e.clientX,y:e.clientY,el:fl,indice:Number(alca.dataset.indice),dobras:fl.dobras.map(p=>({...p})),moved:false};return}}
  if(editMode&&el&&el.podeMover&&!ocupado){drag={modo:'mover',x:e.clientX,y:e.clientY,hitId:el.id,ids:[el.id,...el.anexados],moved:false,dx:0,dy:0};return}
  drag={modo:'pan',x:e.clientX,y:e.clientY,box:{...box},hitId:hit?.dataset.id,moved:false};canvas.classList.add('drag')});
let lastPointer={clientX:0,clientY:0};
canvas.addEventListener('pointermove',e=>{lastPointer={clientX:e.clientX,clientY:e.clientY};if(!drag||!svg)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>3)drag.moved=true;if(!drag.moved)return;
  if(drag.modo==='ligar'){const q=pontoDoDiagrama(e);drag.linha.setAttribute('x2',q.x);drag.linha.setAttribute('y2',q.y);return}
  if(drag.modo==='dobra'){const q=pontoDoDiagrama(e);drag.dobras[drag.indice]={x:grade(q.x),y:grade(q.y)};const a=svg.querySelector('.handle[data-indice="'+drag.indice+'"]');if(a){a.setAttribute('x',drag.dobras[drag.indice].x-5);a.setAttribute('y',drag.dobras[drag.indice].y-5)}previaDoFluxo(drag.el,drag.dobras);return}
  if(drag.modo==='mover'){const k=escala();drag.dx=Math.round(dx*k/10)*10;drag.dy=Math.round(dy*k/10)*10;for(const n of hitsDe(drag.ids)){n.classList.add('moving');n.setAttribute('transform','translate('+drag.dx+' '+drag.dy+')')}return}
  const r=svg.getBoundingClientRect();box={...drag.box,x:drag.box.x-dx/r.width*drag.box.w,y:drag.box.y-dy/r.height*drag.box.h};apply()});
canvas.addEventListener('pointerup',()=>{if(!drag)return;const d=drag;drag=undefined;canvas.classList.remove('drag');
  if(d.modo==='mover'&&d.moved&&(d.dx||d.dy)){void moverPara(d.hitId,d.dx,d.dy);return}
  if(d.modo==='dobra'){if(d.moved)void gravarDobras(d.el.id,d.dobras);return}
  if(d.modo==='ligar'){d.linha.remove();const alvo=alvoSob(lastPointer);if(!d.moved)return;if(!alvo||alvo.id===d.origem){flash('Solte a ligação sobre uma tarefa, evento ou gateway.');return}void ligar(d.origem,alvo.id);return}
  soltarPrevia();if(!d.moved){if(d.hitId)select(d.hitId);else clearSelection()}});
canvas.addEventListener('pointercancel',()=>{drag=undefined;soltarPrevia();canvas.classList.remove('drag')});
function flash(texto,acao){clearTimeout(noticeTimer);notice.replaceChildren();const span=document.createElement('span');span.textContent=texto;notice.append(span);if(acao){const b=document.createElement('button');b.type='button';b.textContent=acao.rotulo;b.addEventListener('click',acao.aoClicar);const linha=document.createElement('span');linha.className='row';linha.append(b);notice.append(linha)}notice.classList.add('show');noticeTimer=setTimeout(()=>notice.classList.remove('show'),acao?12000:2800)}
function limparConflito(){conflict.hidden=true;conflict.replaceChildren()}
function clearSelection(){const pb=document.querySelector('#props');delete pb.dataset.sujo;pb.hidden=true;svg?.querySelector('[data-layer=handles]')?.remove();selectedId=undefined;editando=undefined;inspector.classList.remove('open');svg?.querySelectorAll('.fluig-hit.selected').forEach(x=>x.classList.remove('selected'))}
function text(el,value){el.textContent=value}
function sujo(){return Boolean(editando)&&input.value!==editando.baseline}
function atualizarSujo(){dirty.hidden=!sujo();if(editMode)atualizarSelo()}
input.addEventListener('input',()=>{limparConflito();atualizarSujo()});
function renderPanel(element){
  text(document.querySelector('#kind'),element.tipoAmigavel);text(document.querySelector('#element-name'),element.nome||'Sem nome');text(document.querySelector('#element-id'),element.id);
  const fields=document.querySelector('#fields');fields.replaceChildren();
  for(const field of element.campos.filter(x=>x.rotulo!=='Nome')){const dt=document.createElement('dt'),dd=document.createElement('dd');text(dt,field.rotulo);text(dd,field.valor);fields.append(dt,dd)}
  const technical=document.querySelector('#technical');technical.replaceChildren();
  for(const [key,value] of Object.entries(element.atributos).sort(([a],[b])=>a.localeCompare(b))){const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');text(th,key);text(td,value);tr.append(th,td);technical.append(tr)}
  const mesmo=editando?.id===element.id;
  // Outro elemento: o campo começa com o nome dele. Sem isso, o campo vazio parecia "sujo" e nunca era preenchido.
  if(!mesmo){editando=element.podeRenomear?{id:element.id,baseline:element.nome}:undefined;input.value=editando?element.nome:''}
  else if(!sujo())editando.baseline=element.nome;
  if(editando&&editMode){form.hidden=false;if(!sujo())input.value=element.nome;atualizarSujo()}else{form.hidden=true;if(!editando)input.value='';dirty.hidden=true}
  moveHint.hidden=!(editMode&&element.podeMover);
  if(editMode&&element.dobras)moveHint.hidden=false,moveHint.textContent='Arraste os quadrados para mover as dobras. Clique duplo na linha cria uma dobra; clique duplo num quadrado a remove.';
  else moveHint.textContent='Arraste no diagrama para mover, ou use as setas (10 px; com Shift, 50 px). Os eventos de erro presos à tarefa vão junto.';
  renderAcoes(element);
  renderProps(element);
  inspector.classList.add('open');
}
function select(id){const element=elements.find(x=>x.id===id);if(!element)return;selectedId=id;svg.querySelectorAll('.fluig-hit').forEach(x=>x.classList.toggle('selected',x.dataset.id===id));renderPanel(element);desenharAlcas()}
function shape(tag,element){const node=document.createElementNS(NS,tag);node.classList.add('fluig-hit');if(element.podeMover)node.classList.add('movable');node.dataset.id=element.id;node.setAttribute('tabindex','0');node.setAttribute('role','button');node.setAttribute('aria-label',(element.nome||'Sem nome')+', '+element.tipoAmigavel);return node}
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
// Toda escrita grava no .process na hora. O selo da barra diz o que aconteceu com a última.
const saveState=document.querySelector('#save-state');let ultimoSalvo='Tudo salvo';
function selo(classe,texto,titulo){saveState.className='save'+(classe?' '+classe:'');saveState.textContent=texto;saveState.title=titulo||'As edições são gravadas no .process assim que você as faz'}
function pendencias(){const nome=Boolean(editando)&&sujo(),props=Boolean(document.querySelector('#props').dataset.sujo);return nome||props}
function atualizarSelo(){if(saveState.classList.contains('busy')||saveState.classList.contains('err'))return;if(pendencias())selo('pending','Alterações não salvas','Há um campo do painel alterado e ainda não salvo: use o botão Salvar dele');else selo('ok',ultimoSalvo)}
async function pedir(rota,corpo){
  selo('busy','Salvando…');
  let r,dados;
  try{r=await fetch(rota,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(corpo)});dados=await r.json().catch(()=>({ok:false,mensagem:'resposta ilegível do visualizador'}))}
  catch{selo('err','Não salvo: sem conexão','O visualizador não respondeu; a edição não foi gravada');return {status:0,dados:{ok:false,mensagem:'sem conexão com o visualizador'}}}
  if(dados.ok){
    const hora=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    ultimoSalvo=(rota==='undo'?'Desfeito e salvo às ':rota==='redo'?'Refeito e salvo às ':'Salvo às ')+hora;
    selo('ok',ultimoSalvo);void saveState.offsetWidth;saveState.classList.add('pulso');setTimeout(atualizarSelo,0);
  }else if(dados.mensagem==='nada mudou'||dados.motivo==='sem-desfazer'||dados.motivo==='sem-refazer'){selo('ok',ultimoSalvo);setTimeout(atualizarSelo,0)}
  else selo('err','Não salvo','A edição não foi gravada: '+(dados.mensagem||'erro'));
  return {status:r.status,dados};
}
addEventListener('beforeunload',e=>{if(editMode&&pendencias()){e.preventDefault();e.returnValue=''}});
function mostrarConflito(dados,digitado){
  conflict.replaceChildren();conflict.hidden=false;
  const p=document.createElement('p');p.textContent=dados.mensagem;conflict.append(p);
  if(dados.atual!==undefined){
    const dl=document.createElement('dl');for(const [rotulo,valor] of [['Você começou com',editando.baseline],['O arquivo tem agora',dados.atual],['Você digitou',digitado]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=rotulo;dd.textContent=valor||'(vazio)';dl.append(dt,dd)}conflict.append(dl);
  }
  const acoes=document.createElement('span');acoes.className='row';
  const usar=document.createElement('button');usar.type='button';usar.textContent='Usar o valor do arquivo';usar.hidden=dados.atual===undefined;
  usar.addEventListener('click',()=>{input.value=dados.atual;editando.baseline=dados.atual;limparConflito();atualizarSujo()});
  const cancelar=document.createElement('button');cancelar.type='button';cancelar.textContent='Continuar editando';cancelar.addEventListener('click',limparConflito);
  acoes.append(usar,cancelar);conflict.append(acoes);
}
async function salvar(){
  if(!editando)return;
  const digitado=input.value, alvo={...editando};
  const {status,dados}=await pedir('rename',{id:alvo.id,nomeOriginal:alvo.baseline,nomeNovo:digitado});
  if(dados.ok){limparConflito();const el=elements.find(x=>x.id===alvo.id);if(el)el.nome=digitado;editando.baseline=digitado;text(document.querySelector('#element-name'),digitado||'Sem nome');atualizarSujo();flash('Nome alterado.',{rotulo:'Desfazer',aoClicar:desfazer});return}
  if(status===409&&dados.motivo!=='sem-desfazer'){mostrarConflito(dados,digitado);return}
  flash(dados.mensagem||'não foi possível salvar.');
}
async function desfazer(){
  const {dados}=await pedir('undo',{});
  if(dados.ok){limparConflito();const ap=(dados.apagados||[]).length?' Script apagado: '+dados.apagados.join(', ')+'.':'';const mt=(dados.mantidos||[]).length?' Script mantido, porque foi editado: '+dados.mantidos.join(', ')+'.':'';flash('Edição desfeita.'+ap+mt,{rotulo:'Refazer',aoClicar:refazer});return}
  flash(dados.mensagem||'não foi possível desfazer.');
}
async function refazer(){
  const {dados}=await pedir('redo',{});
  if(dados.ok){limparConflito();flash('Edição refeita.'+((dados.recriados||[]).length?' Script recriado: '+dados.recriados.join(', ')+'.':''),{rotulo:'Desfazer',aoClicar:desfazer});return}
  flash(dados.mensagem||'não foi possível refazer.');
}
function resumoAvisos(dados){const partes=[];if(dados.raiaDepois!==undefined)partes.push('Agora na raia '+(dados.raiaDepois||'nenhuma')+(dados.raiaAntes?' (estava em '+dados.raiaAntes+')':'')+'.');const avisos=dados.avisos||[];if(avisos.length)partes.push('Atenção: '+avisos[0].mensagem+(avisos.length>1?' (+'+(avisos.length-1)+')':''));return partes.join(' ')}
async function moverPara(id,dx,dy){
  if(ocupado)return;ocupado=true;
  try{
    const {status,dados}=await pedir('move',{id,dx,dy,hash:hashAtual});
    if(dados.ok){flash(('Movido. '+resumoAvisos(dados)).trim(),{rotulo:'Desfazer',aoClicar:desfazer});return}
    soltarPrevia();flash(dados.mensagem||'não foi possível mover.');if(status===409)void update();
  }finally{ocupado=false}
}
function pontoDoDiagrama(e){const m=svg.getScreenCTM();if(!m)return{x:0,y:0};const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(m.inverse());return{x:p.x,y:p.y}}
const grade=n=>Math.max(0,Math.round(n/10)*10);
function desenharAlcas(){
  svg?.querySelector('[data-layer=handles]')?.remove();
  const el=selectedId&&elements.find(x=>x.id===selectedId);
  if(!svg||!editMode||!el)return;
  if(!el.dobras){
    // Nó: a alça de ligar, no meio da borda direita.
    if(!podeLigarDe(el))return;
    const c=el.geometria.caixa,alto=el.tipo==='BpmnGateway'?Math.min(c.largura,c.altura):c.altura;
    const g=document.createElementNS(NS,'g');g.setAttribute('data-layer','handles');
    const a=document.createElementNS(NS,'circle');a.classList.add('conector');a.setAttribute('cx',c.x+c.largura+12);a.setAttribute('cy',c.y+alto/2);a.setAttribute('r','8');
    const t=document.createElementNS(NS,'title');t.textContent='Arraste até outro elemento para ligar';a.append(t);g.append(a);svg.append(g);return;
  }
  const g=document.createElementNS(NS,'g');g.setAttribute('data-layer','handles');
  el.dobras.forEach((p,i)=>{const r=document.createElementNS(NS,'rect');r.classList.add('handle');r.dataset.indice=String(i);r.setAttribute('x',p.x-5);r.setAttribute('y',p.y-5);r.setAttribute('width','10');r.setAttribute('height','10');r.setAttribute('rx','2');const t=document.createElementNS(NS,'title');t.textContent='Dobra '+(i+1)+': arraste para mover, clique duplo para remover';r.append(t);g.append(r)});
  svg.append(g);
}
function previaDoFluxo(el,dobras){const pts=el.geometria.pontos;const linha=[pts[0],...dobras,pts[pts.length-1]];const p=svg.querySelector('.fluig-hit.flow[data-id="'+CSS.escape(el.id)+'"]');if(p){p.classList.add('moving');p.setAttribute('d',linha.map((x,i)=>(i?'L':'M')+x.x+' '+x.y).join(' '))}}
async function gravarDobras(id,pontos){
  if(ocupado)return;ocupado=true;
  try{const {status,dados}=await pedir('bends',{id,pontos,hash:hashAtual});
    if(dados.ok){flash(('Dobras alteradas. '+resumoAvisos(dados)).trim(),{rotulo:'Desfazer',aoClicar:desfazer});return}
    flash(dados.mensagem||'não foi possível alterar as dobras.');void update();if(status===409)return}
  finally{ocupado=false}
}
async function endireitarEl(id){
  if(ocupado)return;ocupado=true;
  try{const {status,dados}=await pedir(id===undefined?'straighten-all':'straighten',id===undefined?{hash:hashAtual}:{id,hash:hashAtual});
    if(dados.ok){const n=(dados.fluxos||[]).length;flash((n>1?n+' ligações endireitadas. ':'Ligação endireitada. ')+resumoAvisos(dados),{rotulo:'Desfazer',aoClicar:desfazer});return}
    flash(dados.mensagem||'não foi possível endireitar.');if(status===409)void update()}
  finally{ocupado=false}
}
function renderAcoes(el){
  const box=document.querySelector('#edit-actions');box.replaceChildren();
  const botao=(rotulo,titulo,acao,ativo=true)=>{const b=document.createElement('button');b.type='button';b.textContent=rotulo;b.title=titulo;b.disabled=!ativo;b.addEventListener('click',acao);box.append(b)};
  if(editMode&&el.dobras){botao('Endireitar','Traça a ligação em ângulos retos, pela receita de layout',()=>void endireitarEl(el.id));botao('Remover dobras','Deixa a ligação reta, de ponta a ponta',()=>void gravarDobras(el.id,[]),el.dobras.length>0)}
  else if(editMode&&el.podeMover){
    if(podeLigarDe(el))botao('Ligar a…','Cria uma ligação deste elemento até o próximo que você clicar (ou arraste a alça azul à direita dele)',()=>comecarLigacao(el.id));
    if(el.ligacoes>0)botao('Endireitar ligações','Traça em ângulos retos todas as ligações que entram e saem deste elemento',()=>void endireitarEl(el.id));
  }
  box.hidden=box.childElementCount===0;
}
canvas.addEventListener('dblclick',e=>{
  if(!editMode||!svg||ocupado)return;
  const el=selectedId&&elements.find(x=>x.id===selectedId);if(!el||!el.dobras)return;
  // Com o ponteiro capturado pelo canvas no pointerdown, o dblclick chega com o canvas como alvo: vale o que está sob o ponteiro.
  const sob=document.elementFromPoint(e.clientX,e.clientY);
  const alca=sob?.closest?.('.handle');
  if(alca){e.preventDefault();const i=Number(alca.dataset.indice);void gravarDobras(el.id,el.dobras.filter((_,j)=>j!==i));return}
  const hit=sob?.closest?.('.fluig-hit.flow');if(!hit||hit.dataset.id!==el.id)return;
  e.preventDefault();
  const q=pontoDoDiagrama(e),pts=el.geometria.pontos;let melhor=0,menor=Infinity;
  for(let i=0;i<pts.length-1;i++){const a=pts[i],b=pts[i+1],dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((q.x-a.x)*dx+(q.y-a.y)*dy)/((dx*dx+dy*dy)||1))),d=Math.hypot(a.x+t*dx-q.x,a.y+t*dy-q.y);if(d<menor){menor=d;melhor=i}}
  const novas=[...el.dobras];novas.splice(melhor,0,{x:grade(q.x),y:grade(q.y)});void gravarDobras(el.id,novas);
});
const NATIVOS=${JSON.stringify(Object.fromEntries(Object.entries(MECANISMOS).map(([k, v]) => [k, v.campos]))).replaceAll('<', '\\u003c')};
const ROTULOS={groupId:'Grupo',roleId:'Papel',colleagueId:'Usuário (login)',formField:'Campo do formulário',idNode:'Atividade de referência',returns:'Qual executor'};
let sugestoes={atividades:[],mecanismos:[],grupos:[]};
function no(tag,attrs,...filhos){const n=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v===undefined||v===false)continue;if(k==='text')n.textContent=v;else if(k.slice(0,2)==='on')n.addEventListener(k.slice(2),v);else n.setAttribute(k,v===true?'':v)}n.append(...filhos);return n}
function opcoes(lista,atual){return lista.map(([valor,rotulo])=>no('option',{value:valor,selected:valor===atual,text:rotulo}))}
function lista(id,valores){return no('datalist',{id},...valores.map(v=>no('option',{value:v})))}
async function gravarProps(rota,corpo,ok){
  if(ocupado)return;ocupado=true;
  try{const {status,dados}=await pedir(rota,{...corpo,hash:hashAtual});
    if(dados.ok){const box=document.querySelector('#props');delete box.dataset.sujo;if(selectedId)select(selectedId);flash((ok+' '+resumoAvisos(dados)).trim(),{rotulo:'Desfazer',aoClicar:desfazer});return}
    flash(dados.mensagem||'não foi possível salvar.');if(status===409)void update()}
  finally{ocupado=false}
}
function renderProps(el){
  const box=document.querySelector('#props'),p=el.propriedades;
  if(box.dataset.sujo&&box.dataset.id===el.id&&editMode)return; // não apaga o que está sendo digitado
  box.replaceChildren();delete box.dataset.sujo;box.dataset.id=el.id;atualizarSelo();
  if(!editMode||!p){box.hidden=true;return}
  box.hidden=false;
  const avisoSujo=no('p',{class:'note warn',hidden:true,text:'Alterações não salvas neste painel: use o botão Salvar abaixo.'});
  const marcar=()=>{box.dataset.sujo='1';avisoSujo.hidden=false;atualizarSelo()};
  box.append(avisoSujo);
  box.oninput=marcar;
  if(p.execucao!==undefined){
    box.append(no('h3',{text:'Execução'}));
    if(p.execucao==='1')box.append(no('p',{class:'note',text:'Automática (executionType 1), como o padrão pede.'}));
    else box.append(no('p',{class:'note warn',text:'executionType '+(p.execucao||'ausente')+': fora do padrão, que pede service task automática.'}),no('div',{class:'row'},no('button',{type:'button',text:'Tornar automática',onclick:()=>void gravarProps('execution',{id:el.id},'Service task automática.')})));
  }
  if(p.atribuicao){
    const a=p.atribuicao;box.append(no('h3',{text:'Atribuição'}));
    if(!a.editavel){box.append(no('p',{class:'note',text:a.motivo||'não editável pelo painel'}));return}
    const valores={...a.campos};let escolha=a.customizado?'__custom':a.mecanismo,custom=a.customizado?a.mecanismo:'';
    const campos=no('div');
    const sel=no('select',{id:'mec-select',onchange:e=>{escolha=e.target.value;marcar();desenharCampos()}},...opcoes([['','Nenhum (quem movimenta escolhe)'],...Object.keys(NATIVOS).map(k=>[k,k]),['__custom','Mecanismo customizado']],escolha));
    function desenharCampos(){
      campos.replaceChildren();
      if(escolha==='__custom'){campos.append(no('label',{for:'mec-custom',text:'Mecanismo (id)'}),no('input',{id:'mec-custom',list:'mec-lista',value:custom,placeholder:'MEC_STG_ALCADAS',oninput:e=>{custom=e.target.value}}),lista('mec-lista',sugestoes.mecanismos));return}
      for(const c of NATIVOS[escolha]||[]){
        const id='mec-'+c;campos.append(no('label',{for:id,text:ROTULOS[c]||c}));
        if(c==='idNode')campos.append(no('select',{id,onchange:e=>{valores[c]=e.target.value}},...opcoes([['','Escolha a atividade'],...sugestoes.atividades.map(x=>[x.id,(x.nome||'Sem nome')+' ('+x.id+')'])],valores[c]||'')));
        else if(c==='returns'){if(!valores[c])valores[c]='1';campos.append(no('select',{id,onchange:e=>{valores[c]=e.target.value}},...opcoes([['0','Primeiro executor'],['1','Último executor'],['2','Todos os executores']],valores[c])))}
        else campos.append(no('input',{id,value:valores[c]||'',list:c==='groupId'?'grupo-lista':undefined,oninput:e=>{valores[c]=e.target.value}}),c==='groupId'?lista('grupo-lista',sugestoes.grupos):'');
      }
    }
    desenharCampos();
    box.append(no('label',{for:'mec-select',text:'Mecanismo'}),sel,campos,no('div',{class:'row'},no('button',{type:'button',text:'Salvar atribuição',onclick:()=>{
      const custom_=escolha==='__custom',mecanismo=custom_?custom.trim():escolha,cs={};for(const c of NATIVOS[escolha]||[])cs[c]=valores[c]||'';
      void gravarProps('assignment',{id:el.id,mecanismo,customizado:custom_,campos:cs},'Atribuição salva.')}})));
  }
  if(p.condicoes){
    const g=p.condicoes;box.append(no('h3',{text:'Condições das saídas'}));
    if(!g.editavel){box.append(no('p',{class:'note',text:g.motivo||'não editável pelo painel'}));return}
    if(!p.saidas.length){box.append(no('p',{class:'note',text:'Este gateway ainda não tem saídas.'}));return}
    const modelo=p.saidas.map(s=>{const c=g.condicoes.find(x=>x.destino===s.destino);return {saida:s,c:c?JSON.parse(JSON.stringify(c)):undefined}});
    const lista_=no('div');
    function desenhar(){
      lista_.replaceChildren();
      modelo.forEach((m,i)=>{
        const tipo=m.c?m.c.tipo:'';
        const bloco=no('div',{class:'cond'},no('strong',{text:'Para '+m.saida.nomeDestino+(m.saida.rotulo?' ('+m.saida.rotulo+')':'')}));
        bloco.append(no('select',{'aria-label':'Tipo da condição',onchange:e=>{const v=e.target.value;marcar();if(!v)m.c=undefined;else{m.c=m.c||{destino:m.saida.destino,expressao:'',regras:[]};m.c.tipo=v;if(v==='regra'&&!m.c.regras.length)m.c.regras.push({campo:'',operador:'1',valor:''})}desenhar()}},...opcoes([['','Sem condição'],['regra','Regra (campo do formulário)'],['expressao','Expressão']],tipo)));
        if(tipo==='regra'){
          m.c.regras.forEach((r,j)=>{
            const editavel=r.operador==='1'||r.operador==='2';
            bloco.append(no('div',{class:'regra'},
              no('input',{'aria-label':'Campo',placeholder:'campo',value:r.campo,oninput:e=>{r.campo=e.target.value}}),
              no('select',{'aria-label':'Operador',onchange:e=>{r.operador=e.target.value;marcar()}},...opcoes(editavel?[['1','igual a'],['2','diferente de']]:[[r.operador,'operador '+r.operador]],r.operador)),
              no('input',{'aria-label':'Valor',placeholder:'valor',value:r.valor,disabled:!editavel,oninput:e=>{r.valor=e.target.value}}),
              no('button',{type:'button',title:'Remover regra',text:'×',onclick:()=>{m.c.regras.splice(j,1);marcar();if(!m.c.regras.length)m.c=undefined;desenhar()}})));
          });
          bloco.append(no('div',{class:'row'},no('button',{type:'button',text:'+ regra (e)',onclick:()=>{m.c.regras.push({campo:'',operador:'1',valor:''});marcar();desenhar()}})));
        }
        if(tipo==='expressao')bloco.append(no('textarea',{'aria-label':'Expressão',spellcheck:'false',placeholder:'hAPI.getCardValue("campo") == "valor"',oninput:e=>{m.c.expressao=e.target.value}},m.c.expressao));
        lista_.append(bloco);
      });
    }
    desenhar();
    box.append(lista_,no('p',{class:'note',text:'Regra compara um campo do formulário. Os operadores sem valor do Studio (0 e 9) aparecem, mas não se criam por aqui.'}),
      no('div',{class:'row'},no('button',{type:'button',text:'Salvar condições',onclick:()=>void gravarProps('conditions',{id:el.id,condicoes:modelo.filter(m=>m.c).map(m=>m.c)},'Condições salvas.')})));
  }
}
// Ligar: arrastando a alça do elemento selecionado, ou "Ligar a…" e um clique no destino.
let ligando;
function podeLigarDe(el){return el.podeMover&&el.tipo!=='BpmnEndEvent'&&!/Pool|SwimLane/.test(el.tipo)}
function alvoSob(e){const sob=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.fluig-hit');const el=sob&&elements.find(x=>x.id===sob.dataset.id);return el&&el.podeMover?el:undefined}
function comecarLigacao(origem){ligando={origem};document.body.classList.add('colocando');flash('Clique no elemento de destino da ligação. Esc cancela.')}
function pararDeLigar(){ligando=undefined;document.body.classList.remove('colocando');svg?.querySelector('.previa-ligacao')?.remove()}
async function ligar(origem,destino){
  if(ocupado)return;ocupado=true;
  try{const {status,dados}=await pedir('connect',{origem,destino,hash:hashAtual});
    if(dados.ok){selecionarDepois=dados.criados[0];flash(('Ligação criada. '+(dados.deGateway?'Defina a condição desta saída no painel do gateway. ':'')+resumoAvisos(dados)).trim(),{rotulo:'Desfazer',aoClicar:desfazer});return}
    flash(dados.mensagem||'não foi possível ligar.');if(status===409)void update()}
  finally{ocupado=false}
}
// Adicionar: escolhe o tipo no menu, e o próximo clique no diagrama diz onde.
const addMenu=document.querySelector('#add-menu');let colocando,selecionarDepois;
const NOMES_TIPO={humana:'tarefa humana',recuperacao:'service task com recuperação',servico:'service task',gateway:'gateway',fim:'fim'};
function pararDeColocar(){colocando=undefined;addMenu.value='';document.body.classList.remove('colocando')}
addMenu.addEventListener('change',()=>{colocando=addMenu.value||undefined;document.body.classList.toggle('colocando',Boolean(colocando));if(colocando)flash('Clique no diagrama onde a '+NOMES_TIPO[colocando]+' vai ficar. Esc cancela.')});
async function colocarEm(e){
  const tipo=colocando;pararDeColocar();if(ocupado)return;ocupado=true;
  try{const q=pontoDoDiagrama(e);const {status,dados}=await pedir('add',{tipo,x:Math.round(q.x/10)*10,y:Math.round(q.y/10)*10,hash:hashAtual});
    if(dados.ok){selecionarDepois=dados.criados[0];
      const scripts=(dados.scripts||[]).length?'Script criado: '+dados.scripts.join(', ')+'. ':'';
      const existentes=(dados.scriptsExistentes||[]).length?'Script já existia e não foi tocado: '+dados.scriptsExistentes.join(', ')+'. ':'';
      flash(((tipo==='recuperacao'?'Service task, evento de erro e tratamento criados. ':'Criado. ')+scripts+existentes+'Renomeie no painel. '+resumoAvisos(dados)).trim(),{rotulo:'Desfazer',aoClicar:desfazer});return}
    flash(dados.mensagem||'não foi possível criar.');if(status===409)void update()}
  finally{ocupado=false}
}
function digitando(alvo){return alvo instanceof HTMLElement&&(alvo.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName))}
document.querySelector('#straighten-all').addEventListener('click',()=>void endireitarEl(undefined));
document.querySelector('#undo').addEventListener('click',()=>void desfazer());
document.querySelector('#redo').addEventListener('click',()=>void refazer());
document.addEventListener('keydown',e=>{
  if(!editMode||digitando(e.target))return;
  const mod=e.ctrlKey||e.metaKey,k=e.key.toLowerCase();
  if(mod&&k==='z'&&!e.shiftKey){e.preventDefault();void desfazer();return}
  if(mod&&(k==='y'||(k==='z'&&e.shiftKey))){e.preventDefault();void refazer();return}
  const passo=e.shiftKey?50:10,setas={ArrowLeft:[-passo,0],ArrowRight:[passo,0],ArrowUp:[0,-passo],ArrowDown:[0,passo]}[e.key];
  const el=selectedId&&elements.find(x=>x.id===selectedId);
  if(setas&&el&&el.podeMover){e.preventDefault();void moverPara(el.id,setas[0],setas[1])}
});
form.addEventListener('submit',e=>{e.preventDefault();void salvar()});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();void salvar()}if(e.key==='Escape'){e.stopPropagation();cancelarEdicao()}});
function cancelarEdicao(){limparConflito();if(editando)input.value=editando.baseline;atualizarSujo()}
document.querySelector('#cancel-name').addEventListener('click',cancelarEdicao);
document.querySelector('#close-panel').addEventListener('click',clearSelection);
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(colocando){pararDeColocar();flash('Adição cancelada.');return}if(ligando){pararDeLigar();flash('Ligação cancelada.');return}if(editando&&sujo()){cancelarEdicao();return}clearSelection()});
async function update(){try{const r=await fetch('state',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const s=await r.json();elements=s.elementos||[];hashAtual=s.hash;sugestoes=s.sugestoes||sugestoes;if(!svg||Number(svg.dataset.revision)!==s.revisao){const anterior=box,selectionBefore=selectedId;canvas.innerHTML=s.svg;svg=canvas.querySelector('svg');svg.dataset.revision=String(s.revisao);original=dimensions(svg);box=anterior||{...original};addInteractions();apply();if(selectionBefore&&!elements.some(x=>x.id===selectionBefore)){clearSelection();flash('O elemento selecionado foi removido.')}else if(selectionBefore)select(selectionBefore)}if(selecionarDepois&&elements.some(x=>x.id===selecionarDepois)){select(selecionarDepois);selecionarDepois=undefined;document.querySelector('#name-input')?.focus()}const when=new Date(s.atualizadoEm);status.textContent='atualizado às '+when.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});error.textContent=s.erro||'';error.classList.toggle('show',Boolean(s.erro));dot.classList.toggle('bad',Boolean(s.erro))}catch(e){status.textContent='sem conexão';error.textContent='O visualizador perdeu a conexão com o fluigctl.';error.classList.add('show');dot.classList.add('bad')}}
try{if(localStorage.getItem('fluigctl-edicao')==='1')setEditMode(true)}catch{}
update();const events=new EventSource('events');events.addEventListener('change',update);events.onerror=()=>{dot.classList.add('bad');status.textContent='reconectando…'};
</script></body></html>`;
}
export interface OpcoesServidor {
  arquivo: string;
  token?: string;
  port?: number;
  registroDir?: string;
  /** Onde guardar a versão anterior de cada edição, para o desfazer. */
  undoDir?: string;
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
  const undoDir = opcoes.undoDir ?? join(diretorioDeEstado(), 'edicoes');
  let ultimoTexto = readFileSync(arquivo, 'utf8');

  const avisar = () => {
    for (const res of clientes) res.write(`event: change\ndata: ${estado.revisao}\n\n`);
  };
  const reler = () => {
    try {
      const texto = readFileSync(arquivo, 'utf8');
      if (texto === ultimoTexto && estado.erro === undefined) return;
      const renderizado = renderizar(texto, arquivo);
      ultimoTexto = texto;
      estado = {
        arquivo: estado.arquivo,
        nome: estado.nome,
        svg: renderizado.svg,
        elementos: renderizado.elementos,
        atualizadoEm: new Date().toISOString(),
        revisao: estado.revisao + 1,
        hash: hash(texto),
        sugestoes: renderizado.sugestoes,
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
    const rota = url.startsWith(prefixo) ? url.slice(prefixo.length).split('?')[0] : undefined;
    // O token vem antes de qualquer coisa: sem ele, nem 404 diferente sai.
    if (rota === undefined) {
      responder(res, 404, 'text/plain', 'não encontrado');
      return;
    }
    if (req.method === 'POST') {
      const porta = (server.address() as { port: number } | null)?.port ?? 0;
      void tratarEdicao(req, res, rota, arquivo, undoDir, porta);
      return;
    }
    if (req.method !== 'GET') {
      responder(res, 405, 'text/plain', 'método não permitido');
      return;
    }
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
  undoDir?: string;
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
      ...(opcoes.undoDir === undefined ? {} : { undoDir: opcoes.undoDir }),
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
  if (opcoes.undoDir) args.push('--undo-dir', opcoes.undoDir);
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
