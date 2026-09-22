import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { readForm } from '../src/push/form-source.js';

function pasta(nome: string): string {
  return fileURLToPath(new URL(`./fixtures/forms/${nome}`, import.meta.url));
}

test('readForm tira o nome do formulário da pasta', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  assert.equal(form.nome, 'formSolicitacaoCompras');
});

test('readForm remove o prefixo de documentId do nome da pasta', async () => {
  const form = await readForm(pasta('721291 - Aprovadores'));

  assert.equal(form.nome, 'Aprovadores');
  assert.equal(form.documentIdDaPasta, 721291);
});

test('readForm não inventa documentId quando a pasta não tem prefixo', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  assert.equal(form.documentIdDaPasta, undefined);
});

test('readForm exclui o .metadata dos anexos', async () => {
  // É arquivo do plugin do Eclipse. A extensão Fluiggers pode publicá-lo junto
  // com o formulário; aqui ele fica de fora de propósito.
  const form = await readForm(pasta('formSolicitacaoCompras'));

  assert.equal(form.anexos.some((a) => a.fileName.includes('.metadata')), false);
});

test('readForm exclui a pasta events dos anexos', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  assert.equal(form.anexos.some((a) => a.fileName.includes('events')), false);
});

test('readForm manda os anexos com tamanho em bytes crus e conteúdo em base64', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  const css = form.anexos.find((a) => a.fileName === 'style.css')!;
  assert.equal(css.fileSize, Buffer.byteLength('.campo { color: red; }\n'));
  assert.equal(Buffer.from(css.filecontent, 'base64').toString(), '.campo { color: red; }\n');
});

test('readForm marca como principal o único html da raiz', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  const principais = form.anexos.filter((a) => a.principal);
  assert.equal(principais.length, 1);
  assert.equal(principais[0]!.fileName, 'formSolicitacaoCompras.html');
});

test('readForm aceita html com nome diferente da pasta', async () => {
  const form = await readForm(pasta('721291 - Aprovadores'));

  assert.equal(form.anexos.find((a) => a.principal)!.fileName, 'formInternoAprovadores.html');
});

test('readForm preserva o caminho relativo dos assets em subpasta', async () => {
  const form = await readForm(pasta('formEditalFiart'), { permitirSubpastas: true });

  const nomes = form.anexos.map((a) => a.fileName).sort();
  assert.deepEqual(nomes, ['css/style.css', 'formEditalFiart.html', 'js/lib/select2.min.js']);
});

test('readForm desempata dois html pelo que tem o nome da pasta', () => {
  // Sinal forte e é a regra que a extensão Fluiggers usa. Onze pastas reais
  // têm dois .html; recusar todas seria atrapalhar sem ganhar segurança.
  return readForm(pasta('formAmbiguo')).then((form) => {
    assert.equal(form.anexos.find((a) => a.principal)!.fileName, 'formAmbiguo.html');
  });
});

test('readForm recusa escolher quando nenhum html tem o nome da pasta', async () => {
  // Sem sinal nenhum, publicar o principal errado reescreve a estrutura do
  // formulário no servidor. Melhor parar e perguntar.
  await assert.rejects(() => readForm(pasta('formSemSinal')), /--principal/);
});

test('readForm aceita --principal para desempatar', async () => {
  const form = await readForm(pasta('formAmbiguo'), { principal: 'outro.html' });

  assert.equal(form.anexos.find((a) => a.principal)!.fileName, 'outro.html');
});

test('readForm recusa principal que não existe na pasta', async () => {
  await assert.rejects(
    () => readForm(pasta('formAmbiguo'), { principal: 'inexistente.html' }),
    /inexistente\.html/,
  );
});

test('readForm avisa quando não há html nenhum', async () => {
  await assert.rejects(() => readForm(pasta('formSemHtml')), /nenhum arquivo \.html/i);
});

test('readForm lê os eventos como texto puro, não base64', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  const display = form.eventos.find((e) => e.eventId === 'displayFields')!;
  assert.equal(display.eventDescription, 'function displayFields(form, customHTML) {}\n');
  assert.equal(display.eventVersAnt, false);
});

test('readForm devolve todos os eventos da pasta events', async () => {
  const form = await readForm(pasta('formSolicitacaoCompras'));

  assert.deepEqual(form.eventos.map((e) => e.eventId).sort(), ['displayFields', 'validateForm']);
});

test('readForm devolve lista de eventos vazia quando não há pasta events', async () => {
  const form = await readForm(pasta('formEditalFiart'), { permitirSubpastas: true });

  assert.deepEqual(form.eventos, []);
});

test('readForm avisa quando a pasta não existe', async () => {
  await assert.rejects(() => readForm(pasta('naoExiste')), /não encontrei/i);
});

test('readForm aponta o html que existe em subpasta quando não há na raiz', async () => {
  // Caso real: "Cadastro Unidades" guarda o html em Diretorias/. Dizer só
  // "não há html" manda o usuário procurar um arquivo que existe.
  const erro = await readForm(pasta('formHtmlEmSubpasta')).catch((e: Error) => e);

  assert.ok(erro instanceof Error);
  assert.match(erro.message, /Diretorias\/formDiretorias\.html/);
});

test('readForm recusa anexo em subpasta, que o servidor não aceita', async () => {
  // Medido no homolog da CETENCO: enviar fileName com "/" faz o servidor
  // responder "O sistema não pode encontrar o caminho especificado". Falhar
  // aqui poupa a viagem e diz o que fazer.
  const erro = await readForm(pasta('formEditalFiart')).catch((e: Error) => e);

  assert.ok(erro instanceof Error);
  assert.match(erro.message, /js\/lib\/select2\.min\.js/);
  assert.match(erro.message, /subpasta/i);
});

test('readForm aceita subpasta quando se pede explicitamente', async () => {
  const form = await readForm(pasta('formEditalFiart'), { permitirSubpastas: true });

  assert.equal(form.anexos.length, 3);
});

test('readForm recusa html principal sem tag form', async () => {
  // O servidor responde "Formulário não possui tag form". Pré-checar evita
  // publicar pela metade e dá a mensagem no lugar certo.
  const erro = await readForm(pasta('formSemTagForm')).catch((e: Error) => e);

  assert.ok(erro instanceof Error);
  assert.match(erro.message, /tag <form>/i);
});
