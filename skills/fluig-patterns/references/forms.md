# Forms

## Files

Each form lives in `forms/form<Nome>/`:

| File | Holds |
|---|---|
| `form<Nome>.html` | the markup |
| `main.js` | init, handlers, visibility, locks |
| `consultas.js` | every dataset call, behind one queue |
| `attachments.js` | upload / view / delete through the Fluig attachment tab |
| `style.css` | form styles |
| `utils.js` | optional: masks, formatting, escaping |
| `events/displayFields.js`, `events/validateForm.js` | server side, Rhino ES5 |

Leave `enableFields.js` empty or delete it (see "Locking"). Library copies such
as Select2 go next to the form or in `libs/`.

## HTML

The `<head>` loads, in this order:
1. the style-guide CSS: `/style-guide/css/fluig-style-guide-flat.min.css` (the
   non-flat file returned 404 on the Cetenco servers);
2. jQuery from `/portal/resources/js/jquery/jquery.js`;
3. `/style-guide/js/fluig-style-guide.min.js`;
4. `/webdesk/vcXMLRPC.js`, which provides `DatasetFactory`;
5. `consultas.js`, `attachments.js`, `main.js`.

Body structure:

```html
<div class="fluig-style-guide">
<form name="form" role="form">
  <section class="panel panel-default secao-aprovacao" id="secaoAprovacao">
    <div class="panel-heading"><h3 class="panel-title">Aprovação</h3></div>
    <div class="panel-body">
      <div class="form-group row">
        <div class="form-group col-md-4">
          <label for="decisaoAprovacao">Decisão</label>
          <select class="form-control" name="decisaoAprovacao" id="decisaoAprovacao">…</select>
        </div>
      </div>
    </div>
  </section>
  <!-- campos de controle: idfluig, dataSolicitacao, matriculaSolicitante, faltaAprovador, idmov -->
</form>
</div>
```

- **Every `input` has a `name`.** Publishing fails otherwise. Display-only
  values go in a `<span>`.
- **Hidden control fields go at the end.** They are written by scripts and read
  by gateway conditions.
- **Child tables (pai-filho):**

```html
<table class="table table-bordered text-center" tablename="itens" id="itens"
       noaddbutton="true" nodeletebutton="true">
  <thead><tr><th>Produto</th><th></th></tr></thead>
  <tbody><tr><td><input type="text" class="form-control" name="itemProduto"></td>
             <td><button type="button" onclick="fnWdkRemoveChild(this)">x</button></td></tr></tbody>
</table>
```

  - Every `<table>` has `tablename` and a `<thead>`.
  - Never write the word "table" in an HTML comment. Fluig scans the markup for
    tables, and a malformed one breaks `wdkAddChild`, `getUser` and
    `getActivity`.
  - Add a row with `var i = wdkAddChild("itens")`, then use `$("#itemProduto___" + i)`.
  - Hide the template row from JS.
- **Use a `<select>` with Select2 instead of a zoom field.** Fill it from a
  dataset in the browser, and store the code in a hidden field through
  `option[data-codigo]`.
- **Escape every text that comes from a dataset** before it becomes HTML: build
  options with `$("<option>").text(t)`, or run the text through `escapeHtml`.
  Never use string concatenation or template literals for this.

## displayFields: hand the context to the page

```js
function displayFields(form, customHTML) {
    var atividade = getValue("WKNumState");
    var MODE = form.getFormMode();
    var user = getValue("WKUser");

    // 0 = solicitacao ainda nao criada, 4 = evento de inicio
    if (atividade == 0 || atividade == 4) {
        if (!form.getValue("idfluig")) form.setValue("idfluig", getValue("WKNumProces"));
        form.setValue("matriculaSolicitante", user);
    }

    customHTML.append("<script>");
    customHTML.append("function getAtividade(){ return '" + atividade + "'};");
    customHTML.append("function getMode(){ return '" + MODE + "'};");
    customHTML.append("function getUser(){ return '" + user + "'};");
    customHTML.append("</script>");
}
```

Any value written into the page goes through a JS-literal escaper that also
escapes `<`, so a value cannot close the `</script>` (`textoJs` in
`formReembolso`).

**In VIEW mode Fluig turns each `<select>` into an empty `<span>`.** Inject the
stored values (`VALORES_VISUALIZACAO = {...}`), and have `main.js` write them
into the spans. Also skip loading widgets such as `FLUIGC.calendar` in VIEW mode.

Read the context on the client defensively, because the functions do not exist
outside a process page:

```js
function obterAtividadeAtual() {
    try {
        var a = parseInt(String(typeof getAtividade === "function" ? getAtividade() : ""), 10);
        return isNaN(a) ? 0 : a;
    } catch (e) { return 0; }
}
```

## Visibility per activity

Declare the activity groups once, as a constant, using the real activity ids from
the diagram:

```js
var ATIVIDADES = { solicitante: [0, 4], validacao: [5], aprovador: [32], ajustes: [9], erro: [22, 29] };
```

Keep the same table in `validateForm.js` (`ATIVIDADES_VALIDACAO`).
- **Compare against lists, never against ranges.** Activity ids are not ordered
  by flow.
- **The error activities see what the activity before them saw.** One missing
  from the list shows a different screen to the support person.
- **Leave a group `[]` until the diagram exists**, so the form does not block a
  move it does not know about yet.

Prefer to lock rather than to hide, as Medição puts it: "esconder era a forma
preguiçosa de travar". Keep a section visible when the user needs its content to
decide, and lock its fields. When you do hide, hide on the server:
`form.setVisibleById`, or CSS injected by `displayFields`. Client-side selectors
such as `:checked` fail in VIEW mode, where inputs are spans.

## Locking

`disabled` and `form.setEnabled(false)` lose the value (the field is not
POSTed). Lock instead:

| Control | Lock |
|---|---|
| text, textarea | `readonly` |
| `<select>` / Select2 | `data-readonly="true"`, a handler on `mousedown keydown select2:opening` that calls `preventDefault()`, class `.select2-somente-leitura` |
| radio group | `data-readonly` on the container, `pointer-events:none`, `tabindex=-1` |

Use one function (`aplicarTravasPorAtividade`) as the single place that decides
the locks.

## Calling datasets

Keep every call in `consultas.js`. Calls are async and go through a queue of at
most 4 in flight:

```js
function getDatasetAsync(name, fields, constraints, order) {
    return comVagaDeConsulta(function () {
        return new Promise(function (resolve, reject) {
            DatasetFactory.getDataset(name, fields, constraints, order, { success: resolve, error: reject });
        });
    });
}
var MAX_CONSULTAS_SIMULTANEAS = 4; // o servidor atende 5; a sexta espera ~10 s
```

`consultarDataset(nome, { PAR_X: valor })` sits on top of `getDatasetAsync`:
- it builds the `MUST` constraints;
- it retries 3 times on the `STATUS/MESSAGE` error row;
- it warns once per dataset with `FLUIGC.toast` (an RM licence error gets its
  own message);
- it returns `[]` marked `.falhou = true`, so callers can tell a failure from no
  rows.

Copy it from `forms/formReembolso/consultas.js`.

- **One loading overlay.** `comLoading(promise)` keeps a single ref-counted
  `FLUIGC.loading(window)`. Long loads that are not blocking (such as the product
  catalogue) do not hold the overlay; the select says "Carregando…".
- **Stale answers.** Count requests (`pedidoColigada++`) and drop answers that
  belong to an old choice.
- **Independent loads.** Run them in parallel, and memoize repeated ones
  (`memoConsulta`).
- **Big lists stay in memory, not in the DOM.** 11 thousand `<option>` elements
  froze the form. Feed Select2 through a custom `ajax.transport` that searches
  an in-memory array, case- and accent-insensitive, with all words required and
  50 items per page.
- **No synchronous `DatasetFactory.getDataset(...)` without callbacks.** It freezes
  the page.
- **No `$.ajax` to `/api/public` from a form.**

## Browser JavaScript

- **Plain global functions** with Portuguese verb names (`carregarDoProjeto`,
  `aplicarVisibilidadePorEtapa`), with no modules or namespaces.
- **A single `$(function () { … })`** calls the named init steps in order, then
  binds handlers.
- **Syntax:** ES5 (`var`, `function`) plus `async`/`await` and Promises. Avoid
  arrows and template literals, so code can move between the form and its server
  events.
- **Debug output** goes behind a flag (`RASTREAR`/`DEBUG_FORM`) and a `depurar()`
  helper.
- **Guard Fluig globals.** `wdkAddChild`, `getUser`, `FLUIGC` are missing outside
  the process page: check before calling, and say once, in Portuguese, why the
  action is unavailable.
- **`isEmpty`** is `value == null || String(value).trim() === ""`. With `== ""`,
  the number 0 counts as empty.

## Masks and money

- Masks are hand-written on `input`: CPF/CNPJ, bank, branch and account with
  check digit, currency.
- Currency is typed as digits / 100 and shown with
  `toLocaleString("pt-BR", { minimumFractionDigits: 2 })`.
- `parseValorMonetario` reads it back with `.replace(/\./g, "").replace(",", ".")`.
- Strip punctuation on the server before sending to the RM.

## validateForm

Collect every error, then throw once:

```js
function validateForm(form) {
    var atividade = parseInt(getValue("WKNumState"), 10);
    var erros = [];
    if (grupoAtivo("solicitante", atividade)) validarCampo(form, "codColigada", "Coligada", erros);
    var idx = form.getChildrenIndexes("itens");
    for (var i = 0; i < idx.length; i++) validarCampo(form, "itemProduto___" + idx[i], "Produto (linha " + (i + 1) + ")", erros);
    if (erros.length) {
        throw "<ul style='list-style-type: disc; padding-left:90px' class='alert alert-danger'>" +
            "Os seguintes campos são obrigatórios:\n- " + erros.join("\n- ") + "</ul>";
    }
}
```

- The client can mirror it in `beforeSendValidate(numState, nextState)` to warn
  earlier, using `FLUIGC.toast({ title: "Atenção: ", message, type: "warning" })`.
  The server stays the authority.
- A validation switch (`MODO_TESTE`) must be `false` in the repo.

## Attachments

`attachments.js` dispatches on `data-action="upload|view|delete"`:
- upload goes through `window.parent.$("#ecm-navigation-inputFile-clone")`;
- files are renamed to `<prefixo>_NNN.ext` using
  `parent.ECM.attachmentTable.getData()`;
- each row keeps the description and id in hidden `.anexo` / `.anexoId` fields.
