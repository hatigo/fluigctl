import { ErroFluigctl } from '../../errors.js';
import { filhos, lerXml, type No } from './xml.js';

/**
 * O `.process` tem duas camadas: os objetos de negócio (`bpmn2:*`, filhos
 * diretos da raiz XMI, com as propriedades em atributos) e o pictograma do
 * Graphiti (`pi:Diagram`), que só guarda geometria e aponta para o objeto pelo
 * id em `<link businessObjects="...">`.
 */

export interface ObjetoBpmn {
  /** Nome da tag sem o prefixo: `BpmnTask`, `SequenceFlow`... */
  tipo: string;
  attrs: Record<string, string>;
}

export interface Caixa {
  x: number;
  y: number;
  largura: number;
  altura: number;
  /** Coordenada no diagrama: o x/y de um shape é relativo ao shape que o contém. */
  absX: number;
  absY: number;
  /** Id do objeto do shape que contém este (a pool de uma lane). */
  pai?: string;
}

export interface Ponto {
  x: number;
  y: number;
}

export interface Diagrama {
  objetos: ObjetoBpmn[];
  caixas: Map<string, Caixa>;
  /** Bendpoints de cada conexão, pelo id do fluxo, na ordem do arquivo. */
  dobras: Map<string, Ponto[]>;
}

const numero = (valor: string | undefined): number => (valor ? Number(valor) : 0);

export function lerDiagrama(texto: string): Diagrama {
  const documento = lerXml(texto);
  const raiz = documento.filhos[0];
  if (!raiz || documento.filhos.length > 1 || raiz.nome !== 'xmi:XMI') {
    throw new ErroFluigctl('o .process precisa ter um único elemento raiz <xmi:XMI>', 6);
  }

  // Nenhum dos 255 .process medidos tem outra coisa aqui; o que aparecer é recusado, não ignorado.
  for (const f of raiz.filhos) {
    if (f.nome === 'pi:Diagram') continue;
    if (!f.nome.startsWith('bpmn2:')) {
      throw new ErroFluigctl(`elemento <${f.nome}> na raiz do .process não é suportado`, 6);
    }
    if (f.filhos.length > 0) {
      throw new ErroFluigctl(
        `<${f.nome} id="${f.attrs['id'] ?? ''}"> tem elementos filhos (<${f.filhos[0]!.nome}>), o que a conversão não cobre`,
        6,
      );
    }
  }

  const objetos = raiz.filhos
    .filter((f) => f.nome.startsWith('bpmn2:'))
    .map((f) => ({ tipo: f.nome.slice('bpmn2:'.length), attrs: f.attrs }));

  const caixas = new Map<string, Caixa>();
  const dobras = new Map<string, Ponto[]>();

  const diagrama = filhos(raiz, 'pi:Diagram')[0];
  if (diagrama) {
    const visitar = (shape: No, paiX: number, paiY: number, pai?: string) => {
      const ga = filhos(shape, 'graphicsAlgorithm')[0];
      const x = numero(ga?.attrs['x']);
      const y = numero(ga?.attrs['y']);
      const absX = paiX + x;
      const absY = paiY + y;
      const id = filhos(shape, 'link')[0]?.attrs['businessObjects'];
      if (id && ga) {
        caixas.set(id, {
          x, y, absX, absY,
          largura: numero(ga.attrs['width']),
          altura: numero(ga.attrs['height']),
          ...(pai === undefined ? {} : { pai }),
        });
      }
      for (const filho of filhos(shape, 'children')) visitar(filho, absX, absY, id ?? pai);
    };
    for (const shape of filhos(diagrama, 'children')) visitar(shape, 0, 0);

    for (const conexao of filhos(diagrama, 'connections')) {
      const id = filhos(conexao, 'link')[0]?.attrs['businessObjects'];
      if (!id) continue;
      dobras.set(
        id,
        filhos(conexao, 'bendpoints').map((b) => ({ x: numero(b.attrs['x']), y: numero(b.attrs['y']) })),
      );
    }
  }

  return { objetos, caixas, dobras };
}
