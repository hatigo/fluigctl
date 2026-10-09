import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import { definirCondicaoNoXml, inserirEntreNoXml, mostrarDiagrama, resolverElemento } from '../src/diagram/comandos.js';
import { medirLayout } from '../src/diagram/layout-medida.js';
import { lerCondicoes } from '../src/diagram/props.js';
import { ajustarAoNome } from '../src/diagram/tamanho.js';
import { formasSemEstilo } from '../src/diagram/visual.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * Os comandos de edição do diagrama no terminal (diagram show/add/link/...):
 * as operações do visualizador, para o agente não editar o XML à mão. O caso do
 * experimento de 2026-10-07: incluir "Conferir pedido" entre "Aprovar pedido"
 * e o gateway, que um agente fez editando o XML em 63 passos.
 */

const CONTRATACAO = readFileSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), 'utf8');
const BIN = fileURLToPath(new URL('../../bin/fluigctl.js', import.meta.url));
const objeto = (xml: string, id: string) => lerDiagrama(xml).objetos.find((o) => o.attrs['id'] === id)!;
const destinos = (xml: string, id: string) => lerDiagrama(xml).objetos.filter((o) => o.tipo === 'SequenceFlow' && o.attrs['sourceRef'] === id).map((o) => o.attrs['targetRef']);

test('inserir entre: abre espaço, religa, e o diagrama continua como o Studio grava', () => {
  // task5 "Aprovar" → exclusivegateway6 "Aprovado?" na contratação.
  const r = inserirEntreNoXml(CONTRATACAO, 'task5', 'exclusivegateway6', { tipo: 'humana', nome: 'Conferir' });
  const novo = r.criados[0]!;
  assert.deepEqual(destinos(r.xml, 'task5'), [novo]);
  assert.deepEqual(destinos(r.xml, novo), ['exclusivegateway6']);
  assert.ok(r.movidos.includes('exclusivegateway6'), 'o gateway andou para abrir espaço');
  const d = lerDiagrama(r.xml);
  assert.ok(d.caixas.get(novo)!.absX > d.caixas.get('task5')!.absX && d.caixas.get(novo)!.absX < d.caixas.get('exclusivegateway6')!.absX, 'o novo fica entre os dois');
  assert.deepEqual(checarDiagrama(r.xml).filter((a) => a.grupo === 'estrutura'), []);
  assert.equal(formasSemEstilo(r.xml), 0);
  // O fixture tem tarefas de 140 px (de antes do tamanho do Studio); o novo sai no tamanho dele.
  assert.equal(ajustarAoNome(r.xml, [novo]), r.xml, 'o novo no tamanho e com o rótulo do Studio');
  assert.equal(medirLayout(r.xml).cards, 0);
});

test('inserir depois de um gateway: a condição e o nome da ligação passam para o novo', () => {
  // exclusivegateway6 → servicetask7 ("Avisar reprovação"), com a condição decisaoAprovacao = reprovado.
  const antes = lerCondicoes(objeto(CONTRATACAO, 'exclusivegateway6')).condicoes.find((c) => c.destino === 'servicetask7')!;
  const r = inserirEntreNoXml(CONTRATACAO, 'exclusivegateway6', 'servicetask7', { tipo: 'humana', nome: 'Registrar motivo' });
  const novo = r.criados[0]!;
  const depois = lerCondicoes(objeto(r.xml, 'exclusivegateway6')).condicoes;
  assert.equal(depois.find((c) => c.destino === 'servicetask7'), undefined);
  const movida = depois.find((c) => c.destino === novo)!;
  assert.deepEqual(movida.regras.map((x) => [x.campo, x.operador, x.valor]), antes.regras.map((x) => [x.campo, x.operador, x.valor]));
  assert.equal(depois.length, lerCondicoes(objeto(CONTRATACAO, 'exclusivegateway6')).condicoes.length);
  assert.deepEqual(checarDiagrama(r.xml).filter((a) => a.grupo === 'estrutura'), []);
});

test('o nome resolve o elemento antes da ligação de mesmo nome; ambíguo e inexistente são recusados', () => {
  assert.equal(resolverElemento(CONTRATACAO, 'Aprovar').attrs['id'], 'task5');
  assert.equal(resolverElemento(CONTRATACAO, 'aprovar').attrs['id'], 'task5', 'sem diferença de caixa');
  assert.equal(resolverElemento(CONTRATACAO, 'task5').attrs['id'], 'task5');
  assert.throws(() => resolverElemento(CONTRATACAO, 'Não existe'), /não há elemento/);
  const comLigacao = CONTRATACAO.replace(/(<bpmn2:SequenceFlow id="flow19" name=")[^"]*"/, '$1Aprovar"');
  assert.equal(resolverElemento(comLigacao, 'Aprovar').attrs['id'], 'task5');
});

test('definir a condição de uma saída troca só aquela, e exige a ligação', () => {
  const xml = definirCondicaoNoXml(CONTRATACAO, 'exclusivegateway6', 'servicetask7', { tipo: 'regra', expressao: '', regras: [{ campo: 'decisaoAprovacao', operador: '2', valor: 'aprovado' }] });
  const c = lerCondicoes(objeto(xml, 'exclusivegateway6')).condicoes;
  assert.deepEqual(c.find((x) => x.destino === 'servicetask7')!.regras.map((r) => [r.campo, r.operador, r.valor]), [['decisaoAprovacao', '2', 'aprovado']]);
  assert.equal(c.length, lerCondicoes(objeto(CONTRATACAO, 'exclusivegateway6')).condicoes.length);
  assert.throws(() => definirCondicaoNoXml(CONTRATACAO, 'exclusivegateway6', 'task2', { tipo: 'expressao', expressao: 'true', regras: [] }), /não tem saída para task2/);
});

test('diagram show: na ordem do fluxo, com raia, atribuição e condição', () => {
  const m = mostrarDiagrama(CONTRATACAO);
  assert.equal(m.processo.id, 'contratacao');
  assert.equal(m.elementos[0]!.tipo, 'início');
  assert.equal(m.elementos[1]!.id, 'task2');
  const aprovar = m.elementos.find((e) => e.id === 'task5')!;
  assert.equal(aprovar.atribuicao, 'MEC_ALCADAS');
  const gw = m.elementos.find((e) => e.id === 'exclusivegateway6')!;
  assert.ok(gw.saidas.every((s) => s.condicao?.startsWith('decisaoAprovacao = ')));
  const erro = m.elementos.findIndex((e) => e.id === 'intermediateerror12');
  assert.equal(m.elementos[erro - 1]!.id, 'servicetask3', 'o evento de erro vem logo depois da tarefa dele');
});

test('pelo terminal: temporizador cria/configura e recusas não gravam', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-timer-'));
  try {
    const arquivo = join(raiz, 'contratacao.process');
    writeFileSync(arquivo, CONTRATACAO);
    const env = { ...process.env, XDG_STATE_HOME: join(raiz, 'estado'), FLUIGCTL_FONTE_STUDIO: 'arial' };
    const f = (...args: string[]) => execFileSync(process.execPath, [BIN, 'diagram', ...args], { env, encoding: 'utf8' });
    assert.throws(() => f('add', arquivo, '--type', 'temporizador', '--after', 'task5'), /inteiro positivo/);
    assert.equal(readFileSync(arquivo, 'utf8'), CONTRATACAO, 'temporizador sem --minutes não escreve');
    assert.match(f('add', arquivo, '--type', 'temporizador', '--minutes', '30', '--after', 'task5', '--before', 'exclusivegateway6'), /criado\(s\): intermediatetimer37/);
    assert.match(f('show', arquivo), /intermediatetimer37  temporizador intermediário/);
    assert.match(f('timer', arquivo, 'intermediatetimer37', '--minutes', '31'), /temporizador configurado/);
    assert.match(objeto(readFileSync(arquivo, 'utf8'), 'intermediatetimer37').attrs['trigger'] ?? '', /<frequencia>31<\/frequencia>/);
    const depois = readFileSync(arquivo, 'utf8');
    for (const minutos of ['0', '1.5', '-1']) {
      const args = minutos === '-1' ? ['--minutes=-1'] : ['--minutes', minutos];
      assert.throws(() => f('timer', arquivo, 'intermediatetimer37', ...args), /inteiro positivo/);
      assert.equal(readFileSync(arquivo, 'utf8'), depois);
    }
    assert.throws(() => f('timer', arquivo, 'task2', '--minutes', '30'), /não é um temporizador/);
    assert.equal(readFileSync(arquivo, 'utf8'), depois);
    f('undo', arquivo);
    assert.match(objeto(readFileSync(arquivo, 'utf8'), 'intermediatetimer37').attrs['trigger'] ?? '', /<frequencia>30<\/frequencia>/, 'undo restaura a duração anterior');
    f('redo', arquivo);
    assert.equal(readFileSync(arquivo, 'utf8'), depois, 'redo restaura a configuração');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('pelo terminal: add entre dois, assign, check e undo, no mesmo histórico do visualizador', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-cmd-'));
  try {
    const pasta = join(raiz, 'workflow', 'diagrams');
    mkdirSync(pasta, { recursive: true });
    const arquivo = join(pasta, 'contratacao.process');
    writeFileSync(arquivo, CONTRATACAO);
    const env = { ...process.env, XDG_STATE_HOME: join(raiz, 'estado'), FLUIGCTL_FONTE_STUDIO: 'arial' };
    const f = (...args: string[]) => execFileSync(process.execPath, [BIN, 'diagram', ...args], { env, encoding: 'utf8' });
    assert.match(f('add', arquivo, '--type', 'humana', '--name', 'Conferir', '--after', 'Aprovar', '--before', 'Aprovado?'), /criado\(s\): task\d+/);
    f('assign', arquivo, 'Conferir', '--mechanism', 'Executor Atividade', '--field', 'idNode=Preencher requisição', '--field', 'returns=1');
    const xml = readFileSync(arquivo, 'utf8');
    const conferir = resolverElemento(xml, 'Conferir');
    assert.match(conferir.attrs['managerAssignmentControllerString'] ?? '', /<idNode>task2<\/idNode>/);
    assert.match(f('show', arquivo), /"Conferir"[\s\S]*atribuição: Executor Atividade \(idNode=task2, returns=1\)/);
    f('undo', arquivo);
    f('undo', arquivo);
    assert.equal(readFileSync(arquivo, 'utf8'), CONTRATACAO, 'dois desfazer voltam o arquivo');
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
