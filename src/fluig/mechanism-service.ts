import { ErroFluigctl } from '../errors.js';
import { exigirOk } from './rest.js';
import { login } from './session.js';

/**
 * Mecanismo de atribuição customizado (`mechanisms/<id>.js`), pelo REST do
 * Fluig — as rotas da extensão Fluiggers:
 *
 *   GET    /ecm/api/rest/ecm/mechanism/getCustomAttributionMechanismList
 *   POST   /ecm/api/rest/ecm/mechanism/createAttributionMechanism
 *   POST   /ecm/api/rest/ecm/mechanism/updateAttributionMechanism
 *   DELETE /ecm/api/rest/ecm/mechanism/deleteAttributionMechanism?mechanismId=<id>
 *
 * Diferente do evento global, aqui criar e atualizar são rotas distintas — o
 * criar recusa com "Código do mecanismo de atribuição já cadastrado". E o
 * mecanismo tem campos que não vêm de arquivo nenhum (`name`, `description`,
 * `controlClass`, `assignmentType`, `configurationClass`): no update, quem
 * manda é o **objeto lido do servidor**, com só o código trocado, para nenhum
 * deles ser adivinhado.
 */

const PREFIXO = '/ecm/api/rest/ecm/mechanism/';

/**
 * Os valores de um mecanismo novo, como a extensão cria: implementação custom e
 * tipo 1. Medido no fluig-localdev — o que o servidor devolve depois é isto.
 */
export const MECANISMO_NOVO = {
  assignmentType: 1,
  controlClass: 'com.datasul.technology.webdesk.workflow.assignment.customization.CustomAssignmentImpl',
  preSelectionClass: null,
  configurationClass: '',
} as const;

/** O objeto como o servidor devolve; é ele que volta no update, inteiro. */
export type MecanismoBruto = Record<string, unknown> & {
  attributionMecanismPK?: { companyId?: number; attributionMecanismId?: string };
};

export interface Mecanismo {
  mecanismoId: string;
  /** O `attributionMecanismDescription`: o código do arquivo `.js`. */
  codigo: string;
  nome: string;
  descricao: string;
  bruto: MecanismoBruto;
}

export interface MechanismClient {
  listar(): Promise<Mecanismo[]>;
  criar(mecanismo: MecanismoBruto): Promise<void>;
  atualizar(mecanismo: MecanismoBruto): Promise<void>;
}

export async function mechanismClient(
  baseUrl: string,
  companyId: number,
  username: string,
  password: string,
): Promise<MechanismClient> {
  const cookie = await login(baseUrl, username, password);
  const url = (rota: string) => `${baseUrl}${PREFIXO}${rota}`;
  const cabecalhos = { accept: 'application/json', cookie };

  const post = async (rota: string, corpo: MecanismoBruto, contexto: string): Promise<void> => {
    const resposta = await fetch(url(rota), {
      method: 'POST',
      headers: { ...cabecalhos, 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      redirect: 'manual',
    });
    exigirOk(await resposta.text(), contexto, resposta.status);
  };

  return {
    async listar(): Promise<Mecanismo[]> {
      const resposta = await fetch(url('getCustomAttributionMechanismList'), {
        headers: cabecalhos,
        redirect: 'manual',
      });
      const texto = await resposta.text();
      if (!resposta.ok) exigirOk(texto, 'a leitura dos mecanismos de atribuição', resposta.status);

      let lido: unknown;
      try {
        lido = JSON.parse(texto);
      } catch {
        throw new ErroFluigctl(
          `o servidor não devolveu a lista de mecanismos de atribuição em ${baseUrl} (não é JSON)`,
          7,
        );
      }
      if (!Array.isArray(lido)) {
        throw new ErroFluigctl(
          `o servidor não devolveu a lista de mecanismos de atribuição em ${baseUrl} (o formato mudou?)`,
          7,
        );
      }
      return lido.map((m) => {
        const bruto = m as MecanismoBruto;
        const mecanismoId = bruto.attributionMecanismPK?.attributionMecanismId;
        if (typeof mecanismoId !== 'string' || mecanismoId === '') {
          throw new ErroFluigctl(
            `a lista de mecanismos de atribuição de ${baseUrl} tem um mecanismo sem id`,
            7,
          );
        }
        return {
          mecanismoId,
          codigo: typeof bruto['attributionMecanismDescription'] === 'string' ? (bruto['attributionMecanismDescription'] as string) : '',
          nome: typeof bruto['name'] === 'string' ? (bruto['name'] as string) : '',
          descricao: typeof bruto['description'] === 'string' ? (bruto['description'] as string) : '',
          bruto,
        };
      });
    },

    async criar(mecanismo: MecanismoBruto): Promise<void> {
      await post('createAttributionMechanism', mecanismo, 'a criação do mecanismo de atribuição');
    },

    async atualizar(mecanismo: MecanismoBruto): Promise<void> {
      await post('updateAttributionMechanism', mecanismo, 'a atualização do mecanismo de atribuição');
    },
  };
}

/** O objeto de criação: os valores da extensão mais o id, o nome e a descrição. */
export function mecanismoNovo(
  companyId: number,
  mecanismoId: string,
  nome: string,
  descricao: string,
  codigo: string,
): MecanismoBruto {
  return {
    attributionMecanismPK: { companyId, attributionMecanismId: mecanismoId },
    ...MECANISMO_NOVO,
    name: nome,
    description: descricao,
    attributionMecanismDescription: codigo,
  };
}

/**
 * O objeto do update: o que o servidor devolveu, com `name`, `description` e o
 * código trocados. `controlClass`, `assignmentType` e `configurationClass` vêm
 * do servidor como estão — o mecanismo pode ter sido configurado por lá, e o
 * `.js` no repositório não diz nada sobre eles.
 */
export function mecanismoAtualizado(
  atual: Mecanismo,
  campos: { nome?: string; descricao?: string; codigo: string },
): MecanismoBruto {
  return {
    ...atual.bruto,
    name: campos.nome ?? atual.nome,
    description: campos.descricao ?? atual.descricao,
    attributionMecanismDescription: campos.codigo,
  };
}
