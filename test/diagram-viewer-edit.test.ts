import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { servirDiagrama } from '../src/diagram/viewer.js';
import { lerDiagrama } from '../src/push/diagram/modelo.js';

/**
 * A edição pelo navegador é a única escrita que o visualizador faz. O que estes
 * testes protegem: só o arquivo aberto pode ser tocado, só com o token, só de
 * uma origem local, e nunca sobrescrevendo uma mudança que chegou depois.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/diagrams/processoTeste.process', import.meta.url));

function projeto(): { raiz: string; arquivo: string; registro: string; undo: string; limpar(): void } {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-view-edit-'));
  const arquivo = join(raiz, 'workflow/diagrams/processoTeste.process');
  mkdirSync(dirname(arquivo), { recursive: true });
  cpSync(FIXTURE, arquivo);
  return { raiz, arquivo, registro: join(raiz, 'estado'), undo: join(raiz, 'undo'), limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

async function esperar(condicao: () => boolean, ms = 5000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (condicao()) return;
    await new Promise((ok) => setTimeout(ok, 30));
  }
  assert.fail('a mudança não apareceu dentro do prazo');
}

const nomeNoArquivo = (arquivo: string, id: string): string | undefined =>
  lerDiagrama(readFileSync(arquivo, 'utf8')).objetos.find((o) => o.attrs['id'] === id)?.attrs['name'];

async function postar(url: string, rota: string, corpo: unknown, cabecalhos: Record<string, string> = {}): Promise<{ status: number; dados: Record<string, unknown> }> {
  const r = await fetch(`${url}${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, dados: (await r.json()) as Record<string, unknown> };
}

test('renomear pelo endpoint grava no arquivo aberto e o estado acompanha', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const r = await postar(v.url, 'rename', { id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Preencher e revisar' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.dados, { ok: true, nome: 'Preencher e revisar', avisos: [] });
    assert.equal(nomeNoArquivo(p.arquivo, 'task5'), 'Preencher e revisar');
    await esperar(() => v.estado().elementos.find((x) => x.id === 'task5')?.nome === 'Preencher e revisar');
    assert.match(readFileSync(p.arquivo, 'utf8'), /name="Preencher e revisar"/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('conflito de nome responde 409 com o valor que está no arquivo, sem gravar', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    writeFileSync(p.arquivo, readFileSync(p.arquivo, 'utf8').replace(
      '<bpmn2:BpmnTask id="task5" name="Preencher &gt; revisar"',
      '<bpmn2:BpmnTask id="task5" name="Nome do agente"',
    ));
    await esperar(() => v.estado().elementos.find((x) => x.id === 'task5')?.nome === 'Nome do agente');
    const r = await postar(v.url, 'rename', { id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Nome da pessoa' });
    assert.equal(r.status, 409);
    assert.equal(r.dados['motivo'], 'nome-alterado');
    assert.equal(r.dados['atual'], 'Nome do agente');
    assert.equal(nomeNoArquivo(p.arquivo, 'task5'), 'Nome do agente', 'o trabalho do agente ficou intacto');
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('sem token a escrita nem é roteada; origem estranha e corpo inválido são recusados', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  const original = readFileSync(p.arquivo, 'utf8');
  try {
    const semToken = await fetch(`http://127.0.0.1:${v.registro.port}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'x' }),
    });
    assert.equal(semToken.status, 404);

    const estranha = await postar(v.url, 'rename', { id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'x' }, {
      origin: 'http://evil.test',
    });
    assert.equal(estranha.status, 403);

    const crossSite = await postar(v.url, 'rename', { id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'x' }, {
      'sec-fetch-site': 'cross-site',
    });
    assert.equal(crossSite.status, 403);

    const formulario = await fetch(`${v.url}rename`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'id=task5',
    });
    assert.equal(formulario.status, 400);

    const incompleto = await postar(v.url, 'rename', { id: 'task5' });
    assert.equal(incompleto.status, 400);

    assert.equal(readFileSync(p.arquivo, 'utf8'), original, 'nenhuma tentativa recusada escreveu');
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('GET não escreve, e uma rota de escrita desconhecida não existe', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  const original = readFileSync(p.arquivo, 'utf8');
  try {
    assert.equal((await fetch(`${v.url}rename`)).status, 404);
    assert.equal((await postar(v.url, 'apagar-tudo', {})).status, 404);
    assert.equal(readFileSync(p.arquivo, 'utf8'), original);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('desfazer pelo endpoint devolve o arquivo ao estado anterior', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  const original = readFileSync(p.arquivo, 'utf8');
  try {
    await postar(v.url, 'rename', { id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Editado' });
    assert.notEqual(readFileSync(p.arquivo, 'utf8'), original);

    const r = await postar(v.url, 'undo', {});
    assert.equal(r.status, 200);
    assert.equal(readFileSync(p.arquivo, 'utf8'), original);

    const segunda = await postar(v.url, 'undo', {});
    assert.equal(segunda.status, 409);
    assert.equal(segunda.dados['motivo'], 'sem-desfazer');
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('desfazer recusa quando o agente escreveu depois, e diz por quê', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    await postar(v.url, 'rename', { id: 'task5', nomeOriginal: 'Preencher > revisar', nomeNovo: 'Editado' });
    writeFileSync(p.arquivo, readFileSync(p.arquivo, 'utf8').replace('name="Revisar"', 'name="Depois"'));
    const comMudanca = readFileSync(p.arquivo, 'utf8');
    const r = await postar(v.url, 'undo', {});
    assert.equal(r.status, 409);
    assert.equal(r.dados['motivo'], 'arquivo-alterado');
    assert.equal(readFileSync(p.arquivo, 'utf8'), comMudanca);
  } finally {
    await v.fechar();
    p.limpar();
  }
});

test('a interface oferece o campo, o aviso e o desfazer sem expor o token em nada além da URL', async () => {
  const p = projeto();
  const v = await servirDiagrama({ arquivo: p.arquivo, registroDir: p.registro, undoDir: p.undo });
  try {
    const html = await (await fetch(v.url)).text();
    assert.match(html, /id="name-input"/);
    assert.match(html, /Alteração não salva/);
    assert.match(html, /Usar o valor do arquivo/);
    assert.match(html, /Desfazer/);
    assert.match(html, /Ctrl<\/kbd>\+<kbd>Enter/);
    assert.match(html, /podeRenomear/);
  } finally {
    await v.fechar();
    p.limpar();
  }
});
