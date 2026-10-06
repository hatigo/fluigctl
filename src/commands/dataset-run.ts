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
  customizados?: () => Promise<string[]>;
}

export async function rodarDataset(o: OpcoesDatasetRun, nome: string): Promise<ResultadoDataset> {
  const url = serverUrl(o.server);
  const restricoes = [...(o.restricoes ?? [])];
  // sqlLimit é o limite que o próprio Fluig entende (datasets internos e de
  // formulário); o corte aqui embaixo garante o mesmo para os customizados.
  if (o.limite !== undefined) restricoes.push({ campo: 'sqlLimit', inicial: String(o.limite), final: String(o.limite), tipo: 1 });
  let resultado: ResultadoDataset | undefined;
  if (o.consultar) {
    resultado = await o.consultar();
  } else {
    const cookie = await login(url, o.server.username, o.senha);
    resultado = await consultarDataset(url, cookie, { nome, campos: o.campos, restricoes, ordem: o.ordem });
  }
  if (!resultado) {
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
  return resultado;
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
