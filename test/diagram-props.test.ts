import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checarDiagrama } from '../src/diagram/check.js';
import {
  blobDeAtribuicao,
  codificarAtributo,
  estiloDoArquivo,
  lerAtribuicao,
  lerCondicoes,
  tornarAutomaticaNoXml,
  trocarAtribuicaoNoXml,
  trocarAtributosNoXml,
  trocarCondicoesNoXml,
  type Condicao,
} from '../src/diagram/props.js';
import { hash } from '../src/diagram/edit.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * Modo de edição, passo 3: propriedades no painel. Os blobs XStream de
 * atribuição e condição só se regravam no formato exato do Studio; o resto do
 * arquivo não muda.
 */

const ORIGINAL = readFileSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), 'utf8');
const objeto = (texto: string, id: string) => lerDiagrama(texto).objetos.find((o) => o.attrs['id'] === id)!;
const linhasMudadas = (a: string, b: string) => b.split('\n').filter((l, i) => l !== a.split('\n')[i]).length;

test('atributo sai como o Studio grava, ou no estilo que o arquivo já usa', () => {
  assert.equal(codificarAtributo('<a>\n  "é" & b</a>'), '&lt;a>&#xA;  &quot;&#xe9;&quot; &amp; b&lt;/a>');
  assert.equal(codificarAtributo('<a>\n</a>', { gt: true, decimal: true }), '&lt;a&gt;&#10;&lt;/a&gt;');
  assert.deepEqual(estiloDoArquivo(ORIGINAL), { gt: false, decimal: false });
  assert.deepEqual(estiloDoArquivo('<x a="&lt;b&gt;&#10;"/>'), { gt: true, decimal: true });
});

test('trocar atributo com o mesmo valor devolve o arquivo byte a byte; inserir e remover mexem só na tag', () => {
  for (const id of ['task13', 'exclusivegateway6', 'servicetask3', 'flow21']) {
    const o = objeto(ORIGINAL, id);
    for (const k of ['name', 'condition', 'managerAssignmentControllerString']) {
      if (o.attrs[k] !== undefined) assert.equal(trocarAtributosNoXml(ORIGINAL, id, { [k]: o.attrs[k]! }), ORIGINAL, `${id}.${k}`);
    }
  }
  // Um atributo que a tarefa não tem entra logo depois do vizinho pedido.
  const novo = trocarAtributosNoXml(ORIGINAL, 'task5', { testeFluigctl: 'sim' }, ['managerMechanism']);
  assert.match(novo, /managerMechanism="MEC_ALCADAS" testeFluigctl="sim"/);
  assert.equal(linhasMudadas(ORIGINAL, novo), 1);
  assert.equal(trocarAtributosNoXml(novo, 'task5', { testeFluigctl: null }), ORIGINAL);
});

test('lê a atribuição do diagrama, e o blob regravado é o do Studio', () => {
  const t13 = lerAtribuicao(objeto(ORIGINAL, 'task13'));
  assert.deepEqual(t13, { mecanismo: 'Pool Grupo', customizado: false, campos: { groupId: 'suporte_processos' }, editavel: true });
  assert.equal(blobDeAtribuicao(t13), objeto(ORIGINAL, 'task13').attrs['managerAssignmentControllerString']);
  const t5 = lerAtribuicao(objeto(ORIGINAL, 'task5'));
  assert.equal(t5.customizado, true);
  assert.equal(t5.mecanismo, 'MEC_ALCADAS');
});

test('o blob compacto do diagrama baixado do servidor se lê, mas não se regrava', () => {
  // O pull devolve o blob sem a indentação do Studio; o diagram show e o verificador precisam dos campos.
  const compacto = ORIGINAL.replace(/(id="task13"[^\n]*?managerAssignmentControllerString=")([^"]*)"/, (_, a: string, b: string) => `${a}${b.replace(/&#xA;\s*/g, '')}"`);
  assert.notEqual(compacto, ORIGINAL);
  const t13 = lerAtribuicao(objeto(compacto, 'task13'));
  assert.deepEqual(t13.campos, { groupId: 'suporte_processos' });
  assert.equal(t13.editavel, false);
});

test('trocar a atribuição grava o blob certo, e Nenhum tira o controlador', () => {
  const papel = trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: 'Pool Papel', customizado: false, campos: { roleId: 'suporte' } });
  assert.equal(linhasMudadas(ORIGINAL, papel), 1);
  assert.deepEqual(lerAtribuicao(objeto(papel, 'task13')).campos, { roleId: 'suporte' });
  assert.match(papel, /managerMechanism="Pool Papel" managerAssignmentControllerString="&lt;org\.eclipse\.bpmn2\.impl\.AssignmentControllerPoolRole>&#xA;  &lt;roleId>suporte&lt;\/roleId>/);

  const nenhum = trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: '', customizado: false, campos: {} });
  assert.equal(objeto(nenhum, 'task13').attrs['managerMechanism'], '');
  assert.equal(objeto(nenhum, 'task13').attrs['managerAssignmentControllerString'], undefined);

  const executor = trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: 'Executor Atividade', customizado: false, campos: { idNode: 'task2', returns: '1' } });
  assert.deepEqual(lerAtribuicao(objeto(executor, 'task13')).campos, { idNode: 'task2', returns: '1' });
  const custom = trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: 'MEC_STG_SUPORTE', customizado: true, campos: {} });
  assert.equal(lerAtribuicao(objeto(custom, 'task13')).mecanismo, 'MEC_STG_SUPORTE');

  assert.throws(() => trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: 'Pool Grupo', customizado: false, campos: { groupId: ' ' } }), /informe groupId/);
  assert.throws(() => trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: 'Executor Atividade', customizado: false, campos: { idNode: 'naoexiste', returns: '1' } }), /não existe/);
  assert.throws(() => trocarAtribuicaoNoXml(ORIGINAL, 'task13', { mecanismo: 'Mágico', customizado: false, campos: {} }), /desconhecido/);
  assert.throws(() => trocarAtribuicaoNoXml(ORIGINAL, 'servicetask3', { mecanismo: '', customizado: false, campos: {} }), /tarefa humana/);
});

test('tornar automática grava executionType 1, e recusa o que já é', () => {
  const sincrona = trocarAtributosNoXml(ORIGINAL, 'servicetask3', { executionType: null });
  const auto = tornarAutomaticaNoXml(sincrona, 'servicetask3');
  assert.equal(objeto(auto, 'servicetask3').attrs['executionType'], '1');
  assert.equal(linhasMudadas(sincrona, auto), 1);
  assert.throws(() => tornarAutomaticaNoXml(ORIGINAL, 'servicetask3'), /já é automática/);
  assert.throws(() => tornarAutomaticaNoXml(ORIGINAL, 'task5'), /service task/);
});

test('condições: lê, troca o valor e volta byte a byte com o que foi lido', () => {
  const g = lerCondicoes(objeto(ORIGINAL, 'exclusivegateway6'));
  assert.equal(g.editavel, true);
  assert.deepEqual(g.condicoes.map((c) => [c.destino, c.regras[0]!.campo, c.regras[0]!.valor]), [
    ['exclusivegateway9', 'decisaoAprovacao', 'aprovado'],
    ['servicetask7', 'decisaoAprovacao', 'reprovado'],
  ]);
  assert.equal(trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway6', g.condicoes), ORIGINAL);
  // O painel manda na ordem das saídas; o arquivo volta na ordem do Studio.
  assert.equal(trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway6', [...g.condicoes].reverse()), ORIGINAL);

  const mudadas: Condicao[] = JSON.parse(JSON.stringify(g.condicoes));
  mudadas[1]!.regras[0]!.valor = 'recusado';
  mudadas[1]!.regras.push({ campo: 'motivo', operador: '2', valor: '' });
  const novo = trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway6', mudadas);
  assert.equal(linhasMudadas(ORIGINAL, novo), 1);
  const lido = lerCondicoes(objeto(novo, 'exclusivegateway6')).condicoes[1]!;
  assert.deepEqual(lido.regras.map((r) => [r.campo, r.operador, r.valor, r.meta]), [
    ['decisaoAprovacao', '1', 'recusado', ['0', '0', '6', '2', '1']],
    ['motivo', '2', '', ['0', '0', '6', '2', '2']],
  ]);
  assert.deepEqual(checarDiagrama(novo).filter((a) => a.nivel === 'erro'), []);
});

test('condição por expressão, sem condição, e as recusas', () => {
  const g = lerCondicoes(objeto(ORIGINAL, 'exclusivegateway9')).condicoes;
  const expr: Condicao[] = [{ ...g[0]!, tipo: 'expressao', expressao: 'hAPI.getCardValue("faltaAprovador") == "sim"', regras: [] }, g[1]!];
  const novo = trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', expr);
  const lido = lerCondicoes(objeto(novo, 'exclusivegateway9')).condicoes[0]!;
  assert.equal(lido.tipo, 'expressao');
  assert.equal(lido.expressao, 'hAPI.getCardValue("faltaAprovador") == "sim"');
  assert.match(novo, /&amp;quot;faltaAprovador&amp;quot;/, 'aspas como o XStream, dentro do atributo');

  const so1 = trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', [g[1]!]);
  assert.equal(lerCondicoes(objeto(so1, 'exclusivegateway9')).condicoes.length, 1);

  assert.throws(() => trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', [{ ...g[0]!, destino: 'task2' }]), /não há fluxo/);
  assert.throws(() => trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', [g[0]!, { ...g[0]! }]), /duas condições/);
  assert.throws(() => trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', [{ ...g[0]!, regras: [{ campo: 'x', operador: '9', valor: '' }] }]), /só igual \(1\) e diferente \(2\)/);
  assert.throws(() => trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', [{ ...g[0]!, tipo: 'expressao', expressao: '  ', regras: [] }]), /precisa de uma expressão/);
  assert.throws(() => trocarCondicoesNoXml(ORIGINAL, 'exclusivegateway9', [{ ...g[0]!, regras: [{ campo: 'a b', operador: '1', valor: '' }] }]), /campo inválido/);
});

test('blob com atribuição por caminho fica somente leitura', () => {
  const comMecanismo = ORIGINAL.replace(
    '&lt;targetTask>servicetask4&lt;/targetTask>',
    '&lt;targetTask>servicetask4&lt;/targetTask>&#xA;    &lt;mechanism>Usu&#xe1;rio&lt;/mechanism>',
  );
  assert.notEqual(comMecanismo, ORIGINAL);
  const g = lerCondicoes(objeto(comMecanismo, 'exclusivegateway9'));
  assert.equal(g.editavel, false);
  assert.throws(() => trocarCondicoesNoXml(comMecanismo, 'exclusivegateway9', []), /atribuição por caminho/);
});

function projeto(): { arquivo: string; undo: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-props-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  mkdirSync(join(raiz, 'mechanisms'));
  writeFileSync(join(raiz, 'mechanisms/MEC_STG_SUPORTE.js'), 'function resolve(process, colleague) { return new java.util.ArrayList(); }\n');
  writeFileSync(arquivo, ORIGINAL);
  return { arquivo, undo: join(raiz, 'undo'), registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

async function postar(url: string, rota: string, corpo: unknown): Promise<{ status: number; dados: Record<string, unknown> }> {
  const r = await fetch(`${url}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  return { status: r.status, dados: (await r.json()) as Record<string, unknown> };
}

test('o visualizador entrega propriedades e sugestões, e grava pelas rotas novas', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const e = v.estado();
    assert.deepEqual(e.sugestoes.mecanismos, ['MEC_ALCADAS', 'MEC_STG_SUPORTE'], 'da pasta mechanisms/ e do diagrama');
    assert.ok(e.sugestoes.grupos.includes('suporte_processos'));
    assert.ok(e.sugestoes.atividades.some((a) => a.id === 'task2'));
    assert.equal(e.elementos.find((x) => x.id === 'servicetask3')!.propriedades!.execucao, '1');
    assert.equal(e.elementos.find((x) => x.id === 'exclusivegateway6')!.propriedades!.saidas!.length, 2);
    assert.ok(e.elementos.find((x) => x.id === 'task13')!.campos.some((c) => c.rotulo === 'Atribuído a' && c.valor === 'suporte_processos'));

    const r = await postar(v.url, 'assignment', { id: 'task13', mecanismo: 'MEC_STG_SUPORTE', customizado: true, campos: {}, hash: e.hash });
    assert.equal(r.status, 200);
    assert.ok((r.dados['avisos'] as { mensagem: string }[]).some((a) => /Pool Grupo/.test(a.mensagem)), 'o padrão de recuperação reclama, e a resposta diz');
    const depois = readFileSync(p.arquivo, 'utf8');
    assert.equal(lerAtribuicao(objeto(depois, 'task13')).mecanismo, 'MEC_STG_SUPORTE');

    const g = lerCondicoes(objeto(depois, 'exclusivegateway6')).condicoes;
    g[0]!.regras[0]!.valor = 'ok';
    assert.equal((await postar(v.url, 'conditions', { id: 'exclusivegateway6', condicoes: g, hash: hash(depois) })).status, 200);
    const velho = await postar(v.url, 'execution', { id: 'servicetask3', hash: e.hash });
    assert.equal(velho.status, 409);
    assert.equal((await postar(v.url, 'assignment', { id: 'task13', mecanismo: 'Pool Grupo', campos: 'x', hash: hash(readFileSync(p.arquivo, 'utf8')) })).status, 400);

    const html = await (await fetch(v.url)).text();
    assert.match(html, /Salvar atribuição/);
    assert.match(html, /Salvar condições/);
    assert.match(html, /Tornar automática/);
    assert.match(html, /"Pool Grupo":\["groupId"\]/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('copiar a fixture para o teste não altera nada', () => {
  // Sanidade: as fixtures continuam passando no diagram check.
  const p = mkdtempSync(join(tmpdir(), 'fluigctl-props-'));
  try {
    cpSync(fileURLToPath(new URL('./fixtures/diagrams/contratacao.process', import.meta.url)), join(p, 'c.process'));
    assert.deepEqual(checarDiagrama(readFileSync(join(p, 'c.process'), 'utf8')), []);
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});
