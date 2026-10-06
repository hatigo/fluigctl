/**
 * Modelos de forma e de objeto para quando o diagrama ainda não tem um elemento
 * do tipo que se quer criar. Vêm do diagrama de contratação, que publica e passa
 * no diagram check (os paralelos, de um diagrama do Studio, sem as referências
 * de estilo, cor e fonte); o que se cria a partir deles é reescrito (ids, índices,
 * posição, nome) em add.ts. Gerado a partir de test/fixtures/diagrams/contratacao.process.
 */

export interface Modelo {
  /** Id do objeto no modelo: é o que se troca pelo id novo. */
  id: string;
  /** O bloco de topo do pictograma (`<children>` ou `<connections>`), com o índice que tinha. */
  forma: string;
  indice: number;
  /** A tag `bpmn2:` do objeto. */
  modelo: string;
}

export const MODELOS: Record<string, Modelo> = {
  "humana": {
    id: "task13",
    indice: 3,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Rectangle\" lineWidth=\"1\" width=\"140\" height=\"67\" x=\"450\" y=\"326\"/>\n      <link businessObjects=\"task13\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:MultiText\" width=\"130\" height=\"57\" x=\"5\" y=\"5\" value=\"Tratar erro de al&#xe7;ada\"/>\n      </children>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:Image\" lineWidth=\"1\" transparency=\"0.0\" width=\"16\" height=\"16\" x=\"5\" y=\"5\" id=\"com.totvs.tds.ecm.designer.task.user\" stretchH=\"false\" stretchV=\"false\" proportional=\"false\"/>\n      </children>\n    </children>",
    modelo: "<bpmn2:BpmnTask id=\"task13\" name=\"Tratar erro de al&#xe7;ada\" type=\"80\" extendedFields=\"&lt;list/>\" managerMechanism=\"Pool Grupo\" managerAssignmentControllerString=\"&lt;org.eclipse.bpmn2.impl.AssignmentControllerPoolGroup>&#xA;  &lt;groupId>suporte_processos&lt;/groupId>&#xA;  &lt;mechanismName>Pool Grupo&lt;/mechanismName>&#xA;&lt;/org.eclipse.bpmn2.impl.AssignmentControllerPoolGroup>\" loopType=\"0\" authNotify=\"true\" expediente=\"\" selecionaColaboradores=\"1\" esforcoCalculo=\"0\" executionAttempts=\"0\" frequency=\"0\"/>",
  },
  "servico": {
    id: "servicetask3",
    indice: 8,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Rectangle\" lineWidth=\"1\" width=\"140\" height=\"67\" x=\"450\" y=\"226\"/>\n      <link businessObjects=\"servicetask3\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:MultiText\" width=\"130\" height=\"57\" x=\"5\" y=\"5\" value=\"Obter al&#xe7;adas\"/>\n      </children>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:Image\" lineWidth=\"1\" transparency=\"0.0\" width=\"16\" height=\"16\" x=\"5\" y=\"5\" id=\"com.totvs.tds.ecm.designer.task.service\" stretchH=\"false\" stretchV=\"false\" proportional=\"false\"/>\n      </children>\n    </children>",
    modelo: "<bpmn2:BpmnTask id=\"servicetask3\" name=\"Obter al&#xe7;adas\" type=\"82\" extendedFields=\"&lt;list/>\" managerMechanism=\"\" loopType=\"0\" authNotify=\"true\" serviceName=\"\" scriptFileName=\"contratacao.servicetask3.js\" expediente=\"\" selecionaColaboradores=\"1\" esforcoCalculo=\"0\" executionType=\"1\" executionAttempts=\"0\" executionSucessfulMessage=\"Integration performed successfully\" frequency=\"0\"/>",
  },
  "erro": {
    id: "intermediateerror12",
    indice: 14,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Ellipse\" lineWidth=\"1\" width=\"35\" height=\"35\" x=\"573\" y=\"276\">\n        <graphicsAlgorithmChildren xsi:type=\"al:Ellipse\" lineWidth=\"1\" width=\"35\" height=\"35\"/>\n      </graphicsAlgorithm>\n      <link businessObjects=\"intermediateerror12\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n    </children>",
    modelo: "<bpmn2:BpmnIntermediateEvent id=\"intermediateerror12\" name=\"Erro ao obter al&#xe7;adas\" type=\"43\" extendedFields=\"&lt;list/>\" sequenceAttached=\"3\" signalId=\"0\" parentTask=\"servicetask3\"/>",
  },
  "gateway": {
    id: "exclusivegateway6",
    indice: 10,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Polygon\" lineWidth=\"1\" width=\"60\" height=\"60\" x=\"1060\" y=\"230\">\n        <graphicsAlgorithmChildren xsi:type=\"al:Polygon\" lineWidth=\"1\"/>\n      </graphicsAlgorithm>\n      <link businessObjects=\"exclusivegateway6\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:Text\" width=\"60\" height=\"30\" y=\"60\" value=\"Aprovado?\"/>\n      </children>\n    </children>",
    modelo: "<bpmn2:BpmnGateway id=\"exclusivegateway6\" name=\"Aprovado?\" type=\"120\" extendedFields=\"&lt;list/>\" condition=\"&lt;list>&#xA;  &lt;org.eclipse.bpmn2.impl.ConditionImpl>&#xA;    &lt;order>1&lt;/order>&#xA;    &lt;expression>&lt;/expression>&#xA;    &lt;targetTask>exclusivegateway9&lt;/targetTask>&#xA;    &lt;conditionType>1&lt;/conditionType>&#xA;    &lt;rules>&#xA;      &lt;com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules>&#xA;        &lt;tenantId>0&lt;/tenantId>&#xA;        &lt;version>0&lt;/version>&#xA;        &lt;sequence>6&lt;/sequence>&#xA;        &lt;expressionOrder>1&lt;/expressionOrder>&#xA;        &lt;ruleOrder>1&lt;/ruleOrder>&#xA;        &lt;field>decisaoAprovacao&lt;/field>&#xA;        &lt;value>aprovado&lt;/value>&#xA;        &lt;operator>1&lt;/operator>&#xA;        &lt;valueType>1&lt;/valueType>&#xA;      &lt;/com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules>&#xA;    &lt;/rules>&#xA;  &lt;/org.eclipse.bpmn2.impl.ConditionImpl>&#xA;  &lt;org.eclipse.bpmn2.impl.ConditionImpl>&#xA;    &lt;order>2&lt;/order>&#xA;    &lt;expression>&lt;/expression>&#xA;    &lt;targetTask>servicetask7&lt;/targetTask>&#xA;    &lt;conditionType>1&lt;/conditionType>&#xA;    &lt;rules>&#xA;      &lt;com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules>&#xA;        &lt;tenantId>0&lt;/tenantId>&#xA;        &lt;version>0&lt;/version>&#xA;        &lt;sequence>6&lt;/sequence>&#xA;        &lt;expressionOrder>2&lt;/expressionOrder>&#xA;        &lt;ruleOrder>1&lt;/ruleOrder>&#xA;        &lt;field>decisaoAprovacao&lt;/field>&#xA;        &lt;value>reprovado&lt;/value>&#xA;        &lt;operator>1&lt;/operator>&#xA;        &lt;valueType>1&lt;/valueType>&#xA;      &lt;/com.totvs.tds.ecm.workflow.model.ConditionProcessAutomaticRules>&#xA;    &lt;/rules>&#xA;  &lt;/org.eclipse.bpmn2.impl.ConditionImpl>&#xA;&lt;/list>\"/>",
  },
  "fim": {
    id: "endevent11",
    indice: 7,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Ellipse\" lineWidth=\"1\" width=\"35\" height=\"35\" x=\"1583\" y=\"242\">\n        <graphicsAlgorithmChildren xsi:type=\"al:Ellipse\" lineWidth=\"1\" width=\"35\" height=\"35\"/>\n      </graphicsAlgorithm>\n      <link businessObjects=\"endevent11\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n    </children>",
    modelo: "<bpmn2:BpmnEndEvent id=\"endevent11\" name=\"Aprovada\" type=\"60\" extendedFields=\"&lt;list/>\" signalId=\"0\"/>",
  },
  "fluxo": {
    id: "flow16",
    indice: 0,
    forma: "    <connections xsi:type=\"pi:FreeFormConnection\" visible=\"true\" active=\"true\" start=\"/0/@children.1/@anchors.0\" end=\"/0/@children.2/@anchors.0\">\n      <graphicsAlgorithm xsi:type=\"al:Polyline\" lineWidth=\"1\"/>\n      <link businessObjects=\"flow16\"/>\n    </connections>",
    modelo: "<bpmn2:SequenceFlow id=\"flow16\" name=\"\" sourceRef=\"startevent1\" targetRef=\"task2\" atividadeFluxo=\"\" atividadeRetorno=\"\" extendedFields=\"&lt;list/>\"/>",
  },
  "inicio": {
    id: "startevent1",
    indice: 1,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Ellipse\" lineWidth=\"1\" width=\"35\" height=\"35\" x=\"83\" y=\"82\">\n        <graphicsAlgorithmChildren xsi:type=\"al:Ellipse\" lineWidth=\"1\" width=\"35\" height=\"35\"/>\n      </graphicsAlgorithm>\n      <link businessObjects=\"startevent1\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n    </children>",
    modelo: "<bpmn2:BpmnStartEvent id=\"startevent1\" name=\"In&#xed;cio\" type=\"10\" extendedFields=\"&lt;list/>\" signalId=\"0\" expediente=\"\" selecionaColaboradores=\"1\" esforcoCalculo=\"0\"/>",
  },
  "paralelo": {
    id: "parallelgateway24",
    indice: 7,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Rectangle\" lineWidth=\"1\" filled=\"false\" lineVisible=\"false\" transparency=\"0.0\" width=\"60\" height=\"86\" x=\"880\" y=\"301\">\n        <graphicsAlgorithmChildren xsi:type=\"al:Polygon\" lineWidth=\"1\" filled=\"true\" transparency=\"0.0\" width=\"60\" height=\"60\">\n          <graphicsAlgorithmChildren xsi:type=\"al:Polyline\" lineWidth=\"12\" filled=\"false\" transparency=\"0.0\">\n            <points x=\"8\" y=\"27\"/>\n            <points x=\"52\" y=\"27\"/>\n          </graphicsAlgorithmChildren>\n          <graphicsAlgorithmChildren xsi:type=\"al:Polyline\" lineWidth=\"12\" filled=\"false\" transparency=\"0.0\">\n            <points x=\"27\" y=\"8\"/>\n            <points x=\"27\" y=\"52\"/>\n          </graphicsAlgorithmChildren>\n          <points y=\"30\"/>\n          <points x=\"30\"/>\n          <points x=\"60\" y=\"30\"/>\n          <points x=\"30\" y=\"60\"/>\n          <points y=\"30\"/>\n        </graphicsAlgorithmChildren>\n      </graphicsAlgorithm>\n      <link businessObjects=\"parallelgateway24\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <anchors xsi:type=\"pi:BoxRelativeAnchor\" visible=\"true\" active=\"true\" referencedGraphicsAlgorithm=\"/0/@children.7/@graphicsAlgorithm/@graphicsAlgorithmChildren.0\" relativeWidth=\"0.51\" relativeHeight=\"0.1\">\n        <graphicsAlgorithm xsi:type=\"al:Ellipse\" filled=\"false\" lineVisible=\"false\"/>\n      </anchors>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <anchors xsi:type=\"pi:BoxRelativeAnchor\" visible=\"true\" active=\"true\" referencedGraphicsAlgorithm=\"/0/@children.7/@graphicsAlgorithm/@graphicsAlgorithmChildren.0\" relativeWidth=\"0.51\" relativeHeight=\"0.93\">\n        <graphicsAlgorithm xsi:type=\"al:Ellipse\" filled=\"false\" lineVisible=\"false\"/>\n      </anchors>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:MultiText\" lineWidth=\"1\" filled=\"false\" lineVisible=\"true\" transparency=\"0.0\" width=\"60\" height=\"26\" y=\"60\" horizontalAlignment=\"ALIGNMENT_CENTER\" value=\"Parallel&#xA;\"/>\n      </children>\n    </children>",
    modelo: "<bpmn2:BpmnGateway id=\"parallelgateway24\" name=\"Parallel\" type=\"126\" extendedFields=\"&lt;list/>\" condition=\"&lt;list/>\"/>",
  },
  "juncao": {
    id: "joingateway29",
    indice: 9,
    forma: "    <children xsi:type=\"pi:ContainerShape\" visible=\"true\" active=\"true\">\n      <graphicsAlgorithm xsi:type=\"al:Rectangle\" lineWidth=\"1\" filled=\"false\" lineVisible=\"false\" transparency=\"0.0\" width=\"60\" height=\"99\" x=\"1300\" y=\"161\">\n        <graphicsAlgorithmChildren xsi:type=\"al:Polygon\" lineWidth=\"1\" filled=\"true\" transparency=\"0.0\" width=\"60\" height=\"60\">\n          <graphicsAlgorithmChildren xsi:type=\"al:Polyline\" lineWidth=\"12\" filled=\"false\" transparency=\"0.0\">\n            <points x=\"8\" y=\"27\"/>\n            <points x=\"52\" y=\"27\"/>\n          </graphicsAlgorithmChildren>\n          <graphicsAlgorithmChildren xsi:type=\"al:Polyline\" lineWidth=\"12\" filled=\"false\" transparency=\"0.0\">\n            <points x=\"27\" y=\"8\"/>\n            <points x=\"27\" y=\"52\"/>\n          </graphicsAlgorithmChildren>\n          <points y=\"30\"/>\n          <points x=\"30\"/>\n          <points x=\"60\" y=\"30\"/>\n          <points x=\"30\" y=\"60\"/>\n          <points y=\"30\"/>\n        </graphicsAlgorithmChildren>\n      </graphicsAlgorithm>\n      <link businessObjects=\"joingateway29\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <anchors xsi:type=\"pi:BoxRelativeAnchor\" visible=\"true\" active=\"true\" referencedGraphicsAlgorithm=\"/0/@children.9/@graphicsAlgorithm/@graphicsAlgorithmChildren.0\" relativeWidth=\"0.51\" relativeHeight=\"0.1\">\n        <graphicsAlgorithm xsi:type=\"al:Ellipse\" filled=\"false\" lineVisible=\"false\"/>\n      </anchors>\n      <anchors xsi:type=\"pi:ChopboxAnchor\"/>\n      <anchors xsi:type=\"pi:BoxRelativeAnchor\" visible=\"true\" active=\"true\" referencedGraphicsAlgorithm=\"/0/@children.9/@graphicsAlgorithm/@graphicsAlgorithmChildren.0\" relativeWidth=\"0.51\" relativeHeight=\"0.93\">\n        <graphicsAlgorithm xsi:type=\"al:Ellipse\" filled=\"false\" lineVisible=\"false\"/>\n      </anchors>\n      <children visible=\"true\">\n        <graphicsAlgorithm xsi:type=\"al:MultiText\" lineWidth=\"1\" filled=\"false\" lineVisible=\"true\" transparency=\"0.0\" width=\"60\" height=\"39\" y=\"60\" horizontalAlignment=\"ALIGNMENT_CENTER\" value=\"Finaliza&#xe7;&#xA;&#xe3;o&#xA;\"/>\n      </children>\n    </children>",
    modelo: "<bpmn2:BpmnGateway id=\"joingateway29\" name=\"Finaliza&#xe7;&#xe3;o\" type=\"127\" extendedFields=\"&lt;list/>\" condition=\"&lt;list/>\"/>",
  },
};
