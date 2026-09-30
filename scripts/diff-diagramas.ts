/**
 * Harness diferencial do `push diagram`: converte cada `.process` que tem um
 * `.ecm30.xml` exportado pelo Studio ao lado e compara, filho a filho, o XML
 * gerado com o do Studio.
 *
 *   npm run diff-diagramas -- [raiz] [--detalhe <trecho do caminho>]
 *
 * A raiz (padrão ~/fluig/workspaces) é varrida atrás de pares
 * `workflow/diagrams/X.process` ↔ `workflow/.resources/X.ecm30.xml`. Só lê:
 * nada é escrito nos workspaces.
 *
 * Para não gerar falso diff, o `companyId` vem do ecm30 do par, e o `formId`
 * também quando o `cardIndex` do `.process` é um nome (o conversor não resolve
 * nome sem servidor).
 *
 * O conversor roda em modo parcial: pula o que não é suportado, e a comparação
 * fica restrita às entidades cobertas (estados dos tipos cobertos, links entre
 * eles, todas as raias e anotações, e condições, gatilhos, serviços e bends
 * desses estados e links). O par que tem algo não suportado aparece como tal —
 * no `push diagram` de verdade ele seria recusado.
 *
 * Os scripts (filho 6) vêm de `workflow/scripts/<processId>.*.js` do próprio
 * workspace e são comparados à parte, como o `aplicarScripts` compara: script
 * local desatualizado é esperado e não conta como erro do conversor.
 *
 * "Gabarito" é o par em que a versão, os estados e os links do ecm30 são
 * exatamente os do `.process`: nos outros, o ecm30 é de outra versão do
 * diagrama e a diferença não diz nada sobre o conversor.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';

import { textoAscii } from '../src/commands/push-diagram.js';
import { gerarEcm30 } from '../src/push/diagram/ecm30.js';
import { lerDiagrama, type Diagrama } from '../src/push/diagram/modelo.js';
import { lerXml, type No } from '../src/push/diagram/xml.js';
import { normalizar } from '../src/push/process-events.js';
import { lerScriptsDoProcesso } from '../src/push/process-source.js';

/**
 * Campos que o conversor não tem como reproduzir a partir do `.process`, e por
 * isso ficam fora da comparação. Toda entrada precisa de motivo.
 */
const IGNORADOS: { entidade: string; campo: string; motivo: string }[] = [
  {
    entidade: 'ProcessDefinitionVersion',
    campo: 'formIdV2',
    motivo:
      'omitido de propósito, como no fluig-cd: só o Studio mais novo grava (5 de 118 ecm30, sempre 0) ' +
      'e o XStream do Fluig 1.8.2 aborta em campo desconhecido',
  },
];

const FILHOS_COMPARADOS = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 15, 19] as const;
const TIPOS_COBERTOS = new Set([
  '10', '80', '81', '82', '84', '87', '32', '35', '37', '41', '43', '120', '126', '127', '60', '64', '65', '68',
]);
const TIPOS_DE_NO = new Set([
  'BpmnStartEvent', 'BpmnTask', 'BpmnEndEvent', 'BpmnGateway', 'BpmnIntermediateEvent', 'BpmnSubProcess',
]);

/** Chave de cada filho e, quando ele pende de um estado, o caminho do sequence do estado. */
const CHAVES: Record<number, { chave: (n: No) => string; coberto?: string }> = {
  3: {
    chave: (n) => `${campo(n, 'conditionProcessStatePK.sequence')}/${campo(n, 'conditionProcessStatePK.expressionOrder')}`,
    coberto: 'conditionProcessStatePK.sequence',
  },
  9: { chave: (n) => campo(n, 'processComponGrafPK.componGrafSequence') },
  10: { chave: (n) => campo(n, 'processLinkAssocPK.linkSequence') },
  12: {
    chave: (n) => `${campo(n, 'processStateTriggerPK.stateSequence')}/${campo(n, 'processStateTriggerPK.triggerSequence')}`,
    coberto: 'processStateTriggerPK.stateSequence',
  },
  15: { chave: (n) => campo(n, 'sequence'), coberto: 'sequence' },
  19: {
    chave: (n) => `${campo(n, 'sequence')}/${campo(n, 'expressionOrder')}/${campo(n, 'ruleOrder')}`,
    coberto: 'sequence',
  },
};
const NOMES: Record<number, string> = {
  3: 'ConditionProcessState', 9: 'ProcessComponGraf', 10: 'ProcessLinkAssoc', 12: 'ProcessStateTrigger',
  15: 'ProcessStateService', 19: 'ConditionProcessAutomaticRules',
};

interface Par {
  processo: string;
  ecm30: string;
}

function acharPares(dir: string, pares: Par[] = []): Par[] {
  let entradas;
  try {
    entradas = readdirSync(dir, { withFileTypes: true });
  } catch {
    return pares;
  }
  for (const e of entradas) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const caminho = join(dir, e.name);
    if (e.name === 'workflow' && existsSync(join(caminho, 'diagrams'))) {
      for (const arq of readdirSync(join(caminho, 'diagrams'))) {
        if (!arq.endsWith('.process')) continue;
        const ecm30 = join(caminho, '.resources', `${basename(arq, '.process')}.ecm30.xml`);
        if (existsSync(ecm30)) pares.push({ processo: join(caminho, 'diagrams', arq), ecm30 });
      }
      continue;
    }
    acharPares(caminho, pares);
  }
  return pares;
}

/** Achata uma entidade em caminho → texto; `<x/>` e `<x></x>` viram ''. */
function achatar(no: No, prefixo = '', saida = new Map<string, string>()): Map<string, string> {
  for (const f of no.filhos) {
    const caminho = prefixo ? `${prefixo}.${f.nome}` : f.nome;
    if (f.filhos.length > 0) achatar(f, caminho, saida);
    else saida.set(caminho, f.texto);
  }
  return saida;
}

const ignorado = (entidade: string, campo: string) =>
  IGNORADOS.some((i) => i.entidade === entidade && i.campo === campo);

const campo = (no: No, caminho: string): string => achatar(no).get(caminho) ?? '';

interface Diferenca {
  chave: string;
  esperado: string;
  obtido: string;
}

function compararEntidades(
  entidade: string,
  studio: Map<string, No>,
  gerado: Map<string, No>,
  difs: Diferenca[],
): void {
  for (const [id, s] of studio) {
    const g = gerado.get(id);
    if (!g) {
      difs.push({ chave: `${entidade}: entidade só no Studio`, esperado: id, obtido: '' });
      continue;
    }
    const cs = achatar(s);
    const cg = achatar(g);
    for (const nome of new Set([...cs.keys(), ...cg.keys()])) {
      if (ignorado(entidade, nome)) continue;
      const esperado = cs.get(nome);
      const obtido = cg.get(nome);
      if (esperado === obtido) continue;
      difs.push({
        chave: `${entidade}.${nome}${esperado === undefined ? ' (sobra)' : obtido === undefined ? ' (falta)' : ''}`,
        esperado: `${id}: ${esperado ?? '∅'}`,
        obtido: obtido ?? '∅',
      });
    }
  }
  for (const id of gerado.keys()) {
    if (!studio.has(id)) difs.push({ chave: `${entidade}: entidade só no gerado`, esperado: '', obtido: id });
  }
}

/** Indexa pela chave; chave repetida vira diferença em vez de sumir no Map. */
function porChave(nos: No[], chave: (n: No) => string, lado: string, difs: Diferenca[]): Map<string, No> {
  const mapa = new Map<string, No>();
  for (const n of nos) {
    const k = chave(n);
    if (mapa.has(k)) difs.push({ chave: `${n.nome}: chave repetida no ${lado}`, esperado: k, obtido: k });
    else mapa.set(k, n);
  }
  return mapa;
}

function sequenciasDoDiagrama(d: Diagrama): { nos: Set<string>; fluxos: Set<string> } {
  const sufixo = (id: string | undefined) => /(\d+)$/.exec(id ?? '')?.[1] ?? '';
  const nosIds = new Set(d.objetos.filter((o) => TIPOS_DE_NO.has(o.tipo)).map((o) => o.attrs['id'] ?? ''));
  return {
    nos: new Set([...nosIds].map(sufixo)),
    fluxos: new Set(
      d.objetos
        .filter((o) => o.tipo === 'SequenceFlow' && nosIds.has(o.attrs['sourceRef'] ?? '') && nosIds.has(o.attrs['targetRef'] ?? ''))
        .map((o) => sufixo(o.attrs['id'])),
    ),
  };
}

const iguais = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

async function scriptsDoPar(par: Par, processId: string): Promise<Map<string, string>> {
  try {
    return await lerScriptsDoProcesso(join(par.processo, '..', '..'), processId);
  } catch {
    return new Map();
  }
}

async function main(argv: string[]): Promise<void> {
  const detalheIdx = argv.indexOf('--detalhe');
  const detalhe = detalheIdx === -1 ? undefined : argv[detalheIdx + 1];
  const posicionais = argv.filter((_, i) => i !== detalheIdx && i !== detalheIdx + 1);
  const raiz = posicionais[0] ?? join(homedir(), 'fluig', 'workspaces');

  const pares = acharPares(raiz).sort((a, b) => a.processo.localeCompare(b.processo));
  const contagemCampos = new Map<string, { n: number; exemplo: Diferenca }>();
  const resumo = { pares: pares.length, ilegiveis: 0, gabarito: 0, suportados: 0, suportadosOk: 0, gabaritoOk: 0 };
  const okPorFilho = new Map<number, number>(FILHOS_COMPARADOS.map((f) => [f, 0]));
  const scripts = { iguais: 0, diferentes: [] as string[], semArquivo: 0, soLocal: 0, gabIguais: 0, gabDiferentes: 0 };

  for (const par of pares) {
    const nome = relative(raiz, par.processo);
    let diagrama: Diagrama;
    let studio: No[];
    try {
      diagrama = lerDiagrama(textoAscii(readFileSync(par.processo), par.processo));
      studio = (lerXml(readFileSync(par.ecm30, 'utf8')).filhos[0]?.filhos ?? []);
    } catch (erro) {
      resumo.ilegiveis++;
      console.log(`ilegível   ${nome}: ${(erro as Error).message}`);
      continue;
    }

    const sPD = studio[0]!;
    const sPDV = studio[1]!;
    const companyId = Number(campo(sPD, 'processDefinitionPK.companyId'));
    const cardIndex = diagrama.objetos.find((o) => o.tipo === 'BpmnProcess')?.attrs['cardIndex'] ?? '';
    const formId = /^\d+$/.test(cardIndex) ? undefined : Number(campo(sPDV, 'formId'));
    const processId = diagrama.objetos.find((o) => o.tipo === 'BpmnProcess')?.attrs['id'] ?? '';
    const locais = await scriptsDoPar(par, processId);

    let gerado: No[];
    let naoSuportados: string[];
    try {
      const r = gerarEcm30(diagrama, {
        companyId, parcial: true, scripts: locais, ...(formId === undefined ? {} : { formId }),
      });
      gerado = lerXml(r.xml).filhos[0]!.filhos;
      naoSuportados = r.naoSuportados;
    } catch (erro) {
      resumo.ilegiveis++;
      console.log(`recusado   ${nome}: ${(erro as Error).message}`);
      continue;
    }

    const seqs = sequenciasDoDiagrama(diagrama);
    const estadosStudio = studio[2]!.filhos;
    const linksStudio = studio[4]!.filhos;
    const versaoDiagrama = diagrama.objetos.find((o) => o.tipo === 'BpmnProcess')?.attrs['version'] ?? '';
    const gabarito =
      versaoDiagrama === campo(sPDV, 'processDefinitionVersionPK.version') &&
      iguais(seqs.nos, new Set(estadosStudio.map((e) => campo(e, 'processStatePK.sequence')))) &&
      iguais(seqs.fluxos, new Set(linksStudio.map((l) => campo(l, 'processLinkPK.linkSequence'))));
    if (gabarito) resumo.gabarito++;

    const cobertos = new Set(
      estadosStudio.filter((e) => TIPOS_COBERTOS.has(campo(e, 'bpmnType'))).map((e) => campo(e, 'processStatePK.sequence')),
    );
    const linksCobertos = linksStudio.filter(
      (l) => cobertos.has(campo(l, 'initialStateSequence')) && cobertos.has(campo(l, 'finalStateSequence')),
    );
    const seqLinks = new Set([
      ...linksCobertos.map((l) => campo(l, 'processLinkPK.linkSequence')),
      ...studio[10]!.filhos.map((l) => campo(l, 'processLinkAssocPK.linkSequence')),
    ]);
    const deEstadoCoberto = (caminho: string) => (n: No) => cobertos.has(campo(n, caminho));

    const difsPorFilho = new Map<number, Diferenca[]>();
    for (const f of FILHOS_COMPARADOS) {
      const difs: Diferenca[] = [];
      const s = studio[f]!;
      const g = gerado[f]!;
      if (f === 0 || f === 1) {
        compararEntidades(s.nome, new Map([['-', s]]), new Map([['-', g]]), difs);
      } else if (f === 2) {
        const chave = (n: No) => campo(n, 'processStatePK.sequence');
        compararEntidades('ProcessState', porChave(s.filhos.filter((e) => cobertos.has(chave(e))), chave, 'Studio', difs), porChave(g.filhos, chave, 'gerado', difs), difs);
      } else if (f === 4) {
        const chave = (n: No) => campo(n, 'processLinkPK.linkSequence');
        compararEntidades('ProcessLink', porChave(linksCobertos, chave, 'Studio', difs), porChave(g.filhos, chave, 'gerado', difs), difs);
      } else if (f === 8) {
        const chave = (n: No) => campo(n, 'swimLanePK.sequence');
        compararEntidades('SwimLane', porChave(s.filhos, chave, 'Studio', difs), porChave(g.filhos, chave, 'gerado', difs), difs);
      } else if (f !== 11) {
        const { chave, coberto } = CHAVES[f]!;
        const doStudio = coberto ? s.filhos.filter(deEstadoCoberto(coberto)) : s.filhos;
        compararEntidades(NOMES[f]!, porChave(doStudio, chave, 'Studio', difs), porChave(g.filhos, chave, 'gerado', difs), difs);
      } else {
        const chave = (n: No) => `${campo(n, 'processLinkBendPK.linkSequence')}/${campo(n, 'processLinkBendPK.bendSequence')}`;
        const doStudio = s.filhos.filter((b) => seqLinks.has(campo(b, 'processLinkBendPK.linkSequence')));
        compararEntidades('ProcessLinkBend', porChave(doStudio, chave, 'Studio', difs), porChave(g.filhos, chave, 'gerado', difs), difs);
      }
      difsPorFilho.set(f, difs);
    }

    const eventosStudio = new Map(studio[6]!.filhos.map((e) => [campo(e, 'workflowProcessEventPK.eventId'), campo(e, 'eventDescription')]));
    const eventosGerados = new Map(gerado[6]!.filhos.map((e) => [campo(e, 'workflowProcessEventPK.eventId'), e]));
    for (const [eventId, codigo] of eventosStudio) {
      const g = eventosGerados.get(eventId);
      if (!g) scripts.semArquivo++;
      else if (normalizar(codigo) === normalizar(campo(g, 'eventDescription'))) {
        scripts.iguais++;
        if (gabarito) scripts.gabIguais++;
      } else {
        scripts.diferentes.push(`${nome}: ${eventId}`);
        if (gabarito) scripts.gabDiferentes++;
      }
    }
    scripts.soLocal += [...eventosGerados.keys()].filter((id) => !eventosStudio.has(id)).length;

    const total = [...difsPorFilho.values()].reduce((n, d) => n + d.length, 0);
    const suportado = naoSuportados.length === 0;
    if (suportado) resumo.suportados++;
    if (suportado && total === 0) resumo.suportadosOk++;
    if (gabarito && total === 0) resumo.gabaritoOk++;
    if (gabarito) {
      for (const [f, d] of difsPorFilho) if (d.length === 0) okPorFilho.set(f, okPorFilho.get(f)! + 1);
      for (const d of [...difsPorFilho.values()].flat()) {
        const atual = contagemCampos.get(d.chave);
        contagemCampos.set(d.chave, { n: (atual?.n ?? 0) + 1, exemplo: atual?.exemplo ?? d });
      }
    }

    const filhosTexto = [...difsPorFilho].map(([f, d]) => `${f}:${d.length === 0 ? 'ok' : d.length}`).join(' ');
    console.log(
      `${total === 0 ? 'ok   ' : 'diff '} ${gabarito ? 'gabarito' : 'antigo  '} ${nome}  [${filhosTexto}]` +
        (suportado ? '' : `  unsupported: ${naoSuportados.filter((n) => !n.startsWith('fluxo ')).join('; ')}`),
    );
    if (detalhe !== undefined && nome.includes(detalhe)) {
      for (const d of [...difsPorFilho.values()].flat()) {
        console.log(`      ${d.chave}  studio=${JSON.stringify(d.esperado)}  gerado=${JSON.stringify(d.obtido)}`);
      }
    }
  }

  console.log('\nResumo');
  console.log(`  pares                         ${resumo.pares}`);
  console.log(`  ilegíveis/recusados           ${resumo.ilegiveis}`);
  console.log(`  gabarito (versão, nós e links iguais) ${resumo.gabarito}`);
  console.log(`  só com elementos suportados   ${resumo.suportados} (batem inteiros: ${resumo.suportadosOk})`);
  console.log(`  gabarito, parte coberta batendo em todos os filhos comparados: ${resumo.gabaritoOk}/${resumo.gabarito}`);
  console.log(`  gabarito por filho: ${[...okPorFilho].map(([f, n]) => `${f}=${n}/${resumo.gabarito}`).join('  ')}`);
  console.log(`  campos ignorados: ${IGNORADOS.length ? IGNORADOS.map((i) => `${i.entidade}.${i.campo}`).join(', ') : 'nenhum'}`);
  console.log(
    `  scripts (filho 6, contra workflow/scripts): ${scripts.iguais} iguais, ${scripts.diferentes.length} diferentes, ` +
      `${scripts.semArquivo} sem arquivo local, ${scripts.soLocal} só no local; ` +
      `nos gabaritos ${scripts.gabIguais} iguais, ${scripts.gabDiferentes} diferentes`,
  );
  for (const d of scripts.diferentes) console.log(`      script diferente: ${d}`);
  const top = [...contagemCampos].sort((a, b) => b[1].n - a[1].n).slice(0, 25);
  if (top.length) {
    console.log('\nCampos que mais divergem nos pares gabarito (ocorrências · exemplo studio → gerado)');
    for (const [chave, { n, exemplo }] of top) {
      console.log(`  ${String(n).padStart(5)}  ${chave}  ${JSON.stringify(exemplo.esperado).slice(0, 80)} → ${JSON.stringify(exemplo.obtido).slice(0, 60)}`);
    }
  }
}

await main(process.argv.slice(2));
