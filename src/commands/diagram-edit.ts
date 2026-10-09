import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { ErroFluigctl } from '../errors.js';
import { adicionarNoXml, configurarTemporizadorNoXml, ligarNoXml, scriptsDasCriadas, validarMinutos, type TipoNovo } from '../diagram/add.js';
import { definirCondicaoNoXml, formatarDiagrama, inserirDepoisNoXml, inserirEntreNoXml, mostrarDiagrama, resolverElemento } from '../diagram/comandos.js';
import { ConflitoEdicao, EdicaoInvalida, aplicarEdicao, desfazerUltimaEdicao, endireitar, hash, refazerEdicao, renomearElemento } from '../diagram/edit.js';
import { organizarNoXml } from '../diagram/layout.js';
import { diretorioDeEstado } from '../diagram/viewer.js';
import { trocarAtribuicaoNoXml, type Regra } from '../diagram/props.js';
import { removerNoXml } from '../diagram/remove.js';

/**
 * Os comandos de edição do diagrama no terminal: as mesmas operações do
 * visualizador (e o mesmo histórico de desfazer), para o agente editar o
 * .process sem mexer no XML à mão. Cada um aceita o id ou o nome exato do
 * elemento; `diagram show` lista os dois.
 */

export const USO_EDICAO = [
  'fluigctl diagram show <arquivo.process> [--json]',
  'fluigctl diagram add <arquivo.process> --type <tipo> [--name N] [--group G] [--minutes N] (--after <el> [--before <el>] | --at <x>,<y>) [--lane <raia>]',
  'fluigctl diagram timer <arquivo.process> <elemento> --minutes N',
  'fluigctl diagram link <arquivo.process> <origem> <destino> [--name N] [--when campo=valor]... [--expression E]',
  'fluigctl diagram condition <arquivo.process> <gateway> --to <destino> (--when campo=valor | --when campo!=valor)... | --expression E',
  'fluigctl diagram assign <arquivo.process> <tarefa> --mechanism <M> [--field k=v]... | --custom <MEC_ID> | --none',
  'fluigctl diagram rename <arquivo.process> <elemento> <nome novo>',
  'fluigctl diagram remove <arquivo.process> <elemento ou ligação>',
  'fluigctl diagram organize <arquivo.process>',
  'fluigctl diagram straighten <arquivo.process> [<elemento>]',
  'fluigctl diagram undo|redo <arquivo.process>',
];

const TIPOS: TipoNovo[] = ['humana', 'servico', 'gateway', 'fim', 'inicio', 'paralelo', 'juncao', 'temporizador', 'recuperacao'];
const SUBCOMANDOS = new Set(['show', 'add', 'timer', 'link', 'condition', 'assign', 'rename', 'remove', 'organize', 'straighten', 'undo', 'redo']);

export function ehComandoDeEdicao(sub: string | undefined): boolean {
  return sub !== undefined && SUBCOMANDOS.has(sub);
}

const undoDir = () => join(diretorioDeEstado(), 'edicoes');
const ler = (arquivo: string) => readFileSync(arquivo, 'utf8');
const id = (arquivo: string, ref: string) => resolverElemento(ler(arquivo), ref).attrs['id']!;

/** `campo=valor` vira igual; `campo!=valor`, diferente. */
function lerRegra(texto: string): Regra {
  const m = /^([^=!]+?)(!=|=)(.*)$/s.exec(texto);
  if (!m || !m[1]!.trim()) throw new EdicaoInvalida(`--when "${texto}": use campo=valor ou campo!=valor`);
  return { campo: m[1]!.trim(), operador: m[2] === '!=' ? '2' : '1', valor: m[3]! };
}

function condicaoDe(when: string[] | undefined, expressao: string | undefined) {
  if (when?.length && expressao !== undefined) throw new EdicaoInvalida('use --when ou --expression, não os dois');
  if (expressao !== undefined) return { tipo: 'expressao' as const, expressao, regras: [] };
  if (when?.length) return { tipo: 'regra' as const, expressao: '', regras: when.map(lerRegra) };
  return undefined;
}

/** Os achados do diagram check que a edição deixou (avisos; erro de estrutura não chega a gravar). */
function avisar(avisos: { onde: string; mensagem: string }[] | undefined): void {
  for (const a of avisos ?? []) console.log(`aviso: ${a.onde}: ${a.mensagem}`);
}

export function comandoEdicaoDiagrama(sub: string, argv: string[]): void {
  try {
    executar(sub, argv);
  } catch (e) {
    if (e instanceof EdicaoInvalida || e instanceof ConflitoEdicao) throw new ErroFluigctl(e.message, 2);
    throw e;
  }
}

function executar(sub: string, argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      type: { type: 'string' },
      name: { type: 'string' },
      group: { type: 'string' },
      after: { type: 'string' },
      before: { type: 'string' },
      at: { type: 'string' },
      lane: { type: 'string' },
      when: { type: 'string', multiple: true },
      expression: { type: 'string' },
      to: { type: 'string' },
      mechanism: { type: 'string' },
      field: { type: 'string', multiple: true },
      custom: { type: 'string' },
      none: { type: 'boolean', default: false },
      minutes: { type: 'string' },
    },
  });
  const arquivo = positionals[0];
  const uso = USO_EDICAO.find((u) => u.startsWith(`fluigctl diagram ${sub} `) || (sub === 'undo' || sub === 'redo' ? u.includes('undo|redo') : false));
  if (!arquivo) throw new ErroFluigctl(`uso: ${uso}`, 2);

  if (sub === 'show') {
    const m = mostrarDiagrama(ler(arquivo));
    console.log(values.json ? JSON.stringify(m, null, 2) : formatarDiagrama(m));
    return;
  }

  if (sub === 'add') {
    const tipo = values.type as TipoNovo | undefined;
    if (!tipo || !TIPOS.includes(tipo)) throw new ErroFluigctl(`--type: use ${TIPOS.join(', ')}\nuso: ${uso}`, 2);
    const minutos = values.minutes === undefined ? undefined : Number(values.minutes);
    if (tipo === 'temporizador') validarMinutos(minutos);
    if (tipo !== 'temporizador' && values.minutes !== undefined) throw new EdicaoInvalida('--minutes só é aceito com --type temporizador');
    const novo = { tipo, ...(values.name === undefined ? {} : { nome: values.name }), ...(values.group === undefined ? {} : { grupo: values.group }), ...(minutos === undefined ? {} : { minutos }) };
    let criados: string[] = [];
    let movidos: string[] = [];
    let xmlNovo = '';
    const r = aplicarEdicao(arquivo, undoDir(), (t) => {
      let feito: { xml: string; criados: string[]; movidos?: string[] };
      if (values.at !== undefined) {
        const m = /^(-?\d+),(-?\d+)$/.exec(values.at.replace(/\s/g, ''));
        if (!m) throw new EdicaoInvalida('--at: use x,y (o centro do elemento)');
        feito = adicionarNoXml(t, { ...novo, x: Number(m[1]), y: Number(m[2]) });
      } else if (values.after !== undefined && values.before !== undefined) {
        feito = inserirEntreNoXml(t, resolverElemento(t, values.after).attrs['id']!, resolverElemento(t, values.before).attrs['id']!, novo, values.lane);
      } else if (values.after !== undefined) {
        feito = inserirDepoisNoXml(t, resolverElemento(t, values.after).attrs['id']!, novo, values.lane);
      } else {
        throw new EdicaoInvalida('diga onde: --after <el> (e --before <el> para inserir entre dois) ou --at x,y');
      }
      criados = feito.criados;
      movidos = feito.movidos ?? [];
      xmlNovo = feito.xml;
      return feito.xml;
    }, undefined, () => scriptsDasCriadas(arquivo, xmlNovo, criados));
    console.log(`criado(s): ${criados.join(', ')}${movidos.length ? `; abriu espaço movendo ${movidos.length} elemento(s)` : ''}`);
    for (const s of r.criados ?? []) console.log(`  script novo: ${relative(process.cwd(), s)} (esqueleto: implemente antes de publicar)`);
    avisar(r.avisos);
    return;
  }

  if (sub === 'timer') {
    const [, ref] = positionals;
    const minutos = values.minutes === undefined ? undefined : Number(values.minutes);
    if (!ref) throw new ErroFluigctl(`uso: ${uso}`, 2);
    validarMinutos(minutos);
    const r = aplicarEdicao(arquivo, undoDir(), (t) => configurarTemporizadorNoXml(t, resolverElemento(t, ref).attrs['id']!, minutos!));
    console.log('temporizador configurado');
    avisar(r.avisos);
    return;
  }

  if (sub === 'link') {
    const [, origem, destino] = positionals;
    if (!origem || !destino) throw new ErroFluigctl(`uso: ${uso}`, 2);
    const condicao = condicaoDe(values.when, values.expression);
    let criado = '';
    const r = aplicarEdicao(arquivo, undoDir(), (t) => {
      const a = resolverElemento(t, origem).attrs['id']!;
      const b = resolverElemento(t, destino).attrs['id']!;
      const feito = ligarNoXml(t, a, b, values.name ?? '');
      criado = feito.id;
      return condicao ? definirCondicaoNoXml(feito.xml, a, b, condicao) : feito.xml;
    });
    console.log(`ligação criada: ${criado}`);
    avisar(r.avisos);
    return;
  }

  if (sub === 'condition') {
    const [, gateway] = positionals;
    const condicao = condicaoDe(values.when, values.expression);
    if (!gateway || !values.to || !condicao) throw new ErroFluigctl(`uso: ${uso}`, 2);
    const r = aplicarEdicao(arquivo, undoDir(), (t) => definirCondicaoNoXml(t, resolverElemento(t, gateway).attrs['id']!, resolverElemento(t, values.to!).attrs['id']!, condicao));
    console.log('condição gravada');
    avisar(r.avisos);
    return;
  }

  if (sub === 'assign') {
    const [, tarefa] = positionals;
    if (!tarefa || [values.mechanism !== undefined, values.custom !== undefined, values.none].filter(Boolean).length !== 1) throw new ErroFluigctl(`uso: ${uso}`, 2);
    const campos: Record<string, string> = {};
    for (const f of values.field ?? []) {
      const i = f.indexOf('=');
      if (i < 1) throw new ErroFluigctl(`--field "${f}": use chave=valor`, 2);
      campos[f.slice(0, i)] = f.slice(i + 1);
    }
    const r = aplicarEdicao(arquivo, undoDir(), (t) => {
      // idNode aceita o nome da atividade, como os outros comandos.
      if (campos['idNode']) campos['idNode'] = resolverElemento(t, campos['idNode']).attrs['id']!;
      const mecanismo = values.none ? '' : (values.custom ?? values.mechanism!);
      return trocarAtribuicaoNoXml(t, resolverElemento(t, tarefa).attrs['id']!, { mecanismo, customizado: values.custom !== undefined, campos });
    });
    console.log('atribuição gravada');
    avisar(r.avisos);
    return;
  }

  if (sub === 'rename') {
    const [, ref, nome] = positionals;
    if (!ref || nome === undefined) throw new ErroFluigctl(`uso: ${uso}`, 2);
    const o = resolverElemento(ler(arquivo), ref);
    const r = renomearElemento({ arquivo, id: o.attrs['id']!, nomeOriginal: o.attrs['name'] ?? '', nomeNovo: nome, undoDir: undoDir() });
    console.log(`renomeado: ${o.attrs['id']} "${r.nome}"`);
    avisar(r.avisos);
    return;
  }

  if (sub === 'remove') {
    const [, ref] = positionals;
    if (!ref) throw new ErroFluigctl(`uso: ${uso}`, 2);
    let removidos: string[] = [];
    let scripts: string[] = [];
    const r = aplicarEdicao(arquivo, undoDir(), (t) => {
      const x = removerNoXml(t, resolverElemento(t, ref).attrs['id']!);
      removidos = x.removidos;
      scripts = x.scripts;
      return x.xml;
    });
    console.log(`removido(s): ${removidos.join(', ')}`);
    for (const s of scripts) console.log(`  o script ${s} ficou na pasta: apague se não for mais usado`);
    avisar(r.avisos);
    return;
  }

  if (sub === 'organize') {
    const r = aplicarEdicao(arquivo, undoDir(), (t) => organizarNoXml(t).xml);
    console.log('diagrama organizado');
    avisar(r.avisos);
    return;
  }

  if (sub === 'straighten') {
    const ref = positionals[1];
    const r = endireitar({ arquivo, ...(ref === undefined ? {} : { id: id(arquivo, ref) }), undoDir: undoDir(), hashBase: hash(ler(arquivo)) });
    console.log(`ligações traçadas: ${r.fluxos.join(', ')}`);
    avisar(r.avisos);
    return;
  }

  if (sub === 'undo') {
    desfazerUltimaEdicao(arquivo, undoDir());
    console.log('última edição desfeita');
    return;
  }
  if (sub === 'redo') {
    refazerEdicao(arquivo, undoDir());
    console.log('edição refeita');
    return;
  }
  throw new ErroFluigctl(`uso: ${uso}`, 2);
}
