import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { datasetClient } from '../fluig/dataset-service.js';
import { consultarDataset, type ResultadoDataset, type Restricao } from '../fluig/dataset-rest.js';
import { login } from '../fluig/session.js';

/**
 * `dataset run`: roda um dataset no servidor e mostra as linhas, sem abrir o
 * painel. Só lê. Serve para conferir um dataset recém-publicado e para olhar
 * os dados que um processo vai consultar.
 */

/**
 * Uma restrição no formato da linha de comando:
 *   campo=valor      MUST
 *   campo!=valor     MUST_NOT
 *   campo~valor      MUST com likeSearch (`%` é curinga)
 *   campo=ini..fim   MUST num intervalo
 */
export function lerRestricao(texto: string): Restricao {
  const m = /^([^=!~]+?)(!=|=|~)(.*)$/s.exec(texto);
  if (!m || !m[1]!.trim()) {
    throw new ErroFluigctl(`--where "${texto}": use campo=valor, campo!=valor, campo~valor (com %) ou campo=inicio..fim`, 2);
  }
  const campo = m[1]!.trim();
  const valor = m[3]!;
  if (m[2] === '!=') return { campo, inicial: valor, final: valor, tipo: 3 };
  if (m[2] === '~') return { campo, inicial: valor, final: valor, tipo: 1, like: true };
  const faixa = /^(.*)\.\.(.*)$/s.exec(valor);
  if (faixa) return { campo, inicial: faixa[1]!, final: faixa[2]!, tipo: 1 };
  return { campo, inicial: valor, final: valor, tipo: 1 };
}

export interface OpcoesDatasetRun {
  server: Server;
  senha: string;
  campos?: string[] | undefined;
  restricoes?: Restricao[] | undefined;
  ordem?: string[] | undefined;
  limite?: number | undefined;
  /** Para testes: a resposta do servidor e os datasets customizados. */
  consultar?: () => Promise<ResultadoDataset | undefined>;
  /** Para testes: a resposta à consulta sem filtros, que diz se o dataset existe. */
  sondar?: () => Promise<ResultadoDataset | undefined>;
  customizados?: () => Promise<string[]>;
}

export interface ResultadoRun extends ResultadoDataset {
  /** Campos pedidos que não são colunas do dataset: o servidor os ignora sem avisar. */
  avisos: string[];
}

/** Os campos que a consulta cita (--fields, --where e --order), sem repetir. */
function camposCitados(o: OpcoesDatasetRun): { campo: string; opcao: string }[] {
  const citados = [
    ...(o.campos ?? []).map((campo) => ({ campo, opcao: '--fields' })),
    ...(o.restricoes ?? []).map((r) => ({ campo: r.campo, opcao: '--where' })),
    ...(o.ordem ?? []).map((c) => ({ campo: c.split(';')[0]!.trim(), opcao: '--order' })),
  ];
  return citados.filter((c, i) => citados.findIndex((x) => x.campo === c.campo && x.opcao === c.opcao) === i);
}

function semColuna(o: OpcoesDatasetRun, colunas: string[]): { campo: string; opcao: string }[] {
  return camposCitados(o).filter((c) => !colunas.includes(c.campo));
}

export async function rodarDataset(o: OpcoesDatasetRun, nome: string): Promise<ResultadoRun> {
  const url = serverUrl(o.server);
  const restricoes = [...(o.restricoes ?? [])];
  // sqlLimit é o limite que o próprio Fluig entende (datasets internos e de
  // formulário); o corte aqui embaixo garante o mesmo para os customizados.
  const limite = (n: number) => ({ campo: 'sqlLimit', inicial: String(n), final: String(n), tipo: 1 as const });
  if (o.limite !== undefined) restricoes.push(limite(o.limite));
  let resultado: ResultadoDataset | undefined;
  let cookie: string | undefined;
  if (o.consultar) {
    resultado = await o.consultar();
  } else {
    cookie = await login(url, o.server.username, o.senha);
    resultado = await consultarDataset(url, cookie, { nome, campos: o.campos, restricoes, ordem: o.ordem });
  }
  if (!resultado) {
    // Resposta vazia vem também de dataset que existe (inclusive os internos,
    // que não estão na lista dos customizados) quando a consulta pede uma
    // coluna que ele não tem. A mesma consulta sem filtros diz qual é o caso.
    const sonda = o.sondar ? await o.sondar() : cookie ? await consultarDataset(url, cookie, { nome, restricoes: [limite(1)] }) : undefined;
    if (sonda) {
      const faltam = semColuna(o, sonda.colunas);
      const motivo = faltam.length
        ? faltam.map((c) => `${c.campo} (${c.opcao})`).join(', ') + (faltam.length > 1 ? ' não são colunas dele' : ' não é coluna dele')
        : 'o servidor recusou os filtros';
      throw new ErroFluigctl(`o dataset "${nome}" existe em ${url}, mas não respondeu a esta consulta: ${motivo}. Colunas: ${sonda.colunas.join(', ')}`, 2);
    }
    const lista = o.customizados
      ? await o.customizados()
      : await (await datasetClient(url, o.server.companyId, o.server.username, o.senha)).listCustom();
    if (!lista.includes(nome)) {
      const parecidos = lista.filter((d) => d.toLowerCase().includes(nome.toLowerCase().slice(0, 6))).slice(0, 5);
      throw new ErroFluigctl(
        `o dataset "${nome}" não existe em ${url}` + (parecidos.length ? ` (parecidos: ${parecidos.join(', ')})` : ''),
        3,
      );
    }
    throw new ErroFluigctl(`o dataset "${nome}" existe em ${url}, mas não devolveu colunas: o script falhou sem mensagem — veja o log do servidor`, 7);
  }
  if (o.limite !== undefined) resultado = { ...resultado, linhas: resultado.linhas.slice(0, o.limite) };
  // O servidor devolve as colunas na ordem dele; quem pediu --fields quer a sua.
  if (o.campos?.length) {
    const pedidas = o.campos.filter((c) => resultado!.colunas.includes(c));
    resultado = { ...resultado, colunas: [...pedidas, ...resultado.colunas.filter((c) => !pedidas.includes(c))] };
  }
  // --where e --order numa coluna que não existe o servidor aceita sem avisar;
  // sem o aviso, "0 linha(s)" pareceria "não há dados". Com --fields a resposta
  // só traz as colunas pedidas, e a consulta sem filtros confirma as outras.
  let faltam = resultado.colunas.length ? semColuna({ ...o, campos: [] }, resultado.colunas) : [];
  if (faltam.length && o.campos?.length) {
    const sonda = o.sondar ? await o.sondar() : cookie ? await consultarDataset(url, cookie, { nome, restricoes: [limite(1)] }) : undefined;
    faltam = sonda ? faltam.filter((c) => !sonda.colunas.includes(c.campo)) : [];
  }
  return { ...resultado, avisos: faltam.map((c) => `${c.campo} (${c.opcao}) não é coluna do dataset: confira o nome`) };
}

/** Tabela alinhada para o terminal; valores longos são cortados em `largura`. */
export function formatarTabela(r: ResultadoDataset, largura = 60): string {
  const celula = (v: unknown) => {
    const t = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ');
    return t.length > largura ? `${t.slice(0, largura - 1)}…` : t;
  };
  const linhas = r.linhas.map((l) => r.colunas.map((c) => celula(l[c])));
  const tamanhos = r.colunas.map((c, i) => Math.max(c.length, ...linhas.map((l) => l[i]!.length)));
  const montar = (cs: string[]) => cs.map((c, i) => c.padEnd(tamanhos[i]!)).join('  ').trimEnd();
  return [montar(r.colunas), montar(tamanhos.map((t) => '-'.repeat(t))), ...linhas.map(montar)].join('\n');
}
