---
name: fluig-patterns
description: Use when writing or changing code for a TOTVS Fluig project - datasets, forms (HTML, main.js, displayFields, validateForm), workflow scripts (servicetask, beforeStateEntry, beforeTaskSave, afterProcessCreate), attribution mechanisms, e-mail templates or the RM integration behind them - "cria um dataset", "consulta no RM", "sentença", "campo pai-filho", "esconde o painel na atividade", "service task que integra com o RM", "mecanismo de atribuição", "valida o formulário", "trava o campo". The team's project patterns, taken from the Strategi projects: naming, Rhino ES5 limits, the STATUS/MESSAGE error row, async dataset calls with a concurrency cap, locking fields without disabled, error tasks for service tasks, idempotent retries, environment switches. Not for publishing - that is fluig-deploy.
---

# Fluig project patterns

These are the conventions of the Strategi Fluig projects, taken from the
Cetenco repository (`StrategiConsultoria/fluigcetenco`) and the lessons its
history paid for. Follow them in a new project too: the next person to open the
code expects them.

Writing is this skill; publishing is `fluig-deploy`. Read the reference for the
artifact you are touching before writing it:

| Touching | Read |
|---|---|
| a dataset, an RM query, a write to RM | [references/datasets.md](references/datasets.md) |
| a form: HTML, `main.js`, `consultas.js`, `events/*.js` | [references/forms.md](references/forms.md) |
| a workflow script, a mechanism, an e-mail | [references/workflow.md](references/workflow.md) |
| repo layout, environments, commits, docs, tests | [references/project.md](references/project.md) |

## When the repo already has a style

Copy the newest code in the repo, not the oldest. Look at what changed last
(`git log --format='%h %ad %s' --date=short -- <dir>`) and imitate it. Old
files in Fluig projects are full of Studio templates and copied helpers that the
team has since replaced; matching them spreads the old mistakes.

When this skill and the repo disagree, the repo wins for naming and layout, and
this skill wins for the rules below, which each cost a production incident.

## Rules that are not negotiable

**Server-side JavaScript is Rhino, so write ES5.** Use `var` and `function`, with
no arrow functions, template literals, `let`/`const`, destructuring or
`forEach`. Rhino keeps the first iteration's value in a `const` declared inside a
loop. Convert Java strings with `String(x)` or `x + ""` before comparing them.
This applies to datasets, `events/*.js` of forms, workflow scripts and
mechanisms.

**Never `disabled`, never `form.setEnabled(false)`.** A disabled field is not
POSTed, and Fluig wipes its value from the card. Lock fields like this:
- text: `readonly`;
- `<select>`/Select2: `data-readonly="true"` plus a guard;
- radios: `data-readonly` on the container with `pointer-events:none`.

Have one function decide each lock. Two writers of the same attribute is how
"everything opens locked" happens.

**A dataset never throws out.** On failure, return a row with `STATUS="ERROR"`
and `MESSAGE`. An empty list must mean "no rows", never "the RM failed". The
form retries and warns on the error row. An empty list leaves the select silently
empty.

**A service task throws on purpose.** Every service task has an error boundary
event that leads to an "Erro ao …" human task (group `suporte_processos`), which
loops back to retry. Throw a Portuguese message the support person can act on.

**`beforeStateEntry`, `beforeTaskSave` and `afterProcessCreate` never throw.**
A throw there blocks the user's move. Catch everything, then `log.error`.

**Make every retry idempotent.** Fluig rolls back `hAPI.setCardValue` when the
task throws. Write the "done" marker (`idmov`, `anexosEnviadosRM`, …) only after
the side effect succeeded, and skip the work when the marker is already set.

**Credentials never go in git.** Not in a dataset and not in `servers.json`. The
`dsGetWebServicesAuth` dataset that returns the RM user and password in plain
text is a known debt, not a model. Read credentials from the server (a Fluig
service, a parameter, a card the integration user owns), and keep `servers.json`
and `.env*` in `.gitignore`.

**Test switches are named, at the top, and off on commit.** Examples are
`USAR_STUB`, `MODO_TESTE` and `MODO_DEBUG`, each with a comment saying what it
does when on. Before committing, `grep -rn "USAR_STUB = true\|MODO_TESTE = true"`.
`MODO_TESTE` left on once disabled every validation in HML. Hardcoded test
defaults (`getConstraintValue(c, "IDMOV", "459741")`) are the same mistake.

**At most 4 dataset calls in flight from a form.** The server serves 5 RM
queries at once, and the sixth waits around 10 s. Go through the queue in
`consultas.js` (see forms.md).

## Naming at a glance

| Thing | Pattern | Example |
|---|---|---|
| Process id | snake_case, Portuguese | `solicitacao_compras`, `reembolso` |
| Form folder | `form<PascalCase>`; lookup/cadastro: `formInterno<…>` | `formReembolso`, `formInternoRestricoesReembolso` |
| Dataset | `dsSTG<Processo><Verbo><Coisa>` | `dsSTGReembolsoObterNaturezas` |
| Generic helper dataset | `dsGet*` / `dsSet*`, in `datasets/Utils/` | `dsSetCardValue` |
| Dataset folder | process name in Portuguese, accents and spaces allowed | `datasets/solicitação de compras/` |
| RM sentence | `00.000NN.STG` (app `T`); alçada `FLUIG.00N` | `00.00048.STG` |
| Sentence parameter | `PAR_<COLUNA>` | `PAR_CODCOLIGADA` |
| Workflow script | `<processId>.<evento>.js` | `reembolso.servicetask39.js` |
| Mechanism | `MEC_STG_<NOME>` | `MEC_STG_ALCADAS` |
| Field | camelCase in Portuguese; RM codes mirror the RM column | `decisaoAprovacao`, `codColigada`, `codCCusto` |
| Child-table field | per-table prefix, `___N` suffix at runtime | `apMatricula___3` |
| Radio value | lowercase, no accent | `sim` / `nao`, `aprovado` |

Identifiers, comments, docs and commits are in Portuguese. Code comments in
server-side files are ASCII (no accents). They explain **why**, and carry a date
or request number when they record an incident.

## Where to find a model

In the Cetenco repo, the newest and cleanest code to imitate:
- **RM lookup dataset:** `datasets/reembolso/dsSTGReembolsoObter*.js`.
- **Form:** `forms/formReembolso/` (`consultas.js`, `events/displayFields.js`, `events/validateForm.js`).
- **Service task that writes to RM:** `workflow/scripts/reembolso.servicetask39.js`.
- **Long-lived process, approval rounds, tests, docs:** branch `medicao-contratos`, which holds `tests/` and `docs/`.

Do not imitate:
- `forms/NNN - formX/` folders, which are Studio-exported copies;
- the Minutas forms (looser style, `let`/arrows);
- `enableFields` with `setEnabled`;
- `throwAlerta` copied into 16 files.
