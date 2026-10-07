import { lerDiagrama } from '../push/diagram/modelo.js';
import { medidorDoStudio, type Medidor } from './medida.js';
import { trocarCoordenada } from './edit.js';
import { codificarAtributo, estiloDoArquivo } from './props.js';
import { diagramaDe, filhos, primeiro, type Elemento } from './visual.js';

/**
 * Rótulo e tamanho como o Studio deixa ao abrir: o texto da forma é o nome do
 * objeto, a tarefa tem a altura do texto e o rótulo do gateway vai quebrado
 * (veja medida.ts). Sem isso, o Studio refaz os dois ao abrir e o arquivo fica
 * marcado como alterado; quem salvar, salva formas de outro tamanho, e o que
 * estava preso a elas (bolinha de erro, dobra) fica para trás.
 *
 * Só mexe nos atributos de tamanho e no value do texto; a posição (o canto de
 * cima à esquerda) fica, como o Studio faz. O evento de erro preso à tarefa
 * acompanha o canto de baixo à direita, o que o Studio não faz.
 */

/** A tag de abertura inteira; o valor entre aspas pode ter `>`. */
const TAG = /<[\w:.-]+(?:\s+[\w:.-]+\s*=\s*"[^"]*")*\s*\/?>/y;

const TAREFAS = new Set(['80', '81', '82', '84', '87']);
const GATEWAYS = new Set(['120', '121', '126', '127']);

function trocarAttr(tag: string, nome: string, valor: string): string {
  const re = new RegExp(`(\\s${nome}=")[^"]*(")`);
  return re.test(tag) ? tag.replace(re, `$1${valor}$2`) : tag;
}

/** Ajusta o rótulo e o tamanho de cada id ao nome que o modelo tem. */
export function ajustarAoNome(xml: string, ids: string[], m: Medidor = medidorDoStudio()): string {
  const d = diagramaDe(xml);
  if (!d) return xml;
  const objetos = new Map(lerDiagrama(xml).objetos.filter((o) => o.attrs['id']).map((o) => [o.attrs['id']!, o]));
  const estilo = estiloDoArquivo(xml);
  const blocos = new Map<string, Elemento>();
  const visitar = (e: Elemento) => {
    for (const f of [...filhos(e, 'children'), ...filhos(e, 'connections')]) {
      const id = primeiro(f, 'link')?.attrs.get('businessObjects');
      if (id) blocos.set(id, f);
      visitar(f);
    }
  };
  visitar(d);

  // Trocas de tag: [início, fim, tag nova], aplicadas do fim para o começo.
  const trocas: [number, number, string][] = [];
  const trocar = (e: Elemento | undefined, attrs: Record<string, string>) => {
    if (!e) return;
    TAG.lastIndex = e.inicio;
    const original = TAG.exec(xml)![0];
    let tag = original;
    for (const [k, v] of Object.entries(attrs)) tag = trocarAttr(tag, k, v);
    if (tag !== original) trocas.push([e.inicio, e.inicio + original.length, tag]);
  };
  const moverGa = (e: Elemento, dx: number, dy: number) => {
    TAG.lastIndex = e.inicio;
    const original = TAG.exec(xml)![0];
    const tag = trocarCoordenada(trocarCoordenada(original, 'x', Number(e.attrs.get('x') ?? 0) + dx), 'y', Number(e.attrs.get('y') ?? 0) + dy);
    if (tag !== original) trocas.push([e.inicio, e.inicio + original.length, tag]);
  };
  const gaDosFilhos = (forma: Elemento) => filhos(forma, 'children').filter((c) => !primeiro(c, 'link')).map((c) => primeiro(c, 'graphicsAlgorithm')).filter((g): g is Elemento => g !== undefined);
  const doTipo = (gas: Elemento[], tipo: string) => gas.find((g) => g.attrs.get('xsi:type') === tipo);

  for (const id of new Set(ids)) {
    const o = objetos.get(id);
    const forma = blocos.get(id);
    if (!o || !forma) continue;
    const nome = o.attrs['name'] ?? '';
    const gas = gaDosFilhos(forma);
    if (o.tipo === 'BpmnTask' && TAREFAS.has(o.attrs['type'] ?? '')) {
      const { largura, altura } = m.tarefa(nome);
      const ga = primeiro(forma, 'graphicsAlgorithm');
      const dx = largura - Number(ga?.attrs.get('width') ?? largura);
      const dy = altura - Number(ga?.attrs.get('height') ?? altura);
      trocar(ga, { width: String(largura), height: String(altura) });
      if (dx || dy) {
        for (const ev of objetos.values()) {
          if (ev.tipo !== 'BpmnIntermediateEvent' || ev.attrs['parentTask'] !== id) continue;
          const gaEvento = primeiro(blocos.get(ev.attrs['id']!) ?? forma, 'graphicsAlgorithm');
          if (!gaEvento || !blocos.has(ev.attrs['id']!)) continue;
          moverGa(gaEvento, dx, dy);
        }
      }
      trocar(doTipo(gas, 'al:RoundedRectangle'), { width: String(largura), height: String(altura) });
      trocar(doTipo(gas, 'al:MultiText'), { width: String(largura - 10), height: String(altura - 10), value: codificarAtributo(nome, estilo) });
    } else if (o.tipo === 'BpmnGateway' && GATEWAYS.has(o.attrs['type'] ?? '')) {
      const r = m.rotuloDoGateway(nome);
      trocar(primeiro(forma, 'graphicsAlgorithm'), { height: String(60 + r.altura) });
      trocar(doTipo(gas, 'al:MultiText'), { height: String(r.altura), value: codificarAtributo(r.valor, estilo) });
    } else if (o.tipo === 'SequenceFlow') {
      const texto = filhos(forma, 'connectionDecorators').map((c) => primeiro(c, 'graphicsAlgorithm')).find((g) => g?.attrs.get('xsi:type') === 'al:Text');
      trocar(texto, { value: codificarAtributo(nome, estilo) });
    } else if (o.tipo === 'BpmnPool' || o.tipo === 'BpmnSwimLane') {
      trocar(doTipo(gas, 'al:Text'), { value: codificarAtributo(nome, estilo) });
    }
  }
  trocas.sort((a, b) => b[0] - a[0]);
  let saida = xml;
  for (const [ini, fim, tag] of trocas) saida = saida.slice(0, ini) + tag + saida.slice(fim);
  return saida;
}
