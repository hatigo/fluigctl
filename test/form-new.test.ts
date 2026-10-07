import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { criarFormulario, lerCampo } from '../src/commands/form-new.js';
import { readForm } from '../src/push/form-source.js';

test('--field: nome, ! de obrigatório, tipo e rótulo (que pode ter dois-pontos)', () => {
  assert.deepEqual(lerCampo('cargo'), { nome: 'cargo', tipo: 'text', rotulo: 'cargo', obrigatorio: false });
  assert.deepEqual(lerCampo('valor!:number:Valor: em reais'), { nome: 'valor', tipo: 'number', rotulo: 'Valor: em reais', obrigatorio: true });
  assert.throws(() => lerCampo('1campo'), /letras, números e _/);
  assert.throws(() => lerCampo('campo:select'), /tipo "select" desconhecido/);
});

test('form new: a pasta como a do Studio, com validateForm para os obrigatórios, e o push form a lê', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'form-new-'));
  try {
    const criados = criarFormulario({
      nome: 'formPedido',
      titulo: 'Pedido <teste>',
      pasta: raiz,
      campos: [lerCampo('pedido!:text:Pedido'), lerCampo('obs:textarea:Observação')],
    });
    assert.deepEqual(criados.map((c) => c.slice(raiz.length + 1)), ['formPedido/formPedido.html', 'formPedido/events/validateForm.js']);
    const html = readFileSync(join(raiz, 'formPedido', 'formPedido.html'), 'utf8');
    assert.match(html, /<form name="form" role="form">/);
    assert.match(html, /fluig-style-guide\.min\.css/);
    assert.match(html, /<h3 class="panel-title">Pedido &lt;teste&gt;<\/h3>/);
    assert.match(html, /<label for="pedido">Pedido <span class="obrigatorio">\*<\/span><\/label>\s*<input type="text" class="form-control" id="pedido" name="pedido"/);
    assert.match(html, /<textarea class="form-control" id="obs" name="obs" rows="3"><\/textarea>/);
    const evento = readFileSync(join(raiz, 'formPedido', 'events', 'validateForm.js'), 'utf8');
    assert.match(evento, /\["pedido", "Pedido"\]/);
    assert.doesNotMatch(evento, /"obs"/);
    // O que o push form vai ler: o HTML como principal e o evento.
    const fonte = await readForm(join(raiz, 'formPedido'));
    assert.equal(fonte.eventos.length, 1);
    assert.throws(() => criarFormulario({ nome: 'formPedido', pasta: raiz, campos: [lerCampo('a')] }), /já existe/);
    // Sem obrigatório, sem pasta de eventos.
    criarFormulario({ nome: 'formLivre', pasta: raiz, campos: [lerCampo('a')] });
    assert.deepEqual(readdirSync(join(raiz, 'formLivre')), ['formLivre.html']);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('form new recusa nome inválido, campo repetido e formulário sem campo', () => {
  assert.throws(() => criarFormulario({ nome: 'form pedido', pasta: tmpdir(), campos: [lerCampo('a')] }), /nome de formulário inválido/);
  assert.throws(() => criarFormulario({ nome: 'formX', pasta: tmpdir(), campos: [lerCampo('a'), lerCampo('a!')] }), /campo repetido: a/);
  assert.throws(() => criarFormulario({ nome: 'formX', pasta: tmpdir(), campos: [] }), /pelo menos um --field/);
});
