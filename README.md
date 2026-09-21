# fluigctl

Sobe datasets e formulários para o TOTVS Fluig pela linha de comando — o que a
extensão Fluiggers do VS Code faz, sem precisar de IDE nem de clique em
QuickPick. O mesmo binário serve para você no terminal e para um agente via
script.

## Estado

| | |
|---|---|
| `server add` / `ls` / `rm` / `test` / `set-prod` | pronto |
| `server import` (lê `.vscode/servers.json` da Fluiggers) | pronto |
| `push dataset` | pronto |
| `push form` | pronto |

Fora de escopo por enquanto: `pull`, widget, evento global e mecanismo de
atribuição.

## Instalação

```sh
npm install && npm run build
npm link            # deixa `fluigctl` no PATH
```

## Uso

```sh
export FLUIG_CETENCO_HML_PASSWORD='...'
fluigctl server add cetenco-hml --host homolog.cetenco.com.br --port 8021 --user integracao.fluig
fluigctl server test cetenco-hml

fluigctl push dataset datasets/dsSTGObterProjetos.js --server cetenco-hml --dry-run
fluigctl push dataset datasets/dsSTGObterProjetos.js --server cetenco-hml
fluigctl push dataset datasets/dsNovo.js --server cetenco-hml --create --description "Novo"

fluigctl push form forms/formSolicitacaoCompras --server cetenco-hml --dry-run
fluigctl push form forms/formSolicitacaoCompras --server cetenco-hml
fluigctl push form forms/formNovo --server cetenco-hml \
  --create --parent-id 5 --dataset-name dsformNovo --persistence-type form
```

`server add` descobre `companyId` e `userCode` sozinho, consultando o servidor.

### Importar o que já existe

```sh
fluigctl server import ~/fluig/workspaces          # mostra o que faria
fluigctl server import ~/fluig/workspaces --write  # grava
```

Traz os servidores dos `.vscode/servers.json` da extensão Fluiggers, sem a
senha. Deduplica pelo que identifica um servidor — host, porta, ssl e usuário —
porque o mesmo Fluig costuma aparecer em vários projetos com nomes diferentes.

A marca de produção vem do nome do servidor, o que é palpite: o import lista
tudo que **não** marcou e pede revisão. Corrija com `server set-prod <nome>`.

## Segredos

Nenhuma senha é gravada em disco. `~/.config/fluigctl/servers.json` guarda só
host, porta, usuário, `companyId`, `userCode` e o **nome** da variável de
ambiente que contém a senha — derivado do nome do servidor
(`cetenco-prod` → `FLUIG_CETENCO_PROD_PASSWORD`).

Isso é proposital: o arquivo de config pode ser lido, versionado e inspecionado
por qualquer ferramenta sem expor credencial.

## Produção

Um servidor cadastrado com `--prod` exige que a senha seja digitada no terminal
antes de cada push. A senha digitada é comparada com a da variável de ambiente
(`crypto.timingSafeEqual`) e serve só como autorização — quem vai no SOAP é
sempre a do ambiente.

O prompt abre `/dev/tty` diretamente e recusa qualquer coisa que não seja um
terminal de verdade. **Sem TTY, o push em produção falha com código 5.** Isso
significa que um processo não interativo — um script de CI, um agente — não
consegue subir em produção. É uma garantia estrutural, não uma convenção.

## Publicando um formulário

O `documentId` é resolvido nesta ordem, e cada fonte é conferida contra o
catálogo do servidor antes de valer:

1. `--document-id N`
2. o prefixo numérico da pasta (`721291 - Aprovadores`) — aceito só se a
   descrição no servidor também bater; se apontar para outro formulário, o
   push para, porque isso costuma ser pasta copiada de outro projeto
3. o nome da pasta contra `documentDescription`

Com duas correspondências, o push para e lista os candidatos. Sem nenhuma,
pede `--create` com `--parent-id`, `--dataset-name` e `--persistence-type` —
nada disso é adivinhado, porque `persistenceType` não existe na operação de
atualização e um erro na criação não tem conserto por essa via.

Vão como anexo todos os arquivos da pasta, com o caminho relativo preservado,
**exceto** `events/` (que vira `customEvents`, em texto puro), o `.metadata` do
Eclipse e dotfiles. O arquivo principal é o `.html` único da raiz, ou o que
tiver o nome da pasta, ou o que você indicar em `--principal`.

Rodado contra as 657 pastas de formulário reais dos 12 workspaces: 646 lidas
sem erro, 11 recusadas com motivo — 8 sem `.html` nenhum e 3 com dois `.html`
sem desempate. Nenhuma publicaria o `.metadata` junto.

## Códigos de saída

| | |
|---|---|
| 0 | sucesso |
| 2 | uso inválido |
| 3 | config ou arquivo não encontrado |
| 4 | credencial ausente ou recusada |
| 5 | gate de produção abortado (inclui ausência de TTY) |
| 6 | resolução ambígua ou sem correspondência — falta uma flag |
| 7 | o servidor Fluig recusou a operação |

## Protocolo

SOAP, replicando o caminho que a extensão Fluiggers usa. As assinaturas foram
extraídas do WSDL real, não da documentação — os arquivos estão em
`test/fixtures/wsdl/` e os testes montam um cliente a partir deles, sem rede.

```
ECMDatasetService   (ns http://ws.dataservice.ecm.technology.totvs.com/)
  findAllFormulariesDatasets(companyId:long, username, password)
  addDataset   (companyId:int, username, password, name, description, impl)
  updateDataset(companyId:int, username, password, name, description, impl)

ECMCardIndexService (ns http://ws.dm.ecm.technology.totvs.com/)
  getCardIndexesWithoutApprover(username, password, companyId:int, colleagueId)
  createSimpleCardIndexWithDatasetPersisteType(
    username, password, companyId, parentDocumentId, publisherId,
    documentDescription, cardDescription, datasetName,
    Attachments, customEvents, persistenceType)
  updateSimpleCardIndexWithDatasetAndGeneralInfo(
    username, password, companyId, documentId, publisherId,
    cardDescription, descriptionField, datasetName,
    Attachments, customEvents, generalInfo)
```

Note a ordem dos parâmetros invertida entre os dois serviços, o part
`Attachments` com A maiúsculo enquanto todos os outros são minúsculos, e
`fileSize` — o único campo obrigatório do anexo, em bytes crus.

Duas armadilhas que só o WSDL revela e que o código trata:

- o `soap:address` publicado aponta para o host que gerou o WSDL, então o
  endpoint é **sempre** sobrescrito para o servidor alvo — sem isso, um push
  destinado a um servidor chegaria em outro;
- um `*Array` com um único `<item>` volta como objeto, não como array.

## Testes

```sh
npm test        # 68 testes, sem rede e sem servidor Fluig
npm run typecheck
```

Os testes sobem um Fluig de mentira em `127.0.0.1`, servem o WSDL de fixture e
conferem o XML SOAP enviado — inclusive a ordem dos parâmetros, que em
RPC/literal é normativa.

**Sem cobertura offline**, e assumido como tal:

- se `addDataset` num nome já existente duplica ou sobrescreve;
- se `updateDataset` apaga a `description` atual quando não a informamos —
  hoje mandamos o nome do dataset por falta de fonte melhor, e isso é
  potencialmente destrutivo;
- **a polaridade de `persistenceType`**: a documentação SOAP diz
  `0 = Formulário, 1 = Lista` e o swagger REST diz o inverso. Seguimos a SOAP,
  numa constante única em `push-form.ts`. Errar aqui não tem conserto por
  update;
- se `fileName` com `/` (asset em subpasta) é aceito pelo servidor;
- a mudança de autenticação do Fluig 1.8.2.

Todos se fecham com uma sessão em homologação e um formulário descartável.
