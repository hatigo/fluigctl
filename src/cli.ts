#!/usr/bin/env node
import { parseArgs } from 'node:util';

import {
  configPath,
  loadConfig,
  resolvePassword,
  resolveServer,
  saveConfig,
  serverUrl,
} from './config.js';
import { addServer, listServers, removeServer, setProd } from './commands/server.js';
import { pushDataset } from './commands/push-dataset.js';
import { pushForm } from './commands/push-form.js';
import { pushProcess } from './commands/push-process.js';
import { pushWidget } from './commands/push-widget.js';
import { importCandidates, scanServersJson } from './import.js';
import { decideVersionOption } from './push/form-resolve.js';
import { promptPassword } from './prompt.js';
import { testServer } from './commands/server-test.js';
import { findUserByLogin, login } from './fluig/session.js';
import { ErroFluigctl } from './errors.js';

const USO = `fluigctl — sobe datasets, formulários, widgets e scripts de processo para o TOTVS Fluig

  fluigctl server ls
  fluigctl server add <nome> --host H [--port P] [--ssl] --user U [--prod]
  fluigctl server rm <nome>
  fluigctl server import <dir> [--write]
  fluigctl server set-prod <nome> [--off]
  fluigctl server test <nome>

  fluigctl push dataset <arquivo.js> --server <nome> [--create] [--description D] [--dry-run]
  fluigctl push form <pasta/> --server <nome> [--document-id N] [--principal A] [--description D]
                              (--keep-version | --new-version) [--dry-run]
                              [--create --parent-id N --dataset-name D --persistence-type form|list]
  fluigctl push process <processId> --server <nome> [--workflow <pasta>] [--dry-run]
                              [--no-release] [--save-export <arquivo.xml>] [--base <export.xml>]
      publica os scripts de workflow/scripts/<processId>.*.js num processo que já existe;
      diagrama e atividades continuam sendo publicados pelo Fluig Studio
  fluigctl push widget <wcm/widget/nome> --server <nome> [--dry-run]
      empacota a widget num .war e envia; o servidor instala ou atualiza em segundo plano

A senha de cada servidor vem de variável de ambiente (ex.: FLUIG_CETENCO_HML_PASSWORD).
Nenhuma senha é gravada em disco.`;


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
      options: { write: { type: 'boolean', default: false } },
    });

    const dir = positionals[0];
    if (!dir) throw new ErroFluigctl('uso: fluigctl server import <dir> [--write]', 2);

    const { candidatos, ignorados } = importCandidates(await scanServersJson(dir));

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

    if (!values.write) {
      console.log(`\n${novos.length} servidor(es) a importar. Repita com --write para gravar.`);
      return;
    }

    saveConfig(config);
    console.log(`\n${novos.length} servidor(es) gravados em ${configPath()}.`);
    if (novos.length > 0) {
      console.log('Nenhuma senha foi importada. Defina:');
      for (const nome of novos) {
        console.log(`  export ${config.servers[nome]!.passwordEnv}='...'`);
      }
    }
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
  if (tipo !== 'dataset' && tipo !== 'form' && tipo !== 'process' && tipo !== 'widget') {
    throw new ErroFluigctl(
      `push aceita "dataset", "form", "process" ou "widget" — recebi "${tipo ?? ''}"`,
      2,
    );
  }
  if (tipo === 'process') return pushProcessCli(argv.slice(1));
  if (tipo === 'widget') return pushWidgetCli(argv.slice(1));

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
  console.log(
    values['dry-run']
      ? `[dry-run] ${r.nome} seria ${verbo} em ${alvo} — ${r.bytes} bytes. Nada foi enviado.`
      : `${r.nome} ${verbo} em ${alvo} — ${r.bytes} bytes.`,
  );
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
  const detalhe = `${r.anexos} anexo(s), ${r.eventos} evento(s)`;

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
  console.log(`  alterados            ${lista(r.alterados)}`);
  console.log(`  iguais               ${lista(r.iguais)}`);
  if (r.semScriptLocal.length) console.log(`  sem script local     ${lista(r.semScriptLocal)} (ficam como estão)`);
  if (r.semEventoNoServidor.length) {
    console.log(`  sem evento no servidor ${lista(r.semEventoNoServidor)} (evento novo: exporte pelo Studio)`);
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

async function pushWidgetCli(argv: string[]): Promise<void> {
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
    throw new ErroFluigctl('uso: fluigctl push widget <wcm/widget/nome> --server <nome> [--dry-run]', 2);
  }

  const servidor = resolveServer(loadConfig(), values.server);
  const senha = resolvePassword(servidor);

  const r = await pushWidget({
    server: servidor,
    senha,
    pasta,
    dryRun: values['dry-run'],
    prompt: promptPassword,
  });

  const detalhe = `${r.nome}.war — ${r.entradas} arquivo(s), ${r.bytes} bytes`;
  console.log(
    values['dry-run']
      ? `[dry-run] ${detalhe} seria enviado para ${r.url}. Nada foi enviado.`
      : `${detalhe} enviado para ${values.server} (${serverUrl(servidor)}). ` +
          'A instalação acontece em segundo plano no servidor.',
  );
}

async function main(argv: string[]): Promise<void> {
  const comando = argv[0];

  if (!comando || comando === '--help' || comando === '-h' || comando === 'help') {
    console.log(USO);
    return;
  }

  if (comando === 'server') return comandoServer(argv.slice(1));
  if (comando === 'push') return comandoPush(argv.slice(1));

  throw new ErroFluigctl(`comando desconhecido: ${comando}\n\n${USO}`, 2);
}

main(process.argv.slice(2)).catch((erro: unknown) => {
  const e = erro as Error;
  console.error(`fluigctl: ${e.message}`);
  process.exit(erro instanceof ErroFluigctl ? erro.codigo : 1);
});
