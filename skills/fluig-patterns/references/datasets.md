# Datasets

## Shape

Write a single `createDataset(fields, constraints, sortFields)`. The Studio
template also generates `defineStructure`, `onSync` and `onMobileSync`. Delete
them unless the dataset really is synchronized; empty stubs only mislead the next
reader. Start the file with a block comment that states:

- what the dataset returns;
- which RM sentence or service it uses;
- which constraints it reads;
- who calls it.

Put switches and fixed values at the top, each with a comment:

```js
/*
 * Naturezas de despesa ativas, para TMOV.CODTB5FLX da nota de debito.
 * Sentenca 00.00048.STG. Constraint: PAR_CODCOLIGADA. Usado pelo formReembolso.
 */
var SENTENCA = "00.00048.STG";
var USAR_STUB = false; // true devolve linhas ficticias, para testar sem o RM
```

Helpers are copied into each file because Fluig datasets do not share code. Copy
the **current** version of a helper from the newest dataset in the repo, not
from an old one.

## Reading constraints

```js
function getConstraintValue(constraints, fieldName, defaultValue) {
    if (constraints != null && constraints.length) {
        for (var i = 0; i < constraints.length; i++) {
            if (String(constraints[i].fieldName || "").toUpperCase() == String(fieldName || "").toUpperCase()) {
                var value = constraints[i].initialValue;
                if (value == null || String(value).trim() === "") return defaultValue;
                return value;
            }
        }
    }
    return defaultValue;
}
```

- The default value is `""`, never a real id left over from a test.
- If a required constraint is missing, return the empty dataset: the form calls
  before the user has chosen anything.

## The error row

Errors never `throw` out of `createDataset`. A lookup dataset returns this row on
failure:

```js
    } catch (e) {
        log.error("### dsSTGReembolsoObterNaturezas - erro: " + e);
        return datasetDeErro(e);
    }

function datasetDeErro(e) {
    var erro = DatasetBuilder.newDataset();
    erro.addColumn("STATUS");
    erro.addColumn("MESSAGE");
    erro.addRow(["ERROR", String(e)]);
    return erro;
}
```

The form recognizes the error row as exactly two columns, `STATUS=ERROR` and
`MESSAGE`. It then retries three times, shows one toast per dataset, and marks
the list `falhou`.

Integration datasets called by a service task use another shape. They return one
row with lowercase `status` (`"success"`/`"error"`) and `message`, plus the
produced keys (`IDMOV`, …). The service task checks
`dataset.getValue(0, "status") != "success"` and throws the message. Keep the
shape the repo's callers already read. A rename here breaks every caller
silently.

## Querying the RM (read)

Use SOAP `wsConsultaSQL`, a sentence registered in the RM, with `PAR_` parameters:

```js
var servico = ServiceManager.getService("wsConsultaSQL");
var serviceHelper = servico.getBean();
var locator = servico.instantiate("com.totvs.WsConsultaSQL");
var ws = locator.getRMIwsConsultaSQL();
var serviceAuth = serviceHelper.getBasicAuthenticatedClient(ws, "com.totvs.IwsConsultaSQL", usuario, senha);
var result = serviceAuth.realizarConsultaSQL(SENTENCA, 0, "T", "PAR_CODCOLIGADA=" + codColigada + ";PAR_CODPRJ=" + codPrj);
```

Parse the XML with `org.json`. `Resultado` comes back as an array when there are
several rows and as an object when there is one. A missing `NewDataSet` is an
error, not "no rows":

```js
function parseRegistrosConsultaSQL(result) {
    var registros = [];
    var xmlJson = org.json.XML.toJSONObject(result);
    // Sem resultado o RM devolve <NewDataSet />; qualquer outra coisa e erro, nao lista vazia.
    if (!xmlJson.has("NewDataSet")) throw "Resposta inesperada do RM: " + String(result).substring(0, 300);
    var ds = xmlJson.optJSONObject("NewDataSet");
    if (ds == null || !ds.has("Resultado")) return registros;
    var r = ds.opt("Resultado");
    if (r instanceof org.json.JSONArray) {
        for (var i = 0; i < r.length(); i++) if (!r.isNull(i)) registros.push(r.get(i));
    } else if (r instanceof org.json.JSONObject) {
        registros.push(r);
    }
    return registros;
}

function valorOuVazio(valor) {
    return (valor == null || valor == org.json.JSONObject.NULL) ? "" : String(valor);
}
```

- **One sentence per need.** Document each sentence next to the code. Medição
  keeps `docs/consultas-rm-*.md`, with a table of dataset, `PAR_*`, cardinality
  and consumer, plus the numbered `sql-rm-NN-*.sql` files.
- **RM sentences match on the RM login, not on the Fluig matrícula.** Look up the
  login in `colleague` first.

## Writing to the RM

There are two ways in use:
- **SOAP `wsDataServer`:**
  - `getRMIwsDataServer()` → `getBasicAuthenticatedClient(ws, "com.totvs.IwsDataServer", …)` → `saveRecord(dataServer, xml, contexto)`.
  - The context is `"CODCOLIGADA=1;CODSISTEMA=M;CODUSUARIO=<user>"`.
  - The answer is text:
    - empty → failure;
    - "já existe" / "duplicate" → success, so a retry is idempotent;
    - "erro" / "exception" → failure.
- **REST DataServer through the Fluig authorized client:**

```js
var clientService = fluigAPI.getAuthorizeClientService();
var data = {
    companyId: getValue("WKCompany") + "", serviceCode: "RM_WSDATASERVER_REST",
    endpoint: "/rmsrestdataserver/rest/MOVMOVIMENTOTBCDATA", method: "post", timeoutService: "100",
    options: { encoding: "UTF-8", mediaType: "application/json" },
    headers: { "Content-Type": "application/json;charset=UTF-8", CODCOLIGADA: codColigada + "" },
    params: payload
};
var result = clientService.invoke(JSON.stringify(data)).getResult();
```

Log the payload before sending it: `log.info("[BaixaEstoqueRM] payload=" + JSON.stringify(payload))`.
Business values come from the RM, not from constants: a fixed `PRECOUNITARIO`
once valued stock at R$ 1,00. Check stock balance before a write that consumes
it.

## Fluig services and the GED

- **Cards:** `ServiceManager.getServiceInstance("ECMCardService")` → `updateCardData`.
  Datasets read cards with `getForm` / `getFormChildren`, filtering on
  `documentid`, `tablename` and `metadata#active=true`.
- **GED:** use `ECMFolderService`.
  - Prefer `getSubFoldersOnDemand`: `getSubFolders` also returns documents.
  - Page through large folders (`LIMITE_PAGINA`). Reaching the limit is a signal,
    not "done".
- **Each request gets its own GED folder.** A shared folder exposed one
  supplier's documents to another.

## Rhino and Java

- Collections: `new java.util.ArrayList()` and `new java.util.HashMap()`, for
  example for `notifier.notify`.
- Text and encoding: `new java.lang.String(bytes, "UTF-8")`, `java.util.Base64`,
  `java.text.SimpleDateFormat`.
- Typed SOAP arrays: `java.lang.reflect.Array.newInstance`.
- JSON: native `JSON` for REST payloads, `org.json` for the RM XML.
- Guard against the strings `"null"` and `"undefined"` coming back from
  `String(javaValue)`.

## Logging

Use `log.info` / `log.warn` / `log.error`, never `console.log`. Prefix every line
with the dataset name: `"### dsSTGX - ..."` or a short tag such as
`"[CriarPeriodo] ..."`. With `USAR_STUB` on, log a warning on every call, so a
stub left on shows up in the server log.

## Read-only SQL consoles

`dsSTGConsultaDBRM` and `dsSTGConsultaDBFluig` (in `Utils/`) run SQL through
JDBC: `InitialContext().lookup("/jdbc/Corpore")` for the RM, `/jdbc/AppDS` for
Fluig. They exist for diagnosis and e2e tests. If you copy them:
- accept only `SELECT`/`WITH`;
- receive the SQL as `SENTENCA_B64`;
- cap the rows with `setMaxRows`;
- close everything in `finally`.

Production code goes through registered sentences, not through them.

## Throwaway datasets

Probes (`dsSTGTEMP`, `dsSTGTESTE`, "TEMPORARIO — sonda") are fine while you
investigate. Delete them from the repo and from the server when you are done.
