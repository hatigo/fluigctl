# fluigctl

Publica artefatos de um repositório TOTVS Fluig — datasets, formulários,
widgets e os scripts de um processo — num servidor Fluig, pela linha de
comando. Faz o que o **Exportar** do Fluig Studio e da extensão Fluiggers do VS
Code fazem, sem IDE e sem clique, e serve igual para você no terminal e para um
agente (Claude Code, CI) via script.

## Por que usar

Publicar no Fluig é sobrescrever: o servidor grava o que receber, sem perguntar.
Os caminhos de sempre deixam fácil errar o alvo, apagar o que é do cliente ou
subir em produção sem querer. O `fluigctl` existe para que publicar seja
repetível e difícil de errar:

- **Não publica no lugar errado.** O formulário é resolvido pelo `--document-id`,
  pelo `.metadata` do Studio e só então pelo nome da pasta — e para quando há
  dúvida, listando os candidatos. O nome da pasta engana: no HML da Cetenco,
  `forms/formReembolso` é o formulário 902, e o que se chama "formReembolso" (676)
  é outro.
- **Não apaga o que é do servidor.** Num update mantém a descrição do dataset e o
  nome e o campo descritor do formulário, que o web service sobrescreveria.
- **Simula antes e prova depois.** Todo push tem `--dry-run`, que mostra o alvo e
  o que vai. No dataset, guarda uma cópia do código anterior e confere que o
  servidor devolve o código local.
- **Produção é humana.** Servidor marcado como produção exige a senha digitada
  num terminal de verdade. Um agente ou um script não consegue — por construção,
  não por convenção.
- **A senha não passa por quem chama.** Vem da variável de ambiente, de um
  arquivo próprio com permissão 600 ou do `.vscode/servers.json` da extensão,
  decifrado pela chave desta máquina. Nunca é impressa, e o `servers.json` é
  mantido no `.gitignore`.
- **Barato para um agente.** Comandos curtos e saídas de uma linha.

### Comparado com os outros caminhos

Medido em 02/10/2026 contra o HML da Cetenco, publicando o mesmo dataset e o
mesmo formulário por cada caminho (tokens: o que o agente precisa ler + o que
cada comando custa):

| | fluigctl | skill publicar-fluig | skill fluig-artefatos (curl) | Studio / Fluiggers |
|---|---|---|---|---|
| Uso por agente | sim | sim | sim, montando SOAP na mão | não (interface gráfica) |
| Tokens para 1 dataset + 1 formulário | ~1.900 | ~4.000 | ~12.000 (estimado) | — |
| Publicar dataset | 1,4 s | 1,0 s | — | — |
| Publicar formulário | 2,3 s | 2,4 s | — | — |
| Formulário sem `--document-id`, pasta `formReembolso` | 902 (certo, pelo `.metadata`) | 676 (errado, sem aviso) | o agente escolhe | pergunta |
| Mantém nome e descritor do formulário | sim | sim | depende do agente | sim |
| Produção a partir de um agente | bloqueada (exige TTY) | flags que o agente escreve | variável que o agente define | — |
| Cópia antes / conferência depois | dataset | não | checklist manual | não |
| Testes automatizados | 283 | não | não | — |

Fica para o Studio: criar processo novo, o diagrama (aqui só `--dry-run`, ou o
import com `push process --base`), widget com código Java, evento global,
mecanismo de atribuição e layout.

## Estado

| | |
|---|---|
| `server add` / `ls` / `rm` / `test` / `set-prod` | pronto |
| `server import` (servidores da extensão Fluiggers, e as senhas com `--with-passwords`) | pronto |
| `changed` (o que mudou no git, como comandos) | pronto |
| `push dataset` | pronto |
| `push form` | pronto |
| `push widget` | pronto (widgets sem Java) |
| `push process` (scripts de um processo que já existe; `--base` para importar uma definição) | pronto |
| `push diagram` | só `--dry-run`, fase 1 |

Fora de escopo por enquanto: `pull`, layout WCM, widget com código Java,
evento global e mecanismo de atribuição.

## Instalação

```sh
npm install && npm run build
npm link            # deixa `fluigctl` no PATH
```

Node 22.2 ou mais novo.

## Como usar

### 1. Cadastrar os servidores, uma vez

Se você já usa a extensão Fluiggers, traga os servidores e as senhas dela:

```sh
fluigctl server import ~/fluig/workspaces --with-passwords           # mostra o que faria
fluigctl server import ~/fluig/workspaces --write --with-passwords   # grava
fluigctl server ls
fluigctl server test cetenco-hml
```

Confira a marca de produção que o import listar (`fluigctl server set-prod <nome>`
corrige). Sem a extensão, cadastre à mão e ponha a senha no arquivo próprio:

```sh
fluigctl server add cetenco-hml --host homolog.cetenco.com.br --port 8021 --user integracao.fluig
echo "export FLUIG_CETENCO_HML_PASSWORD='...'" >> ~/.config/fluigctl/env && chmod 600 ~/.config/fluigctl/env
```

`server add` descobre `companyId` e `userCode` sozinho, consultando o servidor.

### 2. No dia a dia: ver o que mudou, simular, publicar

Rode na raiz do repositório Fluig:

```sh
fluigctl changed --server cetenco-hml
```

Para cada artefato alterado, ele imprime o comando com `--dry-run`. Rode a
simulação, leia os `aviso:` e o alvo, e repita sem `--dry-run`:

```sh
fluigctl push dataset datasets/reembolso/dsFoo.js --server cetenco-hml --dry-run
fluigctl push dataset datasets/reembolso/dsFoo.js --server cetenco-hml

fluigctl push form forms/formReembolso/ --server cetenco-hml --keep-version --dry-run
fluigctl push form forms/formReembolso/ --server cetenco-hml --keep-version

fluigctl push process reembolso --server cetenco-hml --dry-run
fluigctl push widget wcm/widget/wdgAniversariantes --server cetenco-hml --dry-run
```

Formulário exige escolher a versão: `--keep-version` sobrescreve a ativa (só
mudou JS, CSS, texto), `--new-version` cria a próxima (ganhou campo — o servidor
recusa campo novo com `--keep-version`). Na dúvida sobre o alvo, passe
`--document-id`.

Criar artefato novo é sempre explícito:

```sh
fluigctl push dataset datasets/dsNovo.js --server cetenco-hml --create --description "Novo"
fluigctl push form forms/formNovo --server cetenco-hml \
  --create --parent-id 5 --dataset-name dsformNovo --persistence-type form
```

### 3. Produção

O mesmo comando, num terminal seu: o `fluigctl` pede a senha antes de enviar.
Um agente não sobe em produção — ele te entrega o comando.

## Importando servidores da extensão

```sh
fluigctl server import ~/fluig/workspaces                                  # mostra o que faria
fluigctl server import ~/fluig/workspaces --write                          # grava os servidores
fluigctl server import ~/fluig/workspaces --write --with-passwords         # e copia as senhas
```

Traz os servidores dos `.vscode/servers.json` da extensão Fluiggers.
Deduplica pelo que identifica um servidor — host, porta, ssl e usuário —
porque o mesmo Fluig costuma aparecer em vários projetos com nomes diferentes.

Com `--with-passwords`, decifra a senha de cada servidor (ver "Segredos") e a
copia para `~/.config/fluigctl/env`, sem imprimi-la. Sem `--write`, só lista o
que copiaria. Em qualquer caso, confere o git de cada repositório onde achou um
`servers.json`: com `--write`, acrescenta `.vscode/servers.json` ao `.gitignore`
que não o tiver; se o arquivo já estiver **versionado**, avisa — ignorar não o
tira do histórico.

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
   definida;
3. o `.vscode/servers.json` da extensão Fluiggers, procurado da pasta atual
   para cima, no servidor de mesmo host, porta, ssl e usuário.

A extensão grava a senha em AES-256-CBC com chave derivada (scrypt) do
`telemetry.machineId` do VS Code — o do `storage.json` do perfil (VS Code,
Insiders, Cursor ou VSCodium). O `fluigctl` decifra com a chave desta máquina;
senha cifrada noutra máquina não abre, e o servidor é pulado. Ao usar essa
fonte, ele diz de qual arquivo leu, acrescenta `.vscode/servers.json` ao
`.gitignore` do repositório e sugere copiar a senha para o arquivo próprio com
`server import --with-passwords`. `FLUIGCTL_NO_VSCODE=1` desliga a fonte 3.

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
3. o `.metadata` do Fluig Studio na pasta — a lista das exportações já feitas,
   cada uma com o documentId. Vale a exportação cujo documentId existe neste
   servidor **e** é o mesmo formulário (mesmo dataset ou mesma descrição): os
   ids não valem de um ambiente para outro. Sobrando mais de uma, desempata o
   servidor da última exportação; sem desempate, para e lista
4. o nome da pasta contra `documentDescription`

O passo 3 existe porque o nome da pasta engana: no HML da Cetenco,
`forms/formReembolso` é o 902 ("formSolicitacaoReembolso"), e o 676, que se
chama "formReembolso", é outro formulário — o push por nome publicou nele.

Num update, o **nome** e o **campo descritor** do formulário ficam os que estão
no servidor. O web service grava o que receber, e mandar o nome da pasta e o
descritor vazio renomeava o formulário e apagava o descritor (o 392 do HML usa
`nomeFantasia`). Mude-os só de propósito, com `--description` e
`--description-field`. O dry-run mostra o nome e o descritor que vão.

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

## Publicando um dataset

Num update, antes de escrever, o `fluigctl` lê do servidor o código e a
descrição atuais (`loadDataset`):

- a descrição é preservada, a menos que venha `--description`;
- o dry-run diz se o servidor já tem exatamente este código;
- o código que estava lá é copiado para
  `~/.local/state/fluigctl/backups/<host>/datasets/<nome>.<data>.js`
  (`$XDG_STATE_HOME` se definido) — é o rollback;
- depois do envio, lê de novo e confere que o servidor devolve o código local.
  Se não devolver, sai com código 7 e aponta a cópia.

## O que mudou no git

```sh
fluigctl changed --server cetenco-hml                # working tree
fluigctl changed --since main --server cetenco-hml   # desde um commit ou branch
```

Traduz os arquivos alterados em artefatos (dataset, formulário, scripts de
processo, widget) e imprime o comando de **cada um**, com `--dry-run`. Não envia
nada: publicar em lote é como se sobrescreve, sem querer, o que outra pessoa
mudou no servidor. Para formulário, compara os `name="..."` do HTML com a
versão anterior e sugere `--new-version` quando há campo novo. Diagrama, evento
global, mecanismo e layout aparecem com o motivo de não serem publicados aqui.

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

## Convertendo um diagrama

```sh
fluigctl push diagram workflow/diagrams/meuProcesso.process --server cetenco-hml \
  --dry-run --save-xml /tmp/meuProcesso.xml
```

Converte o `.process` no XML que o servidor importa (o formato do
`.ecm30.xml` do Studio), sem rede e sem senha: do servidor só se usa o
`companyId` do cadastro. Nada é publicado ainda — sem `--dry-run` o comando sai
com código 2. `cardIndex` numérico vira o `formId`; um nome fica 0, com aviso.

Por enquanto cobre pool, lane, início, tarefas de usuário e de serviço,
gateways exclusivo/paralelo/join com condições, eventos intermediários
(temporizador, condicional, sinal, erro anexado), fim, anotação, fluxo de
sequência e bendpoints. Evento de link, subprocesso, campos descritores,
configuração de app, regras de anexo e atribuição não conferida são recusados
com código 6, listando o que falta — nunca sai XML parcial. Os scripts entram
no XML quando há `workflow/scripts/<processId>.*.js` ao lado de
`workflow/diagrams/`; sem a pasta, o comando avisa.

O plano, as fases e o que foi medido estão em `docs/plano-push-diagrama.md`.
`npm run diff-diagramas [raiz]` compara a conversão com os `.ecm30.xml` do Studio
de uma pasta de workspaces, sem escrever nela.

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
npm test        # 283 testes, sem rede e sem servidor Fluig
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
