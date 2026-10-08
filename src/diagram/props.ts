import { lerDiagrama, type ObjetoBpmn } from '../push/diagram/modelo.js';
import { escaparTexto, lerXml, type No } from '../push/diagram/xml.js';
import { ConflitoEdicao, EdicaoInvalida } from './edit.js';

/**
 * Propriedades editáveis pelo painel: tipo de execução da service task,
 * atribuição da tarefa humana e condições do gateway.
 *
 * As duas últimas moram em blobs XStream dentro de um atributo. O que se grava
 * aqui tem de sair como o Studio grava (o `push diagram` confere os blobs
 * contra os pares do Studio), então a regra é: só se regrava o que se sabe ler
 * e reescrever byte a byte. Um blob que não volta igual pela ida e volta fica
 * somente leitura no painel.
 */

/**
 * Como cada arquivo escreve os atributos. O Studio grava `>` cru e referências
 * hexadecimais (`&#xA;`); outro gravador, presente em 159 atributos do corpus,
 * grava `&gt;` e decimais (`&#10;`). A edição segue o estilo que o arquivo já usa.
 */
export interface EstiloAtributo {
  gt: boolean;
  decimal: boolean;
}

export const ESTILO_STUDIO: EstiloAtributo = { gt: false, decimal: false };

/** O estilo de um valor já gravado; o que ele não revela vem do arquivo. */
function estiloDoValor(bruto: string, doArquivo: EstiloAtributo): EstiloAtributo {
  const decimal = /&#\d+;/.test(bruto) ? true : /&#x[0-9a-fA-F]+;/.test(bruto) ? false : doArquivo.decimal;
  const gt = bruto.includes('&gt;') ? true : bruto.includes('>') ? false : doArquivo.gt;
  return { gt, decimal };
}

export function estiloDoArquivo(xml: string): EstiloAtributo {
  const decimal = /&#\d+;/.test(xml) && !/&#x[0-9a-fA-F]+;/.test(xml);
  return { gt: /="[^"]*&gt;/.test(xml), decimal };
}

/** Atributo como o arquivo grava: `<`, `&`, `"` e controles escapados, não ASCII como referência numérica. */
export function codificarAtributo(valor: string, estilo: EstiloAtributo = ESTILO_STUDIO): string {
  const ref = (cp: number) => (estilo.decimal ? `&#${cp};` : `&#x${cp.toString(16)};`);
  return [...valor].map((c) => {
    const cp = c.codePointAt(0)!;
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>' && estilo.gt) return '&gt;';
    if (c === '"') return '&quot;';
    if (c === '\n') return estilo.decimal ? '&#10;' : '&#xA;';
    if (c === '\r') return estilo.decimal ? '&#13;' : '&#xD;';
    if (c === '\t') return estilo.decimal ? '&#9;' : '&#x9;';
    if (cp < 0x20 || cp > 0x7e) return ref(cp);
    return c;
  }).join('');
}

/** Troca, insere ou remove atributos da tag `bpmn2:` de um id, sem tocar no resto do arquivo. */
export function trocarAtributosNoXml(xml: string, id: string, mudancas: Record<string, string | null>, inserirDepois: string[] = []): string {
  const tag = /<bpmn2:[\w.-]+(?:\s+[\w:.-]+\s*=\s*"[^"]*")*\s*\/?>/g;
  let achada: RegExpExecArray | undefined;
  for (const m of xml.matchAll(tag)) {
    if (/\sid="([^"]*)"/.exec(m[0])?.[1] !== id) continue;
    if (achada) throw new EdicaoInvalida(`o .process tem mais de um objeto com id ${id}`);
    achada = m;
  }
  if (!achada) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  const texto = trocarAtributosNaTag(achada[0], mudancas, inserirDepois, estiloDoArquivo(xml));
  return xml.slice(0, achada.index) + texto + xml.slice(achada.index + achada[0].length);
}

/** Troca, insere ou remove atributos de uma tag isolada; o valor existente dita o estilo de codificação. */
export function trocarAtributosNaTag(tag: string, mudancas: Record<string, string | null>, inserirDepois: string[], estilo: EstiloAtributo): string {
  let texto = tag;
  for (const [nome, valor] of Object.entries(mudancas)) {
    const existente = new RegExp(`\\s${nome}="([^"]*)"`);
    const atual = existente.exec(texto);
    if (valor === null) {
      texto = texto.replace(existente, '');
    } else if (atual) {
      const proprio = estiloDoValor(atual[1]!, estilo);
      texto = texto.replace(existente, () => ` ${nome}="${codificarAtributo(valor, proprio)}"`);
    } else {
      // Entra depois do primeiro vizinho que existir; senão, antes do fim da tag.
      const vizinho = inserirDepois.find((v) => new RegExp(`\\s${v}="[^"]*"`).test(texto));
      const novo = ` ${nome}="${codificarAtributo(valor, estilo)}"`;
      texto = vizinho
        ? texto.replace(new RegExp(`(\\s${vizinho}="[^"]*")`), (m) => m + novo)
        : texto.replace(/\s*(\/?)>$/, (_m, barra: string) => `${novo}${barra}>`);
    }
  }
  return texto;
}

// ---------------------------------------------------------------------------
// XStream: leitura e escrita no formato do Studio (dois espaços por nível).

interface NoX {
  nome: string;
  attrs?: Record<string, string>;
  filhos?: NoX[];
  texto?: string;
}

function paraNoX(no: No): NoX {
  return no.filhos.length > 0
    ? { nome: no.nome, ...(Object.keys(no.attrs).length ? { attrs: no.attrs } : {}), filhos: no.filhos.map(paraNoX) }
    : { nome: no.nome, ...(Object.keys(no.attrs).length ? { attrs: no.attrs } : {}), texto: no.texto };
}

function serializarX(no: NoX, nivel = 0): string {
  const recuo = '  '.repeat(nivel);
  const attrs = Object.entries(no.attrs ?? {}).map(([k, v]) => ` ${k}="${escaparTexto(v)}"`).join('');
  if (no.filhos) return `${recuo}<${no.nome}${attrs}>\n${no.filhos.map((f) => serializarX(f, nivel + 1)).join('\n')}\n${recuo}</${no.nome}>`;
  return `${recuo}<${no.nome}${attrs}>${escaparTexto(no.texto ?? '')}</${no.nome}>`;
}

function lerBlob(blob: string): NoX | undefined {
  try {
    const raiz = lerXml(blob).filhos[0];
    return raiz ? paraNoX(raiz) : undefined;
  } catch {
    return undefined;
  }
}

const texto = (no: NoX | undefined, nome: string) => no?.filhos?.find((f) => f.nome === nome)?.texto;

// ---------------------------------------------------------------------------
// Atribuição da tarefa humana.

const PREFIXO = 'org.eclipse.bpmn2.impl.';

/** Mecanismos nativos que o painel sabe gravar, com a classe e o campo de cada um. */
export const MECANISMOS: Record<string, { classe: string; campos: string[] }> = {
  'Pool Grupo': { classe: 'AssignmentControllerPoolGroup', campos: ['groupId'] },
  Grupo: { classe: 'AssignmentControllerGroup', campos: ['groupId'] },
  'Pool Papel': { classe: 'AssignmentControllerPoolRole', campos: ['roleId'] },
  Usuário: { classe: 'AssignmentControllerColleague', campos: ['colleagueId'] },
  'Campo Formulário': { classe: 'AssignmentControllerFormField', campos: ['formField'] },
  'Executor Atividade': { classe: 'AssignmentControllerExecutorMechanism', campos: ['idNode', 'returns'] },
};

export interface Atribuicao {
  /** '' = sem mecanismo. */
  mecanismo: string;
  /** customizado: o nome do mecanismo é o próprio MEC_ (sem campos). */
  customizado: boolean;
  campos: Record<string, string>;
  /** Associado e o que não se sabe regravar: o painel mostra, mas não edita. */
  editavel: boolean;
  motivo?: string;
}

export function lerAtribuicao(o: ObjetoBpmn): Atribuicao {
  const mecanismo = o.attrs['managerMechanism'] ?? '';
  const blob = o.attrs['managerAssignmentControllerString'] ?? '';
  if (!mecanismo) return { mecanismo: '', customizado: false, campos: {}, editavel: true };
  const nativo = MECANISMOS[mecanismo];
  if (!blob) {
    // Mecanismo customizado gravado sem controlador (43 tarefas no corpus): é só o nome.
    if (!nativo) return { mecanismo, customizado: true, campos: {}, editavel: true };
    return { mecanismo, customizado: false, campos: {}, editavel: true };
  }
  const no = lerBlob(blob);
  const classe = no?.nome.startsWith(PREFIXO) ? no.nome.slice(PREFIXO.length) : '';
  if (!no) {
    return { mecanismo, customizado: false, campos: {}, editavel: false, motivo: 'configuração em um formato que o painel não regrava; altere no XML' };
  }
  if (serializarX(no) !== blob) {
    // O diagrama baixado do servidor traz o blob compacto, sem a indentação do Studio:
    // os campos se leem, mas regravar mudaria o formato.
    const campos = nativo && nativo.classe === classe ? Object.fromEntries(nativo.campos.map((c) => [c, texto(no, c) ?? ''])) : {};
    return { mecanismo, customizado: false, campos, editavel: false, motivo: 'configuração em um formato que o painel não regrava; altere no XML' };
  }
  if (classe === 'AssignmentControllerCustom') return { mecanismo, customizado: true, campos: {}, editavel: true };
  if (!nativo || nativo.classe !== classe) {
    return { mecanismo, customizado: false, campos: {}, editavel: false, motivo: `mecanismo ${mecanismo} (${classe || 'desconhecido'}): o painel ainda não edita este tipo` };
  }
  const campos = Object.fromEntries(nativo.campos.map((c) => [c, texto(no, c) ?? '']));
  return { mecanismo, customizado: false, campos, editavel: true };
}

/** O blob que o Studio grava para uma atribuição. */
export function blobDeAtribuicao(a: { mecanismo: string; customizado: boolean; campos: Record<string, string> }): string {
  if (a.customizado) return serializarX({ nome: `${PREFIXO}AssignmentControllerCustom`, filhos: [{ nome: 'mechanismName', texto: a.mecanismo }] });
  const nativo = MECANISMOS[a.mecanismo];
  if (!nativo) throw new EdicaoInvalida(`mecanismo desconhecido: ${a.mecanismo}`);
  return serializarX({
    nome: PREFIXO + nativo.classe,
    filhos: [...nativo.campos.map((c) => ({ nome: c, texto: a.campos[c] ?? '' })), { nome: 'mechanismName', texto: a.mecanismo }],
  });
}

const ID_VALIDO = /^[\w.@-][\w .@-]*$/;

export function trocarAtribuicaoNoXml(
  xml: string,
  id: string,
  pedido: { mecanismo: string; customizado: boolean; campos: Record<string, string> },
): string {
  const d = lerDiagrama(xml);
  const o = d.objetos.find((x) => x.attrs['id'] === id);
  if (!o) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  if (o.tipo !== 'BpmnTask' || o.attrs['type'] !== '80') throw new EdicaoInvalida('atribuição se edita em tarefa humana');
  if (!lerAtribuicao(o).editavel) throw new EdicaoInvalida('a atribuição atual não é editável pelo painel');

  if (!pedido.mecanismo) {
    return trocarAtributosNoXml(xml, id, { managerMechanism: '', managerAssignmentControllerString: null }, ['extendedFields', 'type']);
  }
  if (pedido.customizado) {
    if (!/^[A-Za-z_][\w]*$/.test(pedido.mecanismo)) throw new EdicaoInvalida('o mecanismo customizado é o id dele, como MEC_STG_ALCADAS');
  } else {
    const nativo = MECANISMOS[pedido.mecanismo];
    if (!nativo) throw new EdicaoInvalida(`mecanismo desconhecido: ${pedido.mecanismo}`);
    for (const c of nativo.campos) {
      const v = (pedido.campos[c] ?? '').trim();
      if (!v) throw new EdicaoInvalida(`informe ${c}`);
      if (c === 'returns' && !['0', '1', '2'].includes(v)) throw new EdicaoInvalida('returns é 0 (primeiro), 1 (último) ou 2 (todos)');
      if (c === 'idNode' && !d.objetos.some((x) => x.attrs['id'] === v)) throw new EdicaoInvalida(`a atividade ${v} não existe no diagrama`);
      if (c !== 'returns' && c !== 'idNode' && !ID_VALIDO.test(v)) throw new EdicaoInvalida(`${c} inválido: ${v}`);
      pedido.campos[c] = v;
    }
  }
  return trocarAtributosNoXml(
    xml,
    id,
    { managerMechanism: pedido.mecanismo, managerAssignmentControllerString: blobDeAtribuicao(pedido) },
    ['managerMechanism', 'extendedFields', 'type'],
  );
}

// ---------------------------------------------------------------------------
// Execução da service task.

export function tornarAutomaticaNoXml(xml: string, id: string): string {
  const o = lerDiagrama(xml).objetos.find((x) => x.attrs['id'] === id);
  if (!o) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  if (o.tipo !== 'BpmnTask' || o.attrs['type'] !== '82') throw new EdicaoInvalida('tipo de execução é da service task');
  if (o.attrs['executionType'] === '1') throw new EdicaoInvalida('a service task já é automática');
  return trocarAtributosNoXml(xml, id, { executionType: '1' }, ['esforcoCalculo', 'scriptFileName', 'type']);
}

// ---------------------------------------------------------------------------
// Condições do gateway.

const REGRA = 'com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules';
const CONDICAO = `${PREFIXO}ConditionImpl`;
const CAMPOS_REGRA = ['tenantId', 'version', 'sequence', 'expressionOrder', 'ruleOrder', 'field', 'value', 'operator', 'valueType'];

export interface Regra {
  campo: string;
  /** '1' igual, '2' diferente; outros (0, 9) só se leem. */
  operador: string;
  valor: string;
  /** tenantId, version, sequence, expressionOrder, ruleOrder como estavam; regra nova não tem. */
  meta?: string[];
}

export interface Condicao {
  destino: string;
  /** 'regra' (conditionType 1) ou 'expressao' (conditionType 0). */
  tipo: 'regra' | 'expressao';
  /** Em condição por regra o Studio deixa a expressão antiga (`false`, `true`): ela é preservada. */
  expressao: string;
  regras: Regra[];
  /** `order` como estava; condição nova recebe o próximo. */
  ordem?: string;
  /** O Studio às vezes não grava a tag expression. */
  semExpressao?: boolean;
}

export interface CondicoesGateway {
  editavel: boolean;
  motivo?: string;
  condicoes: Condicao[];
}

export const OPERADORES_EDITAVEIS = ['1', '2'];

export function lerCondicoes(o: ObjetoBpmn): CondicoesGateway {
  const blob = (o.attrs['condition'] ?? '').trim();
  if (blob === '' || /^<list\s*\/>$/.test(blob)) return { editavel: true, condicoes: [] };
  const lista = lerBlob(o.attrs['condition']!);
  const naoEditavel = (motivo: string): CondicoesGateway => ({ editavel: false, motivo, condicoes: [] });
  if (!lista || lista.nome !== 'list' || serializarX(lista) !== o.attrs['condition']) return naoEditavel('condição em um formato que o painel não regrava; altere no XML');
  const condicoes: Condicao[] = [];
  for (const c of lista.filhos ?? []) {
    const nomes = (c.filhos ?? []).map((f) => f.nome);
    if (c.nome !== CONDICAO || nomes.some((n) => !['order', 'expression', 'targetTask', 'conditionType', 'rules'].includes(n))) {
      return naoEditavel('há atribuição por caminho ou campo que o painel não edita; altere no XML');
    }
    const tipo = texto(c, 'conditionType');
    if (tipo !== '0' && tipo !== '1') return naoEditavel(`conditionType ${tipo ?? 'ausente'}`);
    const regras: Regra[] = [];
    for (const r of c.filhos?.find((f) => f.nome === 'rules')?.filhos ?? []) {
      if (r.nome !== REGRA || (r.filhos ?? []).map((f) => f.nome).join() !== CAMPOS_REGRA.join()) return naoEditavel('regra em formato desconhecido');
      regras.push({
        campo: texto(r, 'field') ?? '',
        operador: texto(r, 'operator') ?? '',
        valor: texto(r, 'value') ?? '',
        meta: CAMPOS_REGRA.slice(0, 5).map((k) => texto(r, k) ?? ''),
      });
    }
    condicoes.push({
      destino: texto(c, 'targetTask') ?? '',
      tipo: tipo === '1' ? 'regra' : 'expressao',
      expressao: texto(c, 'expression') ?? '',
      regras,
      ordem: texto(c, 'order') ?? '',
      ...(nomes.includes('expression') ? {} : { semExpressao: true }),
    });
  }
  return { editavel: true, condicoes };
}

function sufixo(id: string): string {
  return /(\d+)$/.exec(id)?.[1] ?? '0';
}

export function blobDeCondicoes(gatewayId: string, condicoes: Condicao[]): string {
  if (condicoes.length === 0) return '<list/>';
  let proxima = Math.max(0, ...condicoes.map((c) => Number(c.ordem) || 0));
  return serializarX({
    nome: 'list',
    filhos: condicoes.map((c) => {
      const ordem = c.ordem && /^\d+$/.test(c.ordem) ? c.ordem : String(++proxima);
      const filhos: NoX[] = [
        { nome: 'order', texto: ordem },
        ...(c.semExpressao ? [] : [{ nome: 'expression', texto: c.expressao }]),
        { nome: 'targetTask', texto: c.destino },
        { nome: 'conditionType', texto: c.tipo === 'regra' ? '1' : '0' },
      ];
      if (c.tipo === 'regra') {
        filhos.push({
          nome: 'rules',
          filhos: c.regras.map((r, j) => ({
            nome: REGRA,
            filhos: [
              ...(r.meta && r.meta.length === 5
                ? CAMPOS_REGRA.slice(0, 5).map((k, i) => ({ nome: k, texto: r.meta![i]! }))
                : [
                  { nome: 'tenantId', texto: '0' },
                  { nome: 'version', texto: '0' },
                  { nome: 'sequence', texto: sufixo(gatewayId) },
                  { nome: 'expressionOrder', texto: ordem },
                  { nome: 'ruleOrder', texto: String(j + 1) },
                ]),
              { nome: 'field', texto: r.campo },
              { nome: 'value', texto: r.valor },
              { nome: 'operator', texto: r.operador },
              { nome: 'valueType', texto: r.operador === '1' || r.operador === '2' ? '1' : '0' },
            ],
          })),
        });
      }
      return { nome: CONDICAO, filhos };
    }),
  });
}

export function trocarCondicoesNoXml(xml: string, id: string, condicoes: Condicao[]): string {
  const d = lerDiagrama(xml);
  const o = d.objetos.find((x) => x.attrs['id'] === id);
  if (!o) throw new ConflitoEdicao('elemento-removido', `o elemento ${id} não existe mais`);
  if (o.tipo !== 'BpmnGateway') throw new EdicaoInvalida('condições se editam no gateway');
  const atual = lerCondicoes(o);
  if (!atual.editavel) throw new EdicaoInvalida(atual.motivo ?? 'as condições deste gateway não são editáveis pelo painel');
  if (!Array.isArray(condicoes)) throw new EdicaoInvalida('condicoes precisa ser uma lista');

  const saidas = new Set(d.objetos.filter((f) => f.tipo === 'SequenceFlow' && f.attrs['sourceRef'] === id).map((f) => f.attrs['targetRef']));
  const vistos = new Set<string>();
  // Operadores 0 e 9 não se criam pelo painel, mas os que já estão no arquivo podem continuar.
  const existentes = new Set(atual.condicoes.flatMap((c) => c.regras.map((r) => `${c.destino}|${r.campo}|${r.operador}|${r.valor}`)));
  for (const c of condicoes) {
    if (!c || typeof c.destino !== 'string' || !saidas.has(c.destino)) throw new EdicaoInvalida(`não há fluxo deste gateway para ${c?.destino}`);
    if (vistos.has(c.destino)) throw new EdicaoInvalida(`duas condições para ${c.destino}`);
    if (c.ordem !== undefined && (typeof c.ordem !== 'string' || !/^\d*$/.test(c.ordem))) throw new EdicaoInvalida('ordem inválida');
    vistos.add(c.destino);
    if (c.tipo === 'expressao') {
      if (typeof c.expressao !== 'string' || !c.expressao.trim()) throw new EdicaoInvalida(`a condição para ${c.destino} precisa de uma expressão`);
      c.regras = [];
      delete c.semExpressao;
    } else if (c.tipo === 'regra') {
      if (!Array.isArray(c.regras) || c.regras.length === 0) throw new EdicaoInvalida(`a condição para ${c.destino} precisa de pelo menos uma regra`);
      for (const r of c.regras) {
        if (!r || typeof r.campo !== 'string' || !/^[\w.-]+$/.test(r.campo)) throw new EdicaoInvalida(`campo inválido na condição para ${c.destino}`);
        if (typeof r.valor !== 'string') throw new EdicaoInvalida('valor inválido');
        if (!OPERADORES_EDITAVEIS.includes(r.operador) && !existentes.has(`${c.destino}|${r.campo}|${r.operador}|${r.valor}`)) {
          throw new EdicaoInvalida(`operador ${r.operador}: o painel grava só igual (1) e diferente (2)`);
        }
      }
      if (typeof c.expressao !== 'string') c.expressao = '';
      for (const r of c.regras) if (r.meta !== undefined && (!Array.isArray(r.meta) || r.meta.length !== 5 || !r.meta.every((m) => typeof m === 'string' && /^\d*$/.test(m)))) throw new EdicaoInvalida('metadados de regra inválidos');
    } else {
      throw new EdicaoInvalida('tipo de condição é regra ou expressao');
    }
  }
  // Na ordem em que o Studio as guardou (`order`); o painel as lista na ordem das saídas.
  const ordenadas = condicoes
    .map((c, i) => ({ c, i, ordem: c.ordem && /^\d+$/.test(c.ordem) ? Number(c.ordem) : Infinity }))
    .sort((a, b) => a.ordem - b.ordem || a.i - b.i)
    .map((x) => x.c);
  return trocarAtributosNoXml(xml, id, { condition: blobDeCondicoes(id, ordenadas) }, ['extendedFields', 'type']);
}
