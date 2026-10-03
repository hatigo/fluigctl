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
por contador dele bate com a do Studio (medido na fase 1); a versão da PK não.

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

- `sequence` de estado e link = sufixo numérico do id no `.process` (`task5` →
  5; `flow31` → `linkSequence` 31). Sufixo repetido (`task5` e `endevent5`) é
  recusado.
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
  (43) leva `parentSequence` = sequence da tarefa. No `ProcessStateService`,
  `frequency` 0 ou ausente sai 1 e `frequencyType` ausente sai 0 (460 tarefas);
  `serviceName` só sai quando o `.process` tem o atributo (8 sem ele, 8 sem o campo).
- `condition` do gateway (`ConditionImpl` em XStream) → `ConditionProcessState`
  (`conditionType` 1 = regras, 0 = expressão; `condition` = `expression`, ausente
  quando o blob não a tem) + `ConditionProcessAutomaticRules`. A PK da condição
  leva a versão do `.process`, como a PDV (850/850 com versão ≠ 1). O `sequence`
  da regra é o do gateway, não o do blob: 16 regras em pares têm 0 no blob e o
  sequence do gateway no ecm30. `mechanism` + `mecanismoAtribuicaoConfiguracao`
  no caminho → `engineAllocationConfiguration`/`engineAllocationId` na condição,
  no formato do estado (6/6 nos pares). Exclusivo sem condição não gera nenhum
  `ConditionProcessState` (um par gabarito com dois desses).
- Gateway: o estado só tem 17 campos (sem prazo, atribuição nem notificação),
  415/415. `automatic` é `true` só no exclusivo (369/369); paralelo 3 e join 4
  saem `false`.
- Evento intermediário: todos os campos são constantes nos 863 estados, menos
  nome, posição, `automatic` (só o 32), `signalId` e `parentSequence`. O sinal
  não usa o nome na descrição: 37 → `Intermediário Sinal <signalId>`, 41 →
  `Intermediário Recebimento Sinal <signalId>`, com instrução própria (8/8).
- Evento de link (36 → 42 por `linkId`): o Studio cria um `ProcessLink` que não
  está no `.process`, com sequence acima do maior sufixo do diagrama, e em
  vários pares repete o link a cada gravação (até 3 por evento). Como a regra
  não é reproduzível, 36/42 seguem recusados.
- `SequenceFlow` → `ProcessLink`: `fluxoAutomatico` → `automaticLink`,
  `permiteRetorno` → `returnPermited`, `atividadeFluxo`/`atividadeRetorno` →
  `actionLabel`/`returnLabel`, `defaultLink`. Link de anotação →
  `ProcessLinkAssoc`; bendpoints → `ProcessLinkBend`.
- Pool/lane → `SwimLane`: pool `type=1`, lane `type=2` com `parentSequence`,
  cor de `cores`, posição da lane absoluta = `x`/`y` da pool + `x`/`y` relativo
  da lane. O `sequence` da raia **não** é o sufixo do id: é a posição entre
  pools e lanes, na ordem do arquivo, a partir de 1 (`swimlane13` sai 4 quando
  é a quarta raia; 15 pares só batem assim, nenhum só pelo sufixo).
- `BpmnTriggerData` do temporizador → `ProcessStateTrigger`: `runType`
  MINUTE 0 / HOUR 1 / DAY 2, `type` 2 (temporizador) ou 3 (condicional, 35, com
  `value` = `<processId>.<id>.js` mesmo sem `scriptCondition` no blob),
  `frequencia` crua, `timeTrigger` só se o blob tem. A PK leva a versão do
  `.process`; `triggerSequence` conta 0, 1, 2... na ordem do arquivo (10 pares
  com mais de um). `type` 0 é o `messageData` da tarefa de e-mail — uma única
  mensagem em todos os workspaces, então segue recusado.
- `movementTitle`/`movementDescription`/`movementAccessLinkDescription` no
  fluxo: quando o `.process` tem os três, o `ProcessLink` leva os três depois de
  `type` (7/7 nos pares, todos vazios). No fluxo de anotação somem. Nenhum par
  tem valor preenchido, então preenchido é recusado.
- Subprocesso → `subProcessId` + `SubProcessFieldRelationship` (só 10 estados
  de subprocesso em todos os ecm30).
- Anotação (`BpmnAnnotation` type 0) → `ProcessComponGraf` (`componType` 1,
  sequence = sufixo, posição absoluta); o fluxo que sai dela → `ProcessLinkAssoc`.
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
| a PK do `ProcessLinkBend` usa a versão do `.process`, como a PDV | todos os ecm30 com bend |
| nome do arquivo ≠ `processId` | 13/118 |

**Frescor do ecm30 local.** O `mtime` não serve: 80 de 96 pares estão a menos de 60 s um do outro — é a
hora do checkout. Contagem serve: nós == estados em 90/96; somando links ==
fluxos, 64.

**Scripts.** `WorkflowProcessEvent` fica no filho 6. Contra os scripts locais: 839 iguais,
38 diferentes, 80 sem arquivo. O `aplicarScripts` de `src/push/process-events.ts`
funciona sobre o XML gerado **desde que** o conversor emita um
`WorkflowProcessEvent` com `<eventDescription>` para cada script — ele não
cria bloco que falta. Por isso o conversor emite um bloco por arquivo
`<processId>.<eventId>.js` (o Studio inclui todo arquivo da pasta, até
o script de uma tarefa que não existe mais), com a codificação do
`aplicarScripts`; a ordem do Studio é de HashMap, então sai por eventId.

## O que é difícil

- Blobs XStream aninhados dentro de atributos (`org.eclipse.bpmn2.impl.*`,
  `com.totvs.tds.ecm.workflow.model.*`).
- `>` cru dentro de valor de atributo: uma regex ingênua perde ~60% dos
  atributos. O tokenizer precisa consumir o valor entre aspas inteiro (ver
  Decisões, item 1).
- Codificação: `.process` é ASCII com referências numéricas, o ecm30 é UTF-8
  sem declaração, o servidor exporta latin1 e lê UTF-8 no import (o incidente
  do "?" registrado em `src/commands/push-process.ts`).
- `.png` e `.processimage.svg` são arquivos à parte; e há muitos mapas de enum.

**Risco:** uma conversão errada cria uma versão quebrada do processo no
servidor. Versão é substituída, não apagada.

## Fases

Cada fase só termina com o teste diferencial verde nos 74 pares.

### 1. `fluigctl push diagram <arquivo.process> --dry-run --save-xml <arquivo>`

Offline, sem sessão: lê o `.process`, grava o XML. A alavanca é o harness
diferencial: compara, normalizado (ordem de atributos, espaço, PKs de versão),
o XML gerado com o ecm30 que o Studio exportou.
Ordem de cobertura: o que o MVP já cobre → gateways + condições → eventos
intermediários, incluindo temporizadores → tarefas de serviço + eventos de erro
→ anotações e bendpoints.

**Aceite:** os 74 pares batem nos filhos 0–4, 6, 8–12, 15 e 19; o que não bate
é listado por par e por filho, sem erro silencioso; os 2 `.process` inválidos e
qualquer tipo não mapeado são recusados com mensagem.

**Estado (30/09/2026, primeiro corte).** `push diagram --dry-run` cobre pool,
lane, início, tarefa de usuário (80/81/84/87), fim (60/64/65/68), fluxo de
sequência, bendpoints e atribuição Grupo/Papel/Usuário/Campo/Executor/Custom.
Todo o resto é recusado com código 6 — inclusive atributo desconhecido, objeto
sem forma, sequence repetido e arquivo fora do ASCII. `npm run diff-diagramas`
é o harness. Números sobre `~/fluig/workspaces`:

- 96 pares; 1 ilegível; 57 "gabarito" (versão, nós e links iguais — o critério
  de 74 não exigia versão igual, e 12 pares tinham o `.process` uma versão à
  frente do ecm30).
- Só 2 pares têm apenas elementos cobertos; 1 bate inteiro (byte a byte com o
  Studio), o outro tem ecm30 de outro diagrama.
- Em modo parcial (compara só o que é coberto), 54/57 gabaritos batem nos
  filhos 0, 1, 2, 4, 8 e 11. Sobram posição/`mobileReady` editados depois do
  export (2 pares) e a atribuição "Associado", não suportada (1 par).
- Campo ignorado na comparação: só `formIdV2` (omitido de propósito, ver
  fluig-cd).
- Dos 255 `.process`, 18 convertem sem recusa. O maior bloqueio nos simples são
  `movementTitle`/`movementDescription`/`movementAccessLinkDescription` nos
  fluxos: o Studio quase nunca os grava, e a regra ainda não se sabe.

**Estado (30/09/2026, segundo corte).** Entram tarefa de serviço (82) com
`ProcessStateService`, gateways 120/126/127 com `ConditionProcessState` e
`ConditionProcessAutomaticRules` (inclusive atribuição por caminho), eventos
intermediários 32/35/37/41/43 com `ProcessStateTrigger`, anotação
(`ProcessComponGraf` + `ProcessLinkAssoc`), os campos `movement*` vazios e os
scripts de `workflow/scripts/` (filho 6). O harness compara agora os filhos 0–4,
8–12, 15 e 19, e o 6 à parte.

- 42 pares têm só elementos cobertos (eram 2); 34 batem inteiros. Dos 35
  gabaritos entre eles, 34 batem em todos os filhos; o que sobra
  (um par de pedido) é `mobileReady` editado depois do export. Os outros 7 são
  pares "antigo": só a versão das PKs difere.
- Por filho, nos 57 gabaritos (parte coberta): 0=57, 1=55, 2=55, 3=57, 4=57,
  8=57, 9=57, 10=57, 11=56, 12=53, 15=57, 19=57. Sobram: posição e `mobileReady`
  editados depois do export (um par de pagamento e o de pedido), a
  atribuição "Associado" (um par de solicitação de equipamento) e o
  `messageData` da tarefa de e-mail, recusado (4 cópias do mesmo processo de
  pagamento).
- Scripts contra `workflow/scripts/`: 809 iguais, 28 diferentes (script local
  desatualizado — listados pelo harness, não normalizados), 25 eventos do
  Studio sem arquivo local, 11 arquivos locais sem evento no Studio. O harness
  passa os dois lados por `normalizar`, então a diferença entre referência
  numérica (o que o conversor grava) e "?" (o que o Studio grava) para
  caractere fora do latin1 fica escondida de propósito — ver o incidente do "?"
  em `src/commands/push-process.ts`. Script com caractere de controle que não
  seja tab, LF ou CR é recusado: não cabe em XML 1.0.
- Campo ignorado: continua só `formIdV2`.
- Dos 255 `.process`, 109 convertem sem recusa (eram 18). O que mais bloqueia,
  em arquivos afetados: fluxo ligado a elemento não suportado (64, efeito dos
  outros), `descriptorFields` (54), evento de link 36/42 (41), `appsConfiguration`
  (33), condição para destino não suportado (32), subprocesso (28),
  `attachmentRules` (17), atribuição "Associado" (9). Sozinhos, `descriptorFields`
  bloqueia 29 e `appsConfiguration` 15 — ambos fase 2.
- Seguem recusados sem evidência nos pares: `messageData` (uma única mensagem
  em todos os workspaces), `movement*` preenchido, `scriptFileName` de outro
  processo, `scriptFileName` na tarefa de script (87, sem nenhum estado 87 nos
  ecm30), `expression` no fluxo, fluxo sem origem (5 cópias de um processo de cotação;
  o Studio grava o link sem `initialStateSequence`), gateway 121, e
  `controlsAttachmentsSecurity`/`processAttachmentSecurity`/`notifyManagerComplements`/
  `deadlineTime`/`activeProcess` do processo (nenhum em par).

**Estado (30/09/2026, terceiro corte).** Entram os eventos de link 36/42. O
estado não guarda o `linkId`; o Studio cria, para cada fluxo que chega num 36,
um `ProcessLink` do 36 ao 42 apontado por `linkId`, sem `<name>`, que não existe
como `SequenceFlow`. O sequence é o maior sufixo numérico de id do arquivo (nós
e fluxos) + 1, + 2..., na ordem do sufixo do fluxo de entrada, valendo para
todos os 36 juntos. Sem `linkId` que resolva para um único 42, 36 com fluxo de
saída, `linkId` fora de um 36, 42 sem nenhum 36 apontando ou com fluxo de
entrada: recusa com código 6 (nenhum desses casos aparece nos `.process`).

- O harness ganhou a classe "mesma versão": versão e estados iguais aos do
  `.process`, com links a mais no ecm30. São 15 pares, 13 batem inteiros; dos 10
  com evento de link, os 10 batem no filho 4 (29 links) e 8 em todos os filhos
  comparados. Sobram a posição de lane editada depois do export (1 par) e,
  em outro, a atribuição "Associado" (não suportada) e a cor de lane.
- Só um par tem 36 com mais de um fluxo de entrada; a regra de ordem fica
  assumida a partir dele.
- Gabarito segue em 57, 50 batendo em todos os filhos comparados (não muda em
  relação ao corte anterior; a diferença para os números acima é que o
  critério é todos os filhos, e não só 0, 1, 2, 4, 8 e 11).
- Dos 255 `.process`, 126 convertem sem recusa (eram 109). Por arquivos
  afetados: `descriptorFields` (54), fluxo ligado a elemento não suportado (33),
  `appsConfiguration` (33), subprocesso (28), `attachmentRules` (17),
  atribuição "Associado" (9).

**Estado (30/09/2026, quarto corte).** Entram `descriptorFields` (filho 14) e
`appsConfiguration` (filho 17). O harness compara os dois filhos, inclusive a
ordem das linhas, e reporta cada um à parte.

- `descriptorFields` é atributo do `BpmnProcess`: `<list>` de
  `org.eclipse.bpmn2.impl.BpmnProcessFormField` com `id`, `label` e `cardIndex`.
  Vira um `ProcessFormField` por campo: `processFormFieldPK` (`companyId`,
  `processId`, `fieldId`; sem versão), `fieldDescription` = `label` e `slotId`
  = posição no blob, a partir de 1. O `cardIndex` (rótulo do formulário, vazio
  ou não) não vai ao ecm30: 6 dos 15 gabaritos com o atributo o têm preenchido e
  batem do mesmo jeito. Em pares com versão diferente a ordem do Studio difere
  da do blob (3 pares); nos gabaritos é sempre a do blob.
- `appsConfiguration` **não** é do processo: é atributo da tarefa de usuário (80
  em 55 casos; 81 em 1, sem par). Mapa XStream com uma `<entry>` (`<string>` =
  `appKey`, só `approval`) e uma `<list>` de `BpmnProcessAppConfiguration`
  (`appField`: `title`, `description`, `highlight`, `approve`, `reject`; mais
  `description`). Vira um `ProcessAppConfiguration` por campo: `id` 0,
  `tenantId` 0, `processId`, `processVersion` = versão do `.process` (igual à da
  PDV nos 6 pares que têm o filho), `stateSequence` = sufixo da tarefa, `appKey`,
  `appField`, `description` (vazio sai `<description></description>`). Uma
  tarefa atrás da outra, na ordem do arquivo; a ordem dos campos é a do blob.
- Recusa com código 6: classe, campo ou `appKey`/`appField` fora da lista acima,
  `id` repetido, `<list/>` ou `<map>` sem campo (nunca visto), mais de uma
  `<entry>`, `approve`/`reject` não numéricos e `appsConfiguration` em tarefa
  que não seja a 80.
- Harness, nos gabaritos com o atributo (ou com linhas no Studio): filho 14
  bate em 15/15, filho 17 em 2/2 (mesma versão: 14 em 2/2, 17 sem nenhum par).
  Gabarito inteiro: 51/57 e mesma versão 13/15, os mesmos números do HEAD anterior
  (medido de novo; o corte anterior registrava 50).
- Amostra pequena no filho 17: só 6 pares têm linhas, 2 deles gabarito. Nos dois
  as tarefas estão em ordem crescente de sufixo, então "ordem do arquivo" e
  "ordem do sufixo" não se distinguem; `description` vazio vem de um gabarito.
- Dos 255 `.process`, 180 convertem sem recusa (eram 126). Por arquivos
  afetados: fluxo ligado a elemento não suportado (33), subprocesso (28: 23 do
  tipo 100 e 5 do 101), `attachmentRules` (17), atribuição "Associado" (9),
  condição para destino não suportado (13).

**Estado (02/10/2026, quinto corte — início da fase 2).** Entram as regras de
anexo (`attachmentRules` no início e na tarefa de usuário → filho 18) e o
subprocesso 100 (`process`, `transferAttachments`, `sendToNextTaskInSubProcess`,
`formMaps` → filho 16); o ad hoc (101) segue recusado. `approve`/`reject` do
`appsConfiguration` passam a ter de nomear um estado do diagrama: 185/185 dos
valores numéricos nos `.process` medidos nomeiam.

- **Corpus.** `~/fluig/workspaces` tem hoje só 3 clientes (21 pares). Os demais
  vêm de um clone raso e esparso (só `workflow/`) dos 28 repositórios `fluig*`
  da StrategiConsultoria, fora dos workspaces. O harness aceita várias raízes:
  `npm run diff-diagramas -- ~/fluig/workspaces <clone>`. Antes, um bug
  descartava a raiz passada sem `--detalhe` e o harness sempre caía no padrão.
- 109 pares, 72 gabaritos, 56 batendo em todos os filhos comparados. Por filho:
  0=71 1=62 2=67 3=71 4=72 7=70 8=70 9=72 10=72 11=70 12=71 13=70 14=72 15=72
  16=72 17=72 18=72 19=72. Os 16 que não batem: 9 `fluigproduza` (`movement*`
  preenchido, `bpmnVersion` 2, `consenso` no início), 2 `fluiggel` com
  `extendedFields` (filhos 7 e 13), 1 com `deadlineTime`/`warningTime` do
  processo, 1 com atribuição "Associado", 1 com `messageData`, e posições
  editadas depois do export.
- Filho 18: 2/2 gabaritos e 4/4 antigos com o atributo. Filho 16: nenhum
  gabarito tem subprocesso; o único par (antigo) bate em 1 de 2 estados.
- Dos 475 `.process`, 329 convertem sem recusa. Por arquivos afetados (entre
  parênteses, os que só esse motivo bloqueia): atribuição "Associado" 23 (13),
  `movement*` preenchido 20 (2), `controlsAttachmentsSecurity` 17 (4),
  subprocesso sem `sendToNextTaskInSubProcess`/`transferAttachments` 10 (9),
  `extendedFields` 9 (4), `processAttachmentSecurity` 8, `consenso` 8,
  subprocesso 101 7, `deadlineTime` 7, `notifyManagerComplements` 6 (5).

**Estado (02/10/2026, sexto corte).** Entram `movement*` preenchidos (vão ao
`ProcessLink` como estão), `consenso`/`atividadeConjunta` no início (mesma regra
da tarefa, 10/10), `extendedFields` do processo (filhos 7 e 13, um item com
`propertyType` 0 e `isDefaultProperty` false — 8 processos; no gateway, 1 caso
sem par, segue recusado) e `bpmnVersion` como dado do destino: não está no
`.process` (1 em 9 pares do fluigproduza, 2 nos outros 100), então o push o lê
da definição atual do servidor e o harness o lê do ecm30. Corrigido o padrão de
`notifyAuthorityFollowUp` na tarefa: sem `authNotify`, `false` (12/12); com
`authNotify="true"`, `true` (1232/1232). O leitor de XML passa a recusar
atributo repetido (nenhum dos 475 `.process` tem).

- 66/72 gabaritos batendo em todos os filhos (eram 56). Por filho: 0=71 1=71
  2=68 3=71 4=72 7=72 8=70 9=72 10=72 11=70 12=71 13=72 14=72 15=72 16=72 17=72
  18=72 19=72; filhos 7 e 13 em 3/3 dos pares com o atributo. Sobram: atribuição
  "Associado" (1), `messageData` (1), `deadlineTime`/`warningTime` do processo
  (1), posições e tamanhos deslocados por igual num diagrama inteiro (2,
  provável edição depois do export) e um par com versão e condição vazia a
  investigar (1).
- 349/475 `.process` convertem sem recusa (eram 329).

**Estado (02/10/2026, sétimo corte).** Entram a atribuição "Associado" e o
prazo do processo.

- "Associado" (`AssignmentControllerAssociated`) vira `<AssociatedController
  ConditionAssociated="<type>">` com um `<ControlXML TypeAssociated="<mecanismo>">`
  por controlador, cada um com o `<AssignmentController>` da atribuição simples
  (6/6 estados nos pares: `AND` com Grupo, Papel e Executor). Só entra
  controlador cuja forma simples foi conferida (Grupo, Papel, Usuário, Campo,
  Executor); `ColleagueGroup`, aninhado e tipo fora de `AND`/`OR` recusam. `OR`
  (23 controladores, nenhum em par) entra com aviso no resultado. Vale só para
  estados; em condição de gateway segue recusado.
- `deadlineTime`/`warningTime` do processo, em minutos como os das tarefas, viram
  `deadlineTime`/`warningDeadlineTime` da `ProcessDefinition` em segundos (1 par:
  2160 → 129600, 1440 → 86400).
- 68/72 gabaritos batendo em todos os filhos. Os 4 restantes não têm regra
  derivável: `messageData` (1); posições e tamanhos deslocados por igual num
  diagrama inteiro (2); e um com configuração de atribuição vazia e `condition`
  vazia onde o conversor segue a maioria — mecanismo sem blob deixa a
  configuração ausente em 35 estados e vazia em 6; `expression` `false` com
  regras sai `"false"` em 308 condições, ausente em 13 e `""` em 3.
- 369/475 `.process` convertem sem recusa. O que mais bloqueia agora não tem par
  para conferir: `controlsAttachmentsSecurity` (17 arquivos),
  `processAttachmentSecurity` (8), `notifyManagerComplements` (6); e o subprocesso
  (31 arquivos, 1 par antigo).

**Estado (03/10/2026, oitavo corte).** Entram `controlsAttachmentsSecurity`,
`notifyManagerComplements` e `processAttachmentSecurity` do processo. Nenhum
par os tem; a regra veio do `BPMN2ECM30ExportMarshaller` decompilado
(fluig-agentic-development) e foi conferida no HML da Cetenco — é o primeiro
corte aprendido pelo servidor e não por par.

- O filho 5, "sempre vazio", é o `ProcessAttachmentSecurity`. Cada
  `ECMProcessAttachmentSecurityImpl` do blob vira um, com PK `companyId`,
  `processId`, `version` 1 e `sequence` do blob (o Studio descarta `companyId`,
  `processId` e `version` do blob: 0/0, 1/36 nos `.process`), `engineAllocationId`,
  `engineAllocationConfiguration` só quando o blob tem (no formato da atribuição
  do estado), `accessLevel` e `editionMode`.
- `notifyManagerComplements` → `ProcessDefinition`; `controlsAttachmentsSecurity`
  → `ProcessDefinitionVersion`. Booleanos, `false` sem o atributo.
- HML: a versão 5 do `teste_fluigctl`, com o XML do servidor editado à mão
  (`push process --base`), e a versão 6, publicada pelo `push diagram` a partir
  de um `.process` com os três atributos, foram importadas e liberadas sem
  `attachmentSecurityError`. O export devolve os três campos como enviados — a PK
  com a versão do servidor, e `editionMode` sempre `false` (o servidor zera o
  `true` enviado na versão 5).
- Só entra a forma vista nos `.process`: "Todos os Usuários" sem configuração;
  Grupo, Usuário e Campo Formulário com; `accessLevel` com as letras P, R, M, O,
  E, D. Outro mecanismo, sequence repetido, lista vazia e campo desconhecido
  recusam com código 6.
- O harness compara o filho 5: 72/72 gabaritos (todos vazios). Gabaritos
  inteiros seguem 68/72.
- 384/475 `.process` convertem sem recusa (eram 369).

**Estado (03/10/2026, nono corte).** Subprocesso (100) sem `transferAttachments`,
`sendToNextTaskInSubProcess` ou `cancelSubProcess` passa a sair com `false`.

- Regra do modelo do Studio: `BpmnSubProcess.eIsSet` (decompilado) só grava os
  três quando são `true`, e nos 40 subprocessos dos `.process` nenhum vem
  `"false"` — o mesmo que o conversor já fazia com o `cancelSubProcess`. Valor
  fora de `true`/`false` recusa.
- HML: processo descartável novo `teste_fluigctl_sub` (cópia do `teste_fluigctl`)
  e versão 7 do `teste_fluigctl` com início → tarefa → subprocesso → gateway →
  fim, sem os três booleanos e com um `formMaps` (`descricao` → `descricao`,
  `mapFlow` 0). Liberada com `subProcessError=[]`. Solicitação 680: ao sair da
  tarefa abriu a 681 no `teste_fluigctl_sub`, parada no início (efeito de
  `sendToNextTaskInSubProcess` false) e sem o campo; movida até o fim, devolveu
  "valor da filha" à 680, que seguiu do subprocesso para o gateway e o fim.
  `mapFlow` 0 é o `IN` do `BpmnProcessFormMap` (1 = `BOTH`, 2 = `OUT`): a volta
  da filha para a mãe.
- A variante é o fixture `test/fixtures/diagrams/subprocessoTeste.process`.
- 396/475 `.process` convertem sem recusa (eram 384); gabaritos seguem 68/72. O
  ad hoc (101, 7 arquivos, todos com outra recusa junto) segue recusado.

**Estado (03/10/2026, décimo corte).** Caminho de gateway com
`<mechanism></mechanism>` vazio e sem `mecanismoAtribuicaoConfiguracao` (87
condições nos `.process`, nenhuma em par; nos ecm30 só há condição sem os campos,
619, ou com mecanismo e configuração, 16) leva só `engineAllocationId` vazio. O
Studio copia `getMechanism()` e a configuração nula some, como na tarefa com
mecanismo vazio, que tem par. HML: versão 8 do `teste_fluigctl` com o caminho 1
do gateway assim, liberada; solicitação 682 passou pelo subprocesso (filha 683)
e pelo caminho até o fim, finalizada.

- 412/475 `.process` convertem sem recusa (eram 396); gabaritos seguem 68/72.

**Estado (03/10/2026, 11º corte).** Regras de anexo além da forma dos pares:
qualquer operador do combo do Studio (0 nenhum, 1 =, 2 >, 3 >=, 4 <, 5 <=, 6
qualquer — `PropertyBpmnAttachmentRulesSection` decompilado), `amount` vazio (é
`String` no modelo; sai como texto), mais de uma regra por elemento (uma linha
cada, na ordem do blob) e `id` do blob qualquer (o Studio não o copia; sai 0).

- HML: versão 9 do `teste_fluigctl` com uma regra 0/vazio no início e duas na
  tarefa (1/"1" e 6/vazio). Liberada; o export devolve as três como enviadas, com
  `id` e `tenantId` atribuídos pelo servidor. Solicitação 684 abriu (a regra 0
  não bloqueia) e o movimento da tarefa sem anexo foi recusado — HTTP 500 com uma
  `IllegalArgumentException` genérica, sem citar a regra; na versão 8 o mesmo
  movimento passava. A 684 ficou aberta. Versão 10 republicada sem regras.
- O harness segue com o filho 18 em 2/2 gabaritos e 4/4 antigos; gabaritos 68/72.
- 418/475 `.process` convertem sem recusa (eram 412).

**Estado (03/10/2026, 12º corte).** Entram Executor Atividade com `returns` 2 e o
esforço previsto.

- `returns` 2 → `<Returns>All</Returns>` (switch do `getEngineAllocationConfiguration`
  decompilado: 0 First, 1 Last, 2 All; 20 ocorrências nos `.process`, nenhuma em
  par). Outro valor segue recusado.
- `esforcoCalculo`/`esforcoPrevisto` no início (10) e na tarefa de usuário (80) →
  `forecastedEffortType` = `esforcoCalculo`, `forecastedEffort` = `esforcoPrevisto`
  × 60 (minutos → segundos, como os prazos). Nos outros tipos o Studio grava 0, e
  valor diferente de 0 segue recusado.
- HML: versão 11 do `teste_fluigctl` com a tarefa 5 em Executor Atividade `All`
  do início e esforço 3 / 1920.0. Liberada; o export devolve
  `<Returns>All</Returns>`, `forecastedEffortType` 3 e `forecastedEffort` 115200.
  A solicitação 685 caiu na tarefa 5 para Integracao.Fluig, executor do início.
  Versão 12 republicada com a variante de referência (subprocesso, caminho com
  mecanismo vazio), que agora é o fixture `subprocessoTeste.process`.
- 423/475 `.process` convertem sem recusa (eram 418); gabaritos seguem 68/72.

**Estado (03/10/2026, 13º corte).** Entra o "Grupos Colaborador"
(`AssignmentControllerColleagueGroup`): `<AssignmentController><GroupsOf>colleagueId</GroupsOf>
<OnlyWorkGroup>ON|OFF</OnlyWorkGroup><IncludeCommunityGroups>ON|OFF</IncludeCommunityGroups></AssignmentController>`,
no formato do `String.format` do Studio decompilado. Aparece só dentro do
"Associado" (8 controladores, 6 arquivos bloqueados só por isso), sem par.

- HML: versão 13 do `teste_fluigctl` com a tarefa 5 em "Associado" AND (Grupos
  Colaborador de Integracao.Fluig + Usuário Integracao.Fluig). Liberada sem
  `activityError`; o export devolve a configuração igual; a solicitação 686 caiu
  na tarefa 5 para Integracao.Fluig. O AND com o próprio usuário mostra que o
  servidor aceita e resolve o mecanismo, não o efeito isolado do `GroupsOf`.
  Versão 14 republicada com a variante de referência.
- 429/475 `.process` convertem sem recusa (eram 423); gabaritos seguem 68/72.

**Estado (03/10/2026, 14º corte).** `approve`/`reject` do `appsConfiguration` com
o texto literal `null` (5 tarefas, sem par) vão como estão: o
`getProcessAppConfiguration` do Studio copia a `description` sem tratar. Número
continua tendo de nomear um estado; outro texto segue recusado.

- HML: versão 15 do `teste_fluigctl` com `title` e `approve` = `null` na tarefa 5.
  Liberada; o export devolve `null`; a solicitação 687 saiu da tarefa para o
  subprocesso (filha 688). Versão 16 republicada com a variante de referência.
- 435/475 `.process` convertem sem recusa (eram 429); gabaritos seguem 68/72.

**Correção (03/10/2026).** O aviso do subprocesso dizia que a publicação
conferia o processo-alvo no destino, mas o `push diagram` não conferia. Agora
confere: alvo que não está na lista de processos do servidor recusa com código 6,
antes de criar versão ou importar (como pedia a fase 3).

Ficam para o Studio, nos 40 `.process` que ainda não convertem, motivos de 1 a 9
arquivos cada e nenhum com par: ad hoc (101), banco de dados, `BpmnGroup`,
gateway 121, tarefa de e-mail (`messageData`), `scriptFileName` de outro processo,
`appsConfiguration` na tarefa 81, atribuição por Usuário/"Associado" em caminho
de gateway, `expression` no fluxo, `activeProcess`, propriedades estendidas no
gateway, o fluxo sem origem das 5 cópias do `cotacao` e 2 arquivos que não são
XML válido.

**Processo de teste redesenhado (03/10/2026).** O `teste_fluigctl` passou a usar
a geometria de um processo real do corpus (`SolicitacaoDeConsultoriaGeral`, do
fluigbsm), com os mesmos ids: pool com as raias "Solicitante" e "Execução",
Aprovação (usuário) → Registrar aprovação (tarefa de serviço, com erro anexado e
"Tratar erro do serviço") → Conferência (usuário) → gateway "Aprovado?" por regra
no campo `aprovado` (`sim` → fim; senão → Aprovação). Atribuição de todas as
tarefas: Usuário Integracao.Fluig. O script `teste_fluigctl.servicetask24.js`
anota no campo `descricao` que rodou. Fontes em `~/projetos/teste-fluigctl` (o
desenho anterior ficou em `workflow/diagrams-anterior/`).

- HML: versão 18 liberada sem erro de atividade nem de fluxo. Solicitação 689:
  Aprovação → serviço (rodou na hora; `descricao` ganhou "[servico ok, tentativa
  1]") → Conferência → gateway com `aprovado = nao` → de volta à Aprovação →
  serviço de novo → Conferência → gateway com `sim` → fim, finalizada.

### 2. O resto da definição

Subprocessos, regras de anexo, campos de formulário, configuração de app,
propriedades avançadas (filhos 7, 13, 14, 16, 17, 18).

**Aceite:** os 74 pares batem nos 20 filhos, e os 10 estados de subprocesso
geram `SubProcessFieldRelationship` igual ao do Studio.

### 3. `fluigctl push diagram <arquivo.process> --server <s>`

Só atualiza processo que já existe, como o `push process` de hoje. XML gerado
mais os scripts pelo `aplicarScripts` existente, pelo mesmo caminho:
`createVersion` → `importProcess` → `releaseProcess`. Antes de enviar, confere
no destino `formId` (Decisões, item 4), categoria e alvos de subprocesso.

Primeiro no homolog, com um processo descartável. O gate de produção não muda.

**Aceite:** com um processo descartável publicado a partir só do `.process`, o
import responde sucesso, a liberação volta com `ok=true`, e uma solicitação no
homolog abre, passa por um gateway e finaliza. Comparar o export com o XML
enviado não vale logo depois do import: no HML da Cetenco o export devolveu a
versão nova com os eventos antigos (ver o comentário no fim de
`src/commands/push-process.ts`).

**Estado (03/10/2026, fase 3 publicada).** `push diagram` sem `--dry-run`
publica. Converte offline primeiro; confere no destino se o processo existe (e
só cria com `--create`), se o formulário do `cardIndex` existe (número, ou nome
único; vazio é sem formulário) e lê da definição atual o `bpmnVersion`. Processo
existente: `createVersion` → `importProcess` (overWrite) → `releaseProcess`.
Processo novo: `importProcess` com `newProcess` → `releaseProcess`, como o
fluig-cd — o item 5 das Decisões foi revisto a pedido, atrás de `--create`.

Aceite, no HML da Cetenco, com o processo descartável `teste_fluigctl` (adaptado
de um diagrama do corpus: início → tarefa de usuário → gateway exclusivo com
expressões → fim, sem formulário, categoria Backoffice):

- `push diagram --create`: importado e versão 1 liberada (`ok=true`, sem erro de
  atividade nem de fluxo); estados, atribuição (`<User>Integracao.Fluig</User>`)
  e `formId` 0 conferidos no banco.
- Solicitação 677: aberta pela API, tarefa movida para o gateway, que avaliou
  `true` e levou ao fim; histórico 4 → 5 → 8 → 7, status finalizado.
- `push diagram` de novo, sem `--create`: versão 2 criada, importada e liberada.
  Solicitação 678 na versão 2, de ponta a ponta, finalizada.

O `teste_fluigctl` fica no HML para os próximos testes.

**Imagem do diagrama (03/10/2026).** Aberto no portal, o processo mostrava
"Não foi possível exibir o fluxo do processo": o visualizador busca
`/webdesk/svgviewer?processId=…&version=…&currentSequences=…`, e sem imagem o
servidor devolve o `DefaultDiagram.svg`. O Studio manda a imagem no mesmo
`importProcess`, como segundo anexo (`<nome>.processimage.svg`,
`principal=false`, `attach=true`, linhas juntadas com "\n" em UTF-8 —
`WSMethods.exportProcess` decompilado no fluig-agentic-development). Agora o
push manda o SVG do Studio quando ele desenha os mesmos `<g sequence>` do
`.process`, ou um gerado da geometria (mesmas formas, cores e posições; o
losango do gateway é o quadrado do topo da caixa, eventos sem rótulo). Versão 3
do `teste_fluigctl` publicada com a imagem gerada: o svgviewer devolve os
estados 4, 5, 7 e 8 e destaca a atividade atual.

**Ícones na imagem gerada (03/10/2026).** A imagem gerada ganhou as marcas que o
Studio desenha: relógio do temporizador (32), seta do link (36 cheia, 42 vazada),
triângulo do sinal (37/41) e do fim com sinal (64), raio do erro anexado (43),
"X" do fim com erro (65) e o "+" de traço 6 do paralelo e do join, fora do
`<g sequence>`. A geometria é a do Studio, relativa ao centro; nos pares do corpus
405 marcas batem com o `.processimage.svg` (as 8 que não batem são de um SVG que
desenha cada evento duas vezes). Saiu o círculo interno do evento intermediário,
que o Studio não desenha. Nas tarefas, o Studio embute PNGs da TOTVS; aqui vão
desenhos próprios (engrenagem, boneco, envelope, subprocesso normal e ad hoc) na
posição do `al:Image` do `.process`, que coincide com a do Studio em 420 de 427
ícones (os 7 restantes são de SVGs com o diagrama deslocado depois). A marca de
fluxo automático (`automaticFlow`, nos conectores) não é desenhada.

## Decisões (30/09/2026)

"Fazer como o fluig-cd faz."

1. **Parser: sem dependência.** Tokenizer próprio, como o `tokenize` de
   `processConverter.ts`: a regex de tag consome valores entre aspas
   (`"[^"]*"`), então `>` dentro de atributo não quebra. Os ~60% perdidos
   medidos antes vieram de uma regex ingênua de contagem, não desse tokenizer.
   Entidades são decodificadas (o `.process` usa referências numéricas).
2. **Comando recebe o arquivo:**
   `fluigctl push diagram <arquivo.process> --server <s> [--dry-run] [--save-xml <arquivo>] [--no-release]`.
   O `processId` é lido de dentro do `.process` — nome do arquivo ≠ `processId`
   em 13/118. O `convert` da fase 1 é `push diagram --dry-run --save-xml`,
   offline e sem sessão: não resolve `formId` pelo nome, grava o XML com o que
   o arquivo tem e avisa. Os scripts continuam entrando pelo `aplicarScripts`
   (`workflow/scripts/<processId>.*.js`).
3. **Não suportado é erro explícito** listando os tipos, como no fluig-cd. Vale
   para os 2 `.process` inválidos e para `BpmnGroup`.
4. **`formId` como no fluig-cd:** `cardIndex` numérico é usado direto; senão,
   procura pelo `documentDescription` do formulário no servidor de destino.
   Desvio de propósito: o fluig-cd segue com `formId` 0 quando não acha; o
   `fluigctl` recusa com código 6 antes de enviar. Nome achado em mais de um
   formulário também recusa com 6.
5. **Processo novo fica fora da fase 3.** O fluig-cd cria com `newProcess`
   quando não existe; aqui só se atualiza processo existente, como no
   `push process`. Revisitar depois.

## Fora de escopo

- Criar formulário, categoria ou processo-alvo de subprocesso que falte no destino.
- Gerar `.png` / `.processimage.svg`.
- Converter no sentido inverso (ecm30 → `.process`).
- Apagar versão publicada.
