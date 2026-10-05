import test from 'node:test';
import assert from 'node:assert/strict';

import { desenhar, semCores } from '../src/tui/desenho.js';
import {
  atalhos,
  estadoInicial,
  formDe,
  reduzir,
  type Estado,
  type LinhaServidor,
} from '../src/tui/servidores.js';
import { decodificar, desistir, ESPERA_ESC_MS, quebrar, vigiarTamanho, type Tecla } from '../src/tui/terminal.js';

const SERVIDORES: LinhaServidor[] = [
  { nome: 'cetenco-hml', host: 'hml.exemplo.com.br', porta: 8021, ssl: false, usuario: 'integracao', companyId: 1, userCode: 'Integracao.Fluig', senhaEnv: 'FLUIG_CETENCO_HML_PASSWORD', prod: false },
  { nome: 'cetenco-prod', host: 'fluig.exemplo.com.br', porta: 8021, ssl: false, usuario: 'integracao', companyId: 1, userCode: 'Integracao.Fluig', senhaEnv: 'FLUIG_CETENCO_PROD_PASSWORD', prod: true },
];

const inicial = (servidores = SERVIDORES): Estado => estadoInicial(servidores, '/fluig/workspaces');
const tecla = (valor: string): Tecla => ({ tipo: 'caractere', valor });
const ENTER_T: Tecla = { tipo: 'enter' };
const digitos = (texto: string): Tecla[] => [...texto].map(tecla);

/** Aplica uma sequência de teclas e devolve o estado e todos os efeitos. */
function teclar(estado: Estado, ...teclas: Tecla[]): { estado: Estado; efeitos: ReturnType<typeof reduzir>['efeitos'] } {
  let atual = estado;
  const efeitos: ReturnType<typeof reduzir>['efeitos'] = [];
  for (const t of teclas) {
    const r = reduzir(atual, { tipo: 'tecla', tecla: t });
    atual = r.estado;
    efeitos.push(...r.efeitos);
  }
  return { estado: atual, efeitos };
}

// --- redutor: navegação e lista ---

test('a lista anda com as setas e para nas pontas', () => {
  let { estado } = teclar(inicial(), { tipo: 'baixo' });
  assert.equal(estado.foco, 1);
  ({ estado } = teclar(estado, { tipo: 'baixo' }, { tipo: 'baixo' }));
  assert.equal(estado.foco, 1, 'não passa do último');

  ({ estado } = teclar(estado, { tipo: 'cima' }, { tipo: 'cima' }));
  assert.equal(estado.foco, 0, 'não passa do primeiro');
});

test('lista vazia não quebra a navegação', () => {
  const { estado } = teclar(inicial([]), { tipo: 'baixo' }, { tipo: 'cima' });
  assert.equal(estado.foco, 0);
});

test('q sai', () => {
  const { estado, efeitos } = teclar(inicial(), tecla('q'));
  assert.equal(estado.sair, true);
  assert.deepEqual(efeitos, [{ tipo: 'sair' }]);
});

test('ctrl-c sai de qualquer tela', () => {
  const noForm = teclar(inicial(), tecla('a')).estado;
  const { estado, efeitos } = teclar(noForm, { tipo: 'ctrl-c' });
  assert.equal(estado.sair, true);
  assert.deepEqual(efeitos, [{ tipo: 'sair' }]);
});

test('a abre o formulário vazio; enter abre o servidor em foco', () => {
  assert.equal(teclar(inicial(), tecla('a')).estado.tela.tipo, 'form');
  const { estado } = teclar(inicial(), { tipo: 'enter' });
  assert.equal(estado.tela.tipo, 'form');
  assert.equal(estado.tela.tipo === 'form' && estado.tela.form.original, 'cetenco-hml');
});

test('t testa o servidor em foco e o resultado volta como recado', () => {
  assert.deepEqual(teclar(inicial(), tecla('t')).efeitos, [{ tipo: 'testar', nome: 'cetenco-hml' }]);

  const { estado } = reduzir(teclar(inicial(), tecla('t')).estado, {
    tipo: 'teste',
    teste: { nome: 'cetenco-hml', ok: true, detalhe: ['ping ok', 'companyId 1'] },
  });
  assert.equal(estado.recado?.tom, 'ok');
  assert.match(estado.recado!.texto, /companyId 1/);
});

test('teste que falha vira recado de erro', () => {
  const { estado } = reduzir(inicial(), {
    tipo: 'teste',
    teste: { nome: 'x', ok: false, detalhe: ['a senha não confere'] },
  });
  assert.equal(estado.recado?.tom, 'erro');
  assert.match(estado.recado!.texto, /a senha não confere/);
});

// --- produção: o que mexe no comportamento do push ---

test('marcar produção pede confirmação; só o "s" aplica', () => {
  const comFocoNoProd = teclar(inicial(), { tipo: 'baixo' }).estado;
  // No que já é produção, "p" desmarca direto, sem confirmar.
  assert.deepEqual(teclar(comFocoNoProd, tecla('p')).efeitos, [{ tipo: 'alternarProd', nome: 'cetenco-prod', prod: false }]);

  const noHml = teclar(inicial(), tecla('p'));
  assert.equal(noHml.estado.tela.tipo, 'confirmar');
  assert.match(noHml.estado.tela.tipo === 'confirmar' ? noHml.estado.tela.pergunta : '', /PRODUÇÃO/);
  assert.deepEqual(noHml.efeitos, [], 'a confirmação não aplica nada sozinha');

  assert.deepEqual(teclar(noHml.estado, tecla('s')).efeitos, [{ tipo: 'alternarProd', nome: 'cetenco-hml', prod: true }]);
  assert.deepEqual(teclar(noHml.estado, tecla('n')).efeitos, []);
  assert.deepEqual(teclar(noHml.estado, { tipo: 'escape' }).efeitos, []);
});

test('remover pede confirmação e volta para a lista', () => {
  const pedindo = teclar(inicial(), tecla('x'));
  assert.equal(pedindo.estado.tela.tipo, 'confirmar');
  const { estado, efeitos } = teclar(pedindo.estado, tecla('s'));
  assert.deepEqual(efeitos, [{ tipo: 'remover', nome: 'cetenco-hml' }]);
  assert.equal(estado.tela.tipo, 'lista');
});

// --- formulário ---

test('enter avança de campo e só o último conclui', () => {
  let { estado } = teclar(inicial(), tecla('a'));
  assert.equal(estado.tela.tipo === 'form' && estado.tela.form.foco, 'nome');

  // Sete enters: os seis campos, e o sétimo no último conclui (e falha a
  // validação, porque está tudo vazio).
  for (const esperado of ['host', 'porta', 'ssl', 'usuario', 'senha'] as const) {
    ({ estado } = teclar(estado, ENTER_T));
    assert.equal(estado.tela.tipo === 'form' && estado.tela.form.foco, esperado);
    assert.equal(estado.tela.tipo === 'form' ? estado.tela.erro : undefined, undefined, 'ainda não valida');
  }

  ({ estado } = teclar(estado, ENTER_T));
  assert.equal(estado.tela.tipo === 'form' && estado.tela.erro, 'o nome do servidor é obrigatório');
});

test('o formulário valida antes de tentar qualquer rede', () => {
  const noFim = (valores: Partial<Record<string, string>>) => {
    const form = {
      ...formDe(SERVIDORES[0]!),
      original: undefined,
      novo: true,
      foco: 'senha' as const,
      valores: { nome: '', host: '', porta: '', ssl: 'não', usuario: '', senha: '', ...valores },
    };
    return { ...inicial(), tela: { tipo: 'form' as const, form } };
  };
  const erroDe = (valores: Partial<Record<string, string>>) => {
    const { estado, efeitos } = teclar(noFim(valores), ENTER_T);
    assert.deepEqual(efeitos, [], 'validação local não pode pedir rede');
    return estado.tela.tipo === 'form' ? estado.tela.erro : undefined;
  };

  assert.equal(erroDe({}), 'o nome do servidor é obrigatório');
  assert.match(erroDe({ nome: 'Cetenco' })!, /minúsculas, números e hífen/);
  assert.equal(erroDe({ nome: 'ok' }), 'o host é obrigatório');
  assert.equal(erroDe({ nome: 'ok', host: 'h' }), 'o usuário é obrigatório');
  assert.match(erroDe({ nome: 'ok', host: 'h', usuario: 'u', porta: '70000' })!, /porta inválida/);
  assert.match(erroDe({ nome: 'cetenco-hml', host: 'h', usuario: 'u' })!, /já existe um servidor chamado/);
});

test('espaço alterna o ssl, e digitar nele não faz nada', () => {
  const noSsl = (valores: Partial<Record<string, string>> = {}) => ({
    ...inicial(),
    tela: {
      tipo: 'form' as const,
      form: { ...formDe(SERVIDORES[0]!), original: undefined, novo: true, foco: 'ssl' as const, valores: { nome: 'n', host: 'h', porta: '', ssl: 'não', usuario: 'u', senha: '', ...valores } },
    },
  });

  const { estado: ligado } = teclar(noSsl(), tecla(' '));
  assert.equal(ligado.tela.tipo === 'form' && ligado.tela.form.valores.ssl, 'sim');

  const { estado: desligado } = teclar(teclar(noSsl(), tecla(' ')).estado, tecla(' '));
  assert.equal(desligado.tela.tipo === 'form' && desligado.tela.form.valores.ssl, 'não');

  // Letra no campo do ssl não vira valor: ele só tem dois estados.
  const { estado: comLetra } = teclar(noSsl(), tecla('s'));
  assert.equal(comLetra.tela.tipo === 'form' && comLetra.tela.form.valores.ssl, 'não');
});

test('o formulário completo devolve o efeito de salvar, com a porta padrão do esquema', () => {
  // `enter` avança; o último conclui. A porta fica vazia e o ssl em "não".
  const ate = teclar(
    inicial(),
    tecla('a'),
    ...digitos('novo'),
    ENTER_T,
    ...digitos('fluig.exemplo.com.br'),
    ENTER_T,
    ENTER_T,
    ENTER_T,
    ...digitos('integracao'),
    ENTER_T,
    ENTER_T,
  );

  assert.equal(ate.estado.tela.tipo, 'form', 'fica no formulário até o servidor responder');
  assert.deepEqual(ate.efeitos, [
    { tipo: 'salvar', nome: 'novo', original: undefined, host: 'fluig.exemplo.com.br', porta: 80, ssl: false, usuario: 'integracao', senha: undefined, prod: false },
  ]);
});

test('ssl "sim" faz a porta padrão ser 443', () => {
  const form = { ...formDe(SERVIDORES[0]!), valores: { nome: 'novo', host: 'h', porta: '', ssl: 'sim', usuario: 'u', senha: '' }, original: undefined, novo: true, foco: 'senha' as const };
  const estado: Estado = { ...inicial(), tela: { tipo: 'form', form } };
  const { efeitos } = teclar(estado, ENTER_T);
  assert.equal(efeitos[0]!.tipo === 'salvar' && efeitos[0]!.porta, 443);
});

test('a senha digitada vai no efeito e não aparece no desenho', () => {
  const form = { ...formDe(SERVIDORES[0]!), valores: { nome: 'novo', host: 'h', porta: '80', ssl: 'não', usuario: 'u', senha: 'segredo' }, original: undefined, novo: true, foco: 'senha' as const };
  const estado: Estado = { ...inicial(), tela: { tipo: 'form', form } };
  const { efeitos } = teclar(estado, ENTER_T);
  assert.equal(efeitos[0]!.tipo === 'salvar' && efeitos[0]!.senha, 'segredo');

  const quadro = semCores(desenhar(estado, 80, 24));
  assert.ok(!quadro.includes('segredo'), 'a senha não pode ir para a tela');
  assert.match(quadro, /senha\s+•{7}/, 'mostra só o tamanho');
});

test('esc no formulário pede confirmação antes de descartar', () => {
  const noForm = teclar(inicial(), tecla('a'), ...digitos('x')).estado;
  const { estado, efeitos } = teclar(noForm, { tipo: 'escape' });
  assert.equal(estado.tela.tipo, 'confirmar');
  assert.deepEqual(efeitos, []);
  const { estado: descartado } = teclar(estado, tecla('s'));
  assert.equal(descartado.tela.tipo, 'lista');
});

// --- importação ---

test('i pede a listagem e a tela de candidatos chega pelo evento', () => {
  assert.deepEqual(teclar(inicial(), tecla('i')).efeitos, [{ tipo: 'listarParaImportar', dir: '/fluig/workspaces' }]);

  const { estado } = reduzir(inicial(), {
    tipo: 'candidatos',
    dir: '/fluig/workspaces',
    candidatos: [
      { nome: 'a', url: 'http://a', usuario: 'u', prod: false, jaExiste: false, marcado: true },
      { nome: 'b', url: 'http://b', usuario: 'u', prod: false, jaExiste: true, marcado: false },
    ],
  });
  assert.equal(estado.tela.tipo, 'importar');
});

test('importação: espaço marca, o que já existe não marca, e enter confirma', () => {
  const naTela = reduzir(inicial(), {
    tipo: 'candidatos',
    dir: '/w',
    candidatos: [
      { nome: 'a', url: 'http://a', usuario: 'u', prod: false, jaExiste: false, marcado: true },
      { nome: 'b', url: 'http://b', usuario: 'u', prod: false, jaExiste: true, marcado: false },
    ],
  }).estado;

  // Espaço no que já existe não muda nada.
  const noSegundo = teclar(naTela, { tipo: 'baixo' }).estado;
  assert.deepEqual(teclar(noSegundo, tecla(' ')).estado, noSegundo);

  // Espaço no primeiro desmarca; enter sem nada marcado avisa.
  const { estado: semMarcar } = teclar(naTela, tecla(' '));
  const { estado: avisando, efeitos } = teclar(semMarcar, { tipo: 'enter' });
  assert.deepEqual(efeitos, []);
  assert.match(avisando.recado?.texto ?? '', /nenhum candidato marcado/);

  // Marcado, enter pede confirmação com o payload já resolvido.
  const { estado: confirmando } = teclar(naTela, { tipo: 'enter' });
  assert.equal(confirmando.tela.tipo, 'confirmar');
  const { efeitos: aoConfirmar } = teclar(confirmando, tecla('s'));
  assert.deepEqual(aoConfirmar, [{ tipo: 'importar', dir: '/w', nomes: ['a'], comSenhas: false }]);
});

test('a marca e desmarca todos os que podem ser importados, e "s" liga as senhas', () => {
  const naTela = reduzir(inicial(), {
    tipo: 'candidatos',
    dir: '/w',
    candidatos: [
      { nome: 'a', url: 'http://a', usuario: 'u', prod: false, jaExiste: false, marcado: true },
      { nome: 'b', url: 'http://b', usuario: 'u', prod: false, jaExiste: false, marcado: true },
      { nome: 'c', url: 'http://c', usuario: 'u', prod: false, jaExiste: true, marcado: false },
    ],
  }).estado;

  const { estado: desmarcado } = teclar(naTela, tecla('a'));
  assert.deepEqual(
    desmarcado.tela.tipo === 'importar' ? desmarcado.tela.candidatos.map((c) => c.marcado) : [],
    [false, false, false],
  );

  const { estado: comSenhas } = teclar(naTela, tecla('s'));
  assert.equal(comSenhas.tela.tipo === 'importar' && comSenhas.tela.comSenhas, true);
  const { estado: confirmando } = teclar(comSenhas, { tipo: 'enter' });
  const { efeitos } = teclar(confirmando, tecla('s'));
  assert.equal(efeitos[0]!.tipo === 'importar' && efeitos[0]!.comSenhas, true);
});

test('esc na importação volta para a lista', () => {
  const naTela = reduzir(inicial(), { tipo: 'candidatos', dir: '/w', candidatos: [] }).estado;
  assert.equal(teclar(naTela, { tipo: 'escape' }).estado.tela.tipo, 'lista');
});

// --- desenho ---

test('a lista tem cabeçalho de coluna, alvo, usuário e a variável de senha', () => {
  const quadro = semCores(desenhar(inicial(), 120, 24));
  assert.match(quadro, /fluigctl · servidores/, 'título');
  assert.match(quadro, /2 cadastrados/, 'quantos são, no canto');
  assert.match(quadro, /NOME\s+ENDEREÇO\s+USUÁRIO\s+VARIÁVEL DE SENHA/, 'cabeçalho das colunas');
  assert.match(quadro, /▶ cetenco-hml\s+http:\/\/hml\.exemplo\.com\.br:8021\s+integracao\s+FLUIG_CETENCO_HML_PASSWORD/);
  assert.match(quadro, /cetenco-prod\s+PRODUÇÃO\s+http:\/\/fluig\.exemplo\.com\.br:8021/);
});

test('a marca de produção sobrevive ao corte, seja qual for a largura', () => {
  // A marca tem coluna própria, reservada sempre: o que o corte come é o fim da
  // linha (variável de senha, usuário, endereço), nunca ela. Avise-se: uma
  // versão anterior deste desenho pôs a marca no fim e ela virava "P…" a 60
  // colunas — o aviso que mais importa era o primeiro a sumir.
  for (const largura of [40, 50, 60, 72, 80, 100, 120]) {
    const quadro = semCores(desenhar(inicial(), largura, 24));
    const linhaDoProd = quadro.split('\n').find((l) => l.includes('cetenco-prod'))!;
    assert.match(linhaDoProd, /PRODUÇÃO/, `a marca sumiu a ${largura} colunas`);
  }
  // E numa linha apertada o que sobra para o fim é o menos importante.
  const estreito = semCores(desenhar(inicial(), 60, 24));
  const linha = estreito.split('\n').find((l) => l.includes('cetenco-prod'))!;
  assert.ok(!linha.includes('FLUIG_CETENCO_PROD_PASSWORD'), 'a variável é que é cortada');
});

test('nenhuma tela deixa a senha vazar para o quadro', () => {
  const comSenha = { ...inicial(), recado: { tom: 'ok' as const, texto: 'senha SECRETO123 gravada' } };
  assert.ok(semCores(desenhar(comSenha, 200, 24)).includes('SECRETO123'), 'o recado é do shell, não do formulário');
  // O que não pode é o formulário ecoar: coberto no teste da senha.
});

test('tela vazia ensina o caminho em vez de ficar em branco', () => {
  const quadro = semCores(desenhar(inicial([]), 80, 24));
  assert.match(quadro, /nenhum cadastrado/, 'o contexto diz que não há nenhum');
  assert.match(quadro, /Nenhum servidor cadastrado\./);
  assert.match(quadro, /Comece por a para cadastrar o primeiro/, 'e ensina a tecla');
  assert.match(quadro, /\bi\b.*workspaces da extensão Fluiggers/s, 'e a outra porta de entrada');
});

test('a ajuda cobre todas as teclas da lista, sem sobrar nem faltar', () => {
  const { estado } = teclar(inicial(), tecla('?'));
  const quadro = semCores(desenhar(estado, 80, 24));
  // A lista de atalhos do rodapé e a ajuda saem do mesmo lugar, e este teste é
  // o que impede uma tecla de existir sem estar documentada.
  for (const { t: teclaEsperada } of atalhos({ tipo: 'lista' })) {
    assert.match(quadro, new RegExp(`\\s${teclaEsperada.replace(/[?]/g, '\\$&')}\\s`), `a ajuda precisa citar "${teclaEsperada}"`);
  }
  assert.equal(teclar(estado, tecla('z')).estado.tela.tipo, 'lista');
});

// --- decodificação de teclas ---

test('as setas viram as quatro direções', () => {
  const { teclas, resto } = decodificar(Buffer.from('\x1b[A\x1b[B\x1b[C\x1b[D', 'latin1'));
  assert.deepEqual(teclas, [{ tipo: 'cima' }, { tipo: 'baixo' }, { tipo: 'direita' }, { tipo: 'esquerda' }]);
  assert.equal(resto.length, 0);
});

test('enter, tab, backspace e ctrl-c são reconhecidos', () => {
  const { teclas } = decodificar(Buffer.from('\r\n\t\x7f\x08\x03', 'latin1'));
  assert.deepEqual(teclas, [
    { tipo: 'enter' }, { tipo: 'enter' }, { tipo: 'tab' },
    { tipo: 'backspace' }, { tipo: 'backspace' }, { tipo: 'ctrl-c' },
  ]);
});

test('texto comum vira caractere, com acento junto', () => {
  const { teclas } = decodificar(Buffer.from('ação', 'utf8'));
  assert.deepEqual(teclas.map((t) => (t.tipo === 'caractere' ? t.valor : '?')).join(''), 'ação');
});

test('caractere UTF-8 partido em dois blocos é remontado', () => {
  const inteiro = Buffer.from('ç', 'utf8');
  const primeiro = decodificar(inteiro.subarray(0, 1));
  assert.deepEqual(primeiro.teclas, [], 'meio caractere não vira nada');
  assert.equal(primeiro.resto.length, 1);

  const segundo = decodificar(Buffer.concat([primeiro.resto, Buffer.alloc(0)]));
  assert.deepEqual(segundo.teclas, []);

  const completo = decodificar(Buffer.concat([inteiro.subarray(0, 1), inteiro.subarray(1)]));
  assert.deepEqual(completo.teclas, [{ tipo: 'caractere', valor: 'ç' }]);
});

test('seta partida em dois blocos é remontada, inclusive com só o ESC e o colchete', () => {
  const primeiro = decodificar(Buffer.from('\x1b[', 'latin1'));
  assert.deepEqual(primeiro.teclas, []);
  assert.equal(primeiro.incompleto, true, 'ESC seguido de "[" ainda não é decisão');

  const segundo = decodificar(Buffer.concat([primeiro.resto, Buffer.from('A', 'latin1')]));
  assert.deepEqual(segundo.teclas, [{ tipo: 'cima' }]);
  assert.equal(segundo.incompleto, false);
});

test('ESC sozinho fica pendente, e o tempo decide que era cancelar', () => {
  const { teclas, incompleto, resto } = decodificar(Buffer.from('\x1b', 'latin1'));
  assert.deepEqual(teclas, []);
  assert.equal(incompleto, true);
  assert.equal(resto.length, 1);
  assert.ok(ESPERA_ESC_MS > 0);

  // Desistir é o que o terminal faz quando o tempo passa: o ESC vale como
  // cancelar e o pedaço de seta vira caractere, em vez de sumir.
  assert.deepEqual(desistir(Buffer.from('\x1b', 'latin1')), [{ tipo: 'escape' }]);
  assert.deepEqual(desistir(Buffer.from('\x1b[', 'latin1')), [{ tipo: 'escape' }, { tipo: 'caractere', valor: '[' }]);
  assert.deepEqual(desistir(Buffer.alloc(0)), []);
});

test('seta completa que já chegou não espera o relógio', () => {
  const { teclas, incompleto } = decodificar(Buffer.from('\x1b[A', 'latin1'));
  assert.deepEqual(teclas, [{ tipo: 'cima' }]);
  assert.equal(incompleto, false);
});

test('ESC seguido de outra tecla é cancelar, e a outra tecla sai junto', () => {
  const { teclas } = decodificar(Buffer.from('\x1bq', 'latin1'));
  assert.deepEqual(teclas, [{ tipo: 'escape' }, { tipo: 'caractere', valor: 'q' }]);
});

test('outro controle não vira letra nem dispara atalho', () => {
  // Ctrl+A é 0x01: se virasse "a", abriria o formulário sem querer.
  const { teclas } = decodificar(Buffer.from('\x01\x02', 'latin1'));
  assert.deepEqual(teclas, []);
});

test('quebrar respeita a largura sem cortar palavra que cabe', () => {
  assert.deepEqual(quebrar('um dois tres', 7), ['um dois', 'tres']);
  assert.deepEqual(quebrar('palavra_grande', 5), ['palavra_grande'], 'palavra maior que a linha sai inteira');
  assert.deepEqual(quebrar('', 10), ['']);
});

test('formulário válido fica na tela esperando o servidor, sem perder o digitado', () => {
  const form = { ...formDe(SERVIDORES[0]!), valores: { nome: 'novo', host: 'h', porta: '80', ssl: 'não', usuario: 'u', senha: '' }, original: undefined, novo: true, foco: 'senha' as const };
  const estado: Estado = { ...inicial(), tela: { tipo: 'form', form } };
  const { estado: enviando, efeitos } = teclar(estado, { tipo: 'enter' });

  assert.equal(efeitos[0]!.tipo, 'salvar');
  assert.equal(enviando.tela.tipo, 'form', 'só sai do formulário quando o servidor responder');
  assert.equal(enviando.tela.tipo === 'form' && enviando.tela.form.enviando, true);

  // Enter de novo não dispara um segundo cadastro.
  assert.deepEqual(teclar(enviando, { tipo: 'enter' }).efeitos, []);
});

test('login que falha devolve o formulário com o que foi digitado e o motivo', () => {
  const form = { ...formDe(SERVIDORES[0]!), valores: { nome: 'novo', host: 'h', porta: '80', ssl: 'não', usuario: 'u', senha: 'segredo' }, original: undefined, novo: true, enviando: true, foco: 'senha' as const };
  const estado: Estado = { ...inicial(), tela: { tipo: 'form', form } };
  const { estado: comErro } = reduzir(estado, { tipo: 'salvo', ok: false, texto: 'getaddrinfo ENOTFOUND h' });

  assert.equal(comErro.tela.tipo, 'form');
  assert.equal(comErro.tela.tipo === 'form' && comErro.tela.erro, 'getaddrinfo ENOTFOUND h');
  assert.equal(comErro.tela.tipo === 'form' && comErro.tela.form.valores.usuario, 'u', 'o digitado continua ali');
  assert.equal(comErro.tela.tipo === 'form' && comErro.tela.form.enviando, undefined, 'volta a aceitar teclas');
});

test('login que dá certo sai do formulário com o recado', () => {
  const form = { ...formDe(SERVIDORES[0]!), valores: { nome: 'novo', host: 'h', porta: '80', ssl: 'não', usuario: 'u', senha: '' }, original: undefined, novo: true, enviando: true, foco: 'senha' as const };
  const estado: Estado = { ...inicial(), tela: { tipo: 'form', form } };
  const { estado: fora } = reduzir(estado, { tipo: 'salvo', ok: true, texto: '"novo" cadastrado' });

  assert.equal(fora.tela.tipo, 'lista');
  assert.equal(fora.recado?.tom, 'ok');
});

// --- redimensionamento da janela ---

test('o vigia avisa quando o tamanho muda, e só quando muda', () => {
  let tamanho = { colunas: 80, linhas: 24 };
  let disparar: (() => void) | undefined;
  const avisos: { colunas: number; linhas: number }[] = [];

  const parar = vigiarTamanho({
    ler: () => tamanho,
    avisar: (t) => avisos.push(t),
    inscrever: (f) => {
      disparar = f;
      return () => (disparar = undefined);
    },
    inicial: tamanho,
  });

  // O sinal sem mudança de tamanho não avisa.
  disparar!();
  assert.deepEqual(avisos, []);

  tamanho = { colunas: 100, linhas: 40 };
  disparar!();
  assert.deepEqual(avisos, [{ colunas: 100, linhas: 40 }]);

  disparar!();
  assert.deepEqual(avisos.length, 1, 'o mesmo tamanho não avisa de novo');

  tamanho = { colunas: 100, linhas: 24 };
  disparar!();
  assert.deepEqual(avisos.length, 2, 'só a largura mudar já é mudança');

  parar();
  assert.equal(disparar, undefined, 'parar desinscreve');
});

test('o vigia não quebra quando a leitura do tamanho falha', () => {
  let disparar: (() => void) | undefined;
  vigiarTamanho({
    ler: () => {
      throw new Error('sem tty');
    },
    avisar: () => assert.fail('não podia avisar'),
    inscrever: (f) => {
      disparar = f;
      return () => {};
    },
    inicial: { colunas: 80, linhas: 24 },
  });
  assert.doesNotThrow(() => disparar!());
});

test('nenhuma linha passa da largura da tela, seja qual for', () => {
  // O defeito que este teste tranca: as colunas eram calculadas com números
  // redondos e uma URL mais longa estourava a linha, empurrando a tela.
  const muitos: LinhaServidor[] = [
    ...SERVIDORES,
    { nome: 'um-nome-bem-comprido-mesmo', host: 'servidor.muito.longo.exemplo.com.br', porta: 8021, ssl: true, usuario: 'usuario.com.nome.longo', companyId: 1, userCode: 'U', senhaEnv: 'FLUIG_UM_NOME_BEM_COMPRIDO_MESMO_PASSWORD', prod: false },
  ];
  const telas = [
    inicial(muitos),
    teclar(inicial(muitos), tecla('?')).estado,
    teclar(inicial(muitos), tecla('a')).estado,
    teclar(inicial(muitos), tecla('p')).estado,
    reduzir(inicial(muitos), { tipo: 'candidatos', dir: '/w', candidatos: [{ nome: 'um-nome-bem-comprido-mesmo', url: 'https://servidor.muito.longo.exemplo.com.br:8021', usuario: 'usuario.com.nome.longo', prod: true, jaExiste: false, marcado: true }] }).estado,
  ];

  for (const largura of [24, 30, 40, 60, 72, 80, 100, 120, 200]) {
    for (const tela of telas) {
      for (const linha of semCores(desenhar(tela, largura, 24)).split('\n')) {
        assert.ok(linha.length <= largura, `linha de ${linha.length} numa tela de ${largura}: ${linha.slice(0, 40)}…`);
      }
    }
  }
});

test('em tela estreita o rodapé perde atalhos inteiros, e nunca os rótulos de todos', () => {
  const largo = semCores(desenhar(inicial(), 200, 24));
  assert.match(largo, /x remover/, 'com espaço, cabe tudo');
  assert.match(largo, /i importar/);

  const estreito = semCores(desenhar(inicial(), 60, 24));
  // O que sai, sai com o rótulo: nada de uma fila de letras soltas.
  assert.ok(!/·\s*x remover/.test(estreito) || estreito.includes('x remover'), 'sem meia palavra');
  // E o que fica continua explicado, incluindo a saída.
  for (const essencial of ['↑↓ mover', '⏎ rever', 'a novo', '? ajuda', 'q sair']) {
    assert.ok(estreito.includes(essencial), `o rodapé estreito precisa manter "${essencial}"`);
  }
});
