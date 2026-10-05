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
