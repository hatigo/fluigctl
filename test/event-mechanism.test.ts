import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eventIdDoArquivo, pushEvent } from '../src/commands/push-event.js';
import { mecanismoIdDoArquivo, pushMechanism } from '../src/commands/push-mechanism.js';
import { pullEvent, pullMechanism } from '../src/commands/pull.js';
import type { EventoGlobal, GlobalEventClient } from '../src/fluig/global-event-service.js';
import type { Mecanismo, MecanismoBruto, MechanismClient } from '../src/fluig/mechanism-service.js';
import { MECANISMO_NOVO } from '../src/fluig/mechanism-service.js';
import { ErroFluigctl } from '../src/errors.js';
import type { Server } from '../src/config.js';

const SERVER: Server = {
  host: 'fluig.local', port: 8080, ssl: false, username: 'integracao',
  companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
};

const codigoDe = (erro: unknown) => (erro as ErroFluigctl).codigo;
const semPrompt = async () => 's';

/** Um servidor de eventos global em memória, com a semântica medida: gravar substitui a lista. */
function fakeEventos(inicial: EventoGlobal[]) {
  let lista = [...inicial];
  const gravacoes: EventoGlobal[][] = [];
  const cliente: GlobalEventClient = {
    listar: async () => [...lista],
    gravar: async (nova) => {
      gravacoes.push([...nova]);
      lista = [...nova];
    },
    remover: async (id) => {
      lista = lista.filter((e) => e.eventId !== id);
    },
  };
  return { cliente, gravacoes, atuais: () => lista };
}

function repo(): string {
  return mkdtempSync(join(tmpdir(), 'fluigctl-eventos-'));
}

test('push event manda a lista inteira, preservando os eventos que já estavam no servidor', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'events', 'novoEvento.js');
  mkdirSync(join(raiz, 'events'), { recursive: true });
  writeFileSync(arquivo, 'function novoEvento() {}\n');

  const f = fakeEventos([
    { eventId: 'antes', codigo: '// antes\n' },
    { eventId: 'depois', codigo: '// depois\n' },
  ]);
  const r = await pushEvent({ server: SERVER, senha: 's', arquivo, prompt: semPrompt, cliente: f.cliente });

  assert.equal(r.eventId, 'novoEvento');
  assert.equal(r.novo, true);
  assert.equal(r.eventos, 3);
  assert.equal(r.conferido, true);
  // O que importa: a gravação levou os três. Mandar só o nosso apagaria os outros.
  assert.deepEqual(f.gravacoes[0]!.map((e) => e.eventId), ['antes', 'depois', 'novoEvento']);
  assert.deepEqual(f.atuais().map((e) => e.eventId).sort(), ['antes', 'depois', 'novoEvento']);
});

test('push event num evento existente troca só ele, mantendo a posição na lista', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'events', 'meio.js');
  mkdirSync(join(raiz, 'events'), { recursive: true });
  writeFileSync(arquivo, '// novo código\n');

  const f = fakeEventos([
    { eventId: 'a', codigo: '// a\n' },
    { eventId: 'meio', codigo: '// velho\n' },
    { eventId: 'z', codigo: '// z\n' },
  ]);
  const r = await pushEvent({ server: SERVER, senha: 's', arquivo, prompt: semPrompt, cliente: f.cliente });

  assert.equal(r.novo, false);
  assert.equal(r.jaIgual, false);
  assert.deepEqual(f.gravacoes[0]!.map((e) => e.eventId), ['a', 'meio', 'z']);
  assert.equal(f.atuais()[1]!.codigo, '// novo código\n');
});

test('push event em dry-run não grava nada e diz com quantos eventos o servidor ficaria', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'events', 'x.js');
  mkdirSync(join(raiz, 'events'), { recursive: true });
  writeFileSync(arquivo, '// x\n');

  const f = fakeEventos([{ eventId: 'y', codigo: '// y\n' }]);
  const r = await pushEvent({ server: SERVER, senha: 's', arquivo, dryRun: true, prompt: semPrompt, cliente: f.cliente });

  assert.equal(r.eventos, 2);
  assert.equal(r.novo, true);
  assert.equal(f.gravacoes.length, 0);
  assert.deepEqual(f.atuais().map((e) => e.eventId), ['y']);
});

test('push event reconhece o código igual ao do servidor', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'events', 'igual.js');
  mkdirSync(join(raiz, 'events'), { recursive: true });
  writeFileSync(arquivo, 'function igual() {}\n');

  const f = fakeEventos([{ eventId: 'igual', codigo: 'function igual() {}\r\n' }]);
  const r = await pushEvent({ server: SERVER, senha: 's', arquivo, prompt: semPrompt, cliente: f.cliente });
  assert.equal(r.jaIgual, true);
});

test('push event avisa quando o servidor aceita mas devolve outro código', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'events', 'some.js');
  mkdirSync(join(raiz, 'events'), { recursive: true });
  writeFileSync(arquivo, '// enviado\n');

  const cliente: GlobalEventClient = {
    listar: async () => [{ eventId: 'some', codigo: '// outra coisa\n' }], // o servidor nunca guarda o que mandamos
    gravar: async () => {},
    remover: async () => {},
  };
  const r = await pushEvent({ server: SERVER, senha: 's', arquivo, prompt: semPrompt, cliente });
  assert.equal(r.conferido, false);
});

test('eventId vem do nome do arquivo; arquivo sem .js é recusado', () => {
  assert.equal(eventIdDoArquivo('/a/b/events/afterProcessCreate.js'), 'afterProcessCreate');
  assert.equal(eventIdDoArquivo('events/x.js'), 'x');
  assert.throws(() => eventIdDoArquivo('events/x.txt'), (e) => codigoDe(e) === 6);
});

test('um mecanismo novo exige --create, e o create usa os valores da extensão', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'mechanisms', 'MEC_NOVO.js');
  mkdirSync(join(raiz, 'mechanisms'), { recursive: true });
  writeFileSync(arquivo, 'function resolve(process, colleague) {}\n');

  const criados: MecanismoBruto[] = [];
  const lista: Mecanismo[] = [];
  const cliente: MechanismClient = {
    listar: async () => [...lista],
    criar: async (m) => {
      criados.push(m);
      lista.push({ mecanismoId: 'MEC_NOVO', codigo: String(m['attributionMecanismDescription']), nome: String(m['name']), descricao: String(m['description']), bruto: m });
    },
    atualizar: async () => {},
  };

  await assert.rejects(
    pushMechanism({ server: SERVER, senha: 's', arquivo, prompt: semPrompt, cliente }),
    (e) => codigoDe(e) === 6 && /repita com --create/.test((e as Error).message),
  );
  assert.equal(criados.length, 0);

  const r = await pushMechanism({ server: SERVER, senha: 's', arquivo, criar: true, nome: 'Alçadas', prompt: semPrompt, cliente });
  assert.equal(r.acao, 'create');
  assert.equal(r.nome, 'Alçadas');
  // Sem --description, vale o nome; sem --name, valeria o id.
  assert.equal(r.descricao, 'Alçadas');
  assert.deepEqual(criados[0]!.attributionMecanismPK, { companyId: 1, attributionMecanismId: 'MEC_NOVO' });
  assert.equal(criados[0]!.controlClass, MECANISMO_NOVO.controlClass);
  assert.equal(criados[0]!.assignmentType, 1);
  assert.equal(r.conferido, true);
});

test('push mechanism no update manda o objeto do servidor com só o código trocado', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'mechanisms', 'MEC_STG_ALCADAS.js');
  mkdirSync(join(raiz, 'mechanisms'), { recursive: true });
  writeFileSync(arquivo, '// código novo\n');

  const bruto: MecanismoBruto = {
    attributionMecanismPK: { companyId: 1, attributionMecanismId: 'MEC_STG_ALCADAS' },
    name: 'Alçadas do STG',
    description: 'Resolve por nível',
    controlClass: 'com.datasul.CustomAssignmentImpl',
    assignmentType: 1,
    configurationClass: 'config.Que.Existe',
    preSelectionClass: 'pre.Que.Existe',
    campoDesconhecido: 'não pode sumir',
    attributionMecanismDescription: '// velho\n',
  };
  const atualizados: MecanismoBruto[] = [];
  const cliente: MechanismClient = {
    listar: async () => [{ mecanismoId: 'MEC_STG_ALCADAS', codigo: '// velho\n', nome: 'Alçadas do STG', descricao: 'Resolve por nível', bruto }],
    criar: async () => {},
    atualizar: async (m) => {
      atualizados.push(m);
    },
  };

  const r = await pushMechanism({ server: SERVER, senha: 's', arquivo, prompt: semPrompt, cliente });
  assert.equal(r.acao, 'update');
  assert.equal(r.jaIgual, false);

  const enviado = atualizados[0]!;
  assert.equal(enviado['attributionMecanismDescription'], '// código novo\n');
  // Nada do servidor é adivinhado nem perdido.
  assert.equal(enviado['configurationClass'], 'config.Que.Existe');
  assert.equal(enviado['preSelectionClass'], 'pre.Que.Existe');
  assert.equal(enviado['campoDesconhecido'], 'não pode sumir');
  assert.equal(enviado['name'], 'Alçadas do STG');
  assert.equal(enviado['description'], 'Resolve por nível');
});

test('--name e --description mudam o que o update manda', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'mechanisms', 'm.js');
  mkdirSync(join(raiz, 'mechanisms'), { recursive: true });
  writeFileSync(arquivo, '// x\n');

  const atualizados: MecanismoBruto[] = [];
  const bruto: MecanismoBruto = { name: 'Antigo', description: 'Antiga', attributionMecanismDescription: '// x\n' };
  const cliente: MechanismClient = {
    listar: async () => [{ mecanismoId: 'm', codigo: '// x\n', nome: 'Antigo', descricao: 'Antiga', bruto }],
    criar: async () => {},
    atualizar: async (m) => { atualizados.push(m); },
  };
  await pushMechanism({ server: SERVER, senha: 's', arquivo, nome: 'Novo', descricao: 'Nova', prompt: semPrompt, cliente });
  assert.equal(atualizados[0]!['name'], 'Novo');
  assert.equal(atualizados[0]!['description'], 'Nova');
});

test('mecanismoId vem do nome do arquivo, mesmo em subpasta', () => {
  assert.equal(mecanismoIdDoArquivo('mechanisms/MEC_STG_ALCADAS.js'), 'MEC_STG_ALCADAS');
  assert.equal(mecanismoIdDoArquivo('mechanisms/Homologação Nuvem/mac_aprovacao.js'), 'mac_aprovacao');
  assert.throws(() => mecanismoIdDoArquivo('mechanisms/x'), (e) => codigoDe(e) === 6);
});

test('push mechanism em dry-run não escreve e recusa criar sem --create', async () => {
  const raiz = repo();
  const arquivo = join(raiz, 'mechanisms', 'MEC_NOVO.js');
  mkdirSync(join(raiz, 'mechanisms'), { recursive: true });
  writeFileSync(arquivo, '// x\n');

  let escreveu = false;
  const cliente: MechanismClient = {
    listar: async () => [],
    criar: async () => { escreveu = true; },
    atualizar: async () => { escreveu = true; },
  };
  await assert.rejects(
    pushMechanism({ server: SERVER, senha: 's', arquivo, dryRun: true, prompt: semPrompt, cliente }),
    (e) => codigoDe(e) === 6,
  );
  const r = await pushMechanism({ server: SERVER, senha: 's', arquivo, criar: true, dryRun: true, prompt: semPrompt, cliente });
  assert.equal(r.acao, 'create');
  assert.equal(escreveu, false);
});

test('pull event grava events/<id>.js e, sem id, traz todos', async () => {
  const raiz = repo();
  const f = fakeEventos([
    { eventId: 'beforeStateEntry', codigo: '// b\n' },
    { eventId: 'afterProcessCreate', codigo: '// a\n' },
  ]);

  const r = await pullEvent({ server: SERVER, senha: 's', raiz, cliente: f.cliente });
  assert.deepEqual(r.eventos.map((e) => e.eventId), ['beforeStateEntry', 'afterProcessCreate']);
  assert.equal(readFileSync(join(raiz, 'events/beforeStateEntry.js'), 'utf8'), '// b\n');

  // Só um, por id.
  const raiz2 = repo();
  const r2 = await pullEvent({ server: SERVER, senha: 's', raiz: raiz2, eventId: 'beforeStateEntry', cliente: f.cliente });
  assert.deepEqual(r2.eventos.map((e) => e.eventId), ['beforeStateEntry']);
});

test('pull event de um id inexistente lista os que existem: código 3', async () => {
  const raiz = repo();
  const f = fakeEventos([{ eventId: 'soUm', codigo: '// x\n' }]);
  await assert.rejects(
    pullEvent({ server: SERVER, senha: 's', raiz, eventId: 'naoExiste', cliente: f.cliente }),
    (e) => codigoDe(e) === 3 && /soUm/.test((e as Error).message),
  );
});

test('pull event com caractere fora do latin1 grava o que o servidor tem, e não sobrescreve sem --overwrite', async () => {
  const raiz = repo();
  const f = fakeEventos([{ eventId: 'acentuado', codigo: '// Aprovação\n' }]);
  await pullEvent({ server: SERVER, senha: 's', raiz, cliente: f.cliente });
  assert.equal(readFileSync(join(raiz, 'events/acentuado.js'), 'utf8'), '// Aprovação\n');

  writeFileSync(join(raiz, 'events/acentuado.js'), '// local\n');
  await assert.rejects(
    pullEvent({ server: SERVER, senha: 's', raiz, cliente: f.cliente }),
    (e) => codigoDe(e) === 6,
  );
  assert.equal(readFileSync(join(raiz, 'events/acentuado.js'), 'utf8'), '// local\n');
  await pullEvent({ server: SERVER, senha: 's', raiz, sobrescrever: true, cliente: f.cliente });
  assert.equal(readFileSync(join(raiz, 'events/acentuado.js'), 'utf8'), '// Aprovação\n');
});

test('pull mechanism grava mechanisms/<id>.js, inclusive de subpasta', async () => {
  const raiz = repo();
  const cliente: MechanismClient = {
    listar: async () => [
      { mecanismoId: 'MEC_A', codigo: '// a\n', nome: 'A', descricao: 'a', bruto: {} },
      { mecanismoId: 'mac_b', codigo: '// b\n', nome: 'B', descricao: 'b', bruto: {} },
    ],
    criar: async () => {},
    atualizar: async () => {},
  };
  const r = await pullMechanism({ server: SERVER, senha: 's', raiz, cliente });
  assert.deepEqual(r.mecanismos.map((m) => m.arquivo), ['mechanisms/MEC_A.js', 'mechanisms/mac_b.js']);
  assert.equal(readFileSync(join(raiz, 'mechanisms/MEC_A.js'), 'utf8'), '// a\n');
});
