import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adicionarNoXml, blocosDeTopo, criarNoXml, ligarNoXml } from '../src/diagram/add.js';
import { checarDiagrama } from '../src/diagram/check.js';
import { desfazerUltimaEdicao, hash } from '../src/diagram/edit.js';
import { lerAtribuicao } from '../src/diagram/props.js';
import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';
import { converterDiagrama } from '../src/push/diagram/ecm30.js';

/**
 * Modo de edição, passo 4: criar elementos. O que se cria vai para o fim das
 * listas do pictograma (nada que existe muda de posição), clona uma forma do
 * mesmo tipo do arquivo e precisa passar no diagram check e na conversão do push.
 */

const fixture = (nome: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diagrams/${nome}`, import.meta.url)), 'utf8');
const CONTRATACAO = fixture('contratacao.process');
const STUDIO = fixture('studioTeste.process');
const objeto = (t: string, id: string) => lerDiagrama(t).objetos.find((o) => o.attrs['id'] === id);
const erros = (t: string) => checarDiagrama(t).filter((a) => a.nivel === 'erro');

test('criar cada tipo dá ids inéditos, formas no fim e nenhum erro de estrutura', () => {
  let xml = CONTRATACAO;
  const antes = blocosDeTopo(xml).blocos.filter((b) => b.tipo === 'children').length;
  const ids: string[] = [];
  for (const [i, tipo] of (['humana', 'servico', 'gateway', 'fim'] as const).entries()) {
    const r = adicionarNoXml(xml, { tipo, x: 300 + 160 * i, y: 500 });
    ids.push(...r.criados);
    xml = r.xml;
  }
  assert.deepEqual(ids, ['task37', 'servicetask38', 'exclusivegateway39', 'endevent40'], 'número depois do maior em uso (flow36)');
  const blocos = blocosDeTopo(xml).blocos.filter((b) => b.tipo === 'children');
  assert.equal(blocos.length, antes + 4);
  assert.deepEqual(blocos.slice(antes).map((b) => b.id), ids, 'no fim da lista');
  assert.deepEqual(checarDiagrama(xml).filter((a) => a.grupo === 'estrutura'), []);

  const st = objeto(xml, 'servicetask38')!;
  assert.equal(st.attrs['scriptFileName'], 'contratacao.servicetask38.js');
  assert.equal(st.attrs['executionType'], '1');
  assert.equal(st.attrs['incoming'], undefined);
  assert.equal(objeto(xml, 'exclusivegateway39')!.attrs['condition'], '<list/>');
  assert.equal(lerAtribuicao(objeto(xml, 'task37')!).mecanismo, '', 'não herda a atribuição do modelo');
  const c = lerDiagrama(xml).caixas.get('task37')!;
  assert.deepEqual([c.absX + c.largura / 2, c.absY + c.altura / 2], [300, 500], 'centrado no ponto');
  assert.equal(objeto(xml, 'task37')!.attrs['name'], 'Nova tarefa');
});

test('o que já existia continua byte a byte; só entram as linhas novas', () => {
  const { xml } = adicionarNoXml(CONTRATACAO, { tipo: 'fim', x: 400, y: 500, nome: 'Cancelado' });
  // O original aparece inteiro e na ordem dentro do novo: só houve inserção de linhas.
  const novo = xml.split('\n');
  const velho = CONTRATACAO.split('\n');
  let j = 0;
  for (const l of novo) if (j < velho.length && l === velho[j]) j++;
  assert.equal(j, velho.length, 'nenhuma linha antiga mudou');
  // A forma (12 linhas) e o estilo próprio dela, como o Studio grava (o do fim tem 32).
  assert.ok(novo.length - velho.length <= 45, `${novo.length - velho.length} linhas novas`);
  assert.equal(objeto(xml, 'endevent37')!.attrs['name'], 'Cancelado');
});

test('service task com recuperação cria o padrão inteiro, e ele passa no diagram check', () => {
  // Raia Aprovação, numa coluna livre.
  const r = adicionarNoXml(CONTRATACAO, { tipo: 'recuperacao', x: 260, y: 300, nome: 'Integrar RM' });
  const [st, ev, tr, f1, f2] = r.criados;
  assert.deepEqual(r.criados, ['servicetask37', 'intermediateerror39', 'task38', 'flow40', 'flow41']);
  const d = lerDiagrama(r.xml);
  assert.equal(objeto(r.xml, st!)!.attrs['attachedEvents'], ev);
  assert.equal(objeto(r.xml, ev!)!.attrs['parentTask'], st);
  assert.equal(objeto(r.xml, ev!)!.attrs['sequenceAttached'], '37');
  assert.deepEqual(lerAtribuicao(objeto(r.xml, tr!)!).campos, { groupId: 'suporte_processos' });
  assert.equal(objeto(r.xml, f1!)!.attrs['sourceRef'], ev);
  assert.equal(objeto(r.xml, f2!)!.attrs['targetRef'], st);
  assert.equal(objeto(r.xml, tr!)!.attrs['name'], 'Tratar erro: Integrar RM');
  // Geometria da receita: bolinha no canto, tratamento 33 px abaixo, mesma coluna.
  const cs = d.caixas.get(st!)!;
  const ce = d.caixas.get(ev!)!;
  const ct = d.caixas.get(tr!)!;
  // Evento de 35 px: o centro fica em meio pixel do canto, como no relayout.py.
  assert.ok(Math.abs(ce.absX + ce.largura / 2 - (cs.absX + cs.largura)) <= 1);
  assert.ok(Math.abs(ce.absY + ce.altura / 2 - (cs.absY + cs.altura)) <= 1);
  assert.equal(ct.absY, cs.absY + cs.altura + 33);
  assert.equal(ct.absX + ct.largura / 2, cs.absX + cs.largura / 2);
  assert.deepEqual(erros(r.xml).filter((a) => !a.onde.startsWith(st!)), []);
  // O padrão fecha; falta só a saída da service task, que o usuário liga depois.
  assert.deepEqual(
    checarDiagrama(r.xml, { grupo: 'suporte_processos' }).filter((a) => r.criados.some((id) => a.onde.startsWith(id))).map((a) => a.mensagem),
    ['sem saída: a solicitação que chegar aqui fica parada'],
  );
});

test('no formato do Studio, o clone reescreve as referências a si mesmo e herda os estilos', () => {
  const r = adicionarNoXml(STUDIO, { tipo: 'humana', x: 700, y: 120 });
  const id = r.criados[0]!;
  const bloco = blocosDeTopo(r.xml).blocos.find((b) => b.id === id)!;
  const texto = r.xml.slice(bloco.inicio, bloco.fim);
  assert.match(texto, new RegExp(`referencedGraphicsAlgorithm="/0/@children\\.${bloco.indice}/@graphicsAlgorithm"`));
  assert.match(texto, /style="\/0\/@styles\.\d+"/, 'mesmo estilo do Studio que a tarefa modelo usa');
  assert.deepEqual(checarDiagrama(r.xml).filter((a) => a.grupo === 'estrutura'), []);
  // O que o Studio lista em pictogramLinks ganha o link novo.
  const pl = /pictogramLinks="([^"]*)"/.exec(r.xml)?.[1];
  if (pl !== undefined) assert.ok(pl.split(' ').includes(`/0/@children.${bloco.indice}/@link`));
  // Sem gateway no arquivo? Tem: o Studio usa o dele. Sem service task: vem do modelo embutido.
  const s = adicionarNoXml(r.xml, { tipo: 'recuperacao', x: 400, y: 120 });
  assert.deepEqual(checarDiagrama(s.xml).filter((a) => a.grupo === 'estrutura'), []);
});

test('a criação não piora a conversão do push', () => {
  for (const base of [CONTRATACAO, STUDIO]) {
    let xml = base;
    for (const tipo of ['humana', 'gateway', 'fim', 'recuperacao'] as const) xml = adicionarNoXml(xml, { tipo, x: 330, y: 300 + (tipo === 'recuperacao' ? 0 : 0) }).xml;
    assert.doesNotThrow(() => converterDiagrama(xml, { companyId: 1, formId: 1 }));
  }
});

test('ligar dois elementos atualiza modelo, âncoras e conexões, e recusa o que não faz sentido', () => {
  const a = criarNoXml(CONTRATACAO, { tipo: 'humana', nome: 'A', x: 200, y: 450 });
  const b = criarNoXml(a.xml, { tipo: 'fim', nome: 'B', x: 400, y: 460 });
  const f = ligarNoXml(b.xml, a.id, b.id, 'segue');
  assert.equal(objeto(f.xml, a.id)!.attrs['outgoing'], f.id);
  assert.equal(objeto(f.xml, b.id)!.attrs['incoming'], f.id);
  assert.equal(objeto(f.xml, f.id)!.attrs['name'], 'segue');
  assert.deepEqual(checarDiagrama(f.xml).filter((x) => x.grupo === 'estrutura'), []);
  assert.throws(() => ligarNoXml(f.xml, a.id, b.id), /já existe um fluxo/);
  assert.throws(() => ligarNoXml(f.xml, b.id, a.id), /fim não tem saída/);
  assert.throws(() => ligarNoXml(f.xml, a.id, 'startevent1'), /início não tem entrada/);
  assert.throws(() => ligarNoXml(f.xml, a.id, a.id), /a si mesmo/);
  assert.throws(() => ligarNoXml(f.xml, a.id, 'bpmnswimlane2'), /ligam tarefas/);
});

test('renomear a service task leva junto os nomes gerados, e só eles', async () => {
  const { renomearElemento } = await import('../src/diagram/edit.js');
  const p = projeto();
  try {
    const r = adicionarNoXml(CONTRATACAO, { tipo: 'recuperacao', x: 260, y: 300 });
    writeFileSync(p.arquivo, r.xml);
    const [st, ev, tr] = r.criados;
    renomearElemento({ arquivo: p.arquivo, id: st!, nomeOriginal: 'Nova service task', nomeNovo: 'Integrar RM', undoDir: p.undo });
    let t = readFileSync(p.arquivo, 'utf8');
    assert.equal(objeto(t, tr!)!.attrs['name'], 'Tratar erro: Integrar RM');
    assert.equal(objeto(t, ev!)!.attrs['name'], 'Erro: Integrar RM');
    // Nome mudado à mão não acompanha mais.
    renomearElemento({ arquivo: p.arquivo, id: tr!, nomeOriginal: 'Tratar erro: Integrar RM', nomeNovo: 'Corrigir integração', undoDir: p.undo });
    renomearElemento({ arquivo: p.arquivo, id: st!, nomeOriginal: 'Integrar RM', nomeNovo: 'Integrar RM (NF)', undoDir: p.undo });
    t = readFileSync(p.arquivo, 'utf8');
    assert.equal(objeto(t, tr!)!.attrs['name'], 'Corrigir integração');
    assert.equal(objeto(t, ev!)!.attrs['name'], 'Erro: Integrar RM (NF)');
  } finally {
    p.limpar();
  }
});

test('posição fora da pool e tipo desconhecido são recusados', () => {
  assert.throws(() => adicionarNoXml(CONTRATACAO, { tipo: 'humana', x: 5000, y: 300 }), /fora da pool/);
  assert.throws(() => adicionarNoXml(CONTRATACAO, { tipo: 'nada' as never, x: 300, y: 300 }), /tipo desconhecido/);
  // Perto do fundo da raia Solicitante (até y=170): o tratamento cairia na raia de baixo.
  assert.throws(() => adicionarNoXml(CONTRATACAO, { tipo: 'recuperacao', x: 700, y: 120 }), /tratamento cairia na raia Aprova/);
  // A service task cabe; o tratamento, 33 px abaixo, sairia pela borda de baixo.
  assert.throws(() => adicionarNoXml(CONTRATACAO, { tipo: 'recuperacao', x: 300, y: 480 }), /tratamento ficaria fora da pool/);
});

function projeto(): { arquivo: string; undo: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-add-'));
  const arquivo = join(raiz, 'workflow/diagrams/contratacao.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, CONTRATACAO);
  return { arquivo, undo: join(raiz, 'undo'), registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

test('o visualizador cria pela rota add, e um desfazer tira tudo o que a criação pôs', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const r = await fetch(`${v.url}add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tipo: 'recuperacao', x: 260, y: 300, hash: hash(CONTRATACAO) }),
    });
    const dados = (await r.json()) as { ok: boolean; criados: string[] };
    assert.equal(r.status, 200);
    assert.equal(dados.criados.length, 5);
    assert.ok(objeto(readFileSync(p.arquivo, 'utf8'), dados.criados[0]!));
    desfazerUltimaEdicao(p.arquivo, p.undo);
    assert.equal(readFileSync(p.arquivo, 'utf8'), CONTRATACAO);
    const html = await (await fetch(v.url)).text();
    assert.match(html, /id="add-menu"/);
    assert.match(html, /Service task com recuperação/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('o esqueleto do script é JavaScript válido, ASCII e no padrão da skill', async () => {
  const { scriptDeServico } = await import('../src/diagram/add.js');
  const js = scriptDeServico('contratacao', 'servicetask37', 'Integração "RM" */ fim');
  assert.doesNotThrow(() => new Function(`${js}; return servicetask37;`), 'compila');
  assert.match(js, /^function servicetask37\(attempt, message\) \{/);
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(js), 'só ASCII, como a skill pede dos scripts do servidor');
  assert.match(js, /Integracao/);
  assert.doesNotMatch(js, /\*\/ fim/, 'o nome não fecha o comentário');
  assert.match(js, /log\.warn\("contratacao\.servicetask37: ainda nao implementada/);
  // Roda num hAPI de mentira: não lança e deixa o comentário na tarefa.
  const comentarios: string[] = [];
  const corpo = new Function('getValue', 'hAPI', 'log', `${js}; servicetask37(1, ''); return true;`);
  assert.equal(corpo(() => '1', { setTaskComments: (_u: string, _i: string, _s: number, m: string) => comentarios.push(m) }, { warn: () => undefined }), true);
  assert.equal(comentarios.length, 1);
});

test('criar service task grava o script em workflow/scripts, e desfazer e refazer cuidam dele', async () => {
  const p = projeto();
  const scripts = join(dirname(dirname(p.arquivo)), 'scripts');
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  const postar = async (rota: string, corpo: unknown) => {
    const r = await fetch(`${v.url}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    return (await r.json()) as Record<string, unknown>;
  };
  try {
    const r = await postar('add', { tipo: 'recuperacao', x: 260, y: 300, hash: hash(CONTRATACAO) });
    assert.deepEqual(r['scripts'], ['workflow/scripts/contratacao.servicetask37.js']);
    const caminho = join(scripts, 'contratacao.servicetask37.js');
    assert.match(readFileSync(caminho, 'utf8'), /function servicetask37/);

    const u = await postar('undo', {});
    assert.deepEqual(u['apagados'], ['contratacao.servicetask37.js']);
    assert.throws(() => readFileSync(caminho), /ENOENT/);
    const rr = await postar('redo', {});
    assert.deepEqual(rr['recriados'], ['contratacao.servicetask37.js']);

    // Script editado não some no desfazer.
    writeFileSync(caminho, readFileSync(caminho, 'utf8').replace('ainda nao implementada.', 'feito.'));
    const u2 = await postar('undo', {});
    assert.deepEqual(u2['mantidos'], ['contratacao.servicetask37.js']);
    assert.match(readFileSync(caminho, 'utf8'), /feito\./);

    // Arquivo que já existe não é sobrescrito.
    const r2 = await postar('add', { tipo: 'servico', x: 260, y: 300, hash: hash(readFileSync(p.arquivo, 'utf8')) });
    assert.deepEqual(r2['scriptsExistentes'], ['workflow/scripts/contratacao.servicetask37.js']);
    assert.match(readFileSync(caminho, 'utf8'), /feito\./);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('fora do layout workflow/diagrams, nenhum script é criado', async () => {
  const { scriptsDasCriadas } = await import('../src/diagram/add.js');
  const r = adicionarNoXml(CONTRATACAO, { tipo: 'servico', x: 260, y: 300 });
  assert.deepEqual(scriptsDasCriadas('/tmp/solto/contratacao.process', r.xml, r.criados), []);
  assert.equal(scriptsDasCriadas('/w/workflow/diagrams/contratacao.process', r.xml, r.criados)[0]!.caminho, '/w/workflow/scripts/contratacao.servicetask37.js');
});

test('ligar pela rota connect: a ligação nasce traçada, e de gateway avisa a condição', async () => {
  const p = projeto();
  // Uma tarefa solta à esquerda e outra abaixo, para a rota precisar de degrau.
  const a = criarNoXml(CONTRATACAO, { tipo: 'humana', nome: 'A', x: 120, y: 420 });
  const b = criarNoXml(a.xml, { tipo: 'humana', nome: 'B', x: 400, y: 470 });
  writeFileSync(p.arquivo, b.xml);
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  const postar = async (rota: string, corpo: unknown) => {
    const r = await fetch(`${v.url}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    return { status: r.status, dados: (await r.json()) as Record<string, unknown> };
  };
  try {
    const r = await postar('connect', { origem: a.id, destino: b.id, hash: hash(b.xml) });
    assert.equal(r.status, 200);
    const fluxo = (r.dados['criados'] as string[])[0]!;
    const depois = readFileSync(p.arquivo, 'utf8');
    const dobras = lerDiagrama(depois).dobras.get(fluxo)!;
    assert.equal(dobras.length, 2, 'degrau no meio do vão');
    assert.equal(dobras[0]!.x, dobras[1]!.x);
    assert.equal(r.dados['deGateway'], false);
    assert.deepEqual(checarDiagrama(depois).filter((x) => x.grupo === 'estrutura'), []);

    const g = await postar('connect', { origem: 'exclusivegateway6', destino: b.id, hash: hash(depois) });
    assert.equal(g.status, 200);
    assert.equal(g.dados['deGateway'], true);

    const fim = await postar('connect', { origem: 'endevent11', destino: b.id, hash: hash(readFileSync(p.arquivo, 'utf8')) });
    assert.equal(fim.status, 400);
    assert.match(String(fim.dados['mensagem']), /fim não tem saída/);

    const html = await (await fetch(v.url)).text();
    assert.match(html, /Ligar a…/);
    assert.match(html, /conector/);
    assert.match(html, /pedir\('connect'/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('o JavaScript da página do visualizador compila', async () => {
  // Ele é gerado dentro de uma template string: um \n mal escapado vira quebra de linha no meio de uma regex.
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const html = await (await fetch(v.url)).text();
    const js = html.split('<script>')[1]!.split('</script>')[0]!;
    assert.doesNotThrow(() => new Function(js));
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('ver script: lê o arquivo da service task, diz quando não existe e recusa o que não é service task', async () => {
  const { lerScript } = await import('../src/diagram/viewer.js');
  const p = projeto();
  try {
    const scripts = join(dirname(dirname(p.arquivo)), 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'contratacao.servicetask3.js'), 'function servicetask3(attempt, message) {}\n');
    assert.deepEqual(lerScript(p.arquivo, 'servicetask3'), {
      ok: true, caminho: 'workflow/scripts/contratacao.servicetask3.js', existe: true, conteudo: 'function servicetask3(attempt, message) {}\n',
    });
    assert.deepEqual(lerScript(p.arquivo, 'servicetask4'), { ok: true, caminho: 'workflow/scripts/contratacao.servicetask4.js', existe: false });
    assert.equal(lerScript(p.arquivo, 'task5').ok, false);
    const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
    try {
      const r = (await (await fetch(`${v.url}script?id=servicetask3`)).json()) as { conteudo: string };
      assert.match(r.conteudo, /function servicetask3/);
      assert.match(await (await fetch(v.url)).text(), /Ver script/);
    } finally {
      await v.fechar();
    }
  } finally {
    p.limpar();
  }
});

test('início, gateway paralelo e junção: ids no padrão do Studio, sem estilo emprestado, e o push converte', () => {
  let xml = CONTRATACAO;
  const ids: string[] = [];
  for (const [tipo, x] of [['inicio', 200], ['paralelo', 350], ['juncao', 500]] as const) {
    const r = adicionarNoXml(xml, { tipo, x, y: 480 });
    ids.push(r.criados[0]!);
    xml = r.xml;
  }
  assert.deepEqual(ids, ['startevent37', 'parallelgateway38', 'joingateway39']);
  assert.equal(objeto(xml, 'parallelgateway38')!.attrs['type'], '126');
  assert.equal(objeto(xml, 'joingateway39')!.attrs['type'], '127');
  assert.equal(objeto(xml, 'joingateway39')!.attrs['name'], 'Junção');
  // O modelo embutido dos paralelos vem de um diagrama do Studio, sem as referências de estilo dele.
  assert.deepEqual(checarDiagrama(xml).filter((a) => a.grupo === 'estrutura'), []);
  const p = ligarNoXml(xml, 'task2', 'parallelgateway38');
  assert.doesNotThrow(() => converterDiagrama(p.xml, { companyId: 1, formId: 1 }));
  assert.throws(() => ligarNoXml(p.xml, 'task2', 'startevent37'), /início não tem entrada/);
});
