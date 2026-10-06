# Workflow, mechanisms and e-mail

## Layout

```
workflow/diagrams/<processId>.process        diagram (Studio XMI)
workflow/scripts/<processId>.<evento>.js     one file per event / service task
workflow/.resources/                         ecm30.xml, png, svg, *.ws.cache
mechanisms/MEC_STG_<NOME>.js
templates_email/<template>.html
```

- **Service task ids are the Studio's** (`servicetask39`). The XML wires each
  task to its script with `scriptFileName="<processId>.servicetask39.js"`.
- **The agent edits the `.process` XMI directly. Studio is not needed.** Every
  edit ends with the same three checks (see "Editing a diagram" below). For a
  big model, write a step-by-step specification first, as Medição does in
  `docs/especificacao-diagrama-*.md`. It lists:
  - lanes;
  - nodes by type (human, service, gateway, end);
  - one error pair per service task;
  - flows, gateway conditions and assignment.
- **Studio re-serializes the diagram and its caches on export.** Commit that
  churn on its own (`chore(<processo>): diagrama reexportado pelo Studio`), not
  mixed with logic.
- **Do not commit an empty stub** (`function servicetask29(attempt, message) {}`).
  It looks like an implemented task. If a task does nothing yet, say so in a
  comment and log it.

## Diagram conventions

- **Lanes** are named by role ("Solicitante", "Gestor", "Aprovadores", "Externo").
- **Gateways** are questions ("Aprovado?", "NF válida?").
- **Gateway conditions are form-field rules** (field, value, operator), not
  scripts. Scripts and the form write the routing values into control fields:
  `decisaoAprovacao`, `faltaAprovador`, `nfValida`, `temTudoEmEstoque`.
- **Every service task follows the recovery pattern below.**
- **Every human task has an assignee.** A task with no mechanism never reaches
  anyone: approval task 34 in Medição stalled this way until it got
  `MEC_STG_ALCADAS`.

## Service-task recovery pattern (always)

Every workflow follows this pattern, for every service task. The only exception
is one the human calls out explicitly for a specific task.

1. **The service task is automatic:** `executionType="1"`. Synchronous
   (`executionType="0"`) is the rare exception; record why in the task
   instruction or the commit.
2. **It has its own intermediate error event attached.**
   - On the event: `type="43"`, with `parentTask` and `sequenceAttached`.
   - On the task: `attachedEvents`.
   - One event per service task. Never share one between tasks.
3. **The error circle overlaps the task's lower-right corner.** It is not a
   loose node below the flow.
4. **The flow from the circle to the handling task is a short diagonal**, with no
   bendpoints.
5. **The handling task sits right below the service task, in the same functional
   lane.** Do not create a lane just for support. Name it after what failed:
   "Tratar erro de alçada", "Erro ao enviar e-mail".
6. **The handling task is assigned to the support group:**

   ```xml
   managerMechanism="Pool Grupo"
   managerAssignmentControllerString="&lt;org.eclipse.bpmn2.impl.AssignmentControllerPoolGroup>
     &lt;groupId>suporte_processos&lt;/groupId>
     &lt;mechanismName>Pool Grupo&lt;/mechanismName>
   &lt;/org.eclipse.bpmn2.impl.AssignmentControllerPoolGroup>"
   ```

   - `suporte_processos` is the group in the Strategi projects. When the
     process or the human names another one, use that.
   - If the group does not exist on the target server, it has to be created
     there before publishing.
   - **Never** substitute `admin`, the requester or any other user. An error
     task assigned to the wrong person is worse than a failed release.
7. **The handling task flows back to the same service task, to retry.**
   - Never end the process after an automation failure.
   - Never advance it to a later state.
   - The retry only works because the service task is idempotent (see "A
     service task that integrates").

### Layout recipe

`validacao_minutas` (Cetenco, approved 2026-10-06) is the reference. It has 5
lanes, 9 service tasks and flows across lanes. Positions are absolute. Lanes are
relative to the pool.

**Keep the sizes Studio gave each element.** Tasks there are 106×76, or 106×92
when the name is long. Error events are 30×30, though other diagrams use 35×35.
The width of a task decides where its name wraps. Resizing every task to a
standard (140×67) changed the text layout, and the human asked for it back.
Never touch the `al:MultiText` or `al:RoundedRectangle` inside a task, nor the
font.

With `C` as the centre line of the lane's main row, `(x, y, w, h)` as the
service task and `d` as the event's diameter:

| Element | Position |
|---|---|
| task | `(cx − w/2, C − h/2)`: tasks on a row line up by centre, not by top |
| gateway | `(cx − 30, C − 30)`: the diamond is the top 60×60 of the shape, and the label hangs below it |
| start/end event | `(cx − d/2, C − d/2)` |
| error circle | `(x + w − d/2, y + h − d/2)`: centred on the lower-right corner |
| handling task | `(x + w/2 − w'/2, y + h + 33)`: same column, the same gap below every service task, at its own size |
| circle → handling task | no bendpoints: the short diagonal |
| handling task → service task | no bendpoints: a vertical, both centred on the same x |

Rows and lanes:
- **`C = lane top + 90`.** Leave room above the tallest task for the loop
  corridor.
- **Size each lane to its own content.** Lanes need not share a height.
  - A lane with error pairs fits its tallest pair: the tallest service task,
    the 33 px gap and the tallest handling task, plus a margin. With 92 px tasks
    it is 270.
  - A lane with a branch row also fits that row's pair.
  - A lane with only a main row and no pairs is about 160: the corridor above
    and the row.
  - Do not stretch a short lane to match a tall one. A lane that is mostly empty
    only pushes the rest of the process off the screen.
- **The pool's height is the sum of the lanes.** Lane width is the pool width
  minus 30. Each lane's rotated label (`al:Text`) takes the lane height, and the
  pool's label takes the pool height.
- **Keep Studio's lane order and keep every element in its lane.** A lane is a
  role. Moving a task to another lane changes the meaning, not the look.

Flows:
- **The process reads left to right in chronological order.** Each lane's main
  flow is one horizontal row, and each service/handling pair is a compact
  column. Leave about 200 px between column centres.
- **Every flow is orthogonal.** The line is drawn from the source border, through
  the bendpoints, to the target border, and each end aims at the centre of its
  shape (chopbox). So the first bendpoint shares x or y with the source centre,
  and the last one with the target centre. Otherwise the end segment comes out
  diagonal.
- **A flow to another lane runs its vertical through a column that is empty in
  every lane it crosses.** It then turns into the target from the left on the
  row, or drops into it from above at its centre.
- **Gateway exits:**
  - to the lane above, or a loop: from the top;
  - next on the same row: from the right;
  - to a lane below: from the right, with a bend a few dozen px out, when that
    keeps the vertical clear. The bottom exit crosses the gateway's label, so it
    is the last choice.
- **A branch that leaves the main row** (e.g. "Reprovada") drops from the
  gateway to its own row below, and keeps its own pair beneath it.
- **A loop back** (e.g. "Tem mais? → Sim") leaves the gateway from the top. It
  runs in the corridor 20 px above the tallest task of the target's row, and
  drops into the target from above, at its centre.
  - It never passes under the row or through the error pairs.
  - Several loops into the same target share the corridor.
  - A flow from a gateway that climbs from its own row to a target further right
    uses the same pattern: up out of the top, along the corridor, down into the
    target.
- **No line crosses a card.** Lines may cross lanes, and other lines when there
  is no way around.

### Re-laying out an existing diagram

There are two ways:
- **No spec.** The **Organizar** button of the viewer's edit mode
  (`fluigctl diagram open`) applies this recipe to the whole diagram. It
  reorders into chronological columns, keeps each element in its lane, places
  the recovery pairs, sizes the lanes and routes every flow, as one undoable
  edit. Prefer it when the human is in the viewer.
- **A spec you control.** For a layout decided column by column, as in the
  approved `validacao_minutas`, the skill ships `scripts/relayout.py`:

```sh
python3 -I scripts/relayout.py <entrada.process> <spec.json> <saida.process>
```

- The spec says the lane order, the lane heights, the pool width, the centre x
  and lane of each main-row node, and the route bendpoints. In the bendpoints,
  `"C<n>"` is the row centre and `"L<n>"` the return corridor of lane n.
- **`laneHeight`** is either a list, one height per lane in the order of
  `lanes` (`[160, 400]`), or a single number when every lane fits the same
  height.
- **A branch row.** A node may take a third value: how many px below the
  lane's main row it sits (`"servicetask7": [1090, 1, 160]`). This puts a
  branch such as "Reprovada" on its own row, with its pair below it. Size the
  lane height to fit that row's pair as well.
- **Lane positions** are computed from the pool's own `y`: 6 in Studio files,
  whatever another generator wrote elsewhere.
- The script finds each service task's error event and handling task in the
  model, and places them by the recipe.
- It refuses to write when anything outside geometry would change.
- **Example specs:**
  - `scripts/validacao_minutas.json` is the spec of the approved diagram. Run
    on the original, it rebuilds that diagram byte for byte.
  - `scripts/contratacao.json` is a two-lane example. It has a "Reprovada"
    branch row, and a loop "Tem mais? → Sim" in the corridor.

A re-layout done by hand or by another script follows the same limit, and
touches geometry only:
- the `x`/`y` of each top-level shape's first `graphicsAlgorithm`;
- the size of the pool and lanes, and the heights of their label texts;
- the `<bendpoints>` at the end of each `<connections>`.

Do not create or remove shapes, connections, anchors or ids, and keep the
`bpmn2:` model untouched.

Before writing:
- copy the original to the scratchpad;
- run the script on a copy;
- confirm `diff <(grep -E 'bpmn2:|al:MultiText|al:RoundedRectangle' antes) <(grep … depois)`
  is empty.

When the human has the diagram open in `fluigctl diagram open`, check that the
file still matches what the script read before replacing it. They may have
renamed something from the viewer.

**Check the result rendered,** not only the XML:
- render it with the same generator as the viewer and the push:
  `node scripts/render.mjs <arquivo.process> saida.svg`, then
  `rsvg-convert -b white -w 2400 saida.svg -o saida.png`, and look at the PNG.
  - The script needs the fluigctl build; `FLUIGCTL_DIR` points it at another
    checkout.
  - The `<svg>` already carries a `style`, so do not add another one.
  - Or open `fluigctl diagram open`.
- check that no line crosses a card, that every circle sits on its corner and
  that every end segment is straight;
- then run `fluigctl diagram check` and `fluigctl push diagram … --dry-run`.

A re-layout is visual only. List what the pattern check found (missing
mechanisms, a gateway branch with no exit, names like "Erro Envia E-mail"
repeated) and leave the fixes to the human.

### Editing a diagram

The `.process` has two layers, and an edit has to keep both in step:
- **The model.** The `bpmn2:*` lines, one per element or flow. Flows are tied to
  their ends twice: `sourceRef`/`targetRef` on the flow, and `outgoing`/`incoming`
  on each end.
- **The pictogram.** `<children>` shapes and `<connections>`. These point at one
  another **by position**: `/0/@children.8/@anchors.0`, `/0/@connections.12`.
  - Each shape's anchor lists its `outgoingConnections` and
    `incomingConnections`.
  - Each connection names its `start` and `end` anchors.
  - Each shape or connection carries a `<link businessObjects="<id>">` to its
    model object.

Edit it like this:
1. **Copy the original to the scratchpad first.** Process repos are not always
   under git.
2. **Prefer appending to inserting.** A new shape or connection goes at the end
   of its list, so the positions of the existing ones do not move.
   - If you must insert or remove, renumber every `/0/@children.N` and
     `/0/@connections.N` reference after that point.
   - Update both directions of every link: both ends of a flow, and both ends of
     a connection.
3. **When a flow changes its source or target,** remove it from the old end's
   `outgoing`/`incoming`. A stale entry is how `task5` kept `flow30` in the
   contratação diagram.
4. **Run the three checks, in order:**

```sh
fluigctl diagram check workflow/diagrams/<processo>.process --group suporte_processos
node scripts/render.mjs workflow/diagrams/<processo>.process /tmp/x.svg   # then look at the PNG
fluigctl push diagram workflow/diagrams/<processo>.process --server <servidor> --dry-run
```

**`diagram check`** reads the file and changes nothing. It exits 6 when it finds
an error.
- **Structure:**
  - every reference by position resolves;
  - what `pictogramLinks` lists is a `<link>`;
  - anchors and connections agree in both directions;
  - each connection joins the shapes of its flow's `sourceRef`/`targetRef`;
  - each flow is drawn once;
  - `outgoing`/`incoming` agree with the flows;
  - every `al:Text` and `al:MultiText` has `font="/0/@fonts.N"` that resolves.
    Without it Studio throws a NullPointerException while opening the editor
    and shows only a red icon. Shape labels use `<fonts name="Arial" size="8"
    bold="true"/>`, flow labels `<fonts name="Arial" size="8"/>`, both at the
    end of `pi:Diagram`. `diagram check --fix` adds what is missing.
  - every `al:Polygon` has `<points>`. A gateway is drawn as Studio draws it:
    an invisible `al:Rectangle` (`filled="false" lineVisible="false"`) whose
    child is the 60x60 diamond, `<points y="30"/> <points x="30"/> <points
    x="60" y="30"/> <points x="30" y="60"/> <points y="30"/>`, with the label
    below it at `y="60"`. A polygon without points opens as a blank editor: the
    flow anchor asks for the shape's outline and throws IndexOutOfBoundsException.
    `diagram check --fix` redraws it.
  - A broken style or colour reference is only a warning: Studio writes some
    and still opens the file.
- **Elements:** every element has an outgoing flow (except end events and link
  senders) and an incoming one (except start events, link receivers and
  attached error events).
- **Pattern,** for each service task:
  - `executionType="1"`;
  - exactly one attached error event;
  - that event leads to a human handling task in `Pool Grupo` (and in the
    `--group`, when given);
  - the handling task returns only to the same service task;
  - it sits in the same lane;
  - layout warnings: the circle off its corner, the handling task not right
    below.
- **Exceptions:** `--except <id>` releases a service task, and only when the
  human made that exception explicitly. A human task with no mechanism is a
  warning, because the user who moves the request picks the assignee by hand.

`push diagram --dry-run` checks the model against what the server accepts. It
does not look at the pictogram, so a diagram can pass the dry-run, publish, and
still fail to open in Studio. That is what `diagram check` is for.

## Which events

| Event | Use for | May throw? |
|---|---|---|
| `servicetaskN(attempt, message)` | integration, calculation, writing control fields | **yes**, so the error task opens |
| `afterProcessCreate(processId)` | write `idfluig` into the card, create the GED folder, build links | no |
| `beforeStateEntry(sequenceId)` | prepare the task being entered (clear the old decision, reconcile data) | no |
| `beforeTaskSave(colleagueId, nextSequenceId, userList)` | capture what the user just decided, for later events in the same move | no |
| `calculateAgreement(currentState, agreementData)` | consensus in joint tasks | no |

- **Field validation belongs to the form** (`validateForm`), not to workflow
  events.
- **An event that must not block wraps its whole body:**

```js
function beforeStateEntry(sequenceId) {
    try {
        if (sequenceId == ATIV_AJUSTES) {
            // A decisao da rodada anterior nao pode vir marcada na nova entrada da tarefa.
            hAPI.setCardValue("decisaoAjuste", "");
        }
    } catch (e) {
        // Um throw aqui BLOQUEIA a movimentacao do usuario.
        log.error("reembolso.beforeStateEntry: " + e);
    }
}
```

- **Clear the decision field on every re-entry** of a task, or the previous
  round's choice comes back already selected.
- **`getCardValue` in `beforeStateEntry` still sees the pre-save value.** To pass
  what the user decided in this move from `beforeTaskSave` to `beforeStateEntry`,
  use `globalVars`.

## Activity ids

Name activity ids as constants at the top of the file, and compare them with the
event's `sequenceId`:

```js
var ATIV_ANALISE_GESTOR = 13;
var ATIV_VALIDACAO_NF = 149;
```

For behaviour that depends on where the request is going, use a map keyed by
the destination: `var CAMPO_POR_DESTINO = { "13": [...], "149": [...] };`.

## A service task that integrates

The task does not talk to the RM. It calls an integration dataset
(`dsSTG<Processo><Acao>RM`), passing the card and request number, and reads the
`status` / `message` row:

```js
function servicetask39(attempt, message) {
    var user = getValue("WKUser");
    var idfluig = getValue("WKNumProces");
    var documentId = getValue("WKCardId");

    // Idempotente: o card e desfeito quando a task falha, entao idmov so existe se a nota ja foi criada.
    var idmovExistente = String(hAPI.getCardValue("idmov") || "").trim();
    if (idmovExistente) {
        hAPI.setTaskComments(user, idfluig, 0, formatMessage("success", "Movimento já criado no RM (IDMOV " + idmovExistente + ")."));
        return;
    }

    var ds = DatasetFactory.getDataset("dsSTGCriaMovimentoReembolsoRM", null, new Array(
        DatasetFactory.createConstraint("documentid", documentId, documentId, ConstraintType.MUST),
        DatasetFactory.createConstraint("NUMFLUIG", idfluig, idfluig, ConstraintType.MUST)
    ), null);

    if (!ds || ds.rowsCount == 0 || ds.getValue(0, "status") != "success") {
        throw ds && ds.rowsCount > 0 ? ds.getValue(0, "message") : "dsSTGCriaMovimentoReembolsoRM sem retorno.";
    }

    var idmov = String(ds.getValue(0, "IDMOV"));
    hAPI.setCardValue("idmov", idmov);
    hAPI.setTaskComments(user, idfluig, 0, formatMessage("success", "Movimento criado no RM (IDMOV " + idmov + ")."));
}

function formatMessage(type, message) {
    return "<ul style='list-style-type: disc; padding-left:90px' class='alert alert-" + type + "'>" + message + "</ul>";
}
```

- **Record the outcome of every task** with `hAPI.setTaskComments`. That history
  is what support reads.
- **Write markers only after success.** The card is rolled back when the task
  throws. For partial work, such as several attachments, keep the list of what
  already went (`anexosEnviadosRM`) and pass it to the dataset (`JAENVIADOS`).
- **Throw a plain Portuguese message** saying what failed and what to check. The
  old `throwAlerta(msg)` HTML wrapper copied across files is not needed for new
  code.
- **Empty `WKCardId`.** Fall back to the `workflowProcess` dataset
  (`cardDocumentId`); Medição calls this helper `documentIdDoCard()`.

## hAPI notes

- **Read values defensively.** `String(getValue("X") || "").trim()` and
  `String(hAPI.getCardValue("x") || "").trim()`.
- **Child rows.**
  - Read with `hAPI.getChildrenIndexes("tabela")`, then `campo___idx`.
  - The result is a Java `Integer[]`, and probing `.size` on it throws in Rhino.
    Read `.length` inside a try.
  - Add rows through a helper that builds a `java.util.HashMap` and calls
    `hAPI.addCardChild(tabela, mapa)`.
- **Attachments from the GED.** Use `hAPI.attachDocument(id)`, after checking
  `hAPI.listAttachments()` so the same document is not attached twice.

## Approval rounds (alçada)

When a request can go back for adjustment and come again to approval:
1. `fecharRodadaAnterior()` marks the rows still pending as `"Cancelado (nova
   rodada)"`, then increments the round (`apRodada`).
2. The script builds the new rows (`apMatricula`, `apNivel`, `apRodada`,
   `statusAprovacao`).
3. **Validate that every approver exists as a Fluig user before closing the
   round.** If one does not, throw. Otherwise the task goes to nobody and stalls
   silently.
4. Set the control fields `faltaAprovador` (`sim`/`nao`) and
   `aprovacaoNivelCorrente`. The gateway routes on them.

## Attribution mechanisms

A mechanism file holds only `resolve(process, colleague)` and returns a
`java.util.ArrayList` of matrículas or `Pool:Group:<grupo>`.

- **By approval level** (`MEC_STG_ALCADAS`):
  - read the `historicoAprovacao` rows;
  - take the level of the first pending row;
  - return every pending approver at that level;
  - use it with `atividadeConjunta="true"` and `calculateAgreement` for
    consensus.
- **By company/branch group** (`MEC_STG_COMPRADORES` and similar): return
  `"Pool:Group:sc_compradores_coligada_" + codColigada + "_filial_" + codFilial`.
- **Always fall back to the integration user** when nobody is found, so the task
  lands somewhere visible instead of nowhere.
- **Wrap every `getValue` in its own try.** Write "Aprovadores atribuídos: …"
  with `hAPI.setTaskComments`.
- **Built-in mechanisms cover the rest:** group pool, form field (e.g.
  `matriculaGestorContrato`), fixed user.

## E-mail

- **One template for the project** (`templates_email/template_<cliente>_<ano>.html`):
  an Outlook-safe HTML shell with a single FreeMarker variable, `${CONTENT!''}`.
- **An e-mail dataset (`dsSTG<Processo>EnviaEmail`) builds the body** and sends
  it:

```js
var parametros = new java.util.HashMap();
parametros.put("CONTENT", corpoHtml);
parametros.put("subject", assunto);
var destinatarios = new java.util.ArrayList();
destinatarios.add(email);
notifier.notify("integracao.fluig", "template_cetenco_2026", parametros, destinatarios, "text/html");
```

- **The service task only says which message to send.** It passes `documentid`,
  `templateid` (`emailReprovado`, `recusaFornecedor`) and `link`.
- **`MODO_TESTE` redirects every e-mail** to `DESTINATARIOS_TESTE`, prefixes the
  subject with `[TESTE]` and prints a notice in the body. It is `false` in the
  repo.
- **Show the company logo per coligada,** with a default when there is none.

## Logging

Prefix each line with `<processId>.<evento>:` (`reembolso.servicetask91: ...`)
or the mechanism name in brackets (`[MEC_STG_ALCADAS]`). Use `log.info` /
`log.warn` / `log.error`.
