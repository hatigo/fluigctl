# fluigctl

Sobe datasets e formulários para o TOTVS Fluig pela linha de comando — o que a
extensão Fluiggers do VS Code faz, sem precisar de IDE nem de clique em
QuickPick. O mesmo binário serve para você no terminal e para um agente via
script.

## Estado

| | |
|---|---|
| `server add` / `ls` / `rm` / `test` | pronto |
| `push dataset` | pronto |
| `server import` (lê `.vscode/servers.json` da Fluiggers) | a fazer |
| `push form` | a fazer |

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
```

`server add` descobre `companyId` e `userCode` sozinho, consultando o servidor.

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
```

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

**Sem cobertura offline**, e assumido como tal: se `addDataset` num nome já
existente duplica ou sobrescreve; se `updateDataset` apaga a `description`
atual quando não a informamos; e a mudança de autenticação do Fluig 1.8.2.
Fecham-se com uma sessão em homologação.
