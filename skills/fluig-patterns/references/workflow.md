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
- **Do not hand-edit the `.process` XMI.** It has EMF indices. Change it in
  Studio or with `fluigctl diagram`. For a big model, write a step-by-step
  specification first, as Medição does in
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
- **Every service task has an error boundary event.** It leads to an "Erro ao
  …" human task in the `suporte_processos` group, which flows back into the
  service task so support can retry.
- **Every human task has an assignee.** A task with no mechanism never reaches
  anyone: approval task 34 in Medição stalled this way until it got
  `MEC_STG_ALCADAS`.

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
