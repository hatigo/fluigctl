import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErroFluigctl } from '../errors.js';

/**
 * `form new`: a pasta de um formulário novo, como os do acervo (243 formulários
 * do Studio): `forms/<nome>/<nome>.html` com o style guide do Fluig e o
 * `<form name="form">`, os campos em painel, e `events/validateForm.js` (o
 * evento mais comum do acervo) quando há campo obrigatório. Publica-se com
 * `push form --create`.
 */

export const TIPOS_CAMPO = ['text', 'textarea', 'number', 'date', 'email', 'select', 'radio'] as const;
export type TipoCampo = (typeof TIPOS_CAMPO)[number];

export interface Opcao {
  valor: string;
  texto: string;
}

export interface Campo {
  nome: string;
  tipo: TipoCampo;
  rotulo: string;
  obrigatorio: boolean;
  /** Só em select e radio. */
  opcoes?: Opcao[];
}

const NOME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/**
 * `campo[!][:tipo[:Rótulo]]`; o `!` marca obrigatório. Select e radio levam as
 * opções no tipo: `decisao!:radio(aprovado=Aprovar|reprovado=Reprovar):Decisão`
 * (sem `=`, o valor é o próprio texto). O rótulo pode ter dois-pontos.
 */
export function lerCampo(texto: string): Campo {
  const m = /^([^:]*?)(?::([a-z]+)(?:\(([^)]*)\))?)?(?::([\s\S]*))?$/.exec(texto);
  const cabeca = m?.[1] ?? '';
  const tipo = m?.[2] ?? 'text';
  const obrigatorio = cabeca.endsWith('!');
  const nome = obrigatorio ? cabeca.slice(0, -1) : cabeca;
  if (!m || !NOME.test(nome)) throw new ErroFluigctl(`--field "${texto}": o nome do campo usa letras, números e _ (começando por letra)`, 2);
  if (!(TIPOS_CAMPO as readonly string[]).includes(tipo)) {
    throw new ErroFluigctl(`--field "${texto}": tipo "${tipo}" desconhecido; use ${TIPOS_CAMPO.join(', ')}`, 2);
  }
  const rotulo = (m[4] ?? '').trim() || nome;
  const campo: Campo = { nome, tipo: tipo as TipoCampo, rotulo, obrigatorio };
  const comOpcoes = tipo === 'select' || tipo === 'radio';
  if (m[3] !== undefined && !comOpcoes) throw new ErroFluigctl(`--field "${texto}": só select e radio têm opções`, 2);
  if (comOpcoes) {
    const opcoes = (m[3] ?? '').split('|').map((o) => o.trim()).filter(Boolean).map((o) => {
      const i = o.indexOf('=');
      return i < 0 ? { valor: o, texto: o } : { valor: o.slice(0, i).trim(), texto: o.slice(i + 1).trim() || o.slice(0, i).trim() };
    });
    if (opcoes.length < 2) throw new ErroFluigctl(`--field "${texto}": ${tipo} precisa de pelo menos duas opções, como ${tipo}(sim|nao)`, 2);
    const repetidas = opcoes.map((o) => o.valor).filter((v, i, a) => a.indexOf(v) !== i);
    if (repetidas.length) throw new ErroFluigctl(`--field "${texto}": opção repetida: ${repetidas.join(', ')}`, 2);
    campo.opcoes = opcoes;
  }
  return campo;
}

const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function htmlDoCampo(c: Campo): string {
  const rotulo = `${escapar(c.rotulo)}${c.obrigatorio ? ' <span class="obrigatorio">*</span>' : ''}`;
  const comum = `class="form-control" id="${c.nome}" name="${c.nome}"`;
  const r = '                            ';
  const largura = c.tipo === 'textarea' ? 12 : 6;
  if (c.tipo === 'radio') {
    // Como no acervo: cada opção num label.radio-inline; o rótulo do grupo não aponta para um input.
    const idDe = (o: Opcao) => `${c.nome}_${o.valor.replace(/[^\w-]/g, '_')}`;
    return [
      `                        <div class="form-group col-md-${largura}">`,
      `${r}<label>${rotulo}</label>`,
      `${r}<div>`,
      ...c.opcoes!.flatMap((o) => [
        `${r}    <label class="radio-inline">`,
        `${r}        <input type="radio" name="${c.nome}" id="${idDe(o)}" value="${escapar(o.valor)}"> ${escapar(o.texto)}`,
        `${r}    </label>`,
      ]),
      `${r}</div>`,
      `                        </div>`,
    ].join('\n');
  }
  const controle =
    c.tipo === 'textarea'
      ? [`<textarea ${comum} rows="3"></textarea>`]
      : c.tipo === 'select'
      ? [
          `<select ${comum}>`,
          `    <option value="">Selecione</option>`,
          ...c.opcoes!.map((o) => `    <option value="${escapar(o.valor)}">${escapar(o.texto)}</option>`),
          `</select>`,
        ]
      : [`<input type="${c.tipo}" ${comum}${c.tipo === 'text' || c.tipo === 'email' ? ` placeholder="${escapar(c.rotulo)}"` : ''}>`];
  return [
    `                        <div class="form-group col-md-${largura}">`,
    `${r}<label for="${c.nome}">${rotulo}</label>`,
    ...controle.map((l) => `${r}${l}`),
    `                        </div>`,
  ].join('\n');
}

export function htmlDoFormulario(titulo: string, campos: Campo[]): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="/style-guide/css/fluig-style-guide.min.css"/>
    <script src="/portal/resources/js/jquery/jquery.js"></script>
    <script src="/style-guide/js/fluig-style-guide.min.js"></script>
</head>
<body>
    <div class="fluig-style-guide">
        <form name="form" role="form">

            <section class="panel panel-default">
                <div class="panel-heading">
                    <h3 class="panel-title">${escapar(titulo)}</h3>
                </div>
                <div class="panel-body">
                    <div class="row">
${campos.map(htmlDoCampo).join('\n')}
                    </div>
                </div>
            </section>

        </form>
    </div>
</body>
</html>
`;
}

export function validateFormDe(campos: Campo[]): string {
  const obrigatorios = campos.filter((c) => c.obrigatorio);
  return `/**
 * validateForm - campos obrigatórios.
 *
 * Vale em toda atividade. Para exigir um campo só numa atividade, compare
 * getValue("WKNumState") com o número dela (o do id no diagrama: task5 é 5).
 */
var OBRIGATORIOS = [
${obrigatorios.map((c) => `\t[${JSON.stringify(c.nome)}, ${JSON.stringify(c.rotulo)}]`).join(',\n')}
];

function validateForm(form) {
\tvar faltam = [];
\tfor (var i = 0; i < OBRIGATORIOS.length; i++) {
\t\tif (String(form.getValue(OBRIGATORIOS[i][0]) || "").trim() === "") {
\t\t\tfaltam.push(OBRIGATORIOS[i][1]);
\t\t}
\t}
\tif (faltam.length) {
\t\tthrow "Preencha: " + faltam.join(", ") + ".";
\t}
}
`;
}

export interface PedidoFormNovo {
  nome: string;
  titulo?: string;
  campos: Campo[];
  /** Pasta dos formulários do projeto (padrão: forms). */
  pasta: string;
}

/** Cria a pasta do formulário; devolve os arquivos criados. */
export function criarFormulario(p: PedidoFormNovo): string[] {
  if (!NOME.test(p.nome)) throw new ErroFluigctl(`nome de formulário inválido: "${p.nome}"; use letras, números e _ (começando por letra)`, 2);
  if (p.campos.length === 0) throw new ErroFluigctl('o formulário precisa de pelo menos um --field', 2);
  const repetidos = p.campos.map((c) => c.nome).filter((n, i, a) => a.indexOf(n) !== i);
  if (repetidos.length) throw new ErroFluigctl(`campo repetido: ${[...new Set(repetidos)].join(', ')}`, 2);
  const dir = join(p.pasta, p.nome);
  if (existsSync(dir)) throw new ErroFluigctl(`${dir} já existe; o form new não sobrescreve`, 2);
  const criados: string[] = [];
  mkdirSync(dir, { recursive: true });
  const html = join(dir, `${p.nome}.html`);
  writeFileSync(html, htmlDoFormulario(p.titulo ?? p.nome, p.campos), { flag: 'wx' });
  criados.push(html);
  if (p.campos.some((c) => c.obrigatorio)) {
    mkdirSync(join(dir, 'events'));
    const evento = join(dir, 'events', 'validateForm.js');
    writeFileSync(evento, validateFormDe(p.campos), { flag: 'wx' });
    criados.push(evento);
  }
  return criados;
}
