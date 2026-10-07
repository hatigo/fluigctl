import { criarNoXml, ligarNoXml } from './add.js';
import { EdicaoInvalida } from './edit.js';
import { checarDiagrama } from './check.js';
import { codificarAtributo } from './props.js';

/**
 * Um processo novo, como o Studio grava: a pool com as raias, o início ligado
 * ao fim e o objeto do processo com os atributos que os 94 diagramas do acervo
 * têm (volume e expediente "Default", formulário do servidor, complementos).
 *
 * O esqueleto (pool e raias) entra sem o visual; o início, o fim e a ligação
 * entram pelo mesmo caminho do visualizador, que acerta o visual, as fontes e
 * os tamanhos do arquivo inteiro como o Studio os grava (add.ts).
 */

export interface PedidoNovo {
  /** O processId: é o nome do arquivo e o id do processo no servidor. */
  id: string;
  nome: string;
  raias: string[];
  /** Id (número) ou nome do formulário; sem ele, o processo nasce sem formulário. */
  formulario?: string;
  /** O servidor ao qual o Studio associa o processo (serverId). */
  servidor?: string;
  categoria?: string;
}

const LARGURA = 1200;
/** Cabe uma service task com o tratamento de erro logo abaixo, como o padrão pede. */
const ALTURA_RAIA = 260;

export function validarProcessId(id: string): void {
  // O processId vira nome de arquivo (diagrama, scripts) e id no servidor.
  if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(id)) {
    throw new EdicaoInvalida(`processId inválido: "${id}"; use letras, números e _ (começando por letra, até 60)`);
  }
}

export function novoProcesso(p: PedidoNovo): string {
  validarProcessId(p.id);
  const nome = p.nome.trim();
  if (!nome) throw new EdicaoInvalida('o processo precisa de um nome');
  const raias = p.raias.map((r) => r.trim()).filter(Boolean);
  if (raias.length === 0) throw new EdicaoInvalida('o processo precisa de pelo menos uma raia');
  if (new Set(raias).size !== raias.length) throw new EdicaoInvalida('há raias com o mesmo nome');
  const c = (v: string) => codificarAtributo(v);
  const alturaPool = ALTURA_RAIA * raias.length;
  const ancora = (caminho: string) =>
    `<anchors xsi:type="pi:BoxRelativeAnchor" visible="true" active="true" referencedGraphicsAlgorithm="${caminho}/@graphicsAlgorithm" relativeWidth="1.0" relativeHeight="0.51">\n` +
    `          <graphicsAlgorithm xsi:type="al:Ellipse" filled="false" lineVisible="false"/>\n` +
    `        </anchors>`;
  const blocoRaia = (i: number) =>
    [
      `      <children xsi:type="pi:ContainerShape" visible="true" active="true">`,
      `        <graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="${LARGURA - 30}" height="${ALTURA_RAIA}" x="30"${i ? ` y="${i * ALTURA_RAIA}"` : ''}/>`,
      `        <link businessObjects="bpmnswimlane${i + 2}"/>`,
      `        <anchors xsi:type="pi:ChopboxAnchor"/>`,
      `        <anchors xsi:type="pi:ChopboxAnchor"/>`,
      `        ${ancora(`/0/@children.0/@children.${i}`)}`,
      `      </children>`,
    ].join('\n');
  const esqueleto = [
    '<?xml version="1.0" encoding="ASCII"?>',
    '<xmi:XMI xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:al="http://eclipse.org/graphiti/mm/algorithms" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL-XMI" xmlns:pi="http://eclipse.org/graphiti/mm/pictograms">',
    `  <pi:Diagram visible="true" gridUnit="10" diagramTypeId="BPMNdiagram" name="${c(p.id)}" snapToGrid="true" version="0.16.0">`,
    `    <graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" transparency="0.0" width="${LARGURA + 100}" height="${alturaPool + 100}"/>`,
    `    <children xsi:type="pi:ContainerShape" visible="true" active="true">`,
    `      <graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="${LARGURA}" height="${alturaPool}" x="10" y="10"/>`,
    `      <link businessObjects="bpmnpool1"/>`,
    `      <anchors xsi:type="pi:ChopboxAnchor"/>`,
    `      <anchors xsi:type="pi:ChopboxAnchor"/>`,
    `      ${ancora('/0/@children.0').replace(/\n {8}/g, '\n        ').replace(/\n {10}/g, '\n        ')}`,
    ...raias.map((_, i) => blocoRaia(i)),
    `    </children>`,
    `  </pi:Diagram>`,
    `  <bpmn2:BpmnPool id="bpmnpool1" name="${c(nome)}" cores="FFFFFF"/>`,
    ...raias.map((r, i) => `  <bpmn2:BpmnSwimLane id="bpmnswimlane${i + 2}" name="${c(r)}" cores="FFFFFF"/>`),
    `  <bpmn2:BpmnProcess id="${c(p.id)}" name="${c(nome)}" serverId="${c(p.servidor ?? '')}" version="1" author="" extendedFields="&lt;list/>" cardIndex="${c(p.formulario ?? '')}" formSource="server" category="${c(p.categoria ?? '')}" volume="Default" expedient="Default" instruction="" complementsLevel="1" notifyResponsibleComplements="true" notifyRequisitionerComplements="true"/>`,
    '</xmi:XMI>',
    '',
  ].join('\n');

  // Início e fim na primeira raia, à esquerda e à direita, ligados.
  const centro = 10 + ALTURA_RAIA / 2;
  const inicio = criarNoXml(esqueleto, { tipo: 'inicio', nome: 'Início', x: 90, y: centro - 17 });
  const fim = criarNoXml(inicio.xml, { tipo: 'fim', nome: 'Fim', x: LARGURA - 120, y: centro - 17 });
  const pronto = ligarNoXml(fim.xml, inicio.id, fim.id).xml;
  const erros = checarDiagrama(pronto).filter((a) => a.nivel === 'erro');
  if (erros.length) throw new Error(`o processo novo não passou no diagram check: ${erros.map((e) => `${e.onde}: ${e.mensagem}`).join('; ')}`);
  return pronto;
}
