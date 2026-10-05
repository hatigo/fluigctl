# Validação do `pull diagram`

O caminho validado é:

```text
exportProcessInZipFormat → definição ECM 3.0 → gerarProcess → lerDiagrama → gerarEcm30
```

A última etapa usa o conversor de publicação já validado contra o Studio e
serve como verificação de que o `.process` gerado é estruturalmente completo,
sem objetos ou atributos descartados silenciosamente.

## Amostra disponível

Foram usados 17 exports preservados da pesquisa anterior:

- 13 processos do HML da Cetenco;
- 4 processos do `fluig-localdev` descartável.

Resultado: **15 de 17** convertem e passam novamente pelo conversor de push.
Entre eles há tarefas de usuário e serviço, gateways e regras, temporizador,
subprocesso comum e ad hoc, raias, campos descritores e atribuições simples.

Dois exports são recusados antes de gravar:

1. `AL001`: um evento de erro aponta para `parentSequence=6`, mas a definição
   exportada não contém esse estado;
2. `teste_adhoc`: um evento final traz `notifyAuthorityDelay=true` num tipo para
   o qual o modelo `.process` do Studio fixa `false`; não existe atributo que
   represente esse valor.

Essas recusas são intencionais: inventar a referência ou apagar o valor faria o
round-trip alterar o processo.

## Cobertura

- estados, tarefas de usuário, serviço, script e e-mail;
- eventos intermediários, de erro anexado e de link;
- gateways, condições por expressão e regras;
- atribuições simples, Associado e Grupos Colaborador;
- subprocessos e relacionamentos de campos;
- segurança/regras de anexos, campos descritores, propriedades estendidas e
  configuração de aplicativo;
- pools, lanes, grupos, anotações, documentos, bancos, fluxos e bendpoints;
- geração determinística da camada Graphiti.

Dois exports são recusados antes de gravar, e **não por defeito do conversor** — o
Fluig Studio faria pior com os dois:

1. `AL001`: um evento de erro aponta para `parentSequence=6`, e a definição não
tem esse estado. O `populateIntermediateEventLink` do Studio decompilado faz
`mapParentIds.get(parentSequence) == null` e dá `continue`, ou seja, **descarta o
evento em silêncio**; republicar sem ele mudaria o processo. O `pull` para e
explica.
2. `teste_adhoc`: um evento final traz `notifyAuthorityDelay=true` num tipo 68.
O `getProcessStateFromEndEvents` do Studio decompilado fixa `true` para todo fim
e depois sobrescreve com `false` no fim terminal (68), sem nunca ler o valor do
modelo: o campo não existe no `.process`. Republicar gravaria `false`.

Os dois valores vêm de fora do modelo do Studio — provavelmente de outra versão
ou da interface web — e nenhum dos dois pode ser representado no `.process`.

## Achado: fluxo sem origem

O `cotacao` dos workspaces tem um `SequenceFlow` sem `sourceRef`. O conversor de
ida recusava, e a recusa era um defeito: o
`getProcessLinkFromSequenceFlow` do Studio faz

```java
if (sourceFlowNode instanceof BaseElement) {
    pl.setInitialStateSequence(Integer.valueOf(sequence));
}
```

e `null instanceof BaseElement` é falso, então o campo **não sai do XMI**. Correção
feita, e conferida contra o `cotacao.ecm30.xml` que o próprio Studio exportou: o
`<ProcessLink>` de `linkSequence` 62 sai byte a byte igual ao dele, sem
`initialStateSequence`.

O harness diferencial tinha o mesmo critério estreito em dois lugares (contava os
fluxos por “as duas pontas são nós” e excluía do conjunto coberto o link sem uma
das pontas), o que classificava esses pares como “mesma versão” e reportava o link
como sobra. Corrigido também.

| | antes | depois |
|---|---|---|
| `.process` dos workspaces que convertem | 40/45 | **45/45** |
| pares gabarito (versão, nós e links iguais) | 13 | **18** |
| gabaritos batendo em todos os filhos | 13/13 | **18/18** |
| pares “mesma versão” (divergência falsa) | 5 | **0** |

## Como repetir

```bash
npm run validar-pull-diagramas -- /pasta/com/exports
```

O comando é somente leitura. Cada XML é convertido para memória, lido de volta
e passado pelo conversor de publicação. Qualquer recusa deixa o processo com
código de saída 1.

## Pendência de validação manual

Ainda é recomendável abrir pelo menos um arquivo gerado no Fluig Studio para
validar a renderização visual específica da versão instalada. O harness valida
a estrutura Graphiti e o round-trip de negócio, mas não dirige a interface
gráfica do Eclipse.
