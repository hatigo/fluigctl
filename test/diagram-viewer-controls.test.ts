import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arquivoDoRegistro, servirDiagrama, abrirVisualizador, fecharVisualizador } from '../src/diagram/viewer.js';

function projeto() {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-controles-'));
  const arquivo = join(raiz, 'workflow/diagrams/processoTeste.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  cpSync(fileURLToPath(new URL('./fixtures/diagrams/processoTeste.process', import.meta.url)), arquivo);
  return { raiz, arquivo, registro: join(raiz, 'estado'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

test('Atualizar e Encerrar ficam disponíveis também fora do modo de edição', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro });
  try {
    const html = await (await fetch(v.url)).text();
    assert.match(html, /id="refresh-viewer"[^>]*>Atualizar/);
    assert.match(html, /id="shutdown-viewer"[^>]*>Encerrar/);
    assert.match(html, /fetch\('refresh',\{method:'POST'\}\)/);
    assert.match(html, /fetch\('shutdown',\{method:'POST'\}\)/);
    assert.match(html, /events.close\(\)/);
    assert.doesNotMatch(html, /window.close\(\)/);
    assert.match(html, /Visualizador desconectado/);
    assert.match(html, /O diagrama não receberá mais atualizações/);
    assert.match(html, /Você pode fechar esta aba do navegador/);
    assert.match(html, /class="desconectado" role="status"/);
    assert.match(html, /Salve ou cancele as alterações/);
    assert.match(html, /O servidor local foi encerrado/);
  } finally { await v.fechar(); p.limpar(); }
});

test('atualizar relê e redesenha mesmo sem mudança; arquivo inválido preserva o SVG', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro });
  try {
    const original = readFileSync(p.arquivo, 'utf8');
    const revision = v.estado().revisao;
    const refresh = await fetch(`${v.url}refresh`, { method: 'POST' });
    assert.equal(refresh.status, 200);
    assert.equal(v.estado().revisao, revision + 1);
    const svg = v.estado().svg;
    writeFileSync(p.arquivo, '<xml quebrado');
    await fetch(`${v.url}refresh`, { method: 'POST' });
    assert.ok(v.estado().erro);
    assert.equal(v.estado().svg, svg);
    writeFileSync(p.arquivo, original);
    await fetch(`${v.url}refresh`, { method: 'POST' });
    assert.equal(v.estado().erro, undefined);
  } finally { await v.fechar(); p.limpar(); }
});

test('controles exigem token e origem local; GET não desliga o servidor', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, token: 'segredo', registroDir: p.registro });
  try {
    for (const route of ['refresh', 'shutdown']) {
      const noToken = await fetch(`http://127.0.0.1:${v.registro.port}/${route}`, { method: 'POST' });
      assert.equal(noToken.status, 404);
      const otherOrigin = await fetch(`${v.url}${route}`, { method: 'POST', headers: { origin: 'https://evil.example' } });
      assert.equal(otherOrigin.status, 403);
      const crossSite = await fetch(`${v.url}${route}`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(crossSite.status, 403);
    }
    assert.equal((await fetch(`${v.url}shutdown`)).status, 404);
    assert.equal((await fetch(`${v.url}state`)).status, 200);
  } finally { await v.fechar(); p.limpar(); }
});

test('Encerrar fecha HTTP e SSE, remove registro e pode ser chamado novamente', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro });
  try {
    const stream = await fetch(`${v.url}events`);
    const shutdown = await fetch(`${v.url}shutdown`, { method: 'POST', headers: { origin: new URL(v.url).origin } });
    assert.deepEqual(await shutdown.json(), { ok: true });
    await stream.text();
    await v.fechar();
    assert.equal(v.server.listening, false);
    assert.equal(existsSync(arquivoDoRegistro(p.arquivo, p.registro)), false);
    await assert.rejects(fetch(`${v.url}state`));
    await v.fechar();
  } finally { await v.fechar(); p.limpar(); }
});

test('encerrar pelo navegador termina também o processo de servidor em background', async () => {
  const p = projeto();
  let pid = 0;
  try {
    const v = await abrirVisualizador({ arquivo: p.arquivo, registroDir: p.registro, abrirNavegador: false,
      cli: fileURLToPath(new URL('../src/cli.js', import.meta.url)) });
    pid = v.registro.pid;
    const response = await fetch(`${v.url}shutdown`, { method: 'POST' });
    assert.equal(response.status, 200);
    await response.text();
    const deadline = Date.now() + 5000;
    let vivo = true;
    while (vivo && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { vivo = false; }
      if (vivo) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(vivo, false, 'servidor em background terminou');
    assert.equal(existsSync(arquivoDoRegistro(p.arquivo, p.registro)), false);
  } finally {
    await fecharVisualizador(p.arquivo, p.registro);
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* ja terminou */ } }
    p.limpar();
  }
});
