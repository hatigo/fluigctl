import { join } from 'node:path';

import {
  envFilePath,
  loadConfig,
  resolvePassword,
  saveConfig,
  serverUrl,
  type Config,
  type Server,
} from '../config.js';
import { ErroFluigctl } from '../errors.js';
import { gravarNoEnv } from '../env-file.js';
import { findUserByLogin, login } from '../fluig/session.js';
import { importCandidates, scanServersJson } from '../import.js';
import { machineIds, senhaNosArquivos } from '../vscode-credentials.js';
import { desenhar } from '../tui/desenho.js';
import {
  estadoInicial,
  reduzir,
  type CandidatoImport,
  type Efeito,
  type Estado,
  type Evento,
  type LinhaServidor,
} from '../tui/servidores.js';
import { abrirTerminal, type Terminal } from '../tui/terminal.js';
import { addServer, defaultPasswordEnv, removeServer, setProd } from './server.js';
import { testServer } from './server-test.js';

/**
 * O shell do TUI de servidores: liga o terminal ao modelo puro de
 * `tui/servidores.ts`.
 *
 * Quem tem efeito colateral — disco e rede — é só este arquivo, e ele não decide
 * nada: obedece ao efeito que o redutor devolveu e devolve o resultado como
 * evento. Toda a regra de tela (o que cada tecla faz, o que é válido antes de
 * tentar) mora no redutor, onde os testes alcançam sem terminal.
 *
 * O cadastro é o mesmo do CLI: `addServer`, `removeServer`, `setProd`,
 * `testServer`, `scanServersJson` e `gravarNoEnv`. O TUI não reimplementa
 * nenhum deles, então não pode divergir do `fluigctl server ...`.
 *
 * Efeitos que falam com o servidor são os únicos assíncronos, e mostram
 * "conectando..." antes de esperar: o desenho não pode parecer travado.
 */

export interface OpcoesServerUi {
  /** Diretório inicial da importação (padrão: `~/fluig/workspaces`). */
  dir?: string;
  /** Para testes: um terminal de mentira. */
  terminal?: Terminal;
}

export async function serverUi(opcoes: OpcoesServerUi = {}): Promise<void> {
  const terminal = opcoes.terminal ?? abrirTerminal();
  const dirPadrao = opcoes.dir ?? join(process.env['HOME'] ?? '', 'fluig', 'workspaces');

  let estado = estadoInicial(linhas(loadConfig()), dirPadrao);
  // O desenho recebe o estado, e não o lê de fora: o `drenar` mexe no estado
  // dele, e um `pinta` que lesse a variável de fora desenharia o quadro
  // anterior ao resultado da operação.
  const pinta = (e: Estado) => {
    const { colunas, linhas: altura } = terminal.tamanho();
    terminal.desenhar(desenhar(e, colunas, altura));
  };

  pinta(estado);
  try {
    for await (const tecla of terminal.teclas()) {
      const passo = reduzir(estado, { tipo: 'tecla', tecla });
      estado = passo.estado;
      pinta(estado);
      if (estado.sair) break;
      estado = await drenar(terminal, estado, passo.efeitos, pinta);
      if (estado.sair) break;
    }
  } finally {
    terminal.fechar();
  }
}

/**
 * Executa a fila de efeitos até esvaziar, aplicando cada resultado ao estado.
 *
 * A fila é finita: efeito que pede rede devolve `recado` ou `teste`, e nenhum
 * dos dois gera efeito. O limite existe só para o caso de um ciclo aparecer numa
 * mudança futura — melhor parar com erro do que girar.
 */
async function drenar(
  terminal: Terminal,
  inicial: Estado,
  fila: Efeito[],
  pinta: (e: Estado) => void,
): Promise<Estado> {
  let estado = inicial;
  const pendentes = [...fila];
  let passos = 0;

  while (pendentes.length > 0) {
    if (++passos > 20) throw new ErroFluigctl('o TUI entrou em laço de efeitos', 6);
    const efeito = pendentes.shift()!;

    if (precisaDeRede(efeito)) {
      const { colunas, linhas } = terminal.tamanho();
      terminal.desenhar(desenhar({ ...estado, recado: { tom: 'aviso', texto: 'conectando...' } }, colunas, linhas));
    }

    for (const evento of await executar(efeito)) {
      const r = reduzir(estado, evento);
      estado = r.estado;
      pendentes.push(...r.efeitos);
    }
    pinta(estado);
  }

  return estado;
}

const precisaDeRede = (e: Efeito) => e.tipo === 'salvar' || e.tipo === 'testar' || e.tipo === 'importar' || e.tipo === 'listarParaImportar';

function linhas(config: Config): LinhaServidor[] {
  return Object.entries(config.servers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([nome, s]) => ({
      nome,
      host: s.host,
      porta: s.port,
      ssl: s.ssl,
      usuario: s.username,
      companyId: s.companyId,
      userCode: s.userCode,
      senhaEnv: s.passwordEnv,
      prod: s.prod === true,
    }));
}

const recado = (tom: 'ok' | 'erro' | 'aviso', texto: string): Evento => ({ tipo: 'recado', tom, texto });
const recarregou = (): Evento => ({ tipo: 'servidores', servidores: linhas(loadConfig()) });

async function executar(efeito: Efeito): Promise<Evento[]> {
  switch (efeito.tipo) {
    case 'sair':
      return [];

    case 'recarregar':
      return [recarregou()];

    case 'salvar':
      return salvar(efeito);

    case 'testar':
      return testar(efeito.nome);

    case 'listarParaImportar':
      return listarCandidatos(efeito.dir);

    case 'importar':
      return importar(efeito.dir, efeito.nomes, efeito.comSenhas);

    case 'remover':
      try {
        saveConfig(removeServer(loadConfig(), efeito.nome));
        return [
          recarregou(),
          recado(
            'ok',
            `"${efeito.nome}" removido do cadastro. A senha no arquivo próprio não foi tocada.`,
          ),
        ];
      } catch (erro) {
        return [recado('erro', (erro as Error).message)];
      }

    case 'alternarProd':
      try {
        saveConfig(setProd(loadConfig(), efeito.nome, efeito.prod));
        return [
          recarregou(),
          recado(
            'ok',
            efeito.prod
              ? `"${efeito.nome}" marcado como PRODUÇÃO: o push passa a exigir a senha digitada no terminal.`
              : `"${efeito.nome}" deixou de ser produção.`,
          ),
        ];
      } catch (erro) {
        return [recado('erro', (erro as Error).message)];
      }
  }
}

/**
 * Salvar segue a ordem do `server add`: prova a credencial **antes** de gravar.
 * Cadastro pela metade — servidor gravado com companyId 0 porque o login falhou —
 * seria pior do que não gravar, e é o que o CLI também evita.
 */
async function salvar(efeito: Extract<Efeito, { tipo: 'salvar' }>): Promise<Evento[]> {
  try {
    const atual = loadConfig();
    if (efeito.original === undefined && atual.servers[efeito.nome]) {
      return [{ tipo: 'salvo', ok: false, texto: `o servidor "${efeito.nome}" já existe. Remova-o antes de recadastrar.` }];
    }

    // Campo a campo, como no `server add`: nada além do esperado entra no arquivo.
    const provisorio: Server = {
      host: efeito.host,
      port: efeito.porta,
      ssl: efeito.ssl,
      username: efeito.usuario,
      companyId: 0,
      userCode: '',
      passwordEnv: defaultPasswordEnv(efeito.nome),
    };

    // A senha digitada vai para o arquivo próprio (600), nunca para o
    // servidores.json — a mesma regra do `server import --with-passwords`.
    if (efeito.senha !== undefined) gravarNoEnv(envFilePath(), provisorio.passwordEnv, efeito.senha);

    const senha = efeito.senha ?? resolvePassword(provisorio);
    const url = serverUrl(provisorio);
    const cookie = await login(url, provisorio.username, senha);
    const usuario = await findUserByLogin(url, cookie, provisorio.username);

    // Rever um servidor é tirar o antigo e gravar o novo, com ou sem troca de
    // nome: `addServer` recusa nome que já existe, de propósito, e por isso uma
    // edição sem renomear não podia passar por ele em cima do registro atual.
    let config = atual;
    if (efeito.original !== undefined) {
      config = removeServer(config, efeito.original);
    }
    config = addServer(config, efeito.nome, {
      ...provisorio,
      companyId: usuario.companyId,
      userCode: usuario.userCode,
    });
    saveConfig(config);

    return [
      { tipo: 'servidores', servidores: linhas(config) },
      {
        tipo: 'salvo',
        ok: true,
        texto:
          `"${efeito.nome}" cadastrado em ${url} · companyId ${usuario.companyId} · userCode ${usuario.userCode}` +
          (efeito.senha === undefined ? '' : ` · senha gravada em ${envFilePath()}`),
      },
    ];
  } catch (erro) {
    return [{ tipo: 'salvo', ok: false, texto: `${(erro as Error).message} — nada foi gravado.` }];
  }
}

async function testar(nome: string): Promise<Evento[]> {
  try {
    const servidor = loadConfig().servers[nome];
    if (!servidor) return [recado('erro', `"${nome}" não está mais no cadastro.`)];
    const r = await testServer(servidor, resolvePassword(servidor));
    return [
      {
        tipo: 'teste',
        teste: {
          nome,
          ok: r.pingOk && r.divergencias.length === 0,
          detalhe: [
            r.pingOk ? 'ping ok' : 'PING FALHOU',
            `companyId ${r.companyId}`,
            `userCode ${r.userCode}`,
            ...r.divergencias,
          ],
        },
      },
    ];
  } catch (erro) {
    return [{ tipo: 'teste', teste: { nome, ok: false, detalhe: [(erro as Error).message] } }];
  }
}

async function listarCandidatos(dir: string): Promise<Evento[]> {
  try {
    const arquivos = await scanServersJson(dir);
    const { candidatos } = importCandidates(arquivos);
    const config = loadConfig();
    const naTela: CandidatoImport[] = candidatos.map((c) => ({
      nome: c.nome,
      url: serverUrl(c.servidor),
      usuario: c.servidor.username,
      prod: c.servidor.prod === true,
      jaExiste: config.servers[c.nome] !== undefined,
      // Já entra marcado o que pode ser gravado; o que existe fica fora.
      marcado: config.servers[c.nome] === undefined,
    }));
    return [{ tipo: 'candidatos', dir, candidatos: naTela }];
  } catch (erro) {
    return [recado('erro', (erro as Error).message)];
  }
}

async function importar(dir: string, nomes: string[], comSenhas: boolean): Promise<Evento[]> {
  try {
    const arquivos = await scanServersJson(dir);
    const { candidatos } = importCandidates(arquivos);
    const escolhidos = candidatos.filter((c) => nomes.includes(c.nome));
    if (escolhidos.length === 0) return [recado('aviso', 'nenhum candidato marcado')];

    let config = loadConfig();
    for (const c of escolhidos) {
      if (config.servers[c.nome]) continue; // já cadastrado: mantido, como no `server import`
      config = addServer(config, c.nome, c.servidor);
    }
    saveConfig(config);

    let senhas = '';
    if (comSenhas) {
      const ids = machineIds();
      let quantas = 0;
      for (const c of escolhidos) {
        const achada = senhaNosArquivos(config.servers[c.nome]!, arquivos, ids);
        if (!achada) continue;
        gravarNoEnv(envFilePath(), config.servers[c.nome]!.passwordEnv, achada.senha);
        quantas++;
      }
      senhas = ` Senhas copiadas: ${quantas} de ${escolhidos.length}.`;
    }

    return [
      { tipo: 'servidores', servidores: linhas(config) },
      recado('ok', `${escolhidos.length} servidor(es) gravados.${senhas}`),
    ];
  } catch (erro) {
    return [recado('erro', (erro as Error).message)];
  }
}
