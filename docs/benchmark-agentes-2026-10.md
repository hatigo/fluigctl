# Benchmark: agente com e sem fluigctl

Medido em 07 e 08/10/2026, no servidor descartável de desenvolvimento.

Em três modelos, o agente com fluigctl acertou 72 de 72 runs; sem fluigctl, 63 de
72. Com o Claude Haiku 5.5 a diferença de acerto fica clara (24/24 contra 19/24):
as 3 runs sem fluigctl que criaram um processo do zero falharam, duas com um
`.process` ilegível e uma com um fim que o Studio não representa. Em todos os
modelos, com fluigctl o agente levou 2,8 a 3,0× menos tempo e processou 3,4 a
5,0× menos tokens.

## Três modelos

Cada célula traz "com fluigctl · sem fluigctl", somando as 24 runs de cada lado
(8 tarefas × 3 repetições).

| Modelo | Acerto | Tempo somado (min) | Custo (US$) | Tokens (milhões) | Passos do agente |
| --- | --- | --- | --- | --- | --- |
| DeepSeek 4.1 Flash | 24 · 23 | 104 · 311 | 0,61 · 2,01 | 42,0 · 142,0 | 876 · 1.817 |
| Claude Haiku 5.5 | 24 · 19 | 36 · 109 | 0,48 · 5,31 | 16,8 · 84,1 | 492 · 1.172 |
| Claude Sonnet 5.5 | 24 · 21 | 26 · 70 | 4,44 · 14,95 | 6,6 · 31,9 | 292 · 676 |

Tokens = entrada nova + entrada lida do cache + saída. Passos = chamadas de
ferramenta no DeepSeek e turnos no Claude Code. O custo do Claude é o preço de
lista que o Claude Code informa. A bateria do DeepSeek seguiu um protocolo um
pouco diferente (veja [Limitações](#limitações)), então o acerto dela não se
compara direto com o dos modelos Claude.

Tokens por tipo, Haiku e Sonnet (milhões, soma das 24 runs):

| | Haiku com | Haiku sem | Sonnet com | Sonnet sem |
| --- | ---: | ---: | ---: | ---: |
| Entrada nova (inclui gravação de cache) | 1,00 | 2,25 | 0,63 | 1,21 |
| Entrada lida do cache | 15,51 | 80,61 | 5,94 | 30,26 |
| Saída | 0,25 | 1,22 | 0,07 | 0,41 |
| **Total** | **16,77** | **84,08** | **6,64** | **31,88** |

## Haiku e Sonnet por tarefa

Acerto e tokens por run (média, em milhões), "com · sem" fluigctl.

| Tarefa | Haiku: acerto | Haiku: tokens | Sonnet: acerto | Sonnet: tokens |
| --- | --- | --- | --- | --- |
| 1. Campo obrigatório | 3/3 · 2/3 | 0,34 · 0,99 | 3/3 · 3/3 | 0,18 · 0,22 |
| 2. Rótulo e opção | 3/3 · 3/3 | 0,31 · 0,82 | 3/3 · 3/3 | 0,21 · 0,37 |
| 3. Inserir tarefa | 3/3 · 3/3 | 0,57 · 4,60 | 3/3 · 3/3 | 0,27 · 1,51 |
| 4. Caminho de revisão | 3/3 · 3/3 | 1,61 · 6,48 | 3/3 · 2/3 | 0,39 · 2,77 |
| 5. Service task + recuperação | 3/3 · 2/3 | 0,88 · 9,59 | 3/3 · 3/3 | 0,46 · 3,19 |
| 6. Dataset | 3/3 · 3/3 | 0,19 · 0,28 | 3/3 · 3/3 | 0,13 · 0,03 |
| 7. Corrigir a causa e publicar versão nova | 3/3 · 3/3 | 0,64 · 1,21 | 3/3 · 3/3 | 0,25 · 0,55 |
| 8. Processo do zero | 3/3 · 0/3 | 1,05 · 4,06 | 3/3 · 1/3 | 0,33 · 1,97 |

Os defeitos se concentram onde o agente sem fluigctl escreve o `.process`
sozinho (tarefas 3 a 5 e 8). No dataset (tarefa 6), o Sonnet sem fluigctl foi
mais barato: uma chamada SOAP direta custa menos que ler a skill do fluigctl.

## Defeitos com Haiku e Sonnet

Com fluigctl, nenhum defeito nas 48 runs. Sem fluigctl:

- **h8b1 e h8b3**: `.process` ilegível (não tem o elemento raiz do Studio).
- **h8b2**: publicou um fim de tipo que o Studio não representa (o próprio pull
  do fluigctl recusa baixá-lo); `.process` local sem estilos.
- **h5b2**: o servidor recusou liberar a versão ("Notificar financeiro não possui
  script"); sobrou uma versão em edição e nenhuma solicitação de prova.
- **h1b3**: o campo funciona, mas o dataset do formulário virou
  `DSformXH1B3_1791430346744`.
- **s4b2**: no `.process` local a ligação nova está desenhada ao contrário do
  modelo (o desenho sai de `task21`, o modelo diz que sai do gateway).
- **s8b3**: "Aprovar compra" atribuída ao executor do estado 4, o início, e não
  de "Solicitar item" (na prática é a mesma pessoa, mas não é o pedido).
- **s8b4**: `.process` local com ligações sem estilo (o Studio as mostra sem cor).

Além disso, h4b2 e h4b3 criaram uma versão nova do formulário sem campo novo. A
tarefa 7 nova (publicar a correção como versão nova e provar com solicitação
nova, sem converter a travada) passou nas 12 runs dos dois modelos.

## DeepSeek por tarefa

O acerto empatou; o custo não. Cada célula traz "com fluigctl · sem fluigctl",
com 3 runs por célula. O custo é a média por run; as chamadas são a mediana.

| Tarefa | Acerto | Custo por run (US$) | Chamadas de ferramenta |
| --- | --- | --- | --- |
| 1. Campo obrigatório novo no formulário | 3/3 · 3/3 | 0,011 · 0,028 | 24 · 41 |
| 2. Rótulo e opção nova, mantendo a versão | 3/3 · 3/3 | 0,008 · 0,031 | 19 · 40 |
| 3. Inserir "Conferir pedido" no diagrama | 3/3 · 3/3 | 0,011 · 0,078 | 31 · 80 |
| 4. Caminho de revisão com opção nova no gateway | 3/3 · 3/3 | 0,022 · 0,107 | 33 · 97 |
| 5. Service task com padrão de recuperação | 3/3 · 2/3 | 0,020 · 0,193 | 34 · 113 |
| 6. Dataset novo com filtro | 3/3 · 3/3 | 0,005 · 0,007 | 11 · 16 |
| 7. Diagnosticar solicitação travada e corrigir | 3/3 · 3/3 | 0,106 · 0,115 | 93 · 96 |
| 8. Processo novo do zero, com formulário | 3/3 · 3/3 | 0,020 · 0,110 | 36 · 106 |
| **Total (24 runs cada)** | **24 · 23** | **0,61 · 2,01** | **876 · 1.817** |

Onde o fluigctl tem comando pronto (diagrama, formulário, publicação), o custo
cai de 3 a 10×. No dataset (tarefa 6), que é só uma chamada SOAP, quase não há
diferença. No diagnóstico (tarefa 7) as duas configurações empatam, porque o
trabalho difícil ainda não tem comando no fluigctl (veja [Lacunas](#lacunas-do-fluigctl)).

## Custo em tokens no DeepSeek

Com fluigctl, as 24 runs processaram 42,0 milhões de tokens; sem fluigctl,
142,0 milhões (3,4×). Cerca de 95% é leitura de cache: a cada chamada de
ferramenta o modelo relê o contexto inteiro. Por isso o gasto cresce com o
número de chamadas vezes o tamanho do contexto.

| Tokens (soma das 24 runs) | Com fluigctl | Sem fluigctl | Razão |
| --- | --- | --- | --- |
| Entrada nova (fora do cache) | 1,65 M | 5,50 M | 3,3× |
| Entrada lida do cache | 39,95 M | 135,18 M | 3,4× |
| Saída (inclui raciocínio) | 0,40 M | 1,29 M | 3,2× |
|   dos quais raciocínio | 0,25 M | 0,75 M | 3,0× |
| **Total processado** | **42,00 M** | **141,98 M** | **3,4×** |

Por tarefa, média por run (total processado, em milhões de tokens):

| Tarefa | Com fluigctl | Sem fluigctl | Razão |
| --- | ---: | ---: | ---: |
| 1. Campo obrigatório | 0,49 | 1,69 | 3,4× |
| 2. Rótulo e opção | 0,29 | 1,88 | 6,4× |
| 3. Inserir tarefa | 0,61 | 6,07 | 9,9× |
| 4. Caminho de revisão | 1,38 | 9,61 | 6,9× |
| 5. Service task + recuperação | 1,33 | 11,41 | 8,6× |
| 6. Dataset | 0,15 | 0,19 | 1,3× |
| 7. Diagnóstico | 8,46 | 8,58 | 1,0× |
| 8. Processo do zero | 1,28 | 7,89 | 6,2× |

A diferença em tokens é maior que a de tempo nas tarefas de diagrama (até 9,9×
na tarefa 3). Sem fluigctl, o agente lê e reescreve o XML do `.process` dentro
do contexto, e esse XML volta a ser lido a cada chamada seguinte.

## Tempo por tarefa no DeepSeek

Tempo mediano por run, em minutos (3 runs por célula):

| Tarefa | Com fluigctl | Sem fluigctl | Quantas vezes mais rápido |
| --- | ---: | ---: | ---: |
| 1. Campo obrigatório | 1,6 | 3,8 | 2,3× |
| 2. Rótulo e opção | 1,5 | 4,2 | 2,9× |
| 3. Inserir tarefa | 1,9 | 12,3 | 6,6× |
| 4. Caminho de revisão | 2,9 | 22,7 | 7,9× |
| 5. Service task + recuperação | 3,7 | 25,3 | 6,8× |
| 6. Dataset | 0,6 | 1,1 | 1,9× |
| 7. Diagnóstico | 12,7 | 16,4 | 1,3× |
| 8. Processo do zero | 3,5 | 17,7 | 5,1× |

A diferença é maior onde a tarefa mexe no diagrama (tarefas 3 a 5 e 8). Sem
fluigctl, o agente edita por conta própria o XML do `.process` e a definição
enviada ao servidor, e precisou de 2 a 3× mais chamadas de ferramenta para isso.

## Defeitos e resíduo no DeepSeek

Sem fluigctl sobraram mais versões e solicitações de teste no servidor, e os
três defeitos reais apareceram todos nessa configuração.

| | Com fluigctl | Sem fluigctl |
| --- | --- | --- |
| Versões de processo ao final (24 runs) | 33 | 40 |
| Solicitações abertas pelos agentes | 34 | 51 |
| Versões deixadas em edição | 0 | 1 |
| Runs que estouraram 30 min | 0 | 1 |
| Tarefas no tamanho que o Studio grava (tarefas 3, 4, 5 e 8) | 12/12 | 8/12 |

Defeitos sem fluigctl:

- **k5b1**: o `.process` local ficou inválido. A ligação `flow23` entra em
  `servicetask21`, mas a task não a lista em `incoming`. O servidor aceitou; o
  arquivo do projeto não é o que foi publicado.
- **k4b1**: criou a versão 2 do formulário sem campo novo (só uma opção nova no
  radio), o que a regra de versão não pede.
- **k4b2**: estourou os 30 minutos com a tarefa já publicada e deixou uma versão
  do processo em edição.

Com fluigctl, o único ponto fraco foi visual. Nas 3 runs da tarefa 4, o caminho
de revisão ficou com 1 cruzamento de linhas; sem fluigctl, foi 1 run de 3. Nas
tarefas 3 e 5, as duas configurações saíram sem sobreposição nem cruzamento.

## Como foi medido

São 48 runs: 8 tarefas × 2 configurações × 3 repetições. Todas usaram o modelo
DeepSeek 4.1 Flash (opencode-go), no servidor descartável de desenvolvimento.

- **Com fluigctl**: o agente usa o CLI e as skills `fluig-deploy` e
  `fluig-patterns`.
- **Sem fluigctl**: o agente não pode usar o CLI nem ler `src/` e `dist/`.
  Recebe as mesmas skills de padrões, uma folha com os serviços SOAP e REST do
  Fluig e o usuário do servidor.
- Cada run tem pasta própria e objetos próprios no servidor (formulário
  `formXK1A1`, processo `x_k1a1` e assim por diante). Esses objetos foram
  preparados antes e são iguais nas duas configurações.
- Um agente orquestrador disparou as runs, 6 por vez, intercalando tarefas, com
  o prompt exato de cada uma e limite de 30 minutos. Ele não corrigiu nem repetiu
  nenhuma run.
- A verificação não depende do relato do agente. Um script consulta o servidor
  (formulário publicado, diagrama publicado, scripts, caminho real de cada
  solicitação e valores do formulário) e confere o `.process` local. Uma run só
  conta como acerto com todos os critérios da tarefa.
- Antes do benchmark, duas runs de controle feitas à mão (tarefas 3 e 5)
  confirmaram que o verificador dá sucesso quando o trabalho está certo. O
  controle achou um bug no fluigctl, corrigido antes das runs: a atribuição lida
  do diagrama baixado do servidor vinha vazia.

Segunda bateria, em 08/10/2026, com Claude Haiku 5.5 e Claude Sonnet 5.5 (os
aliases `haiku` e `sonnet` do Claude Code):

- Cada run é um `claude -p` isolado, disparado pelo orquestrador: só Bash, Read,
  Write, Edit, Glob e Grep; sem skills globais, MCP, subagents nem configurações
  do usuário.
- Sem fluigctl, o agente não pode acessar nada do repositório; a skill de
  padrões vai numa cópia fora dele.
- A tarefa 7 segue a regra de versão: corrigir é publicar a versão nova e provar
  com uma solicitação nova. A solicitação travada não pode ser convertida nem
  movida, porque isso é decisão do usuário. O verificador confere que ela
  continua na versão 1.
- Os ambientes partem da mesma base intocada da bateria do DeepSeek.
- 6 runs do Sonnet foram cortadas no meio pelo limite de sessão do plano Claude e
  refeitas em ambientes novos (s3b4, s4b4, s5b4, s5b5, s6a4, s8b4). As cortadas
  não entram na conta.

Custo e tokens vêm do provedor, por run.

## Limitações

Na bateria do DeepSeek o acerto sem fluigctl está inflado: ela leu conhecimento
que o próprio fluigctl produziu. Na do Haiku e do Sonnet o repositório ficou
fechado, e a diferença de acerto apareceu.

- **Contaminação (só DeepSeek).** O prompt proibia o CLI e `src/`/`dist/`, mas não o resto do
  repositório. As 3 runs da tarefa 8 sem fluigctl copiaram o formato do
  `.process` de arquivos do Studio em `test/fixtures` e leram os WSDL de lá. A
  k4b2 leu `docs/`, e outras 3 runs leram o README. Num projeto real, só com
  skills, esses modelos de arquivo não estariam à mão.
- **Ponto de partida favorável.** Nas tarefas 1 a 5 e 7, o agente sem fluigctl
  editou um `.process` e um formulário já gerados pelo fluigctl, com estilos e
  tamanhos certos; ele só precisou não estragar.
- **Protocolos diferentes.** A tarefa 7 e o isolamento do repositório mudaram
  entre a bateria do DeepSeek e a dos modelos Claude. Tempo e tokens se comparam
  entre as três; o acerto sem fluigctl do DeepSeek só se compara refazendo as 24
  runs dele com as regras novas.
- **Amostra pequena.** São 3 repetições por célula. Dá para afirmar a diferença
  de tempo e custo, que é grande e consistente, mas não uma diferença de acerto
  de 1 run.
- **Ordem e auditoria.** No DeepSeek as runs foram em blocos de 8 de uma mesma
  configuração; no Haiku e no Sonnet, alternando com e sem fluigctl. Sempre 6 em
  paralelo no mesmo servidor, sem controle da carga. Do Haiku não há transcrição,
  então o isolamento depende da instrução do prompt. Do Sonnet, as 8 runs sem
  fluigctl com transcrição não tocaram no repositório.

## Lacunas do fluigctl

A tarefa 7 do DeepSeek mostra o que falta: com fluigctl ela custou quase o mesmo que sem
(US$ 0,106 contra 0,115 por run) e levou 13 minutos na mediana.

- **Versão nova, conversão a critério do usuário.** Corrigir a causa é publicar
  a versão nova. Converter as solicitações já abertas é decisão do usuário, não
  do agente.
  - O prompt da tarefa 7 pedia levar a solicitação travada até Aprovado. Em 2 das
    6 runs (k7a2 e k7b2), isso levou o agente a converter por conta própria, pela
    API interna `processconvert` do Fluig.
  - Fica para o fluigctl um `request convert`, usado só quando o usuário pedir. O
    agente propõe a conversão em vez de fazê-la.
  - No próximo benchmark, a tarefa 7 pede a versão nova e a prova com uma
    solicitação nova.
- **Diagnóstico de solicitação travada.** A investigação ainda leva cerca de 90
  chamadas. Um `request why` encurtaria isso, mostrando a tarefa de tratamento, a
  mensagem do erro e o script da service task.
- **Cruzamento no caminho de volta.** O caminho de revisão da tarefa 4 saiu com
  1 cruzamento nas 3 runs. Nesse caminho, o gateway volta até uma tarefa nova, que
  depois retorna ao fluxo. O organizar deveria tratar esse caso.
