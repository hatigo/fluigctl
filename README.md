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
| `push widget` | pronto (widgets sem Java) |

Fora de escopo por enquanto: `pull`, layout WCM, widget com código Java,
evento global e mecanismo de atribuição.

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

fluigctl push form forms/formSolicitacaoCompras --server cetenco-hml --keep-version --dry-run
fluigctl push form forms/formSolicitacaoCompras --server cetenco-hml --keep-version
fluigctl push form forms/formSolicitacaoCompras --server cetenco-hml --new-version
fluigctl push form forms/formNovo --server cetenco-hml \
  --create --parent-id 5 --dataset-name dsformNovo --persistence-type form

fluigctl push widget wcm/widget/wdgAniversariantes --server cetenco-hml --dry-run
fluigctl push widget wcm/widget/wdgAniversariantes --server cetenco-hml
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

`~/.config/fluigctl/servers.json` nunca contém senha. Guarda host, porta,
usuário, `companyId`, `userCode` e o **nome** da variável que a contém,
derivado do nome do servidor (`cetenco-prod` → `FLUIG_CETENCO_PROD_PASSWORD`).
O arquivo pode ser lido, versionado e inspecionado sem expor credencial.

A senha vem, nesta ordem:

1. a variável de ambiente;
2. `~/.config/fluigctl/env`, no formato de shell, se a variável não estiver
   definida.

```sh
# ~/.config/fluigctl/env   (chmod 600)
export FLUIG_CETENCO_HML_PASSWORD='...'
export FLUIG_CETENCO_PROD_PASSWORD='...'
```

O arquivo existe porque exportar a variável a cada sessão não funciona para
processos não interativos — um shell zsh não interativo lê `.zshenv`, não
`.zshrc`. Quem lê o arquivo é sempre o CLI. O `fluigctl` avisa se ele estiver
acessível a outros usuários.

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

### Versão

Atualizar um formulário **exige** escolher, e a recusa acontece antes de
qualquer chamada de rede:

| flag | efeito |
|---|---|
| `--keep-version` | sobrescreve a versão ativa no lugar |
| `--new-version` | cria a próxima versão; a anterior continua legível |

Não há default. Sobrescrever a versão ativa é irreversível, e isso não pode
ser o que acontece quando ninguém disse nada — o `fluigctl` roda tanto na sua
mão quanto na de um agente, e o silêncio de um script não é consentimento.

`--create` não aceita essas flags: `versionOption` não existe na operação de
criação.

Medido no servidor: as versões andam de mil em mil (1000 → 2000 → 3000) e o
conteúdo antigo continua acessível por `getCardIndexContent`, então
`--new-version` dá rollback de verdade.

Vão como anexo todos os arquivos da pasta, com o caminho relativo preservado,
**exceto** `events/` (que vira `customEvents`, em texto puro), o `.metadata` do
Eclipse e dotfiles. O arquivo principal é o `.html` único da raiz, ou o que
tiver o nome da pasta, ou o que você indicar em `--principal`.

Rodado contra as 657 pastas de formulário reais dos 12 workspaces: 646 lidas
sem erro, 11 recusadas com motivo — 8 sem `.html` nenhum e 3 com dois `.html`
sem desempate. Nenhuma publicaria o `.metadata` junto.

## Publicando um widget

`push widget` recebe a pasta da widget (`wcm/widget/<nome>`), monta o `.war` em
memória — sem Maven — e envia pelo mesmo endpoint da extensão Fluiggers,
`/portal/api/rest/wcmservice/rest/product/uploadfile`, com a sessão do portal.
O nome da widget é o nome da pasta. Não há `--create`: o servidor instala se a
widget não existe e atualiza se existe.

O pacote segue o mapeamento da extensão, sem compressão:

| origem | no `.war` |
|---|---|
| `src/main/webapp/WEB-INF/*.xml` | `WEB-INF/` |
| `src/main/resources/*.*` | `WEB-INF/classes/` |
| `src/main/webapp/resources/**` | `resources/`, com as subpastas |

Diferenças de propósito em relação à extensão:

- todos os arquivos vão em bytes crus — a extensão lê `src/main/resources`
  como UTF-8 e corrompe `.properties` gravado em latin1;
- `.metadata` e dotfiles ficam de fora, como no `push form`;
- pasta sem `src/main/webapp/WEB-INF` ou sem
  `src/main/resources/application.info` é recusada com código 3;
- widget com arquivo em `src/main/java` é recusada com código 6, antes de
  qualquer chamada de rede: as classes precisam do build do Maven, e o
  `fluigctl` não compila Java. Publique essas pelo Fluig Studio ou Maven.

`--dry-run` monta o pacote e mostra nome, número de arquivos, tamanho e a URL
de destino, sem abrir sessão nem enviar nada.

**A instalação é assíncrona.** Uma resposta de sucesso quer dizer que o servidor
aceitou o `.war`; a widget é instalada ou atualizada em segundo plano, e o
`fluigctl` não espera por isso. Uma resposta com `message` é erro do servidor e
sai com código 7.

Rodado (só o empacotamento) contra as 160 entradas de `wcm/widget/` dos
workspaces: 147 empacotadas, todas aprovadas por `unzip -t`; 7 recusadas por
terem Java; 6 recusadas por não serem pasta de widget (dois `.zip`, um `.txt`,
duas pastas só com `target/` e uma sem `WEB-INF`).

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
npm test        # 206 testes, sem rede e sem servidor Fluig
npm run typecheck
```

Os testes sobem um Fluig de mentira em `127.0.0.1`, servem o WSDL de fixture e
conferem o XML SOAP enviado — inclusive a ordem dos parâmetros, que em
RPC/literal é normativa.

### O que foi medido no servidor

As perguntas abaixo estavam em aberto e foram respondidas contra o homolog da
CETENCO (Fluig 1.8, `4.201.225.233:8021`), criando artefatos descartáveis:

| Pergunta | Resposta medida |
|---|---|
| `addDataset` num nome existente duplica? | Não. O servidor recusa com `DuplicatedDatasetException` e nada muda. |
| `updateDataset` apaga a `description`? | **Sim.** Grava o que receber. Por isso o update lê a descrição atual antes de enviar. |
| `persistenceType`: 0 é Formulário ou Lista? | **0 = Formulário, 1 = Lista** — a documentação SOAP está certa, o swagger REST está invertido. Verificado por `metaListId`: 0 com `form`, 86 com `list`. |
| `fileName` com `/` funciona? | **Não.** O servidor responde "O sistema não pode encontrar o caminho especificado". O push agora recusa antes de enviar. |
| `versionOption` "0" e "2" | "0" mantém a versão, "2" cria a próxima. A numeração anda de mil em mil (1000 → 2000), não de um em um. |
| O `ping` devolve texto? | Neste servidor devolve `{"response":"pong"}` em JSON. Os dois formatos são aceitos. |
| O HTML principal precisa de algo? | Sim, uma tag `<form>`. Sem ela o servidor recusa. O push checa antes. |

**Continua sem cobertura:** a mudança de autenticação do Fluig 1.8.2 em
servidores que a tenham, e o comportamento em versões diferentes de 1.8.
