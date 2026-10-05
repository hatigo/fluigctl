import { ErroFluigctl } from '../errors.js';

/**
 * A widget auxiliar do Fluiggers é o único caminho de leitura de widget que
 * existe: o Fluig não expõe serviço para baixar o `.war` de uma widget
 * instalada. A extensão Fluiggers instala essa auxiliar no servidor e conversa
 * com ela por três rotas próprias (`/fluiggersWidget/api/...`); é o mesmo que
 * este cliente faz.
 *
 * Como toda widget, a auxiliar precisa ser *publicada*, e é isso que a torna
 * uma dependência explícita: o `fluigctl` só a instala quando alguém pede.
 */

const PREFIXO = '/fluiggersWidget/api';
const CAMINHO_UPLOAD = '/portal/api/rest/wcmservice/rest/product/uploadfile';
const NOME_AUXILIAR = 'fluiggersWidget';

/** De onde a extensão, e agora o fluigctl, baixam o `.war` da auxiliar. */
export const URL_DA_AUXILIAR =
  'https://raw.githubusercontent.com/fluiggers/fluig-widget-helper/refs/heads/master/target/fluiggersWidget.war';

export interface WidgetNoServidor {
  /** O `code` é o nome da pasta da widget: `wcm/widget/<code>`. */
  code: string;
  title: string;
  description: string;
  /** Nome do `.war` que a auxiliar devolve em `/widgets/<filename>`. */
  filename: string;
}

export interface WidgetHelperClient {
  /** A auxiliar responde `pong`? Sem ela não há como listar nem baixar. */
  instalada(): Promise<boolean>;
  listar(): Promise<WidgetNoServidor[]>;
  baixar(filename: string): Promise<Buffer>;
}

export async function widgetHelperClient(baseUrl: string, cookie: string): Promise<WidgetHelperClient> {
  const cabecalhos = { accept: 'application/json', cookie };

  return {
    async instalada(): Promise<boolean> {
      const resposta = await fetch(`${baseUrl}${PREFIXO}/ping`, { headers: { cookie } });
      // 200 com "pong" é o mesmo critério da extensão; qualquer outra coisa é ausência.
      return resposta.status === 200 && (await resposta.text()).trim() === 'pong';
    },

    async listar(): Promise<WidgetNoServidor[]> {
      const resposta = await fetch(`${baseUrl}${PREFIXO}/widgets`, { headers: cabecalhos });
      if (!resposta.ok) {
        throw new ErroFluigctl(
          `a widget auxiliar respondeu ${resposta.status} ao listar as widgets de ${baseUrl}`,
          7,
        );
      }
      const lista = (await resposta.json()) as unknown;
      if (!Array.isArray(lista)) {
        throw new ErroFluigctl(`a widget auxiliar não devolveu uma lista de widgets em ${baseUrl}`, 7);
      }
      return lista.map((w) => {
        const item = w as Partial<WidgetNoServidor>;
        return {
          code: String(item.code ?? ''),
          title: String(item.title ?? ''),
          description: String(item.description ?? ''),
          filename: String(item.filename ?? ''),
        };
      });
    },

    async baixar(filename: string): Promise<Buffer> {
      const resposta = await fetch(`${baseUrl}${PREFIXO}/widgets/${encodeURIComponent(filename)}`, {
        headers: { cookie },
      });
      if (!resposta.ok) {
        throw new ErroFluigctl(
          `a widget auxiliar respondeu ${resposta.status} ao baixar "${filename}" (${(await resposta.text()).slice(0, 200)})`,
          7,
        );
      }
      return Buffer.from(await resposta.arrayBuffer());
    },
  };
}

/**
 * Publica a widget auxiliar no servidor — a mesma sequência da extensão:
 * baixa o `.war` do repositório do Fluiggers e sobe pelo endpoint de upload de
 * widget. Devolve o nome publicado para quem chamou poder dizer o que fez.
 */
export async function instalarWidgetHelper(baseUrl: string, cookie: string): Promise<string> {
  const origem = await fetch(URL_DA_AUXILIAR);
  if (!origem.ok) {
    throw new ErroFluigctl(`não consegui baixar a widget auxiliar de ${URL_DA_AUXILIAR} (HTTP ${origem.status})`, 7);
  }
  const war = Buffer.from(await origem.arrayBuffer());

  const arquivo = `${NOME_AUXILIAR}.war`;
  const corpo = new FormData();
  corpo.append('fileName', arquivo);
  corpo.append('fileDescription', 'WCM Eclipse Plugin Deploy Artifact');
  corpo.append('attachment', new Blob([new Uint8Array(war)]), arquivo);

  const resposta = await fetch(baseUrl + CAMINHO_UPLOAD, {
    method: 'POST',
    headers: { accept: 'application/json', cookie },
    body: corpo,
    redirect: 'manual',
  });
  const texto = await resposta.text();

  if (!resposta.ok) {
    throw new ErroFluigctl(
      `o servidor recusou a widget auxiliar (HTTP ${resposta.status}): ${texto.slice(0, 300)}`,
      7,
    );
  }
  try {
    const conteudo = JSON.parse(texto) as { message?: string | { message?: string } };
    if (conteudo?.message) {
      const mensagem =
        typeof conteudo.message === 'string' ? conteudo.message : conteudo.message.message;
      throw new ErroFluigctl(`o servidor recusou a widget auxiliar: ${mensagem ?? ''}`, 7);
    }
  } catch (erro) {
    if (erro instanceof ErroFluigctl) throw erro;
    throw new ErroFluigctl(`resposta inesperada ao instalar a widget auxiliar: não é JSON`, 7);
  }

  return NOME_AUXILIAR;
}

/** A recusa que explica a dependência, com o comando que resolve. */
export function semWidgetHelper(url: string): ErroFluigctl {
  return new ErroFluigctl(
    `o servidor ${url} não tem a widget auxiliar do Fluiggers, e é ela que sabe ler o .war ` +
      'de uma widget instalada — o Fluig não expõe serviço para isso. Rode de novo com ' +
      '--instalar-helper para publicá-la (é uma publicação no servidor), ou instale pelo ' +
      'VS Code, com a extensão Fluiggers.',
    3,
  );
}
