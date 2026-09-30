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
