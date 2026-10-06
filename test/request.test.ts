import test from 'node:test';
import assert from 'node:assert/strict';

import type { Server } from '../src/config.js';
import {
  aguardar,
  cancelarSolicitacao,
  formatarSolicitacao,
  lerCampo,
  lerSolicitacao,
  moverSolicitacao,
  type PortaSolicitacao,
} from '../src/commands/request.js';
import type { Restricao } from '../src/fluig/dataset-rest.js';

/**
 * Solicitações sem a tela do Fluig. O servidor falso responde como o localdev
 * respondeu na contratação: histórico e tarefas pelos datasets internos, a
 * tarefa de pool que precisa ser assumida antes do move, e a service task com
 * `System:Auto` até o job rodar.
 */

const SERVIDOR: Server = { host: 'fluig.exemplo', port: 8080, ssl: false, username: 'admin', companyId: 1, userCode: 'admin', passwordEnv: 'X' };

interface Estado {
  status: number;
  historico: Record<string, unknown>[];
  tarefas: Record<string, unknown>[];
  chamadas: string[];
}

function falso(e: Estado, aoLer?: () => void): PortaSolicitacao {
  const valor = (rs: Restricao[], campo: string) => rs.find((r) => r.campo === campo)?.inicial;
  return {
    async dataset(nome, rs) {
      if (nome === 'workflowProcess') {
        aoLer?.();
        return valor(rs, 'workflowProcessPK.processInstanceId') === '11' ? [{ processId: 'contratacao', version: 6, status: e.status }] : [];
      }
      if (nome === 'processHistory') return e.historico;
      if (nome === 'processTask') return e.tarefas;
      if (nome === 'processState') return [3, 13].map((s) => ({ 'processStatePK.sequence': s, stateName: s === 3 ? 'Obter alçadas' : 'Tratar erro de alçada' }));
      throw new Error(nome);
    },
    async iniciar() {
      e.chamadas.push('iniciar');
      return { processInstanceId: 11 };
    },
    async mover(id, corpo) {
      e.chamadas.push(`mover ${id} ${JSON.stringify(corpo)}`);
    },
    async assumir(id, thread) {
      e.chamadas.push(`assumir ${id} ${thread}`);
    },
    async cancelar(id) {
      e.chamadas.push(`cancelar ${id}`);
      e.status = 1;
    },
    async campos() {
      return { salario: '9000', cargo: '' };
    },
  };
}

const mov = (seq: number, estado: number, ativo: boolean) => ({
  'processHistoryPK.movementSequence': seq,
  stateSequence: estado,
  active: ativo,
  threadSequence: 0,
  movementHour: `17:3${seq}:00`,
});
const tarefa = (seq: number, quem: string, status: number, obs = '') => ({
  'processTaskPK.movementSequence': seq,
  'processTaskPK.colleagueId': quem,
  status,
  taskObservation: obs,
});

/** Falhou em Obter alçadas e caiu no tratamento, no pool de suporte. */
function noTratamento(): Estado {
  return {
    status: 0,
    historico: [mov(4, 13, true), mov(3, 3, false)],
    tarefas: [tarefa(3, 'System:Auto', 2, 'Atividade de serviço executada com falha: O salario esta vazio'), tarefa(4, 'Pool:Group:suporte_processos', 0)],
    chamadas: [],
  };
}

const opcoes = (e: Estado, aoLer?: () => void) => ({ server: SERVIDOR, senha: 's', prompt: async () => '', porta: falso(e, aoLer), intervaloMs: 1 });

test('show: histórico em ordem, nome dos estados e a mensagem da service task que falhou', async () => {
  const s = await lerSolicitacao(opcoes(noTratamento()), 11);
  assert.deepEqual(s.movimentos.map((m) => [m.sequencia, m.estado, m.nomeEstado]), [[3, 3, 'Obter alçadas'], [4, 13, 'Tratar erro de alçada']]);
  const texto = formatarSolicitacao(s, true);
  assert.match(texto, /solicitação 11 {2}contratacao v6 {2}aberta/);
  assert.match(texto, /System:Auto \(concluída\): Atividade de serviço executada com falha: O salario esta vazio/);
  assert.match(texto, /▶ +4 .* 13 Tratar erro de alçada/);
  assert.match(texto, /salario = 9000/);
  assert.doesNotMatch(texto, /cargo =/, 'campo vazio não aparece');
  await assert.rejects(lerSolicitacao(opcoes(noTratamento()), 99), /não existe/);
});

test('move: tarefa de pool é assumida antes, e o move usa o movimento aberto', async () => {
  const e = noTratamento();
  const r = await moverSolicitacao(opcoes(e), 11, 3, { salario: '9000' }, 'corrigido', false);
  assert.equal(r.assumida, true);
  assert.deepEqual(e.chamadas, ['assumir 11 0', `mover 11 ${JSON.stringify({ movementSequence: 4, targetState: 3, formFields: { salario: '9000' }, comment: 'corrigido' })}`]);
});

test('move: dry-run não escreve; service task rodando e solicitação fechada são recusadas', async () => {
  const e = noTratamento();
  assert.equal((await moverSolicitacao(opcoes(e), 11, 3, {}, undefined, true)).de.estado, 13);
  assert.deepEqual(e.chamadas, []);

  const rodando: Estado = { ...noTratamento(), historico: [mov(3, 3, true)], tarefas: [tarefa(3, 'System:Auto', 0)] };
  await assert.rejects(moverSolicitacao(opcoes(rodando), 11, 4, {}, undefined, false), /service task 3 "Obter alçadas".*--wait/);

  await assert.rejects(moverSolicitacao(opcoes({ ...noTratamento(), status: 2 }), 11, 3, {}, undefined, false), /não está aberta \(finalizada\)/);
});

test('move: com duas tarefas abertas (paralelo), pede --from', async () => {
  const e: Estado = { ...noTratamento(), historico: [mov(5, 3, true), mov(6, 13, true)], tarefas: [tarefa(5, 'admin', 0), tarefa(6, 'admin', 0)] };
  await assert.rejects(moverSolicitacao(opcoes(e), 11, 4, {}, undefined, false), /2 tarefas abertas.*--from/);
  assert.equal((await moverSolicitacao(opcoes(e), 11, 4, {}, undefined, true, 13)).de.sequencia, 6);
});

test('--wait espera o job rodar a service task', async () => {
  const e: Estado = { ...noTratamento(), historico: [mov(3, 3, true)], tarefas: [tarefa(3, 'System:Auto', 0)] };
  let leituras = 0;
  const s = await aguardar(
    opcoes(e, () => {
      if (++leituras === 3) {
        e.historico = noTratamento().historico;
        e.tarefas = noTratamento().tarefas;
      }
    }),
    11,
  );
  assert.equal(leituras, 3);
  assert.equal(s.movimentos.at(-1)!.estado, 13);
});

test('cancel confere no servidor; campo da linha de comando separa no primeiro =', async () => {
  const e = noTratamento();
  assert.equal((await cancelarSolicitacao(opcoes(e), 11, 'teste', false)).status, 1);
  assert.deepEqual(e.chamadas, ['cancelar 11']);
  await assert.rejects(cancelarSolicitacao(opcoes(e), 11, 'teste', false), /já cancelada/);
  assert.deepEqual(lerCampo('obs=a=b'), ['obs', 'a=b']);
  assert.throws(() => lerCampo('=x'), /campo=valor/);
});
