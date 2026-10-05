import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abrirVisualizador,
  arquivoDoRegistro,
  fecharVisualizador,
  lerEstadoInicial,
  servirDiagrama,
} from '../src/diagram/viewer.js';
import { ErroFluigctl } from '../src/errors.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/diagrams/processoTeste.process', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function projeto(): { raiz: string; arquivo: string; registro: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-viewer-'));
  const arquivo = join(raiz, 'workflow/diagrams/processoTeste.process');
  const registro = join(raiz, 'estado');
  mkdirSync(dirname(arquivo), { recursive: true });
  cpSync(FIXTURE, arquivo);
  return { raiz, arquivo, registro, limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

async function esperar(condicao: () => boolean, ms = 5000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((ok) => setTimeout(ok, 30));
  }
  assert.fail('a mudança não apareceu dentro do prazo');
}

test('estado inicial vem diretamente do .process e contém SVG', () => {
  const e = lerEstadoInicial(FIXTURE);
  assert.equal(e.nome, 'processoTeste');
  assert.equal(e.revisao, 1);
  assert.match(e.svg, /^<\?xml[^>]*>\n<svg/);
  assert.match(e.svg, /sequence="4"/);
  assert.ok(e.elementos.length > 0);
  const tarefa = e.elementos.find((x) => x.id === 'task5')!;
  assert.equal(tarefa.tipoAmigavel, 'Atividade de usuário');
  assert.deepEqual(tarefa.campos.find((x) => x.rotulo === 'Atribuição'), { rotulo: 'Atribuição', valor: 'Pool Grupo' });
  assert.deepEqual(tarefa.campos.find((x) => x.rotulo === 'Configurações avançadas'), { rotulo: 'Configurações avançadas', valor: 'Presentes' });
  assert.equal(tarefa.atributos['extendedFields'], undefined, 'XML interno nem é enviado ao navegador');
  assert.equal(Object.values(tarefa.atributos).some((v) => /^\s*</.test(v)), false);
  assert.deepEqual(tarefa.geometria.caixa, { x: 150, y: 53, largura: 106, altura: 67 });

  const fluxo = e.elementos.find((x) => x.id === 'flow10')!;
  assert.equal(fluxo.tipoAmigavel, 'Fluxo');
  assert.equal(fluxo.campos.some((x) => x.rotulo === 'Configurações avançadas'), false, '<list/> vazio não conta');
  assert.match(fluxo.campos.find((x) => x.rotulo === 'Origem')!.valor, /Preencher > revisar \(task5\)/);
  assert.match(fluxo.campos.find((x) => x.rotulo === 'Destino')!.valor, /Revisar \(task7\)/);
  assert.ok((fluxo.geometria.pontos?.length ?? 0) >= 2);
  assert.deepEqual(fluxo.geometria.pontos?.[0], { x: 203, y: 120 }, 'mesma borda que o SVG, não o centro da tarefa');
  assert.equal(e.elementos.some((x) => x.id === 'processoTeste'), false, 'objeto sem desenho não entra no Tab');
});

test('arquivo ausente e .process inválido recusam antes de abrir porta', () => {
  assert.throws(
    () => lerEstadoInicial('/nao/existe.process'),
    (e: unknown) => e instanceof ErroFluigctl && e.codigo === 3 && /não encontrado/.test(e.message),
  );
  const p = projeto();
  try {
    writeFileSync(p.arquivo, '<quebrado>');
    assert.throws(
      () => lerEstadoInicial(p.arquivo),
      (e: unknown) => e instanceof ErroFluigctl && e.codigo === 6 && /não consegui abrir/.test(e.message),
    );
  } finally { p.limpar(); }
});

test('servidor exige token, não habilita CORS e entrega a interface navegável', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, token: 'segredo', registroDir: p.registro });
  try {
    const semToken = await fetch(`http://127.0.0.1:${v.registro.port}/state`);
    assert.equal(semToken.status, 404);
    assert.equal(semToken.headers.get('access-control-allow-origin'), null);

    const pagina = await fetch(v.url);
    const html = await pagina.text();
    assert.equal(pagina.status, 200);
    assert.match(html, /processoTeste/);
    assert.match(html, /Ajustar/);
    assert.match(html, /addEventListener\('wheel'/, 'zoom');
    assert.match(html, /pointermove/, 'pan');
    assert.match(html, /Detalhes técnicos/);
    assert.match(html, /classList\.add\('fluig-hit'/, 'camada selecionável');
    assert.match(html, /tabindex/, 'navegação por teclado');
    assert.match(html, /O elemento selecionado foi removido/);
    assert.match(pagina.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

    const estado = await (await fetch(`${v.url}state`)).json() as { arquivo: string; svg: string };
    assert.equal(estado.arquivo, p.arquivo);
    assert.match(estado.svg, /<svg/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('mudança válida atualiza; mudança inválida e arquivo ausente preservam o último SVG', async () => {
  const p = projeto();
  const original = readFileSync(p.arquivo, 'utf8');
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro });
  try {
    const svg1 = v.estado().svg;
    writeFileSync(p.arquivo, original.replaceAll('Aprova&#xe7;&#xe3;o', 'Revisão pelo agente'));
    await esperar(() => v.estado().svg.includes('Revisão pelo agente'));
    assert.equal(v.estado().elementos.find((x) => x.id === 'bpmnswimlane9')?.nome, 'Revisão pelo agente');
    const svg2 = v.estado().svg;
    assert.notEqual(svg2, svg1);
    assert.equal(v.estado().erro, undefined);

    writeFileSync(p.arquivo, '<xmi:XMI');
    await esperar(() => v.estado().erro !== undefined);
    assert.equal(v.estado().svg, svg2, 'último desenho válido continua na tela');

    rmSync(p.arquivo);
    await esperar(() => v.estado().erro === 'arquivo não encontrado');
    assert.equal(v.estado().svg, svg2);

    writeFileSync(p.arquivo, original);
    await esperar(() => v.estado().erro === undefined);
    assert.equal(v.estado().revisao, 3, 'só versões válidas avançam a revisão');
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('registro é privado, determinístico e some ao fechar o servidor', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro });
  const caminho = arquivoDoRegistro(p.arquivo, p.registro);
  try {
    assert.ok(existsSync(caminho));
    assert.equal(arquivoDoRegistro(p.arquivo, p.registro), caminho);
    const modo = (await import('node:fs')).statSync(caminho).mode & 0o777;
    assert.equal(modo, 0o600);
  } finally {
    await v.fechar();
  }
  assert.ok(!existsSync(caminho));
  p.limpar();
});

test('open em segundo plano retorna, reutiliza a instância e close a encerra', async () => {
  const p = projeto();
  let pid: number | undefined;
  try {
    const primeira = await abrirVisualizador({
      arquivo: p.arquivo,
      abrirNavegador: false,
      registroDir: p.registro,
      cli: CLI,
    });
    pid = primeira.registro.pid;
    assert.equal(primeira.reutilizada, false);
    assert.ok(pid !== process.pid, 'é outro processo');
    assert.match(await (await fetch(primeira.url)).text(), /fluigctl/);

    const segunda = await abrirVisualizador({
      arquivo: p.arquivo,
      abrirNavegador: false,
      registroDir: p.registro,
      cli: CLI,
    });
    assert.equal(segunda.reutilizada, true);
    assert.equal(segunda.registro.pid, pid);

    const fechado = await fecharVisualizador(p.arquivo, p.registro);
    assert.equal(fechado?.pid, pid);
    await esperar(() => {
      try { process.kill(pid!, 0); return false; } catch { return true; }
    });
    assert.ok(!existsSync(arquivoDoRegistro(p.arquivo, p.registro)));
    pid = undefined;
  } finally {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* já saiu */ }
    }
    p.limpar();
  }
});

test('close não mata o PID de um registro adulterado', async () => {
  const p = projeto();
  try {
    const registro = arquivoDoRegistro(p.arquivo, p.registro);
    mkdirSync(dirname(registro), { recursive: true });
    writeFileSync(registro, JSON.stringify({
      version: 1,
      arquivo: p.arquivo,
      pid: process.pid,
      port: 9,
      token: 'nao-e-o-servidor',
      iniciadoEm: new Date().toISOString(),
    }));
    const fechado = await fecharVisualizador(p.arquivo, p.registro);
    assert.equal(fechado?.pid, process.pid);
    assert.ok(!existsSync(registro));
    assert.ok(true, 'se chegou aqui, não matou o processo de testes');
  } finally { p.limpar(); }
});
