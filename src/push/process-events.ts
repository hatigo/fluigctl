/**
 * Os scripts de um processo vivem dentro da própria definição XML
 * (`<WorkflowProcessEvent>`, com o código em `<eventDescription>`). Publicar um
 * script é trocar esse texto na definição que o servidor já tem e reenviá-la.
 *
 * Tudo aqui opera sobre a definição decodificada em latin1 — é a codificação
 * em que o servidor a exporta e a espera de volta.
 */

export interface EventoDoProcesso {
  eventId: string;
  codigo: string;
}

export interface ResultadoEventos {
  xml: string;
  alterados: string[];
  iguais: string[];
  /** Evento que o servidor tem e o repositório não: fica como está. */
  semScriptLocal: string[];
  /** Script do repositório sem evento no servidor: só o Studio cria evento novo. */
  semEventoNoServidor: string[];
}

const BLOCO_EVENTO = /<WorkflowProcessEvent>([\s\S]*?)<\/WorkflowProcessEvent>/g;

export function eventosDoProcesso(xml: string): EventoDoProcesso[] {
  const eventos: EventoDoProcesso[] = [];
  for (const m of xml.matchAll(BLOCO_EVENTO)) {
    const bloco = m[1] ?? '';
    const id = /<eventId>([^<]*)<\/eventId>/.exec(bloco)?.[1];
    const descricao = /<eventDescription>([\s\S]*?)<\/eventDescription>/.exec(bloco);
    if (id === undefined) continue;
    eventos.push({ eventId: decodificar(id), codigo: descricao ? decodificar(descricao[1] ?? '') : '' });
  }
  return eventos;
}

/**
 * Troca o código de cada evento pelo script do repositório (`scripts` indexado
 * pelo eventId). Evento cujo código já é igual não é tocado, para o diff do
 * dry-run mostrar só o que muda de verdade.
 */
export function aplicarScripts(xml: string, scripts: Map<string, string>): ResultadoEventos {
  const alterados: string[] = [];
  const iguais: string[] = [];
  const semScriptLocal: string[] = [];
  const vistos = new Set<string>();

  const novo = xml.replace(BLOCO_EVENTO, (inteiro, bloco: string) => {
    const idBruto = /<eventId>([^<]*)<\/eventId>/.exec(bloco)?.[1];
    if (idBruto === undefined) return inteiro;
    const eventId = decodificar(idBruto);
    vistos.add(eventId);

    const local = scripts.get(eventId);
    if (local === undefined) {
      semScriptLocal.push(eventId);
      return inteiro;
    }

    const atual = /<eventDescription>([\s\S]*?)<\/eventDescription>/.exec(bloco);
    if (atual && normalizar(decodificar(atual[1] ?? '')) === normalizar(local)) {
      iguais.push(eventId);
      return inteiro;
    }
    if (!atual) {
      // Sem <eventDescription> não há onde pôr o código sem inventar a estrutura.
      semScriptLocal.push(eventId);
      return inteiro;
    }

    alterados.push(eventId);
    const trocado = bloco.replace(
      /<eventDescription>[\s\S]*?<\/eventDescription>/,
      () => `<eventDescription>${codificar(local)}</eventDescription>`,
    );
    return `<WorkflowProcessEvent>${trocado}</WorkflowProcessEvent>`;
  });

  const semEventoNoServidor = [...scripts.keys()].filter((id) => !vistos.has(id)).sort();
  return { xml: novo, alterados, iguais, semScriptLocal, semEventoNoServidor };
}

/**
 * Entidades filhas exportadas com o `<id>` do banco logo após a tag de abertura.
 * Reimportadas com esse id, o Hibernate as trata como já existentes ("detached
 * entity passed to persist") em vez de criar as linhas da versão nova — o
 * fluiglocaldev confirmou em ConditionProcessAutomaticRules e aplica o mesmo a
 * ProcessStateService, que tem o mesmo formato.
 */
export function removerIdsDasEntidadesFilhas(xml: string): string {
  return xml.replace(
    /(<(?:ConditionProcessAutomaticRules|ProcessStateService)>)\s*<id>[^<]*<\/id>/g,
    '$1',
  );
}

/** O servidor espera a definição sem a declaração `<?xml ...?>`. */
export function semDeclaracaoXml(xml: string): string {
  return xml.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
}

/**
 * Compara como o servidor guarda: fim de linha, espaço no fim e — porque o Studio
 * converte o script para latin1 ao exportar — qualquer caractere fora do latin1
 * vira "?" (o "—" de um comentário chega ao servidor como "?"). Sem isso, todo
 * script com um travessão apareceria como alterado para sempre.
 */
function normalizar(codigo: string): string {
  return Array.from(codigo.replace(/\r\n?/g, '\n').replace(/\s+$/, ''))
    .map((c) => ((c.codePointAt(0) ?? 0) > 0xff ? '?' : c))
    .join('');
}

function decodificar(texto: string): string {
  return texto
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Escapa para texto de XML. O que não cabe em latin1 vira referência numérica:
 * a definição trafega em ISO-8859-1, e um caractere fora dela seria trocado
 * por "?" no caminho.
 */
function codificar(texto: string): string {
  let saida = '';
  for (const c of texto.replace(/\r\n?/g, '\n')) {
    const ponto = c.codePointAt(0) ?? 0;
    if (c === '&') saida += '&amp;';
    else if (c === '<') saida += '&lt;';
    else if (c === '>') saida += '&gt;';
    else if (c === '"') saida += '&quot;';
    else if (ponto > 0xff) saida += `&#${ponto};`;
    else saida += c;
  }
  return saida;
}
