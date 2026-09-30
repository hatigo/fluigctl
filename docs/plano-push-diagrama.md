# Plano: publicar o diagrama sem o Fluig Studio

Hoje `push process` publica só os scripts de um processo que já existe; o
diagrama (`workflow/diagrams/*.process`, XMI do Graphiti) continua indo pelo
Studio. Este plano leva o diagrama ao servidor convertendo-o para o XML que
`ECMWorkflowEngineService.importProcess` aceita — o formato do `.ecm30.xml`.

Nada é enviado ao servidor antes da fase 3.

## O que foi medido

Varredura só de leitura de `~/fluig/workspaces` em 30/09/2026.

| | |
|---|---|
| `.process` | 255 (2 não são XML válido) |
| `.ecm30.xml` em `workflow/.resources` | 118 |
| pares com o mesmo nome | 96, dos quais 94 legíveis |
| pares em que todo estado bate com um nó por sufixo + nome | 90 |
| pares com conjunto de nós **e** de links idêntico | 74 — o gabarito |

Já existe um conversor MVP no fluiglocaldev (StrategiConsultoria),
`fluig-cd/src/core/processConverter.ts`, ~600 linhas. Cobre pool, lane,
início, tarefa, fim e fluxo de sequência; recusa gateway, evento intermediário
e subprocesso. Isso dá **44 de 255** diagramas reais. A numeração de lanes
(contador) e a versão da PK dele diferem das do Studio.

### Estrutura do `.ecm30.xml`

A raiz é `<list>` com exatamente 20 filhos, na mesma ordem nos 118 arquivos.
Contagem = total de elementos somando os 118. Referência pequena:
`bsm/fluigbsm/workflow/.resources/vagaExterna.ecm30.xml`.

| # | conteúdo | total |
|---|---|---|
| 0 | `ProcessDefinition` | — |
| 1 | `ProcessDefinitionVersion` | — |
| 2 | `ProcessState` | 3481 |
| 3 | `ConditionProcessState` | 899 |
| 4 | `ProcessLink` | 4063 |
| 5 | sempre vazio | 0 |
| 6 | `WorkflowProcessEvent` | 957 |
| 7 | `AdvancedProcessProperties` | 1 |
| 8 | `SwimLane` | 537 |
| 9 | `ProcessComponGraf` (anotações) | 66 |
| 10 | `ProcessLinkAssoc` | 57 |
| 11 | `ProcessLinkBend` | 1434 |
| 12 | `ProcessStateTrigger` (temporizadores) | 54 |
| 13 | `ExtendedPropertyField` | 1 |
| 14 | `ProcessFormField` | 232 |
| 15 | `ProcessStateService` | 653 |
| 16 | `SubProcessFieldRelationship` | 154 |
| 17 | `ProcessAppConfiguration` | 98 |
| 18 | `ProcessAttachmentRules` | 7 |
| 19 | `ConditionProcessAutomaticRules` | 720 |

### Mapeamento `.process` → ecm30

- `sequence` = sufixo numérico do id no `.process` (`task5` → 5; `flow31` →
  `linkSequence` 31).
- `bpmnType` = `type` do `.process`; `stateType` é derivado:

  | `type` | `stateType` |
  |---|---|
  | 10 (início) | 0 |
  | 80, 81, 82, 84, 87 (tarefas) | 0 |
  | 120 (gateway exclusivo) | 1, `automatic=true` |
  | 126 (paralelo) / 127 (join) | 3 / 4 |
  | 100 (subprocesso) | 2 |
  | 60, 64, 65, 68 (fins) | 6 |
  | 32, 35, 36, 37, 41, 42, 43 (intermediários) | 0 (32, temporizador: `automatic=true`) |

- `positionX/Y` = `x`/`y` crus do `ContainerShape` de topo.
- Atribuição vai inline no `ProcessState` (`engineAllocationId`,
  `engineAllocationConfiguration`); o `managerAssignmentControllerString` do
  XStream vira um `<AssignmentController>` simples (`PoolGroup` → `<Group>`;
  `ExecutorMechanism` → `<BaseActivity>N</BaseActivity><Returns>Last</Returns>`).
- Tarefa de serviço (82) → `executionType` + `ProcessStateService` +
  `WorkflowProcessEvent` com `eventId=servicetaskN`; o evento de erro anexado
  (43) leva `parentSequence`.
- `condition` do gateway (`ConditionImpl` em XStream) → `ConditionProcessState`
  (`conditionType` 1 = regras, 0 = expressão) + `ConditionProcessAutomaticRules`.
- `SequenceFlow` → `ProcessLink`: `fluxoAutomatico` → `automaticLink`,
  `permiteRetorno` → `returnPermited`, `atividadeFluxo`/`atividadeRetorno` →
  `actionLabel`/`returnLabel`, `defaultLink`. Link de anotação →
  `ProcessLinkAssoc`; bendpoints → `ProcessLinkBend`.
- Pool/lane → `SwimLane`: pool `type=1`, lane `type=2` com `parentSequence`,
  cor de `cores`, posição da lane absoluta = `x` da pool + `x` relativo da lane.
- `BpmnTriggerData` do temporizador → `ProcessStateTrigger` (`runType` numérico).
- Subprocesso → `subProcessId` + `SubProcessFieldRelationship` (só 10 estados
  de subprocesso em todos os ecm30).
- Anotação → `ProcessComponGraf`.
- `BpmnGroup` (5 no total, nenhum em par) não tem correspondente encontrado.

### O que não está no `.process`

`companyId`; o corpo dos scripts (`workflow/scripts/<processId>.<eventId>.js`);
boa parte dos defaults; e referências que precisam existir no destino —
`formId` (de `BpmnProcess.cardIndex`), `categoryId`, volume, período e o
processo-alvo de cada subprocesso.

### Manias do Studio

| | |
|---|---|
| `ProcessDefinitionVersion.processId` = `processDescription` | 118/118 |
| `PDV.version` = versão do `.process`, mas toda PK de State/Link/Lane usa `version=1` | 118/118 |
| nome do arquivo ≠ `processId` | 13/118 |

**Frescor do ecm30 local.** O `mtime` não serve: 80 de 96 pares estão a menos de 60 s um do outro — é a
hora do checkout. Contagem serve: nós == estados em 90/96; somando links ==
fluxos, 64.

**Scripts.** `WorkflowProcessEvent` fica no filho 6. Contra os scripts locais: 839 iguais,
38 diferentes, 80 sem arquivo. O `aplicarScripts` de `src/push/process-events.ts`
funciona sobre o XML gerado **desde que** o conversor emita um
`WorkflowProcessEvent` com `<eventDescription>` para cada script — ele não
cria bloco que falta.

## O que é difícil

- Blobs XStream aninhados dentro de atributos (`org.eclipse.bpmn2.impl.*`,
  `com.totvs.tds.ecm.workflow.model.*`).
- `>` cru dentro de valor de atributo: regex perde ~60% dos atributos. Precisa
  de um parser XML de verdade — e dependência nova é decisão do dono.
- Codificação: `.process` é ASCII com referências numéricas, o ecm30 é UTF-8
  sem declaração, o servidor exporta latin1 e lê UTF-8 no import (o incidente
  do "?" registrado em `src/commands/push-process.ts`).
- `.png` e `.processimage.svg` são arquivos à parte; e há muitos mapas de enum.

**Risco:** uma conversão errada cria uma versão quebrada do processo no
servidor. Versão é substituída, não apagada.

## Fases

Cada fase só termina com o teste diferencial verde nos 74 pares.

### 1. `fluigctl convert process <arquivo.process>`

Offline: lê o `.process`, grava o XML. A alavanca é o harness diferencial: compara, normalizado (ordem de atributos,
espaço, PKs de versão), o XML gerado com o ecm30 que o Studio exportou.
Ordem de cobertura: o que o MVP já cobre → gateways + condições → eventos
intermediários, incluindo temporizadores → tarefas de serviço + eventos de erro
→ anotações e bendpoints.

**Aceite:** os 74 pares batem nos filhos 0–4, 6, 8–12, 15 e 19; o que não bate
é listado por par e por filho, sem erro silencioso; os 2 `.process` inválidos e
qualquer tipo não mapeado são recusados com mensagem.

### 2. O resto da definição

Subprocessos, regras de anexo, campos de formulário, configuração de app,
propriedades avançadas (filhos 7, 13, 14, 16, 17, 18).

**Aceite:** os 74 pares batem nos 20 filhos, e os 10 estados de subprocesso
geram `SubProcessFieldRelationship` igual ao do Studio.

### 3. `push process --diagram` (ou equivalente)

XML gerado + scripts pelo `aplicarScripts` existente, pelo mesmo caminho de
hoje: `createVersion` → `importProcess` → `releaseProcess`. Antes de enviar,
confere no destino `formId`, categoria e alvos de subprocesso.

Primeiro no homolog, com um processo descartável. O gate de produção não muda.

**Aceite:** com um processo descartável publicado a partir só do `.process`, o
import responde sucesso, a liberação volta com `ok=true`, e uma solicitação no
homolog abre, passa por um gateway e finaliza. Comparar o export com o XML
enviado não vale logo depois do import: no HML da Cetenco o export devolveu a
versão nova com os eventos antigos (ver o comentário no fim de
`src/commands/push-process.ts`).

## Decisões em aberto (do dono)

- Dependência de parser XML: qual, e se entra.
- Forma do comando: `convert process` + `push process --diagram`, ou outra.
- O que fazer com os 2 `.process` inválidos e com `BpmnGroup`.
- Resolver `formId` pelo nome do formulário, como o fluig-cd faz, ou exigir o id.

## Fora de escopo

- Criar formulário, categoria ou processo-alvo de subprocesso que falte no destino.
- Gerar `.png` / `.processimage.svg`.
- Converter no sentido inverso (ecm30 → `.process`).
- Apagar versão publicada.
