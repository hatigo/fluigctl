# Validação real de temporizador — fluig-localdev — 2026-10-09

## Escopo e alvo

- Alias exclusivo: `fluig-localdev`.
- URL confirmada: `http://100.90.132.16:8080`.
- `server ls` não apresentou marcador `PRODUÇÃO`; `server test fluig-localdev` confirmou login, ping e `admin`, `companyId 1`.
- Não foram lidos segredos, nem usados outros servidores, `request move`, e-mail, integração, grupo, usuário ou configuração global.

## Artefatos e publicação

| Item | Valor |
|---|---|
| Formulário isolado | `formTimerDev20261009` |
| documentId | `414` |
| Processo isolado | `timerDev20261009` |
| Timer | `intermediatetimer20261012` (tipo Studio 32) |
| Versão para 1 minuto | `v1`, liberada |
| Solicitação de 1 minuto | `292` |
| Versão para 5 minutos | `v2`, liberada |
| Solicitação de 5 minutos | `293` |

O formulário tinha somente o campo não obrigatório `observacao`. O processo tinha `Início → Temporizador → Fim`; não há tarefas de e-mail, integração nem scripts. Antes de cada escrita foram executados `diagram check` e `push ... --dry-run`.

A publicação foi aceita pelo servidor em ambas as versões (`Import: Processo importado com sucesso!`; liberação `ok=true`, `activityError=[]`, `flowError=[]`). Isto por si só não é a evidência de execução; as observações abaixo são a evidência de disparo.

## Execução real — MINUTE/1

Configuração local publicada: `runType=MINUTE`, `timeTrigger=0:0:0`, `frequencia=1` por `diagram add --type temporizador --minutes 1`.

- UTC antes do start: `2026-10-09T13:04:58Z`.
- Solicitação `292`, processo `timerDev20261009`, versão `1`.
- Histórico do servidor: Início `10:05:03`; entrada no temporizador `10:05:06`, responsável `System:Auto`, aberta.
- Saída automática: Fim `10:06:06`; solicitação `status: 2` (fechada).
- O próprio movimento do timer foi concluído por `System:Auto`, com observação: `Tarefa Automática: Decisão tomada conforme condição 0 Atividade Destino: Fim`.
- Tempo observado entre entrada e fim: exatamente 60 s; latência observada sobre o nominal de 60 s: 0 s na precisão de segundos do histórico.

Não foi usado `request move`.

## Execução real — MINUTE/5

Após `diagram timer ... --minutes 5`, `diagram check`, dry-run e publicação, o servidor liberou a versão `2`.

Evidência lida de volta do servidor com `pull diagram timerDev20261009 --server fluig-localdev`:

```xml
<runType>MINUTE</runType><timeTrigger>0:0:0</timeTrigger><frequencia>5</frequencia><isCondition>false</isCondition>
```

- UTC antes do start: `2026-10-09T13:09:47Z`.
- Solicitação `293`, processo `timerDev20261009`, versão `2`.
- Histórico do servidor: Início `10:09:49`; entrada no temporizador `10:09:50`, responsável `System:Auto`, aberta.
- Saída automática: Fim `10:15:51`; solicitação `status: 2` (fechada).
- Movimento automático do timer: `System:Auto`, observação `Tarefa Automática: Decisão tomada conforme condição 0 Atividade Destino: Fim`.
- Tempo observado entre entrada e fim: 361 s (6 min 1 s); nominal 300 s; latência do scheduler observada: +61 s.

Não foi usado `request move`.

## Comandos executados (segredos omitidos)

```sh
npm run build
node bin/fluigctl.js server ls
node bin/fluigctl.js server test fluig-localdev
node bin/fluigctl.js form new formTimerDev20261009 --field observacao:text:Observação --forms <isolado>/forms
node bin/fluigctl.js push form <isolado>/forms/formTimerDev20261009 --server fluig-localdev --create --dry-run
node bin/fluigctl.js push form <...> --server fluig-localdev --create
node bin/fluigctl.js diagram new timerDev20261009 --form formTimerDev20261009 --server fluig-localdev --workflow <isolado>/workflow
node bin/fluigctl.js diagram add <processo> --type temporizador --minutes 1 --after Início --before Fim
node bin/fluigctl.js diagram show <processo>
node bin/fluigctl.js diagram check <processo>
node bin/fluigctl.js push diagram <processo> --server fluig-localdev --create --dry-run
node bin/fluigctl.js push diagram <processo> --server fluig-localdev --create
node bin/fluigctl.js process versions timerDev20261009 --server fluig-localdev
node bin/fluigctl.js request start timerDev20261009 --server fluig-localdev --comment <validação>
node bin/fluigctl.js request show 292 --server fluig-localdev --json
node bin/fluigctl.js diagram timer <processo> intermediatetimer20261012 --minutes 5
node bin/fluigctl.js push diagram <processo> --server fluig-localdev --dry-run
node bin/fluigctl.js push diagram <processo> --server fluig-localdev
node bin/fluigctl.js pull diagram timerDev20261009 --server fluig-localdev --workflow <isolado>/pulled --name timerDevServer
node bin/fluigctl.js request start timerDev20261009 --server fluig-localdev --comment <validação>
node bin/fluigctl.js request show 293 --server fluig-localdev --json
```

## Limpeza, resíduos e limitações

- Solicitações `292` e `293` fecharam automaticamente; nenhuma foi cancelada.
- Permanecem no servidor, intencionalmente: formulário `formTimerDev20261009`/documentId `414`, processo `timerDev20261009`, versões liberadas `v1` e `v2`, e o histórico das duas solicitações fechadas. O Fluig não oferece remoção dessas versões por esta CLI.
- A árvore local isolada `.tmp/timer-dev-validation-20261009-2484379/` foi removida após a evidência; este relatório é o registro local retido.
- A configuração de 5 minutos foi confirmada por pull do servidor. Para a versão 1, o registro disponível é a publicação de `MINUTE/1`, a solicitação explicitamente em `v1` e a transição automática server-side exatamente 60 s depois; não foi obtida uma exportação histórica independente da versão 1 após a versão 2 substituí-la como ativa.
- Esta validação prova execução do scheduler neste ambiente e nesses dois momentos; não é garantia de latência constante nem validação em produção.
