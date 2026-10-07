import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { consultarDataset, type Restricao } from '../fluig/dataset-rest.js';
import { login } from '../fluig/session.js';
import { fluigSoapClient, invoke } from '../fluig/soap.js';
import { confirmProduction, type PromptSenha } from '../guard.js';

/**
 * Solicitações sem a tela do Fluig: abrir, ver onde estão e movimentar. É o que
 * testa um processo depois do push — inclusive o caminho de erro das service
 * tasks, que só aparece quando o job do servidor roda o script.
 *
 * O que foi medido no localdev (contratação, v6):
 * - abrir e movimentar: REST v2 de process-management (`/processes/{id}/start`
 *   e `/requests/{id}/move`), com a sessão do usuário cadastrado;
 * - tarefa de pool (`Pool:Group:x`) não se movimenta antes de ser assumida: o
 *   move responde "Tarefa não encontrada". Assumir é o `takeProcessTask` do SOAP;
 * - a lista de tarefas do REST v2 rotula cada movimento com o estado seguinte.
 *   Por isso o histórico vem dos datasets `processHistory` (estado de cada
 *   movimento) e `processTask` (quem, status e a observação — onde o Fluig põe
 *   a mensagem de falha da service task);
 * - service task com execução posterior fica com `System:Auto` até o job rodar
 *   (uns 20 s no localdev).
 */

export interface Tarefa {
  responsavel: string;
  /** 0 aberta, 2 concluída, 3 transferida (assumida de um pool). */
  status: number;
  observacao: string;
}

export interface Movimento {
  sequencia: number;
  estado: number;
  nomeEstado: string;
  ativo: boolean;
  thread: number;
  quando: string;
  tarefas: Tarefa[];
}

export interface Solicitacao {
  id: number;
  processId: string;
  versao: number;
  /** 0 aberta, 1 cancelada, 2 finalizada. */
  status: number;
  movimentos: Movimento[];
  campos: Record<string, string>;
}

/** O que toca o servidor; os testes trocam por um falso. */
export interface PortaSolicitacao {
  dataset(nome: string, restricoes: Restricao[]): Promise<Record<string, unknown>[]>;
  iniciar(processId: string, corpo: Record<string, unknown>): Promise<{ processInstanceId: number }>;
  mover(id: number, corpo: Record<string, unknown>): Promise<void>;
  assumir(id: number, thread: number): Promise<void>;
  cancelar(id: number, motivo: string): Promise<void>;
  campos(id: number): Promise<Record<string, string>>;
}

export interface OpcoesSolicitacao {
  server: Server;
  senha: string;
  prompt: PromptSenha;
  porta?: PortaSolicitacao;
  /** Para testes: espera entre consultas do --wait. */
  intervaloMs?: number;
}

const igual = (campo: string, valor: string | number): Restricao => ({ campo, inicial: String(valor), final: String(valor), tipo: 1 });

/** Erro do REST v2: `{"code","message","detailedMessage"}`. */
export function erroDoRest(texto: string, status: number, contexto: string): ErroFluigctl {
  let m = texto.trim().slice(0, 300);
  try {
    const e = JSON.parse(texto) as { code?: string; message?: string; detailedMessage?: string };
    m = [e.message || e.code, e.detailedMessage].filter(Boolean).join(' — ') || m;
  } catch {
    // Corpo que não é JSON: a recusa do validateForm vem como texto entre chaves,
    // "{Erro ao salvar dados de formulário: \n\nPreencha: ...}".
    m = m.replace(/^\{([\s\S]*)\}$/, '$1');
  }
  // A recusa do validateForm vem em HTML (a lista que a tela mostra) e com quebras de linha.
  m = m.replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' ').trim();
  return new ErroFluigctl(`o servidor recusou ${contexto}: ${m} (HTTP ${status})`, 7);
}

export function portaReal(server: Server, senha: string): PortaSolicitacao {
  const url = serverUrl(server);
  let cookie: Promise<string> | undefined;
  const sessao = () => (cookie ??= login(url, server.username, senha));
  const postar = async (caminho: string, corpo: unknown, contexto: string) => {
    const r = await fetch(`${url}${caminho}`, {
      method: 'POST',
      headers: { cookie: await sessao(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const texto = await r.text();
    if (!r.ok) throw erroDoRest(texto, r.status, contexto);
    return JSON.parse(texto) as Record<string, unknown>;
  };
  return {
    async dataset(nome, restricoes) {
      const r = await consultarDataset(url, await sessao(), { nome, restricoes });
      if (!r) throw new ErroFluigctl(`o dataset interno "${nome}" não respondeu em ${url}`, 7);
      return r.linhas;
    },
    async iniciar(processId, corpo) {
      const r = await postar(`/process-management/api/v2/processes/${encodeURIComponent(processId)}/start`, corpo, `abrir a solicitação de ${processId}`);
      return { processInstanceId: Number(r['processInstanceId']) };
    },
    async mover(id, corpo) {
      await postar(`/process-management/api/v2/requests/${id}/move`, corpo, `movimentar a solicitação ${id}`);
    },
    async assumir(id, thread) {
      const cliente = await fluigSoapClient(url, 'ECMWorkflowEngineService');
      const r = await invoke<{ result?: string }>(cliente, 'takeProcessTask', {
        username: server.username,
        password: senha,
        companyId: server.companyId,
        userId: server.userCode ?? server.username,
        processInstanceId: id,
        threadSequence: thread,
      });
      if (r?.result !== 'OK') throw new ErroFluigctl(`o servidor não deixou assumir a tarefa da solicitação ${id}: ${String(r?.result ?? 'sem resposta')}`, 7);
    },
    async cancelar(id, motivo) {
      const cliente = await fluigSoapClient(url, 'ECMWorkflowEngineService');
      const r = await invoke<{ result?: string }>(cliente, 'cancelInstance', {
        username: server.username,
        password: senha,
        companyId: server.companyId,
        processInstanceId: id,
        userId: server.userCode ?? server.username,
        cancelText: motivo,
      });
      if (r?.result !== 'OK') throw new ErroFluigctl(`o servidor não cancelou a solicitação ${id}: ${String(r?.result ?? 'sem resposta')}`, 7);
    },
    async campos(id) {
      const r = await fetch(`${url}/process-management/api/v2/requests?processInstanceId=${id}&expand=formFields`, {
        headers: { cookie: await sessao(), accept: 'application/json' },
      });
      const texto = await r.text();
      if (!r.ok) throw erroDoRest(texto, r.status, `ler o formulário da solicitação ${id}`);
      const itens = (JSON.parse(texto) as { items?: { formFields?: { field: string; value: string }[] | null }[] }).items ?? [];
      return Object.fromEntries((itens[0]?.formFields ?? []).map((f) => [f.field, f.value ?? '']));
    },
  };
}

const porta = (o: OpcoesSolicitacao) => o.porta ?? portaReal(o.server, o.senha);

export async function lerSolicitacao(o: OpcoesSolicitacao, id: number): Promise<Solicitacao> {
  const p = porta(o);
  const [processo] = await p.dataset('workflowProcess', [igual('workflowProcessPK.processInstanceId', id)]);
  if (!processo) throw new ErroFluigctl(`a solicitação ${id} não existe em ${serverUrl(o.server)}`, 3);
  const processId = String(processo['processId']);
  const versao = Number(processo['version']);
  const [historico, tarefas, estados, campos] = await Promise.all([
    p.dataset('processHistory', [igual('processHistoryPK.processInstanceId', id)]),
    p.dataset('processTask', [igual('processTaskPK.processInstanceId', id)]),
    p.dataset('processState', [igual('processStatePK.processId', processId), igual('processStatePK.version', versao)]),
    p.campos(id),
  ]);
  const nomes = new Map(estados.map((e) => [Number(e['processStatePK.sequence']), String(e['stateName'] ?? '')]));
  const movimentos = historico
    .map((h): Movimento => {
      const sequencia = Number(h['processHistoryPK.movementSequence']);
      const estado = Number(h['stateSequence']);
      return {
        sequencia,
        estado,
        nomeEstado: nomes.get(estado) ?? '',
        ativo: h['active'] === true,
        thread: Number(h['threadSequence'] ?? 0),
        quando: String(h['movementHour'] ?? ''),
        tarefas: tarefas
          .filter((t) => Number(t['processTaskPK.movementSequence']) === sequencia)
          .map((t) => ({
            responsavel: String(t['processTaskPK.colleagueId'] ?? ''),
            status: Number(t['status']),
            observacao: String(t['taskObservation'] ?? ''),
          })),
      };
    })
    .sort((a, b) => a.sequencia - b.sequencia);
  return { id, processId, versao, status: Number(processo['status']), movimentos, campos };
}

/** `campo=valor` da linha de comando. */
export function lerCampo(texto: string): [string, string] {
  const i = texto.indexOf('=');
  if (i <= 0) throw new ErroFluigctl(`--field "${texto}": use campo=valor`, 2);
  return [texto.slice(0, i).trim(), texto.slice(i + 1)];
}

/** A tarefa aberta de um movimento ativo — a que um move consome. */
function tarefaAberta(m: Movimento): Tarefa | undefined {
  return m.tarefas.find((t) => t.status === 0);
}

export const emServiceTask = (s: Solicitacao) =>
  s.status === 0 && s.movimentos.some((m) => m.ativo && tarefaAberta(m)?.responsavel === 'System:Auto');

/** Espera o job do servidor rodar as service tasks com execução posterior. */
export async function aguardar(o: OpcoesSolicitacao, id: number, limiteS = 180): Promise<Solicitacao> {
  const fim = Date.now() + limiteS * 1000;
  for (;;) {
    const s = await lerSolicitacao(o, id);
    if (!emServiceTask(s)) return s;
    if (Date.now() > fim) throw new ErroFluigctl(`a solicitação ${id} continua numa service task depois de ${limiteS} s: o job do servidor não rodou`, 7);
    await new Promise((r) => setTimeout(r, o.intervaloMs ?? 5000));
  }
}

export async function abrirSolicitacao(
  o: OpcoesSolicitacao,
  processId: string,
  campos: Record<string, string>,
  comentario: string | undefined,
  dryRun: boolean,
): Promise<{ id?: number }> {
  if (dryRun) return {};
  await confirmProduction(o.server, o.senha, `abrir uma solicitação de ${processId}`, o.prompt);
  const r = await porta(o).iniciar(processId, { formFields: campos, ...(comentario ? { comment: comentario } : {}) });
  if (!Number.isInteger(r.processInstanceId) || r.processInstanceId <= 0) {
    throw new ErroFluigctl(`o servidor não devolveu o número da solicitação de ${processId}`, 7);
  }
  return { id: r.processInstanceId };
}

export interface ResultadoMove {
  de: Movimento;
  assumida: boolean;
}

export async function moverSolicitacao(
  o: OpcoesSolicitacao,
  id: number,
  para: number,
  campos: Record<string, string>,
  comentario: string | undefined,
  dryRun: boolean,
  deEstado?: number,
): Promise<ResultadoMove> {
  const s = await lerSolicitacao(o, id);
  if (s.status !== 0) throw new ErroFluigctl(`a solicitação ${id} não está aberta (${s.status === 1 ? 'cancelada' : 'finalizada'})`, 6);
  let ativos = s.movimentos.filter((m) => m.ativo && tarefaAberta(m));
  if (deEstado !== undefined) ativos = ativos.filter((m) => m.estado === deEstado);
  if (ativos.length === 0) {
    throw new ErroFluigctl(`a solicitação ${id} não tem tarefa aberta${deEstado !== undefined ? ` no estado ${deEstado}` : ''}`, 6);
  }
  if (ativos.length > 1) {
    throw new ErroFluigctl(
      `a solicitação ${id} tem ${ativos.length} tarefas abertas (${ativos.map((m) => `${m.estado} "${m.nomeEstado}"`).join(', ')}): diga qual com --from <estado>`,
      6,
    );
  }
  const de = ativos[0]!;
  const responsavel = tarefaAberta(de)!.responsavel;
  if (responsavel === 'System:Auto') {
    throw new ErroFluigctl(`a solicitação ${id} está na service task ${de.estado} "${de.nomeEstado}", que o job do servidor ainda vai rodar: use request show --wait`, 6);
  }
  const pool = responsavel.startsWith('Pool:');
  if (dryRun) return { de, assumida: pool };
  await confirmProduction(o.server, o.senha, `movimentar a solicitação ${id} de ${de.estado} para ${para}`, o.prompt);
  const p = porta(o);
  if (pool) await p.assumir(id, de.thread);
  await p.mover(id, {
    movementSequence: de.sequencia,
    targetState: para,
    formFields: campos,
    ...(comentario ? { comment: comentario } : {}),
  });
  return { de, assumida: pool };
}

export async function cancelarSolicitacao(o: OpcoesSolicitacao, id: number, motivo: string, dryRun: boolean): Promise<Solicitacao> {
  const s = await lerSolicitacao(o, id);
  if (s.status !== 0) throw new ErroFluigctl(`a solicitação ${id} não está aberta (${s.status === 1 ? 'já cancelada' : 'finalizada'})`, 6);
  if (dryRun) return s;
  await confirmProduction(o.server, o.senha, `cancelar a solicitação ${id} de ${s.processId}`, o.prompt);
  await porta(o).cancelar(id, motivo);
  const depois = await lerSolicitacao(o, id);
  if (depois.status !== 1) throw new ErroFluigctl(`o servidor respondeu OK, mas a solicitação ${id} não aparece cancelada`, 7);
  return depois;
}

const STATUS_TAREFA: Record<number, string> = { 0: 'aberta', 2: 'concluída', 3: 'assumida' };
const STATUS_SOLICITACAO: Record<number, string> = { 0: 'aberta', 1: 'cancelada', 2: 'finalizada' };

/** O histórico para o terminal, com a mensagem inteira das service tasks que falharam. */
export function formatarSolicitacao(s: Solicitacao, comCampos = false): string {
  const linhas = [`solicitação ${s.id}  ${s.processId} v${s.versao}  ${STATUS_SOLICITACAO[s.status] ?? `status ${s.status}`}`];
  for (const m of s.movimentos) {
    const marca = m.ativo && tarefaAberta(m) ? '▶' : ' ';
    linhas.push(`${marca} ${String(m.sequencia).padStart(3)}  ${m.quando}  ${String(m.estado).padStart(3)} ${m.nomeEstado}`);
    for (const t of m.tarefas) {
      linhas.push(`         ${t.responsavel} (${STATUS_TAREFA[t.status] ?? `status ${t.status}`})${t.observacao ? `: ${t.observacao.replace(/\s+/g, ' ')}` : ''}`);
    }
  }
  if (comCampos) {
    const preenchidos = Object.entries(s.campos).filter(([, v]) => v !== '');
    linhas.push('', preenchidos.length ? 'formulário:' : 'formulário: (vazio)');
    for (const [k, v] of preenchidos.sort(([a], [b]) => a.localeCompare(b))) linhas.push(`  ${k} = ${v}`);
  }
  return linhas.join('\n');
}
