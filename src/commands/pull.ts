import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { serverUrl, type Server } from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { cardIndexClient, type CardIndexClient } from '../fluig/cardindex-service.js';
import { loadDataset, type DatasetNoServidor } from '../fluig/dataset-service.js';
import { versaoAtiva } from '../fluig/document-service.js';
import { globalEventClient, type GlobalEventClient } from '../fluig/global-event-service.js';
import { mechanismClient, type MechanismClient } from '../fluig/mechanism-service.js';
import { login } from '../fluig/session.js';
import {
  instalarWidgetHelper,
  semWidgetHelper,
  widgetHelperClient,
  type WidgetHelperClient,
} from '../fluig/widget-helper.js';
import { workflowEngineClient, type WorkflowEngineClient } from '../fluig/workflow-service.js';
import { confirmProduction, type PromptSenha } from '../guard.js';
import { decideForm } from '../push/form-resolve.js';
import { arquivosDaPasta, nomeDaPasta } from '../push/form-source.js';
import { eventosDoProcesso, normalizar } from '../push/process-events.js';
import { prefixoDosScripts } from '../push/process-source.js';
import { lerMetadataStudio } from '../push/studio-metadata.js';
import { entradasDoZip } from '../push/zip.js';
import { gerarProcess } from '../pull/process-diagram.js';
import { desmontarWar } from '../pull/widget-war.js';

/**
 * Baixa do servidor o que está publicado — o caminho inverso do push. Nunca
 * sobrescreve em silêncio: arquivo novo é gravado, igual fica como está, e
 * arquivo local diferente do servidor só é trocado com `--overwrite`. Sem ele, se
 * algum diferir, nada é gravado (código 6): gravar parte e parar deixaria a
 * pasta numa mistura difícil de entender. Só lê do servidor.
 */

export interface ArquivoBaixado {
  /** Caminho relativo à pasta de trabalho. */
  caminho: string;
  /** Texto (script: comparado como no push) ou bytes (anexo de formulário: comparado byte a byte e gravado como veio). */
  conteudo: string | Buffer;
}

export interface ResultadoPull {
  novos: string[];
  iguais: string[];
  /** Locais diferentes do servidor: sobrescritos só com `--overwrite`. */
  diferentes: string[];
  gravados: string[];
}

/** Compara com o disco e, se puder, grava. A comparação é a do push (fim de linha, "?" fora do latin1). */
export function aplicarPull(
  raiz: string,
  arquivos: readonly ArquivoBaixado[],
  opcoes: { dryRun?: boolean; sobrescrever?: boolean },
): ResultadoPull {
  const novos: string[] = [];
  const iguais: string[] = [];
  const diferentes: string[] = [];
  for (const a of arquivos) {
    const caminho = resolve(raiz, a.caminho);
    if (!existsSync(caminho)) novos.push(a.caminho);
    else if (igual(readFileSync(caminho), a.conteudo)) iguais.push(a.caminho);
    else diferentes.push(a.caminho);
  }

  const gravados: string[] = [];
  if (opcoes.dryRun) return { novos, iguais, diferentes, gravados };
  if (diferentes.length > 0 && !opcoes.sobrescrever) {
    throw new ErroFluigctl(
      `estes arquivos locais diferem do servidor e não foram tocados — nada foi gravado:\n  ` +
        diferentes.join('\n  ') +
        '\nConfira a diferença (o --dry-run lista) e rode de novo com --overwrite para trazer a versão do servidor.',
      6,
    );
  }
  for (const a of arquivos) {
    if (iguais.includes(a.caminho)) continue;
    const caminho = resolve(raiz, a.caminho);
    mkdirSync(dirname(caminho), { recursive: true });
    if (Buffer.isBuffer(a.conteudo)) writeFileSync(caminho, a.conteudo);
    else writeFileSync(caminho, a.conteudo.endsWith('\n') ? a.conteudo : `${a.conteudo}\n`, 'utf8');
    gravados.push(a.caminho);
  }
  return { novos, iguais, diferentes, gravados };
}

function igual(local: Buffer, doServidor: string | Buffer): boolean {
  return Buffer.isBuffer(doServidor)
    ? local.equals(doServidor)
    : normalizar(local.toString('utf8')) === normalizar(doServidor);
}

export interface OpcoesPullProcess {
  server: Server;
  senha: string;
  processId: string;
  /** Pasta `workflow` do repositório (padrão: `workflow`). */
  pastaWorkflow: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: WorkflowEngineClient;
}

/**
 * Scripts de um processo: os `WorkflowProcessEvent` da definição publicada, em
 * `<workflow>/scripts/<prefixo>.<eventId>.js` — com o prefixo do push process (o
 * nome do `.process` local com este id, ou o próprio id).
 */
export async function pullProcess(opcoes: OpcoesPullProcess): Promise<ResultadoPull & { prefixo: string }> {
  const { server, senha, processId } = opcoes;
  const cliente =
    opcoes.cliente ??
    (await workflowEngineClient(serverUrl(server), server.companyId, server.username, senha, server.userCode));
  if (!(await cliente.listProcessIds()).includes(processId)) {
    throw new ErroFluigctl(`o processo "${processId}" não existe em ${serverUrl(server)}`, 3);
  }
  const definicao = (await cliente.exportProcess(processId)).toString('latin1');
  const { prefixo } = await prefixoDosScripts(opcoes.pastaWorkflow, processId);
  const pastaScripts = join(opcoes.pastaWorkflow, 'scripts');
  const arquivos = eventosDoProcesso(definicao)
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))
    .map((e) => ({ caminho: join(pastaScripts, `${prefixo}.${e.eventId}.js`), conteudo: e.codigo }));
  return { ...aplicarPull('.', arquivos, opcoes), prefixo };
}

export interface OpcoesPullDiagram extends Omit<OpcoesPullProcess, 'pastaWorkflow'> {
  /** Pasta `workflow` do repositório (padrão: `workflow`). */
  pastaWorkflow: string;
  /** Nome do arquivo, sem `.process`; por padrão usa o processId. */
  nomeDoArquivo?: string;
}

/** Baixa a definição ECM 3.0 e a converte para um `.process` editável pelo Studio. */
export async function pullDiagram(opcoes: OpcoesPullDiagram): Promise<ResultadoPull & { arquivo: string }> {
  const cliente = opcoes.cliente ?? (await workflowEngineClient(
    serverUrl(opcoes.server), opcoes.server.companyId, opcoes.server.username, opcoes.senha, opcoes.server.userCode,
  ));
  if (!(await cliente.listProcessIds()).includes(opcoes.processId)) {
    throw new ErroFluigctl(`o processo "${opcoes.processId}" não existe em ${serverUrl(opcoes.server)}`, 3);
  }
  const exportado = (await cliente.exportProcess(opcoes.processId)).toString('latin1');
  const nome = opcoes.nomeDoArquivo ?? opcoes.processId;
  const arquivo = join(opcoes.pastaWorkflow, 'diagrams', `${nome}.process`);
  const convertido = gerarProcess(exportado, nome);
  return { ...aplicarPull('.', [{ caminho: arquivo, conteudo: convertido.process }], opcoes), arquivo };
}

export interface OpcoesPullEvento {
  server: Server;
  senha: string;
  /** `eventId`; sem ele, baixa todos os eventos globais do servidor. */
  eventId?: string;
  /** Raiz do repositório (padrão: a pasta atual). */
  raiz?: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: GlobalEventClient;
}

export interface ResultadoPullEvento extends ResultadoPull {
  /** Os eventos baixados, com o arquivo de cada um. */
  eventos: { eventId: string; arquivo: string }[];
}

/**
 * Eventos globais do servidor para `events/<eventId>.js` — o mesmo arquivo que o
 * `push event` lê. Sem `eventId`, traz todos: o servidor não tem paginação nem
 * filtro, e a lista costuma ser curta.
 */
export async function pullEvent(opcoes: OpcoesPullEvento): Promise<ResultadoPullEvento> {
  const raiz = opcoes.raiz ?? '.';
  const cliente =
    opcoes.cliente ??
    (await globalEventClient(
      serverUrl(opcoes.server),
      opcoes.server.companyId,
      opcoes.server.username,
      opcoes.senha,
    ));

  const disponiveis = await cliente.listar();
  const escolhidos =
    opcoes.eventId === undefined ? disponiveis : disponiveis.filter((e) => e.eventId === opcoes.eventId);
  if (escolhidos.length === 0) {
    throw new ErroFluigctl(
      `não existe evento global "${opcoes.eventId}" em ${serverUrl(opcoes.server)}. ` +
        (disponiveis.length
          ? `Os que existem: ${disponiveis.map((e) => e.eventId).sort().join(', ')}.`
          : 'O servidor não tem nenhum evento global.'),
      3,
    );
  }

  const eventos = escolhidos.map((e) => ({ eventId: e.eventId, arquivo: join('events', `${e.eventId}.js`) }));
  const arquivos: ArquivoBaixado[] = escolhidos.map((e, i) => ({
    caminho: eventos[i]!.arquivo,
    conteudo: e.codigo,
  }));
  return { ...aplicarPull(raiz, arquivos, opcoes), eventos };
}

export interface OpcoesPullMecanismo {
  server: Server;
  senha: string;
  /** `attributionMecanismId`; sem ele, baixa todos os customizados do servidor. */
  mecanismoId?: string;
  raiz?: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: MechanismClient;
}

export interface ResultadoPullMecanismo extends ResultadoPull {
  mecanismos: { mecanismoId: string; arquivo: string }[];
}

/**
 * Mecanismos de atribuição customizados para `mechanisms/<id>.js`. O nome e a
 * descrição de cada um ficam no servidor e não têm onde ir no repositório; vão
 * como aviso, para não sumirem sem ninguém ver.
 */
export async function pullMechanism(opcoes: OpcoesPullMecanismo): Promise<ResultadoPullMecanismo> {
  const raiz = opcoes.raiz ?? '.';
  const cliente =
    opcoes.cliente ??
    (await mechanismClient(
      serverUrl(opcoes.server),
      opcoes.server.companyId,
      opcoes.server.username,
      opcoes.senha,
    ));

  const disponiveis = await cliente.listar();
  const escolhidos =
    opcoes.mecanismoId === undefined
      ? disponiveis
      : disponiveis.filter((m) => m.mecanismoId === opcoes.mecanismoId);
  if (escolhidos.length === 0) {
    throw new ErroFluigctl(
      `não existe mecanismo de atribuição customizado "${opcoes.mecanismoId}" em ${serverUrl(opcoes.server)}. ` +
        (disponiveis.length
          ? `Os que existem: ${disponiveis.map((m) => m.mecanismoId).sort().join(', ')}.`
          : 'O servidor não tem nenhum mecanismo customizado.'),
      3,
    );
  }

  const mecanismos = escolhidos.map((m) => ({
    mecanismoId: m.mecanismoId,
    arquivo: join('mechanisms', `${m.mecanismoId}.js`),
  }));
  const arquivos: ArquivoBaixado[] = escolhidos.map((m, i) => ({
    caminho: mecanismos[i]!.arquivo,
    conteudo: m.codigo,
  }));
  return { ...aplicarPull(raiz, arquivos, opcoes), mecanismos };
}

export interface OpcoesPullWidget {
  server: Server;
  senha: string;
  /** `code` da widget, que é o nome da pasta: `wcm/widget/<code>`. */
  nome: string;
  /** Raiz do repositório (padrão: a pasta atual). */
  raiz?: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Publica a widget auxiliar do Fluiggers, sem a qual não há leitura de widget. */
  instalarHelper?: boolean;
  /** Só o `--instalar-helper` usa: é ele que escreve no servidor. */
  prompt?: PromptSenha;
  /** Para testes. */
  cliente?: WidgetHelperClient;
}

export interface ResultadoPullWidget extends ResultadoPull {
  code: string;
  /** Entradas do `.war` sem lugar na pasta da widget: manifesto e o que se gera de novo. */
  ignorados: string[];
  /** Classes sem código-fonte: vão para `src/main/java` e o push recusa a pasta. */
  compilados: string[];
  avisos: string[];
  /** Arquivos da pasta local que o `.war` do servidor não tem (ficam como estão). */
  soLocais: string[];
  /** A auxiliar foi publicada agora, e não já estava no servidor. */
  helperInstalado: boolean;
}

/** Os arquivos da pasta da widget, relativos a ela, sem dotfiles. */
function arquivosLocaisDaWidget(pasta: string): string[] {
  const achados: string[] = [];
  const visitar = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (entrada.startsWith('.')) continue;
      const caminho = join(dir, entrada);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else achados.push(relative(pasta, caminho).split(sep).join('/'));
    }
  };
  if (existsSync(pasta)) visitar(pasta);
  return achados.sort();
}

/**
 * Uma widget instalada volta para `wcm/widget/<code>`, a pasta que o
 * `push widget` lê — inclusive o `pom.xml` e o `src/main/java` de um pacote
 * compilado, que o push recusa republicar sem build. Como nos outros pull, o
 * local nunca é trocado em silêncio: o que o servidor não tem fica listado, e
 * arquivo local diferente só é sobrescrito com `--overwrite`.
 *
 * A leitura passa pela widget auxiliar do Fluiggers, que é a única rota que
 * existe — o Fluig não expõe serviço para baixar o `.war` instalado. Sem ela no
 * servidor, a recusa aponta o `--instalar-helper`; instalar é publicar, então é
 * explícito e passa pelo portão de produção.
 */
export async function pullWidget(opcoes: OpcoesPullWidget): Promise<ResultadoPullWidget> {
  const { server, senha, nome } = opcoes;
  const raiz = opcoes.raiz ?? '.';
  const url = serverUrl(server);

  // A sessão só abre quando é precisa: com cliente injetado (testes), ou para
  // instalar, quem fala com o servidor é de fora.
  let helper = opcoes.cliente;
  let cookie: string | undefined;
  let instalou = false;
  const sessao = async () => (cookie ??= await login(url, server.username, senha));
  if (!helper) helper = await widgetHelperClient(url, await sessao());

  // A checagem vale sempre; o que o `--instalar-helper` muda é poder resolver a falta.
  if (!(await helper.instalada())) {
    if (!opcoes.instalarHelper) throw semWidgetHelper(url);
    // Instalar é publicar: o --dry-run promete não escrever nada, então não instala.
    if (opcoes.dryRun) {
      throw new ErroFluigctl(
        `o servidor ${url} não tem a widget auxiliar, e o --dry-run não publica nada — ` +
          'sem ela não há como listar nem baixar widget. Rode sem --dry-run para publicá-la.',
        3,
      );
    }
    await confirmProduction(
      server,
      senha,
      'instalar a widget auxiliar do Fluiggers (ela publica uma widget no servidor)',
      opcoes.prompt ?? (async () => ''),
    );
    await instalarWidgetHelper(url, await sessao());
    instalou = true;
  }

  const disponiveis = await helper.listar();
  const escolhida = disponiveis.find((w) => w.code === nome);
  if (!escolhida) {
    const parecidas = disponiveis.filter((w) => w.code.toLowerCase() === nome.toLowerCase()).map((w) => w.code);
    const dica = parecidas.length === 1 ? ` Existe uma com outra caixa: ${parecidas[0]}.` : '';
    throw new ErroFluigctl(
      `não existe widget "${nome}" em ${url}.${dica} ` +
        (disponiveis.length
          ? `As instaladas são: ${disponiveis.map((w) => w.code).sort().join(', ')}.`
          : 'O servidor não devolveu nenhuma widget instalada.'),
      3,
    );
  }
  if (!escolhida.filename) {
    throw new ErroFluigctl(`a widget auxiliar não informou o arquivo da widget "${nome}"`, 7);
  }

  const desmontado = desmontarWar(entradasDoZip(await helper.baixar(escolhida.filename), `o pacote da widget "${nome}"`), nome);
  const pasta = join('wcm', 'widget', escolhida.code);
  const arquivos: ArquivoBaixado[] = desmontado.arquivos.map((a) => ({
    caminho: join(pasta, a.caminho),
    conteudo: a.dados,
  }));

  const avisos: string[] = [];
  if (desmontado.compilados.length) {
    avisos.push(
      `a widget "${nome}" tem ${desmontado.compilados.length} arquivo(s) compilado(s), guardado(s) em src/main/java: ` +
        'o push widget recusa essa pasta, porque compilar de novo é trabalho do Maven.',
    );
  }
  const locais = arquivosLocaisDaWidget(join(raiz, pasta));
  const doServidor = new Set(desmontado.arquivos.map((a) => a.caminho));

  return {
    ...aplicarPull(raiz, arquivos, opcoes),
    code: escolhida.code,
    ignorados: desmontado.ignorados,
    compilados: desmontado.compilados,
    avisos,
    soLocais: locais.filter((l) => !doServidor.has(l)),
    helperInstalado: instalou,
  };
}

/** As widgets instaladas no servidor, para o `--list`. Só lê. */
export async function listarWidgets(opcoes: {
  server: Server;
  senha: string;
  cliente?: WidgetHelperClient;
}): Promise<{ code: string; title: string; description: string }[]> {
  const url = serverUrl(opcoes.server);
  const helper = opcoes.cliente ?? (await widgetHelperClient(url, await login(url, opcoes.server.username, opcoes.senha)));
  if (!(await helper.instalada())) throw semWidgetHelper(url);
  return (await helper.listar()).map(({ code, title, description }) => ({ code, title, description }));
}

export interface OpcoesPullDataset {
  server: Server;
  senha: string;
  nome: string;
  /** Raiz do repositório (padrão: a pasta atual). */
  raiz?: string;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  carregar?: (nome: string) => Promise<DatasetNoServidor>;
}

/** Os `datasets/**\/<nome>.js` do repositório. */
function datasetsLocais(raiz: string, nome: string): string[] {
  const achados: string[] = [];
  const visitar = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const caminho = join(dir, entrada);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (entrada === `${nome}.js`) achados.push(relative(raiz, caminho));
    }
  };
  if (existsSync(join(raiz, 'datasets'))) visitar(join(raiz, 'datasets'));
  return achados.sort();
}

/**
 * Código de um dataset, no arquivo que o repositório já tem para ele
 * (`datasets/**\/<nome>.js`) ou, sem nenhum, em `datasets/<nome>.js`. Dois
 * arquivos com o nome: recusa, por não saber qual é.
 */
export async function pullDataset(opcoes: OpcoesPullDataset): Promise<ResultadoPull & { arquivo: string }> {
  const raiz = opcoes.raiz ?? '.';
  const locais = datasetsLocais(raiz, opcoes.nome);
  if (locais.length > 1) {
    throw new ErroFluigctl(`mais de um arquivo para o dataset "${opcoes.nome}": ${locais.join(', ')}`, 6);
  }
  const carregar =
    opcoes.carregar ??
    (async (nome: string) => {
      const url = serverUrl(opcoes.server);
      return loadDataset(url, await login(url, opcoes.server.username, opcoes.senha), nome);
    });
  const noServidor = await carregar(opcoes.nome);
  if (noServidor.impl === undefined) {
    throw new ErroFluigctl(`o dataset "${opcoes.nome}" não existe em ${serverUrl(opcoes.server)} (ou não é customizado)`, 3);
  }
  if (noServidor.tipo !== undefined && noServidor.tipo !== 'CUSTOM') {
    throw new ErroFluigctl(`o dataset "${opcoes.nome}" é ${noServidor.tipo}, não customizado: não tem código JavaScript para baixar`, 6);
  }
  const arquivo = locais[0] ?? join('datasets', `${opcoes.nome}.js`);
  return { ...aplicarPull(raiz, [{ caminho: arquivo, conteudo: noServidor.impl }], opcoes), arquivo };
}

export interface OpcoesPullForm {
  server: Server;
  senha: string;
  /** Pasta do formulário no repositório; se ainda não existir, é criada (o alvo sai do nome dela ou do `documentId`). */
  pasta: string;
  documentId?: number;
  dryRun?: boolean;
  sobrescrever?: boolean;
  /** Para testes. */
  cliente?: CardIndexClient;
  versao?: (documentId: number) => Promise<number>;
}

export interface ResultadoPullForm extends ResultadoPull {
  documentId: number;
  versao: number;
  avisos: string[];
  /** Arquivos da pasta local que o servidor não tem (ficam como estão). */
  soLocais: string[];
}

/**
 * Anexos e eventos de um formulário publicado, na pasta dele. O alvo é
 * resolvido como no push form (`--document-id`, prefixo da pasta, `.metadata`
 * do Studio, nome). O servidor guarda os anexos só pelo nome, então cada um vai
 * para o arquivo local de mesmo nome, em qualquer subpasta (`libs/x.js`), ou
 * para a raiz da pasta; os eventos vão para `events/<evento>.js`.
 */
export async function pullForm(opcoes: OpcoesPullForm): Promise<ResultadoPullForm> {
  const { server, senha, pasta } = opcoes;
  const url = serverUrl(server);
  const existe = existsSync(pasta);

  const cliente =
    opcoes.cliente ?? (await cardIndexClient(url, server.companyId, server.username, senha, server.userCode));
  const { nome, documentIdDaPasta } = nomeDaPasta(pasta);
  const metadata = join(pasta, '.metadata');
  const studio = existsSync(metadata) ? lerMetadataStudio(readFileSync(metadata)) : undefined;
  let decisao;
  try {
    decisao = decideForm({
      nome,
      catalogo: await cliente.listForms(),
      ...(studio === undefined ? {} : { studio }),
      ...(opcoes.documentId === undefined ? {} : { documentId: opcoes.documentId }),
      ...(documentIdDaPasta === undefined ? {} : { documentIdDaPasta }),
    });
  } catch (erro) {
    // A recusa do push ensina a criar o formulário; no pull, só não há o que baixar.
    if (erro instanceof ErroFluigctl && /não existe neste servidor\. Para criá-lo/.test(erro.message)) {
      throw new ErroFluigctl(`o formulário "${nome}" não existe em ${url}; se tem outro nome lá, use --document-id`, 3);
    }
    throw erro;
  }
  if (decisao.acao !== 'update') throw new ErroFluigctl(`o formulário "${nome}" não existe em ${url}`, 3);
  const { documentId } = decisao;

  const versao = await (opcoes.versao ?? (async (id: number) => versaoAtiva(url, await login(url, server.username, senha), id)))(documentId);

  const locais = existe ? await arquivosDaPasta(pasta) : [];
  const porNome = new Map<string, string[]>();
  for (const local of locais) {
    const n = local.split('/').pop()!;
    porNome.set(n, [...(porNome.get(n) ?? []), local]);
  }

  const arquivos: ArquivoBaixado[] = [];
  const doServidor = new Set<string>();
  for (const anexo of (await cliente.listAttachments(documentId)).sort()) {
    const candidatos = porNome.get(anexo) ?? [];
    if (candidatos.length > 1) {
      throw new ErroFluigctl(
        `o anexo "${anexo}" do servidor tem mais de um arquivo local com o nome: ${candidatos.join(', ')}. ` +
          'O push também recusa esta pasta; renomeie um deles.',
        6,
      );
    }
    const relativo = candidatos[0] ?? anexo;
    doServidor.add(relativo);
    arquivos.push({ caminho: join(pasta, relativo), conteudo: await cliente.attachmentContent(documentId, versao, anexo) });
  }
  for (const e of (await cliente.events(documentId)).sort((a, b) => (a.eventId < b.eventId ? -1 : 1))) {
    arquivos.push({ caminho: join(pasta, 'events', `${e.eventId}.js`), conteudo: e.eventDescription });
  }

  return {
    ...aplicarPull('.', arquivos, opcoes),
    documentId,
    versao,
    avisos: decisao.avisos,
    soLocais: locais.filter((l) => !doServidor.has(l)),
  };
}
