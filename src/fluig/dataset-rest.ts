import { ErroFluigctl } from '../errors.js';

/**
 * Consulta de dataset pelo REST público, o mesmo que o `DatasetFactory` do
 * navegador usa. Responde 200 até para dataset que não existe: o `content` vem
 * vazio (`{}`), sem colunas e sem mensagem. Quem chama decide o que isso quer
 * dizer, porque só ele sabe se o dataset deveria existir.
 */

/** 1 = MUST, 2 = SHOULD, 3 = MUST_NOT — os números do `ConstraintType`. */
export type TipoRestricao = 1 | 2 | 3;

export interface Restricao {
  campo: string;
  inicial: string;
  final: string;
  tipo: TipoRestricao;
  /** `%` no valor vira curinga, como `likeSearch` do `DatasetFactory`. */
  like?: boolean;
}

export interface ConsultaDataset {
  nome: string;
  campos?: string[] | undefined;
  restricoes?: Restricao[] | undefined;
  ordem?: string[] | undefined;
}

export interface ResultadoDataset {
  colunas: string[];
  linhas: Record<string, unknown>[];
}

/** O que o servidor devolveu; `undefined` quando veio o `content` vazio. */
export async function consultarDataset(url: string, cookie: string, c: ConsultaDataset): Promise<ResultadoDataset | undefined> {
  const resposta = await fetch(`${url}/api/public/ecm/dataset/datasets`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: c.nome,
      fields: c.campos?.length ? c.campos : null,
      constraints: c.restricoes?.length
        ? c.restricoes.map((r) => ({ _field: r.campo, _initialValue: r.inicial, _finalValue: r.final, _type: r.tipo, _likeSearch: r.like === true }))
        : null,
      order: c.ordem?.length ? c.ordem : null,
    }),
  });
  const texto = await resposta.text();
  let corpo: { content?: { columns?: unknown; values?: unknown }; message?: unknown };
  try {
    corpo = JSON.parse(texto) as typeof corpo;
  } catch {
    throw new ErroFluigctl(`o servidor não devolveu o dataset "${c.nome}" (HTTP ${resposta.status}): ${texto.trim().slice(0, 200)}`, 7);
  }
  if (corpo.message) {
    const m = corpo.message as { message?: unknown };
    throw new ErroFluigctl(`o dataset "${c.nome}" falhou: ${typeof m === 'string' ? m : String(m.message ?? JSON.stringify(m))}`, 7);
  }
  const conteudo = corpo.content;
  if (!conteudo || !Array.isArray(conteudo.columns)) return undefined;
  return {
    colunas: conteudo.columns.map(String),
    linhas: Array.isArray(conteudo.values) ? (conteudo.values as Record<string, unknown>[]) : [],
  };
}
