import { lerDiagrama, type Caixa, type ObjetoBpmn } from '../push/diagram/modelo.js';
import { filhos, lerXml, type No } from '../push/diagram/xml.js';

/**
 * Confere um `.process` editado fora do Studio.
 *
 * O agente edita o XMI direto, e duas coisas podem quebrar sem que o
 * `push diagram --dry-run` veja, porque ele só lê o modelo `bpmn2`:
 *
 * - **estrutura do Graphiti**: o pictograma aponta para os próprios nós por
 *   posição (`/0/@children.8/@anchors.0`, `/0/@connections.12`). Uma inserção
 *   fora de lugar desloca tudo, e o diagrama publica certo mas não abre no
 *   Studio. Foi assim que um `pictogramLinks` quebrou em 03/10/2026.
 * - **o padrão de recuperação das service tasks** (skill fluig-patterns,
 *   references/workflow.md): automática, evento de erro próprio, tratamento
 *   no grupo de suporte logo abaixo e na mesma raia, voltando à mesma task.
 *
 * Só lê; não corrige nada.
 */

export type Nivel = 'erro' | 'aviso';

export interface Achado {
  nivel: Nivel;
  /** `estrutura` (o arquivo está inconsistente) ou `padrao` (o processo foge do padrão). */
  grupo: 'estrutura' | 'padrao';
  /** Id do objeto BPMN ou caminho do nó no pictograma. */
  onde: string;
  mensagem: string;
}

export interface OpcoesCheck {
  /** Service tasks que o humano liberou do padrão (exceção explícita). */
  excecoes?: string[];
  /** Grupo de suporte esperado nas tarefas de tratamento; sem isso, qualquer grupo serve. */
  grupo?: string;
}

const TIPO_HUMANA = '80';
const TIPO_SERVICO = '82';
const TIPO_ERRO = '43';
const TIPO_LINK_ENVIA = '36';
const TIPO_LINK_RECEBE = '42';
const NOS_DE_FLUXO = new Set(['BpmnTask', 'BpmnGateway', 'BpmnStartEvent', 'BpmnEndEvent', 'BpmnIntermediateEvent', 'BpmnSubProcess']);

/** Um caminho EMF: `/0` e depois `@feature` ou `@feature.indice`. */
const CAMINHO = /^\/\d+(\/@[\w]+(\.\d+)?)*$/;

function resolver(raiz: No, caminho: string): No | undefined {
  const [, topo, ...partes] = caminho.split('/');
  let no: No | undefined = raiz.filhos[Number(topo)];
  for (const parte of partes) {
    if (!no) return undefined;
    const [nome, indice] = parte.slice(1).split('.');
    const candidatos = filhos(no, nome!);
    no = candidatos[indice === undefined ? 0 : Number(indice)];
  }
  return no;
}

/** Caminho de cada nó do pictograma, para comparar com o que as referências dizem. */
function caminhos(diagrama: No): Map<No, string> {
  const mapa = new Map<No, string>();
  const visitar = (no: No, caminho: string) => {
    mapa.set(no, caminho);
    const contagem = new Map<string, number>();
    const total = new Map<string, number>();
    for (const f of no.filhos) total.set(f.nome, (total.get(f.nome) ?? 0) + 1);
    for (const f of no.filhos) {
      const i = contagem.get(f.nome) ?? 0;
      contagem.set(f.nome, i + 1);
      // O EMF escreve sem índice a feature de valor único (`@link`, `@graphicsAlgorithm`).
      visitar(f, `${caminho}/@${f.nome}${total.get(f.nome)! > 1 || MULTIPLOS.has(f.nome) ? `.${i}` : ''}`);
    }
  };
  visitar(diagrama, '/0');
  return mapa;
}

/** Features de muitos valores: levam índice mesmo quando há um só. */
const MULTIPLOS = new Set([
  'children', 'connections', 'anchors', 'bendpoints', 'connectionDecorators', 'colors', 'fonts', 'styles',
  'graphicsAlgorithmChildren', 'properties', 'points',
]);

function lista(valor: string | undefined): string[] {
  return (valor ?? '').split(/\s+/).filter(Boolean);
}

function conferirEstrutura(raiz: No, diagrama: No, objetos: Map<string, ObjetoBpmn>, achados: Achado[]): void {
  const erro = (onde: string, mensagem: string) => achados.push({ nivel: 'erro', grupo: 'estrutura', onde, mensagem });
  const caminhoDe = caminhos(diagrama);

  // 1. Toda referência por caminho resolve.
  for (const [no, caminho] of caminhoDe) {
    for (const [attr, valor] of Object.entries(no.attrs)) {
      const tokens = lista(valor);
      if (tokens.length === 0 || !tokens.every((t) => CAMINHO.test(t))) continue;
      for (const t of tokens) {
        if (resolver(raiz, t)) continue;
        // Estilo, cor e fonte só mudam a aparência; o Studio grava alguns quebrados e abre.
        if (/^\/0\/@(styles|colors|fonts)\b/.test(t)) {
          achados.push({ nivel: 'aviso', grupo: 'estrutura', onde: caminho, mensagem: `${attr} aponta para ${t}, que não existe` });
        } else {
          erro(caminho, `${attr} aponta para ${t}, que não existe`);
        }
      }
    }
  }

  // 2. O que o pictogramLinks lista é um <link>. O contrário não vale: o próprio Studio
  // reexporta diagramas com <link> fora da lista (medicao-contratos, 15 deles) e os abre.
  for (const t of lista(diagrama.attrs['pictogramLinks'])) {
    const no = resolver(raiz, t);
    if (no && no.nome !== 'link') erro('pictogramLinks', `${t} é um <${no.nome}>, não um <link>`);
  }

  // 3. Âncoras e conexões concordam nos dois sentidos.
  const conexoes = filhos(diagrama, 'connections');
  const formaDaAncora = (ancora: No | undefined): string | undefined => {
    if (!ancora) return undefined;
    for (const [no] of caminhoDe) {
      if (filhos(no, 'anchors').includes(ancora)) return filhos(no, 'link')[0]?.attrs['businessObjects'];
    }
    return undefined;
  };
  conexoes.forEach((conexao, i) => {
    const caminho = `/0/@connections.${i}`;
    const fluxo = filhos(conexao, 'link')[0]?.attrs['businessObjects'];
    const onde = fluxo ?? caminho;
    const inicio = conexao.attrs['start'] ? resolver(raiz, conexao.attrs['start']) : undefined;
    const fim = conexao.attrs['end'] ? resolver(raiz, conexao.attrs['end']) : undefined;
    if (inicio && !lista(inicio.attrs['outgoingConnections']).includes(caminho)) {
      erro(onde, `a âncora de origem (${conexao.attrs['start']}) não lista ${caminho} em outgoingConnections`);
    }
    if (fim && !lista(fim.attrs['incomingConnections']).includes(caminho)) {
      erro(onde, `a âncora de destino (${conexao.attrs['end']}) não lista ${caminho} em incomingConnections`);
    }

    // 4. A conexão liga as formas do sourceRef e do targetRef do fluxo.
    if (!fluxo) {
      erro(caminho, 'conexão sem <link businessObjects>');
      return;
    }
    const objeto = objetos.get(fluxo);
    if (!objeto) {
      erro(caminho, `a conexão aponta para o fluxo ${fluxo}, que não existe no modelo`);
      return;
    }
    const origem = formaDaAncora(inicio);
    const destino = formaDaAncora(fim);
    if (origem !== undefined && origem !== objeto.attrs['sourceRef']) {
      erro(fluxo, `o desenho sai de ${origem}, mas o modelo diz sourceRef="${objeto.attrs['sourceRef']}"`);
    }
    if (destino !== undefined && destino !== objeto.attrs['targetRef']) {
      erro(fluxo, `o desenho chega em ${destino}, mas o modelo diz targetRef="${objeto.attrs['targetRef']}"`);
    }
  });
  for (const [no, caminho] of caminhoDe) {
    for (const attr of ['outgoingConnections', 'incomingConnections'] as const) {
      for (const t of lista(no.attrs[attr])) {
        const conexao = resolver(raiz, t);
        if (!conexao) continue; // já acusado em 1
        const ponta = attr === 'outgoingConnections' ? 'start' : 'end';
        if (conexao.attrs[ponta] !== caminho) erro(caminho, `${attr} lista ${t}, mas o ${ponta} dessa conexão é ${conexao.attrs[ponta] ?? 'vazio'}`);
      }
    }
  }

  // 5. Cada <link> aponta para um objeto do modelo, e cada fluxo do modelo está desenhado uma vez.
  const desenhados = new Map<string, number>();
  for (const [no, caminho] of caminhoDe) {
    if (no.nome !== 'link') continue;
    for (const id of lista(no.attrs['businessObjects'])) {
      if (!objetos.has(id)) erro(caminho, `businessObjects="${id}" não existe no modelo`);
      desenhados.set(id, (desenhados.get(id) ?? 0) + 1);
    }
  }
  for (const [id, o] of objetos) {
    const vezes = desenhados.get(id) ?? 0;
    if (vezes > 1) erro(id, `desenhado ${vezes} vezes`);
    if (vezes === 0 && o.tipo !== 'BpmnProcess' && (o.tipo === 'SequenceFlow' || o.tipo.startsWith('Bpmn'))) erro(id, `${o.tipo} sem desenho no diagrama`);
  }

  // 6. incoming/outgoing do modelo batem com os fluxos.
  for (const [id, o] of objetos) {
    if (o.tipo !== 'SequenceFlow') continue;
    const origem = objetos.get(o.attrs['sourceRef'] ?? '');
    const destino = objetos.get(o.attrs['targetRef'] ?? '');
    if (!origem) erro(id, `sourceRef="${o.attrs['sourceRef'] ?? ''}" não existe`);
    else if (!lista(origem.attrs['outgoing']).includes(id)) erro(id, `${o.attrs['sourceRef']} não lista ${id} em outgoing`);
    if (!destino) erro(id, `targetRef="${o.attrs['targetRef'] ?? ''}" não existe`);
    else if (!lista(destino.attrs['incoming']).includes(id)) erro(id, `${o.attrs['targetRef']} não lista ${id} em incoming`);
  }
  for (const [id, o] of objetos) {
    for (const attr of ['outgoing', 'incoming'] as const) {
      for (const f of lista(o.attrs[attr])) {
        const fluxo = objetos.get(f);
        const ponta = attr === 'outgoing' ? 'sourceRef' : 'targetRef';
        if (!fluxo) erro(id, `${attr} lista ${f}, que não existe`);
        else if (fluxo.attrs[ponta] !== id) erro(id, `${attr} lista ${f}, mas o ${ponta} dele é ${fluxo.attrs[ponta] ?? 'vazio'}`);
      }
    }
  }
}

function grupoDoPool(tarefa: ObjetoBpmn): string | undefined {
  const controle = tarefa.attrs['managerAssignmentControllerString'] ?? '';
  if (!controle.includes('AssignmentControllerPoolGroup')) return undefined;
  return /<groupId>([^<]*)<\/groupId>/.exec(controle)?.[1]?.trim() || undefined;
}

function raiaDe(caixa: Caixa | undefined, raias: [string, Caixa][]): string | undefined {
  if (!caixa) return undefined;
  const cy = caixa.absY + caixa.altura / 2;
  return raias.find(([, r]) => cy >= r.absY && cy < r.absY + r.altura)?.[0];
}

function conferirPadrao(
  objetos: Map<string, ObjetoBpmn>,
  caixas: Map<string, Caixa>,
  opcoes: OpcoesCheck,
  achados: Achado[],
): void {
  const achar = (nivel: Nivel, onde: string, mensagem: string) => achados.push({ nivel, grupo: 'padrao', onde, mensagem });
  const excecoes = new Set(opcoes.excecoes ?? []);
  const nome = (id: string) => {
    const n = objetos.get(id)?.attrs['name'];
    return n ? `${id} ("${n}")` : id;
  };
  const destinos = (id: string) =>
    lista(objetos.get(id)?.attrs['outgoing']).map((f) => objetos.get(f)?.attrs['targetRef']).filter((t): t is string => !!t);
  const raias = [...objetos].filter(([, o]) => o.tipo === 'BpmnSwimLane').flatMap(([id]) => {
    const c = caixas.get(id);
    return c ? [[id, c] as [string, Caixa]] : [];
  });

  const eventosDe = new Map<string, string[]>();
  for (const [id, o] of objetos) {
    if (o.tipo === 'BpmnIntermediateEvent' && o.attrs['type'] === TIPO_ERRO && o.attrs['parentTask']) {
      eventosDe.set(o.attrs['parentTask'], [...(eventosDe.get(o.attrs['parentTask']) ?? []), id]);
    }
  }

  for (const [id, o] of objetos) {
    // Nos 95 diagramas do acervo, só fim e link que envia ficam sem saída, e só
    // início, link que recebe e erro anexado ficam sem entrada.
    if (NOS_DE_FLUXO.has(o.tipo)) {
      const semSaida = o.tipo === 'BpmnEndEvent' || (o.tipo === 'BpmnIntermediateEvent' && o.attrs['type'] === TIPO_LINK_ENVIA);
      const semEntrada =
        o.tipo === 'BpmnStartEvent' ||
        (o.tipo === 'BpmnIntermediateEvent' && (o.attrs['type'] === TIPO_LINK_RECEBE || (o.attrs['type'] === TIPO_ERRO && !!o.attrs['parentTask'])));
      if (!semSaida && lista(o.attrs['outgoing']).length === 0) {
        achar('erro', nome(id), 'sem saída: a solicitação que chegar aqui fica parada');
      }
      if (!semEntrada && lista(o.attrs['incoming']).length === 0) {
        achar('erro', nome(id), 'sem entrada: nenhuma solicitação chega aqui');
      }
    }
    if (o.tipo === 'BpmnTask' && o.attrs['type'] === TIPO_HUMANA && !o.attrs['managerMechanism']) {
      // Comum nos diagramas do Studio: quem movimenta escolhe o responsável à mão. Por isso aviso.
      achar('aviso', nome(id), 'tarefa humana sem mecanismo de atribuição: quem movimenta escolhe o responsável à mão');
    }
    if (o.tipo !== 'BpmnTask' || o.attrs['type'] !== TIPO_SERVICO || excecoes.has(id)) continue;

    if (o.attrs['executionType'] !== '1') {
      achar('erro', nome(id), `executionType="${o.attrs['executionType'] ?? ''}": service task deve ser automática (1), salvo exceção explícita`);
    }
    const eventos = eventosDe.get(id) ?? [];
    if (eventos.length !== 1) {
      achar('erro', nome(id), eventos.length === 0 ? 'sem evento de erro anexado' : `${eventos.length} eventos de erro anexados; deve ser um`);
      continue;
    }
    const evento = eventos[0]!;
    if (!lista(o.attrs['attachedEvents']).includes(evento)) {
      achar('erro', nome(id), `attachedEvents não lista o evento ${evento}`);
    }

    const tratamentos = destinos(evento);
    if (tratamentos.length !== 1) {
      achar('erro', nome(evento), tratamentos.length === 0 ? 'o evento de erro não leva a nenhuma tarefa de tratamento' : 'o evento de erro leva a mais de uma tarefa');
      continue;
    }
    const tratamento = tratamentos[0]!;
    const t = objetos.get(tratamento)!;
    if (t.tipo !== 'BpmnTask' || t.attrs['type'] !== TIPO_HUMANA) {
      achar('erro', nome(tratamento), 'o evento de erro deve levar a uma tarefa humana de tratamento');
      continue;
    }
    const grupo = grupoDoPool(t);
    if (t.attrs['managerMechanism'] !== 'Pool Grupo' || !grupo) {
      achar('erro', nome(tratamento), `tratamento deve ser Pool Grupo com groupId (está "${t.attrs['managerMechanism'] ?? ''}")`);
    } else if (opcoes.grupo && grupo !== opcoes.grupo) {
      achar('erro', nome(tratamento), `grupo "${grupo}"; o esperado é "${opcoes.grupo}"`);
    }
    const volta = destinos(tratamento);
    if (!volta.includes(id)) {
      achar('erro', nome(tratamento), `o tratamento não volta para ${id}: depois de uma falha, a retentativa é na mesma service task`);
    }
    const outros = volta.filter((d) => d !== id);
    if (outros.length > 0) {
      achar('erro', nome(tratamento), `o tratamento também segue para ${outros.join(', ')}: falha de automação não encerra nem avança o processo`);
    }

    // Desenho: avisos, não erros — o processo funciona, só foge da receita.
    const cs = caixas.get(id);
    const ce = caixas.get(evento);
    const ct = caixas.get(tratamento);
    if (cs && ce) {
      const cx = ce.absX + ce.largura / 2;
      const cy = ce.absY + ce.altura / 2;
      const dist = Math.hypot(cx - (cs.absX + cs.largura), cy - (cs.absY + cs.altura));
      if (dist > ce.largura / 2) achar('aviso', nome(evento), 'a bolinha de erro não está sobre o canto inferior direito da service task');
    }
    if (cs && ct) {
      const abaixo = ct.absY >= cs.absY + cs.altura;
      const mesmaColuna = ct.absX < cs.absX + cs.largura && ct.absX + ct.largura > cs.absX;
      if (!abaixo || !mesmaColuna) achar('aviso', nome(tratamento), 'o tratamento não está logo abaixo da service task');
      const ra = raiaDe(cs, raias);
      const rb = raiaDe(ct, raias);
      if (ra && rb && ra !== rb) achar('erro', nome(tratamento), `o tratamento está na raia ${rb}, e a service task na ${ra}: deve ficar na mesma raia`);
    }
  }
}

export function checarDiagrama(texto: string, opcoes: OpcoesCheck = {}): Achado[] {
  const raiz = lerXml(texto).filhos[0]!;
  const { objetos: lista_, caixas } = lerDiagrama(texto);
  const objetos = new Map(lista_.filter((o) => o.attrs['id']).map((o) => [o.attrs['id']!, o]));
  const achados: Achado[] = [];
  const diagrama = filhos(raiz, 'pi:Diagram')[0];
  if (!diagrama) {
    achados.push({ nivel: 'erro', grupo: 'estrutura', onde: '/0', mensagem: 'sem <pi:Diagram>: o Studio não abre o arquivo' });
  } else if (raiz.filhos[0] !== diagrama) {
    achados.push({ nivel: 'erro', grupo: 'estrutura', onde: '/0', mensagem: 'o <pi:Diagram> precisa ser o primeiro filho da raiz: as referências /0/... apontam para ele' });
  } else {
    conferirEstrutura(raiz, diagrama, objetos, achados);
  }
  conferirPadrao(objetos, caixas, opcoes, achados);
  return achados;
}
