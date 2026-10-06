#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  configPath,
  envFilePath,
  loadConfig,
  resolvePassword,
  resolveServer,
  saveConfig,
  serverUrl,
} from './config.js';
import { addServer, listServers, removeServer, setProd } from './commands/server.js';
import { serverUi } from './commands/server-ui.js';
import { checarDiagrama } from './diagram/check.js';
import { adicionarMembro, criarGrupo, listarGrupos, verGrupo } from './commands/group.js';
import { liberarVersao, versoesDoProcesso } from './commands/process-versions.js';
import { formatarTabela, lerRestricao, rodarDataset } from './commands/dataset-run.js';
import { abrirSolicitacao, aguardar, cancelarSolicitacao, formatarSolicitacao, lerCampo, lerSolicitacao, moverSolicitacao } from './commands/request.js';
import { estado as estadoDaSkill, instalarSkill, origensDasSkills, removerSkill } from './commands/skill.js';
import { pushDataset } from './commands/push-dataset.js';
import { pushDiagram } from './commands/push-diagram.js';
import { eventIdDoArquivo, pushEvent } from './commands/push-event.js';
import { pushForm } from './commands/push-form.js';
import { mecanismoIdDoArquivo, pushMechanism } from './commands/push-mechanism.js';
import { pushProcess } from './commands/push-process.js';
import { pushWcm } from './commands/push-wcm.js';
import {
  pullDataset,
  pullDiagram,
  pullEvent,
  pullForm,
  pullMechanism,
  pullProcess,
  pullWidget,
  listarWidgets,
  type ResultadoPull,
} from './commands/pull.js';
import { importCandidates, scanServersJson } from './import.js';
import { gravarNoEnv } from './env-file.js';
import { avisoGit, garantirIgnorado } from './gitignore.js';
import { machineIds, senhaNosArquivos } from './vscode-credentials.js';
import { changedArtifacts, comandoSugerido } from './commands/changed.js';
import { decideVersionOption } from './push/form-resolve.js';
import { promptPassword } from './prompt.js';
import { testServer } from './commands/server-test.js';
import { findUserByLogin, login } from './fluig/session.js';
import { ErroFluigctl } from './errors.js';
import { abrirVisualizador, diretorioDeEstado, executarServidor, fecharVisualizador } from './diagram/viewer.js';
import { aplicarEdicao } from './diagram/edit.js';
import { garantirFontes, textosSemFonte } from './diagram/fonts.js';

const USO = `fluigctl — sobe datasets, formulários, widgets e processos para o TOTVS Fluig, e baixa esses artefatos

  fluigctl server ls
  fluigctl server add <nome> --host H [--port P] [--ssl] --user U [--prod]
  fluigctl server rm <nome>
  fluigctl server import <dir> [--write] [--with-passwords]
      traz os servidores dos .vscode/servers.json da extensão Fluiggers; com --with-passwords,
      copia as senhas (decifradas com a chave desta máquina) para o arquivo de senhas do fluigctl
  fluigctl server set-prod <nome> [--off]
  fluigctl server test <nome>
  fluigctl server ui [--dir <pasta>]      (para gente: precisa de um terminal de verdade)
      tela no terminal para cadastrar, rever, testar, marcar produção e remover servidores,
      e para importar os da extensão Fluiggers

  fluigctl skill [ls | install [--copy] [--force] | uninstall]
      põe (ou tira) as skills que ensinam um agente a publicar com o fluigctl
      (fluig-deploy) e a escrever no padrão dos projetos (fluig-patterns);
      sem argumento, diz onde elas estão e onde daria para instalar

  fluigctl diagram open <arquivo.process> [--no-open] [--foreground]
      abre no navegador um visualizador local que acompanha mudanças no arquivo
  fluigctl diagram close <arquivo.process>
      encerra o visualizador desse arquivo

  fluigctl group ls --server <nome>
  fluigctl group show <grupo> --server <nome>
  fluigctl group add <grupo> --server <nome> [--description D] [--dry-run]
  fluigctl group add-member <grupo> <login> --server <nome> [--dry-run]
      grupos sem o painel do Fluig: listar, ver os membros, criar e pôr alguém

  fluigctl process versions <processId> --server <nome>
  fluigctl process release <processId> --server <nome> [--dry-run]
      as versões do processo (qual roda, quais ficaram em edição) e liberar a em edição

  fluigctl diagram check <arquivo.process> [--except <id>]... [--group <id>] [--json] [--fix]
      confere um .process editado fora do Studio: referências do Graphiti,
      fluxos x formas, textos sem fonte, elementos sem saída ou sem entrada, e o
      padrão de recuperação das service tasks; --fix acrescenta as fontes que faltam

  fluigctl dataset run <nome> --server <nome> [--where campo=valor]... [--fields a,b]
                              [--order a,b] [--limit N] [--json]
      roda o dataset no servidor e mostra as linhas; só lê. --where aceita
      campo=valor, campo!=valor, campo~valor (% é curinga) e campo=inicio..fim

  fluigctl request start <processId> --server <nome> [--field campo=valor]... [--comment C] [--wait] [--dry-run]
  fluigctl request show <número> --server <nome> [--form] [--wait] [--json]
  fluigctl request move <número> --to <estado> --server <nome> [--field campo=valor]... [--comment C]
                              [--from <estado>] [--wait] [--dry-run]
  fluigctl request cancel <número> --server <nome> --comment <motivo> [--dry-run]
      abre, mostra, movimenta e cancela solicitações sem a tela do Fluig. O show traz o histórico
      com a mensagem de falha das service tasks; tarefa de pool é assumida antes do move;
      --wait espera o job do servidor rodar as service tasks com execução posterior

  fluigctl changed [--since <ref>] [--server <nome>]
      lista o que mudou no git como artefatos do Fluig e sugere o comando de cada um; não envia nada

  fluigctl push dataset <arquivo.js> --server <nome> [--create] [--description D] [--dry-run]
  fluigctl push form <pasta/> --server <nome> [--document-id N] [--principal A] [--description D]
                              (--keep-version | --new-version) [--dry-run]
                              [--create --parent-id N --dataset-name D --persistence-type form|list]
  fluigctl push process <processId> --server <nome> [--workflow <pasta>] [--dry-run]
                              [--no-release] [--save-export <arquivo.xml>] [--base <export.xml>]
      publica os scripts de workflow/scripts/ num processo que já existe — pelo nome do
      .process que tem este id, como o Studio, ou pelo próprio id; o diagrama vai pelo push diagram
  fluigctl push widget <wcm/widget/nome> --server <nome> [--dry-run]
      empacota a widget num .war e envia; o servidor instala ou atualiza em segundo plano
  fluigctl push layout <wcm/layout/nome> --server <nome> [--dry-run]
      o mesmo para um layout WCM; o application.type da pasta é conferido contra o comando
  fluigctl push diagram <arquivo.process> --server <nome> [--dry-run] [--save-xml <arquivo>]
                              [--create] [--no-release]
      converte o diagrama no XML que o servidor importa e publica: nova versão, import e liberação;
      --create cria o processo que não existe no destino. O --dry-run converte sem rede e sem senha
  fluigctl push event <events/<id>.js> --server <nome> [--dry-run]
      publica o evento global; o id sai do nome do arquivo
  fluigctl push mechanism <mechanisms/<id>.js> --server <nome> [--create] [--name N] [--description D] [--dry-run]
      publica o mecanismo de atribuição customizado; --create cria o que não existe no destino

  fluigctl pull process <processId> --server <nome> [--workflow <pasta>] [--dry-run] [--overwrite]
      baixa os scripts do processo publicado para workflow/scripts/ (mesmo prefixo do push process)
  fluigctl pull dataset <nome> --server <nome> [--dry-run] [--overwrite]
      baixa o código do dataset para o datasets/**/<nome>.js que já existe, ou datasets/<nome>.js
  fluigctl pull form <pasta/> --server <nome> [--document-id N] [--dry-run] [--overwrite]
      baixa anexos e eventos do formulário (alvo resolvido como no push form) para a pasta
  fluigctl pull diagram <processId> --server <nome> [--workflow <pasta>] [--name <nome>] [--dry-run] [--overwrite]
      converte a definição publicada em workflow/diagrams/<nome>.process
  fluigctl pull widget [<code>] --server <nome> [--dry-run] [--overwrite] [--instalar-helper]
      baixa a widget instalada para wcm/widget/<code>; sem o código, lista as instaladas
      a leitura passa pela widget auxiliar do Fluiggers — --instalar-helper a publica no servidor
  fluigctl pull event [<eventId>] --server <nome> [--dry-run] [--overwrite]
      baixa os eventos globais para events/<eventId>.js; sem o id, traz todos os do servidor
  fluigctl pull mechanism [<id>] --server <nome> [--dry-run] [--overwrite]
      baixa os mecanismos customizados para mechanisms/<id>.js; sem o id, traz todos
      Só lê do servidor. Arquivo local diferente do servidor só é trocado com --overwrite;
      sem ele, se algum diferir, nada é gravado

A senha de cada servidor vem, nesta ordem: da variável de ambiente (ex.: FLUIG_CETENCO_HML_PASSWORD),
do arquivo de senhas do fluigctl (~/.config/fluigctl/env, permissão 600) ou do .vscode/servers.json
da extensão, da pasta atual para cima. O .vscode/servers.json é mantido no .gitignore.
Nenhuma senha é impressa, nem gravada no cadastro de servidores.

Códigos de saída — nada é escrito quando o código é 2 a 6:
  0  feito
  2  uso errado (inclui push form sem dizer o que fazer com a versão)
  3  servidor ou arquivo não encontrado
  4  a senha não está em nenhuma das fontes; é pergunta para o humano
  5  precisa de gente no terminal: produção, e a tela de servidores
  6  ambíguo ou sem correspondência; a mensagem diz a flag que resolve
  7  o servidor Fluig recusou a operação

--dry-run existe em todo push e pull: mostra o alvo e o que mudaria, sem escrever.`;


async function comandoServer(argv: string[]): Promise<void> {
  const sub = argv[0];
  const resto = argv.slice(1);

  if (sub === 'ls') {
    console.log(listServers(loadConfig()));
    return;
  }

  if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: resto,
      allowPositionals: true,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        ssl: { type: 'boolean', default: false },
        user: { type: 'string' },
        prod: { type: 'boolean', default: false },
      },
    });

    const nome = positionals[0];
    if (!nome || !values.host || !values.user) {
      throw new ErroFluigctl('uso: fluigctl server add <nome> --host H --user U [--ssl] [--port P] [--prod]', 2);
    }

    const porta = values.port ? Number(values.port) : values.ssl ? 443 : 80;
    if (!Number.isInteger(porta) || porta <= 0) {
      throw new ErroFluigctl(`porta inválida: ${values.port}`, 2);
    }

    // Cadastra provisoriamente para derivar passwordEnv, consulta o servidor
    // para descobrir companyId e userCode, e só então grava.
    const provisorio = addServer(loadConfig(), nome, {
      host: values.host,
      port: porta,
      ssl: values.ssl,
      username: values.user,
      companyId: 0,
      userCode: '',
      ...(values.prod ? { prod: true } : {}),
    });

    const servidor = provisorio.servers[nome]!;
    const senha = resolvePassword(servidor);
    const url = serverUrl(servidor);

    const cookie = await login(url, servidor.username, senha);
    const usuario = await findUserByLogin(url, cookie, servidor.username);

    servidor.companyId = usuario.companyId;
    servidor.userCode = usuario.userCode;

    saveConfig(provisorio);
    console.log(
      `${nome} cadastrado: ${url} · companyId=${usuario.companyId} · ` +
        `userCode=${usuario.userCode} · senha em ${servidor.passwordEnv}` +
        (servidor.prod ? ' · PRODUÇÃO' : ''),
    );
    return;
  }

  if (sub === 'import') {
    const { values, positionals } = parseArgs({
      args: resto,
      allowPositionals: true,
      options: {
        write: { type: 'boolean', default: false },
        'with-passwords': { type: 'boolean', default: false },
      },
    });

    const dir = positionals[0];
    if (!dir) throw new ErroFluigctl('uso: fluigctl server import <dir> [--write] [--with-passwords]', 2);

    const arquivos = await scanServersJson(dir);
    const { candidatos, ignorados } = importCandidates(arquivos);

    if (candidatos.length === 0) {
      console.log(`nenhum servidor encontrado em ${dir}`);
      for (const i of ignorados) console.log(`  ignorado  ${i}`);
      return;
    }

    let config = loadConfig();
    const novos: string[] = [];
    const jaExistiam: string[] = [];

    for (const c of candidatos) {
      if (config.servers[c.nome]) {
        jaExistiam.push(c.nome);
        continue;
      }
      config = addServer(config, c.nome, c.servidor);
      novos.push(c.nome);
      console.log(
        `  ${values.write ? '+' : '·'} ${c.nome.padEnd(28)} ${serverUrl(c.servidor)}` +
          `  ${c.servidor.username}` +
          (c.servidor.prod ? '  PRODUÇÃO' : '') +
          (c.precisaIdentidade ? '  (sem companyId/userCode — rode server test)' : ''),
      );
    }

    for (const nome of jaExistiam) console.log(`  = ${nome} (já cadastrado, mantido)`);
    for (const i of ignorados) console.log(`  ignorado  ${i}`);

    const semMarca = candidatos.filter((c) => !c.servidor.prod).map((c) => c.nome);
    if (semMarca.length > 0) {
      console.log(
        `\nCONFIRA: estes NÃO foram marcados como produção, e portanto não terão\n` +
          `gate de senha. A marca vem do nome do servidor, que é um palpite.\n` +
          semMarca.map((n) => `  ${n}`).join('\n') +
          `\nCorrija o que estiver errado com: fluigctl server set-prod <nome>`,
      );
    }

    // Os servers.json carregam senha cifrada com a chave desta máquina: fora do git, sempre.
    console.log('');
    for (const a of arquivos) {
      const aviso = avisoGit(a.path, garantirIgnorado(a.path, values.write));
      if (aviso) console.log(`  git  ${aviso}`);
    }

    if (values.write) {
      saveConfig(config);
      console.log(`\n${novos.length} servidor(es) gravados em ${configPath()}.`);
    } else {
      console.log(`\n${novos.length} servidor(es) a importar. Repita com --write para gravar.`);
    }

    if (!values['with-passwords']) {
      if (values.write && novos.length > 0) {
        console.log('Nenhuma senha foi importada. Defina as variáveis, ou repita com --with-passwords:');
        for (const nome of novos) console.log(`  export ${config.servers[nome]!.passwordEnv}='...'`);
      }
      return;
    }

    // Copia as senhas da extensão para o arquivo próprio. O valor nunca é impresso.
    const ids = machineIds();
    const destino = envFilePath();
    const semSenha: string[] = [];
    console.log(`\nSenhas (${destino}, permissão 600):`);
    for (const c of candidatos) {
      const servidor = config.servers[c.nome];
      if (!servidor) continue;
      const achada = senhaNosArquivos(servidor, arquivos, ids);
      if (!achada) {
        semSenha.push(c.nome);
        continue;
      }
      const como = values.write ? gravarNoEnv(destino, servidor.passwordEnv, achada.senha) : 'a copiar';
      console.log(
        `  ${c.nome.padEnd(28)} ${servidor.passwordEnv}  ${como}` +
          (servidor.prod ? '  (produção: o push continua exigindo a senha digitada no terminal)' : ''),
      );
    }
    for (const nome of semSenha) {
      console.log(`  ${nome.padEnd(28)} sem senha que esta máquina decifre (cifrada noutra máquina?)`);
    }
    if (!values.write) console.log('Repita com --write para copiar.');
    return;
  }

  if (sub === 'rm') {
    const nome = resto[0];
    if (!nome) throw new ErroFluigctl('uso: fluigctl server rm <nome>', 2);
    saveConfig(removeServer(loadConfig(), nome));
    console.log(`${nome} removido de ${configPath()}`);
    return;
  }

  if (sub === 'set-prod') {
    const { values, positionals } = parseArgs({
      args: resto,
      allowPositionals: true,
      options: { off: { type: 'boolean', default: false } },
    });

    const nome = positionals[0];
    if (!nome) throw new ErroFluigctl('uso: fluigctl server set-prod <nome> [--off]', 2);

    saveConfig(setProd(loadConfig(), nome, !values.off));
    console.log(
      values.off
        ? `${nome} deixou de ser produção — push passa a rodar sem confirmação.`
        : `${nome} marcado como produção — push passa a exigir a senha no terminal.`,
    );
    return;
  }

  if (sub === 'ui') {
    const { values } = parseArgs({
      args: resto,
      allowPositionals: true,
      options: { dir: { type: 'string' } },
    });
    return serverUi(values.dir === undefined ? {} : { dir: values.dir });
  }

  if (sub === 'test') {
    const nome = resto[0];
    if (!nome) throw new ErroFluigctl('uso: fluigctl server test <nome>', 2);

    const servidor = resolveServer(loadConfig(), nome);
    const resultado = await testServer(servidor, resolvePassword(servidor));

    console.log(`${nome}: ${serverUrl(servidor)}`);
    console.log(`  login    ok`);
    console.log(`  ping     ${resultado.pingOk ? 'ok' : 'FALHOU (sessão não validou)'}`);
    console.log(`  usuário  ${resultado.userCode} · companyId ${resultado.companyId}`);
    for (const d of resultado.divergencias) console.log(`  aviso    ${d}`);

    if (!resultado.pingOk) throw new ErroFluigctl('a sessão não validou no ping', 7);
    return;
  }

  throw new ErroFluigctl(`subcomando desconhecido: server ${sub ?? ''}\n\n${USO}`, 2);
}

async function comandoPush(argv: string[]): Promise<void> {
  const tipo = argv[0];
  if (!ehTipoPush(tipo)) {
    throw new ErroFluigctl(
      `push aceita "dataset", "form", "process", "widget", "layout", "diagram", "event" ou "mechanism" — recebi "${tipo ?? ''}"`,
      2,
    );
  }
  if (tipo === 'process') return pushProcessCli(argv.slice(1));
  if (tipo === 'widget') return pushWcmCli(argv.slice(1), 'widget');
  if (tipo === 'layout') return pushWcmCli(argv.slice(1), 'layout');
  if (tipo === 'diagram') return pushDiagramCli(argv.slice(1));
  if (tipo === 'event') return pushEventCli(argv.slice(1));
  if (tipo === 'mechanism') return pushMechanismCli(argv.slice(1));

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      create: { type: 'boolean', default: false },
      description: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'document-id': { type: 'string' },
      'parent-id': { type: 'string' },
      'dataset-name': { type: 'string' },
      'persistence-type': { type: 'string' },
      'description-field': { type: 'string' },
      principal: { type: 'string' },
      'new-version': { type: 'boolean', default: false },
      'keep-version': { type: 'boolean', default: false },
    },
  });

  if (tipo === 'form') return pushFormCli(values, positionals);

  const arquivo = positionals[0];
  if (!arquivo || !values.server) {
    throw new ErroFluigctl(
      'uso: fluigctl push dataset <arquivo.js> --server <nome> [--create] [--description D] [--dry-run]',
      2,
    );
  }

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);

  const r = await pushDataset({
    server: servidor,
    senha,
    arquivo,
    create: values.create,
    ...(values.description === undefined ? {} : { description: values.description }),
    dryRun: values['dry-run'],
    prompt: promptPassword,
  });

  const verbo = r.acao === 'create' ? 'criado' : 'atualizado';
  const alvo = `${values.server} (${serverUrl(servidor)})`;
  if (values['dry-run']) {
    console.log(
      `[dry-run] ${r.nome} seria ${verbo} em ${alvo} — ${r.bytes} bytes` +
        (r.jaIgual ? ' (o servidor já tem este código)' : r.jaIgual === false ? ' (código diferente do servidor)' : '') +
        '. Nada foi enviado.',
    );
    return;
  }
  console.log(`${r.nome} ${verbo} em ${alvo} — ${r.bytes} bytes.`);
  if (r.backup) console.log(`  cópia do que estava no servidor: ${r.backup}`);
  if (r.conferido === true) console.log('  conferido: o servidor devolve o código local.');
  if (r.conferido === false) {
    throw new ErroFluigctl(
      `o servidor aceitou, mas o código que ele devolve NÃO é o local. ` +
        (r.backup ? `O anterior está em ${r.backup}.` : ''),
      7,
    );
  }
}

type ValoresPush = {
  server?: string | undefined;
  create?: boolean | undefined;
  description?: string | undefined;
  'dry-run'?: boolean | undefined;
  'document-id'?: string | undefined;
  'parent-id'?: string | undefined;
  'dataset-name'?: string | undefined;
  'persistence-type'?: string | undefined;
  'description-field'?: string | undefined;
  principal?: string | undefined;
  'new-version'?: boolean | undefined;
  'keep-version'?: boolean | undefined;
};

function inteiro(valor: string | undefined, flag: string): number | undefined {
  if (valor === undefined) return undefined;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ErroFluigctl(`${flag} precisa de um número inteiro positivo — recebi "${valor}"`, 2);
  }
  return n;
}

async function pushFormCli(values: ValoresPush, positionals: string[]): Promise<void> {
  const pasta = positionals[0];
  if (!pasta || !values.server) {
    throw new ErroFluigctl(
      'uso: fluigctl push form <pasta/> --server <nome> [--document-id N] [--dry-run]',
      2,
    );
  }

  const tipoPersistencia = values['persistence-type'];
  if (tipoPersistencia !== undefined && tipoPersistencia !== 'form' && tipoPersistencia !== 'list') {
    throw new ErroFluigctl(
      `--persistence-type aceita "form" ou "list" — recebi "${tipoPersistencia}"`,
      2,
    );
  }

  // Decidido antes de qualquer chamada de rede: sobrescrever a versão ativa é
  // irreversível e não pode acontecer por omissão.
  const versionOption = decideVersionOption({
    create: values.create ?? false,
    keepVersion: values['keep-version'] ?? false,
    newVersion: values['new-version'] ?? false,
  });

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);
  const documentId = inteiro(values['document-id'], '--document-id');
  const parentId = inteiro(values['parent-id'], '--parent-id');

  const r = await pushForm({
    server: servidor,
    senha,
    pasta,
    ...(documentId === undefined ? {} : { documentId }),
    create: values.create ?? false,
    ...(parentId === undefined ? {} : { parentId }),
    ...(values['dataset-name'] === undefined ? {} : { datasetName: values['dataset-name'] }),
    ...(tipoPersistencia === undefined ? {} : { persistenceType: tipoPersistencia }),
    ...(values['description-field'] === undefined
      ? {}
      : { descriptionField: values['description-field'] }),
    ...(values.description === undefined ? {} : { description: values.description }),
    ...(values.principal === undefined ? {} : { principal: values.principal }),
    ...(versionOption === undefined ? {} : { versionOption }),
    dryRun: values['dry-run'] ?? false,
    prompt: promptPassword,
  });

  for (const aviso of r.avisos) console.log(`aviso: ${aviso}`);

  const alvo = `${values.server} (${serverUrl(servidor)})`;
  const detalhe =
    `${r.anexos} anexo(s), ${r.eventos} evento(s)` +
    (r.nomeEnviado === undefined
      ? ''
      : `, nome "${r.nomeEnviado}", campo descritor "${r.descritorEnviado ?? ''}"`);

  if (values['dry-run']) {
    console.log(
      r.acao === 'update'
        ? `[dry-run] ${r.nome} seria atualizado em ${alvo}, documentId ${r.documentId} — ${detalhe}. Nada foi enviado.`
        : `[dry-run] ${r.nome} seria criado em ${alvo} — ${detalhe}. Nada foi enviado.`,
    );
    return;
  }

  console.log(
    r.acao === 'update'
      ? `${r.nome} atualizado em ${alvo}, documentId ${r.documentId} — ${detalhe}.`
      : `${r.nome} criado em ${alvo} com documentId ${r.documentId} — ${detalhe}.`,
  );
}

async function pushProcessCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      workflow: { type: 'string', default: 'workflow' },
      'dry-run': { type: 'boolean', default: false },
      'no-release': { type: 'boolean', default: false },
      'save-export': { type: 'string' },
      base: { type: 'string' },
    },
  });

  const processId = positionals[0];
  if (!processId || !values.server) {
    throw new ErroFluigctl(
      'uso: fluigctl push process <processId> --server <nome> [--workflow <pasta>] [--dry-run] [--no-release]',
      2,
    );
  }

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);

  const r = await pushProcess({
    server: servidor,
    senha,
    processId,
    pastaWorkflow: values.workflow,
    dryRun: values['dry-run'],
    liberar: !values['no-release'],
    ...(values['save-export'] === undefined ? {} : { salvarExport: values['save-export'] }),
    ...(values.base === undefined ? {} : { base: values.base }),
    prompt: promptPassword,
  });

  const alvo = `${values.server} (${serverUrl(servidor)})`;
  const lista = (ids: string[]) => (ids.length ? ids.join(', ') : '-');
  console.log(`${processId} em ${alvo}`);
  if (r.prefixoDosScripts) console.log(`  scripts              workflow/scripts/${r.prefixoDosScripts}.*.js (nome do .process deste id)`);
  console.log(`  alterados            ${lista(r.alterados)}`);
  console.log(`  iguais               ${lista(r.iguais)}`);
  if (r.semScriptLocal.length) console.log(`  sem script local     ${lista(r.semScriptLocal)} (ficam como estão)`);
  if (r.semEventoNoServidor.length) {
    console.log(`  sem evento no servidor ${lista(r.semEventoNoServidor)} (evento novo: publique o diagrama com push diagram)`);
  }

  if (values['dry-run']) {
    console.log(r.alterados.length ? '[dry-run] Nada foi enviado.' : '[dry-run] Nada a publicar.');
    return;
  }
  if (!r.publicado) {
    console.log('Nada a publicar: os scripts do servidor já são os do repositório.');
    return;
  }
  console.log(
    r.liberado === null
      ? `Publicado; versão nova em edição (--no-release). Import: ${r.mensagemImport || '-'}`
      : `Publicado e liberado. Import: ${r.mensagemImport || '-'} · Liberação: ${r.mensagemLiberacao || '-'}`,
  );
}

const TIPOS_PUSH = ['dataset', 'form', 'process', 'widget', 'layout', 'diagram', 'event', 'mechanism'] as const;
type TipoPush = (typeof TIPOS_PUSH)[number];
const ehTipoPush = (t: string | undefined): t is TipoPush =>
  t !== undefined && (TIPOS_PUSH as readonly string[]).includes(t);

async function pushEventCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const arquivo = positionals[0];
  if (!arquivo || !values.server) {
    throw new ErroFluigctl('uso: fluigctl push event <events/<id>.js> --server <nome> [--dry-run]', 2);
  }

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);

  const r = await pushEvent({
    server: servidor,
    senha,
    arquivo,
    dryRun: values['dry-run'],
    prompt: promptPassword,
  });

  const alvo = `${values.server} (${serverUrl(servidor)})`;
  const acao = r.novo ? 'criado' : 'atualizado';
  if (values['dry-run']) {
    console.log(
      `[dry-run] evento global ${r.eventId} seria ${acao} em ${alvo} — ${r.bytes} bytes` +
        (r.novo ? '' : r.jaIgual ? ' (o servidor já tem este código)' : ' (código diferente do servidor)') +
        `. O servidor ficaria com ${r.eventos} evento(s). Nada foi enviado.`,
    );
    return;
  }
  console.log(`evento global ${r.eventId} ${acao} em ${alvo} — ${r.bytes} bytes; o servidor tem ${r.eventos}.`);
  if (r.conferido === true) console.log('  conferido: o servidor devolve o código local.');
  if (r.conferido === false) {
    throw new ErroFluigctl(`o servidor aceitou, mas o código que ele devolve NÃO é o local.`, 7);
  }
}

async function pushMechanismCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      create: { type: 'boolean', default: false },
      name: { type: 'string' },
      description: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const arquivo = positionals[0];
  if (!arquivo || !values.server) {
    throw new ErroFluigctl(
      'uso: fluigctl push mechanism <mechanisms/<id>.js> --server <nome> [--create] [--name N] [--description D] [--dry-run]',
      2,
    );
  }

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);

  const r = await pushMechanism({
    server: servidor,
    senha,
    arquivo,
    criar: values.create,
    ...(values.name === undefined ? {} : { nome: values.name }),
    ...(values.description === undefined ? {} : { descricao: values.description }),
    dryRun: values['dry-run'],
    prompt: promptPassword,
  });

  const alvo = `${values.server} (${serverUrl(servidor)})`;
  const acao = r.acao === 'create' ? 'criado' : 'atualizado';
  if (values['dry-run']) {
    console.log(
      `[dry-run] mecanismo ${r.mecanismoId} seria ${acao} em ${alvo} — ${r.bytes} bytes` +
        (r.jaIgual === undefined ? '' : r.jaIgual ? ' (o servidor já tem este código)' : ' (código diferente do servidor)') +
        `. nome "${r.nome}", descrição "${r.descricao}". Nada foi enviado.`,
    );
    return;
  }
  console.log(`mecanismo ${r.mecanismoId} ${acao} em ${alvo} — ${r.bytes} bytes.`);
  if (r.conferido === true) console.log('  conferido: o servidor devolve o código local.');
  if (r.conferido === false) {
    throw new ErroFluigctl(`o servidor aceitou, mas o código que ele devolve NÃO é o local.`, 7);
  }
}

async function pushWcmCli(argv: string[], tipo: 'widget' | 'layout'): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const pasta = positionals[0];
  if (!pasta || !values.server) {
    throw new ErroFluigctl(
      `uso: fluigctl push ${tipo} <wcm/${tipo}/nome> --server <nome> [--dry-run]`,
      2,
    );
  }

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);

  const r = await pushWcm({
    server: servidor,
    senha,
    pasta,
    tipo,
    dryRun: values['dry-run'],
    prompt: promptPassword,
  });

  const detalhe = `${r.codigo}.war — ${r.entradas} arquivo(s), ${r.bytes} bytes`;
  console.log(
    values['dry-run']
      ? `[dry-run] ${detalhe} seria enviado para ${r.url}. Nada foi enviado.`
      : `${detalhe} enviado para ${values.server} (${serverUrl(servidor)}). ` +
          'A instalação acontece em segundo plano no servidor.',
  );
  if (r.aviso) console.log(`  aviso: ${r.aviso}`);
}

async function pushDiagramCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      'save-xml': { type: 'string' },
      create: { type: 'boolean', default: false },
      'no-release': { type: 'boolean', default: false },
    },
  });

  const arquivo = positionals[0];
  if (!arquivo || !values.server) {
    throw new ErroFluigctl(
      'uso: fluigctl push diagram <arquivo.process> --server <nome> [--dry-run] [--save-xml <arquivo>] [--create] [--no-release]',
      2,
    );
  }

  // O dry-run não abre sessão: só usa o companyId do cadastro. Publicar precisa da senha.
  const servidor = resolveServer(loadConfig(), values.server);
  const senha = values['dry-run'] ? undefined : resolvePassword(servidor);

  const r = await pushDiagram({
    server: servidor,
    nomeServidor: values.server,
    arquivo,
    dryRun: values['dry-run'],
    ...(values['save-xml'] === undefined ? {} : { salvarXml: values['save-xml'] }),
    ...(senha === undefined ? {} : { senha, prompt: promptPassword }),
    criar: values.create,
    liberar: !values['no-release'],
  });

  const c = r.contagens;
  console.log(`${r.processId} versão ${r.versao} para ${values.server} (companyId ${servidor.companyId})`);
  console.log(`  formId               ${r.formId}`);
  console.log(`  estados              ${c.estados}`);
  console.log(`  links                ${c.links}`);
  console.log(`  raias                ${c.raias}`);
  console.log(`  bendpoints           ${c.dobras}`);
  console.log(`  condições            ${c.condicoes}`);
  console.log(`  anotações            ${c.anotacoes}`);
  console.log(`  scripts              ${c.eventos}`);
  console.log(`  imagem               ${r.imagem.nome} (${r.imagem.origem === 'studio' ? 'do Studio' : 'gerada'}, ${r.imagem.bytes} bytes)`);
  for (const aviso of r.avisos) console.log(`aviso: ${aviso}`);
  if (values['save-xml']) console.log(`XML gravado em ${values['save-xml']}.`);
  if (values['dry-run']) {
    console.log('[dry-run] Nada foi enviado.');
    return;
  }
  const alvo = `${values.server} (${serverUrl(servidor)})`;
  console.log(
    `${r.processId} ${r.criado ? 'criado' : 'publicado'} em ${alvo} com formId ${r.formId}. Import: ${r.mensagemImport || '-'}` +
      (r.liberado === null ? ' · versão em edição (--no-release)' : ` · Liberação: ${r.mensagemLiberacao || '-'}`),
  );
}

const TIPOS_PULL = ['process', 'dataset', 'form', 'diagram', 'widget', 'event', 'mechanism'] as const;
type TipoPull = (typeof TIPOS_PULL)[number];
const ehTipoPull = (t: string | undefined): t is TipoPull =>
  t !== undefined && (TIPOS_PULL as readonly string[]).includes(t);

async function comandoPull(argv: string[]): Promise<void> {
  const tipo = argv[0];
  const uso =
    'uso: fluigctl pull process <processId> --server <nome> [--workflow <pasta>] [--dry-run] [--overwrite]\n' +
    '     fluigctl pull dataset <nome> --server <nome> [--dry-run] [--overwrite]\n' +
    '     fluigctl pull form <pasta/> --server <nome> [--document-id N] [--dry-run] [--overwrite]\n' +
    '     fluigctl pull diagram <processId> --server <nome> [--workflow <pasta>] [--name <nome>] [--dry-run] [--overwrite]\n' +
    '     fluigctl pull widget [<code>] --server <nome> [--dry-run] [--overwrite] [--instalar-helper]\n' +
    '     fluigctl pull event [<eventId>] --server <nome> [--dry-run] [--overwrite]\n' +
    '     fluigctl pull mechanism [<id>] --server <nome> [--dry-run] [--overwrite]';
  if (!ehTipoPull(tipo)) throw new ErroFluigctl(uso, 2);

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      workflow: { type: 'string', default: 'workflow' },
      'dry-run': { type: 'boolean', default: false },
      overwrite: { type: 'boolean', default: false },
      'document-id': { type: 'string' },
      name: { type: 'string' },
      'instalar-helper': { type: 'boolean', default: false },
    },
  });
  const nome = positionals[0];
  if (!values.server || (!nome && !['widget', 'event', 'mechanism'].includes(tipo))) throw new ErroFluigctl(uso, 2);

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);
  const comum = { server: servidor, senha, dryRun: values['dry-run'], sobrescrever: values.overwrite };

  let r: ResultadoPull;
  const plural: Record<TipoPull, string> = {
    process: 'processos',
    dataset: 'datasets',
    form: 'formulários',
    diagram: 'diagramas',
    widget: 'widgets',
    event: 'eventos globais',
    mechanism: 'mecanismos de atribuição',
  };
  console.log(`${nome ?? plural[tipo]} de ${values.server} (${serverUrl(servidor)})`);
  if (tipo === 'widget') {
    // Sem código é só listagem: o equivalente CLI do seletor da extensão.
    if (!nome) {
      for (const w of await listarWidgets({ server: servidor, senha })) {
        console.log(`  ${w.code.padEnd(32)} ${w.title}${w.description ? ` — ${w.description}` : ''}`);
      }
      return;
    }
    const w = await pullWidget({
      ...comum,
      nome,
      instalarHelper: values['instalar-helper'],
      prompt: promptPassword,
    });
    console.log(`  code ${w.code}`);
    if (w.helperInstalado) console.log('  a widget auxiliar do Fluiggers foi publicada neste servidor agora');
    for (const aviso of w.avisos) console.log(`  aviso: ${aviso}`);
    if (w.ignorados.length) {
      console.log(`  no .war, sem lugar na pasta (ficam de fora)  ${w.ignorados.join(', ')}`);
    }
    if (w.soLocais.length) console.log(`  só no local         ${w.soLocais.join(', ')} (ficam como estão)`);
    r = w;
  } else if (tipo === 'process') {
    r = await pullProcess({ ...comum, processId: nome!, pastaWorkflow: values.workflow });
    if (r.novos.length + r.iguais.length + r.diferentes.length === 0) {
      console.log('  o processo publicado não tem scripts.');
      return;
    }
  } else if (tipo === 'event') {
    const e = await pullEvent({
      ...comum,
      raiz: '.',
      ...(nome === undefined ? {} : { eventId: nome }),
    });
    console.log(`  evento(s)  ${e.eventos.map((x) => x.eventId).join(', ')}`);
    r = e;
  } else if (tipo === 'mechanism') {
    const m = await pullMechanism({
      ...comum,
      raiz: '.',
      ...(nome === undefined ? {} : { mecanismoId: nome }),
    });
    console.log(`  mecanismo(s)  ${m.mecanismos.map((x) => x.mecanismoId).join(', ')}`);
    r = m;
  } else if (tipo === 'diagram') {
    r = await pullDiagram({
      ...comum, processId: nome!, pastaWorkflow: values.workflow,
      ...(values.name ? { nomeDoArquivo: values.name } : {}),
    });
  } else if (tipo === 'form') {
    const documentId = values['document-id'] === undefined ? undefined : Number(values['document-id']);
    if (documentId !== undefined && !(Number.isInteger(documentId) && documentId > 0)) {
      throw new ErroFluigctl(`--document-id precisa ser um número: ${values['document-id']}`, 2);
    }
    const f = await pullForm({ ...comum, pasta: nome!, ...(documentId === undefined ? {} : { documentId }) });
    console.log(`  documentId ${f.documentId}, versão ${f.versao}`);
    for (const aviso of f.avisos) console.log(`  aviso: ${aviso}`);
    if (f.soLocais.length) console.log(`  só no local         ${f.soLocais.join(', ')} (ficam como estão)`);
    r = f;
  } else {
    r = await pullDataset({ ...comum, nome: nome! });
  }

  const lista = (arquivos: string[]) => (arquivos.length ? arquivos.join(', ') : '-');
  console.log(`  novos                ${lista(r.novos)}`);
  console.log(`  iguais               ${lista(r.iguais)}`);
  console.log(`  diferentes           ${lista(r.diferentes)}`);
  if (values['dry-run']) {
    console.log(
      r.diferentes.length && !values.overwrite
        ? '[dry-run] Nada foi gravado. Os diferentes só são trocados com --overwrite.'
        : '[dry-run] Nada foi gravado.',
    );
    return;
  }
  console.log(r.gravados.length ? `Gravados: ${r.gravados.join(', ')}` : 'Nada a gravar: o repositório já tem o que está no servidor.');
}

function comandoChanged(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string' },
      server: { type: 'string', short: 's' },
    },
  });

  const { raiz, artefatos } = changedArtifacts(process.cwd(), values.since);
  const origem = values.since ? `desde ${values.since}, mais o working tree` : 'no working tree';
  if (artefatos.length === 0) {
    console.log(`nada a publicar ${origem} (${raiz}).`);
    return;
  }

  console.log(`${artefatos.length} artefato(s) alterado(s) ${origem} — rode na raiz ${raiz}:`);
  for (const a of artefatos) {
    console.log(`  ${comandoSugerido(a, values.server ?? '<servidor>')}`);
    if (a.tipo === 'form' && a.camposNovos.length > 0) {
      console.log(`      campos novos (exigem --new-version): ${a.camposNovos.join(', ')}`);
    }
    if (a.tipo === 'form' && a.htmlNovo) console.log('      formulário novo no git: confira se já existe no servidor');
    if (a.tipo === 'process') console.log(`      eventos alterados: ${a.eventos.join(', ')}`);
  }
  console.log('\nTire o --dry-run de cada um depois de conferir. Nada foi enviado.');
}

function comandoSkill(argv: string[]): void {
  const sub = argv[0] ?? 'ls';
  const uso =
    'uso: fluigctl skill [ls]\n' +
    '     fluigctl skill install [--dir <pasta>] [--copy] [--force] [--dry-run]\n' +
    '     fluigctl skill uninstall [--dir <pasta>] [--dry-run]';

  if (sub === 'ls') {
    let origens: string[];
    try {
      origens = origensDasSkills();
    } catch (erro) {
      throw new ErroFluigctl((erro as Error).message, 3);
    }
    console.log('estas são as skills que vêm com o fluigctl:');
    for (const o of origens) console.log(`  ${o}`);
    console.log('');
    for (const e of estadoDaSkill(undefined, origens)) {
      const situacao = !e.instalada
        ? e.pastaExiste
          ? 'não instalada'
          : 'não instalada (a pasta de skills ainda não existe)'
        : e.nossa !== true
          ? 'ocupada por outra coisa, e o fluigctl não mexe nela'
          : `${e.como === 'link' ? 'instalada como link para o repositório' : 'instalada como cópia'}${e.desatualizada ? ', e desatualizada' : ''}`;
      console.log(`  ${e.destino}\n      ${situacao}`);
    }
    console.log('\n"fluigctl skill install" põe as skills onde os agentes procuram.');
    return;
  }

  if (sub !== 'install' && sub !== 'uninstall') throw new ErroFluigctl(uso, 2);

  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      copy: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const comuns = {
    ...(values.dir === undefined ? {} : { dir: values.dir }),
    dryRun: values['dry-run'],
  };

  if (sub === 'install') {
    const r = instalarSkill({ ...comuns, copiar: values.copy, forcar: values.force });
    for (const f of r.feito) {
      console.log(`${f.acao === 'ja estava' ? 'já estava' : f.acao === 'atualizada' ? 'atualizada' : 'instalada'}: ${f.destino} (${f.como === 'link' ? 'link para o repositório' : 'cópia'})`);
    }
    for (const x of r.recusados) console.log(`recusado: ${x.destino} — ${x.motivo}`);
    if (values['dry-run']) console.log('[dry-run] Nada foi escrito.');
    else if (r.feito.length > 0) console.log('\nUm agente que leia esse diretório passa a ver as skills na próxima sessão.');
    if (r.recusados.length > 0) throw new ErroFluigctl('havia skill ocupada; nada dela foi tocado', 6);
    return;
  }

  const r = removerSkill(comuns);
  for (const d of r.removidos) console.log(`removida: ${d}`);
  for (const x of r.recusados) console.log(`recusado: ${x.destino} — ${x.motivo}`);
  if (r.removidos.length === 0 && r.recusados.length === 0) console.log('não havia skill do fluigctl instalada.');
  if (values['dry-run']) console.log('[dry-run] Nada foi removido.');
}

async function comandoGroup(argv: string[]): Promise<void> {
  const sub = argv[0];
  const uso =
    'uso: fluigctl group ls --server <nome>\n' +
    '     fluigctl group show <grupo> --server <nome>\n' +
    '     fluigctl group add <grupo> --server <nome> [--description D] [--dry-run]\n' +
    '     fluigctl group add-member <grupo> <login> --server <nome> [--dry-run]';
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      description: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.server || !sub) throw new ErroFluigctl(uso, 2);
  const servidor = resolveServer(loadConfig(), values.server);
  const o = { server: servidor, senha: resolvePassword(servidor), prompt: promptPassword };
  const alvo = `${values.server} (${serverUrl(servidor)})`;
  const dry = values['dry-run'];

  if (sub === 'ls') {
    const grupos = await listarGrupos(o);
    if (grupos.length === 0) console.log(`nenhum grupo em ${alvo}`);
    for (const g of grupos.sort((a, b) => a.groupId.localeCompare(b.groupId))) console.log(`${g.groupId}${g.descricao && g.descricao !== g.groupId ? `  ${g.descricao}` : ''}`);
    return;
  }
  const grupo = positionals[0];
  if (!grupo) throw new ErroFluigctl(uso, 2);
  if (sub === 'show') {
    const r = await verGrupo(o, grupo);
    console.log(`${r.grupo.groupId}  ${r.grupo.descricao}`);
    console.log(r.membros.length ? r.membros.map((m) => `  ${m}`).join('\n') : '  (sem membros)');
    return;
  }
  if (sub === 'add') {
    const r = await criarGrupo(o, grupo, values.description ?? grupo, dry);
    if (r.jaExistia) console.log(`o grupo ${grupo} já existe em ${alvo}; nada foi feito`);
    else if (dry) console.log(`[dry-run] o grupo ${grupo} seria criado em ${alvo}. Nada foi enviado.`);
    else console.log(`grupo ${grupo} criado em ${alvo} (conferido na lista do servidor)`);
    return;
  }
  if (sub === 'add-member') {
    const usuario = positionals[1];
    if (!usuario) throw new ErroFluigctl(uso, 2);
    const r = await adicionarMembro(o, grupo, usuario, dry);
    if (r.jaEstava) console.log(`${usuario} (${r.colleagueId}) já está no grupo ${grupo}; nada foi feito`);
    else if (dry) console.log(`[dry-run] ${usuario} (${r.colleagueId}) entraria no grupo ${grupo} em ${alvo}. Nada foi enviado.`);
    else console.log(`${usuario} (${r.colleagueId}) entrou no grupo ${grupo} (conferido no servidor)`);
    return;
  }
  throw new ErroFluigctl(uso, 2);
}

async function comandoProcess(argv: string[]): Promise<void> {
  const sub = argv[0];
  const uso =
    'uso: fluigctl process versions <processId> --server <nome>\n' +
    '     fluigctl process release <processId> --server <nome> [--dry-run]';
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: { server: { type: 'string', short: 's' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const processId = positionals[0];
  if (!values.server || !processId || (sub !== 'versions' && sub !== 'release')) throw new ErroFluigctl(uso, 2);
  const servidor = resolveServer(loadConfig(), values.server);
  const o = { server: servidor, senha: resolvePassword(servidor), prompt: promptPassword };
  if (sub === 'versions') {
    const versoes = await versoesDoProcesso(o, processId);
    if (versoes.length === 0) throw new ErroFluigctl(`o processo "${processId}" não existe em ${serverUrl(servidor)}`, 6);
    for (const v of versoes) {
      const estado = v.emUso ? 'em uso (liberada)' : v.emEdicao ? 'em edição' : v.ativa ? 'liberada' : 'antiga';
      console.log(`v${v.versao}  ${estado}${v.bloqueada ? ', bloqueada' : ''}`);
    }
    return;
  }
  const r = await liberarVersao(o, processId, values['dry-run']);
  if (values['dry-run']) console.log(`[dry-run] a versão ${r.versao} de ${processId} seria liberada. Nada foi enviado.`);
  else console.log(`versão ${r.versao} de ${processId} liberada${r.mensagem ? ` — ${r.mensagem.slice(0, 200)}` : ''}`);
}

async function comandoDataset(argv: string[]): Promise<void> {
  const uso =
    'uso: fluigctl dataset run <nome> --server <nome> [--where campo=valor]... [--fields a,b] [--order a,b] [--limit N] [--json]';
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      where: { type: 'string', multiple: true },
      fields: { type: 'string' },
      order: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const nome = positionals[0];
  if (argv[0] !== 'run' || !nome || positionals.length !== 1 || !values.server) throw new ErroFluigctl(uso, 2);
  const lista = (v: string | undefined) => v?.split(',').map((x) => x.trim()).filter(Boolean);
  let limite: number | undefined;
  if (values.limit !== undefined) {
    limite = Number(values.limit);
    if (!Number.isInteger(limite) || limite < 1) throw new ErroFluigctl(`--limit "${values.limit}": use um inteiro positivo`, 2);
  }
  const servidor = resolveServer(loadConfig(), values.server);
  const r = await rodarDataset(
    {
      server: servidor,
      senha: resolvePassword(servidor),
      campos: lista(values.fields),
      restricoes: (values.where ?? []).map(lerRestricao),
      ordem: lista(values.order),
      limite,
    },
    nome,
  );
  if (values.json) {
    console.log(JSON.stringify(r.linhas, null, 2));
    return;
  }
  console.log(formatarTabela(r));
  console.log(`\n${r.linhas.length} linha(s)`);
}

async function comandoRequest(argv: string[]): Promise<void> {
  const sub = argv[0];
  const uso =
    'uso: fluigctl request start <processId> --server <nome> [--field campo=valor]... [--comment C] [--wait] [--dry-run]\n' +
    '     fluigctl request show <número> --server <nome> [--form] [--wait] [--json]\n' +
    '     fluigctl request move <número> --to <estado> --server <nome> [--field campo=valor]... [--comment C] [--from <estado>] [--wait] [--dry-run]\n' +
    '     fluigctl request cancel <número> --server <nome> --comment <motivo> [--dry-run]';
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      server: { type: 'string', short: 's' },
      field: { type: 'string', multiple: true },
      comment: { type: 'string' },
      to: { type: 'string' },
      from: { type: 'string' },
      form: { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const alvo = positionals[0];
  if (!values.server || !alvo || positionals.length !== 1 || !['start', 'show', 'move', 'cancel'].includes(sub ?? '')) throw new ErroFluigctl(uso, 2);
  const inteiro = (v: string | undefined, nome: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ErroFluigctl(`${nome} "${v ?? ''}": use um número inteiro positivo`, 2);
    return n;
  };
  const servidor = resolveServer(loadConfig(), values.server);
  const o = { server: servidor, senha: resolvePassword(servidor), prompt: promptPassword };
  const campos = Object.fromEntries((values.field ?? []).map(lerCampo));
  const dry = values['dry-run'];
  const mostrar = async (id: number) => {
    const s = values.wait ? await aguardar(o, id) : await lerSolicitacao(o, id);
    console.log(values.json ? JSON.stringify(s, null, 2) : formatarSolicitacao(s, values.form));
  };

  if (sub === 'show') return mostrar(inteiro(alvo, 'número'));
  if (sub === 'start') {
    const r = await abrirSolicitacao(o, alvo, campos, values.comment, dry);
    if (dry) {
      console.log(`[dry-run] abriria uma solicitação de ${alvo} em ${values.server} com ${Object.keys(campos).length} campo(s). Nada foi enviado.`);
      return;
    }
    console.log(`solicitação ${r.id} aberta\n`);
    return mostrar(r.id!);
  }
  if (sub === 'cancel') {
    if (!values.comment) throw new ErroFluigctl(`request cancel pede --comment com o motivo, que fica no histórico\n${uso}`, 2);
    const id = inteiro(alvo, 'número');
    const s = await cancelarSolicitacao(o, id, values.comment, dry);
    console.log(dry ? `[dry-run] a solicitação ${id} (${s.processId} v${s.versao}) seria cancelada. Nada foi enviado.` : `solicitação ${id} cancelada (conferido no servidor)`);
    return;
  }
  if (!values.to) throw new ErroFluigctl(uso, 2);
  const id = inteiro(alvo, 'número');
  const r = await moverSolicitacao(o, id, inteiro(values.to, '--to'), campos, values.comment, dry, values.from === undefined ? undefined : inteiro(values.from, '--from'));
  const de = `${r.de.estado} "${r.de.nomeEstado}"`;
  if (dry) {
    console.log(`[dry-run] a solicitação ${id} iria de ${de} para ${values.to}${r.assumida ? ', assumindo a tarefa do pool antes' : ''}. Nada foi enviado.`);
    return;
  }
  console.log(`solicitação ${id} movimentada de ${de} para ${values.to}${r.assumida ? ' (tarefa do pool assumida antes)' : ''}\n`);
  return mostrar(id);
}

async function comandoDiagram(argv: string[]): Promise<void> {
  const sub = argv[0];
  const uso =
    'uso: fluigctl diagram open <arquivo.process> [--no-open] [--foreground]\n' +
    '     fluigctl diagram close <arquivo.process>\n' +
    '     fluigctl diagram check <arquivo.process> [--except <id>]... [--group <id>] [--json] [--fix]';

  if (sub === 'check') {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        except: { type: 'string', multiple: true },
        group: { type: 'string' },
        json: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
      },
    });
    const arquivo = positionals[0];
    if (!arquivo || positionals.length !== 1) throw new ErroFluigctl(uso, 2);
    if (values.fix) {
      // Só o reparo seguro: as fontes que faltam. Passa pelo histórico do
      // visualizador, então o Desfazer de lá volta o arquivo.
      const faltam = textosSemFonte(readFileSync(arquivo, 'latin1'));
      if (faltam === 0) console.log(`--fix: nenhum texto sem fonte em ${arquivo}`);
      else {
        aplicarEdicao(arquivo, join(diretorioDeEstado(), 'edicoes'), garantirFontes);
        console.log(`--fix: fonte acrescentada em ${faltam} texto(s) de ${arquivo} (desfaz pelo visualizador)`);
      }
    }
    const achados = checarDiagrama(readFileSync(arquivo, 'utf8'), {
      excecoes: values.except ?? [],
      ...(values.group === undefined ? {} : { grupo: values.group }),
    });
    const erros = achados.filter((a) => a.nivel === 'erro').length;
    if (values.json) console.log(JSON.stringify(achados, null, 2));
    else {
      for (const a of achados) console.log(`${a.nivel === 'erro' ? 'erro ' : 'aviso'}  ${a.grupo === 'estrutura' ? 'estrutura' : 'padrão   '}  ${a.onde}: ${a.mensagem}`);
      console.log(`${achados.length === 0 ? 'ok: ' : ''}${erros} erro(s), ${achados.length - erros} aviso(s) em ${arquivo}`);
    }
    if (erros > 0) throw new ErroFluigctl(`${arquivo}: ${erros} erro(s)`, 6);
    return;
  }

  if (sub === 'open') {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        'no-open': { type: 'boolean', default: false },
        foreground: { type: 'boolean', default: false },
      },
    });
    const arquivo = positionals[0];
    if (!arquivo || positionals.length !== 1) throw new ErroFluigctl(uso, 2);
    const instancia = await abrirVisualizador({
      arquivo,
      abrirNavegador: !values['no-open'],
      foreground: values.foreground,
    });
    console.log(`${instancia.reutilizada ? 'visualizador já aberto' : 'visualizador aberto'}: ${instancia.url}`);
    console.log(`pid: ${instancia.registro.pid}`);
    return;
  }

  if (sub === 'close') {
    const arquivo = argv[1];
    if (!arquivo || argv.length !== 2) throw new ErroFluigctl(uso, 2);
    const fechado = await fecharVisualizador(arquivo);
    console.log(fechado ? `visualizador encerrado: ${fechado.arquivo}` : `não havia visualizador aberto para ${resolve(arquivo)}`);
    return;
  }

  // É a entrada privada do processo em segundo plano. Não aparece no help para
  // que ninguém precise conhecer token nem diretório de registro.
  if (sub === 'serve') {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        token: { type: 'string' },
        'registry-dir': { type: 'string' },
        'undo-dir': { type: 'string' },
      },
    });
    const arquivo = positionals[0];
    if (!arquivo || !values.token || positionals.length !== 1) throw new ErroFluigctl(uso, 2);
    await executarServidor({
      arquivo,
      token: values.token,
      ...(values['registry-dir'] === undefined ? {} : { registroDir: values['registry-dir'] }),
      ...(values['undo-dir'] === undefined ? {} : { undoDir: values['undo-dir'] }),
    });
  }

  throw new ErroFluigctl(uso, 2);
}

async function main(argv: string[]): Promise<void> {
  const comando = argv[0];

  if (!comando || comando === '--help' || comando === '-h' || comando === 'help') {
    console.log(USO);
    return;
  }

  if (comando === 'server') return comandoServer(argv.slice(1));
  if (comando === 'skill') return comandoSkill(argv.slice(1));
  if (comando === 'diagram') return comandoDiagram(argv.slice(1));
  if (comando === 'group') return comandoGroup(argv.slice(1));
  if (comando === 'process') return comandoProcess(argv.slice(1));
  if (comando === 'dataset') return comandoDataset(argv.slice(1));
  if (comando === 'request') return comandoRequest(argv.slice(1));
  if (comando === 'changed') return comandoChanged(argv.slice(1));
  if (comando === 'push') return comandoPush(argv.slice(1));
  if (comando === 'pull') return comandoPull(argv.slice(1));

  throw new ErroFluigctl(`comando desconhecido: ${comando}\n\n${USO}`, 2);
}

main(process.argv.slice(2)).catch((erro: unknown) => {
  const e = erro as Error;
  console.error(`fluigctl: ${e.message}`);
  process.exit(erro instanceof ErroFluigctl ? erro.codigo : 1);
});
