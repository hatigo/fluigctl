import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ErroFluigctl } from '../errors.js';
import { CONTEXTO_PADRAO, type ContextoPreview } from './frame-api.js';
import { resolveFormSource, startPreviewCore } from './preview-core.js';
import { diretorioDoCache, lerManifesto, mensagemCacheAusente } from './style-guide.js';

export interface RegistroPreview {
  version: 1;
  arquivo: string;
  raiz: string;
  pid: number;
  port: number;
  token: string;
}

export function diretorioDePreview(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'fluigctl', 'formularios');
}

export function arquivoDoRegistro(arquivo: string, dir = diretorioDePreview()): string {
  const id = createHash('sha256').update(resolve(arquivo)).digest('hex').slice(0, 24);
  return join(dir, `${id}.json`);
}

function salvarRegistro(registro: RegistroPreview, caminho: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const temporario = `${caminho}.${process.pid}.tmp`;
  writeFileSync(temporario, `${JSON.stringify(registro, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // O rename atômico evita que outro `open` leia metade do JSON.
  renameSync(temporario, caminho);
}

export function lerRegistro(arquivo: string, dir?: string): RegistroPreview | undefined {
  const caminho = arquivoDoRegistro(arquivo, dir);
  try {
    const registro = JSON.parse(readFileSync(caminho, 'utf8')) as RegistroPreview;
    if (registro.version !== 1 || resolve(registro.arquivo) !== resolve(arquivo)) return undefined;
    return registro;
  } catch {
    return undefined;
  }
}

export function urlDoRegistro(r: RegistroPreview): string {
  return `http://127.0.0.1:${r.port}/control/${r.token}`;
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Confirma pelo token e pelo arquivo antes de confiar num PID persistido. */
async function registroAtivo(registro: RegistroPreview): Promise<boolean> {
  if (!processoVivo(registro.pid)) return false;
  try {
    const resposta = await fetch(`http://127.0.0.1:${registro.port}/state/${registro.token}`, {
      signal: AbortSignal.timeout(600),
    });
    if (!resposta.ok) return false;
    const estado = (await resposta.json()) as { arquivo?: unknown };
    return typeof estado.arquivo === 'string' && resolve(estado.arquivo) === resolve(registro.arquivo);
  } catch {
    return false;
  }
}

function abrirNavegador(url: string): void {
  const sistema = platform();
  const comando = sistema === 'darwin' ? 'open' : sistema === 'win32' ? 'cmd' : 'xdg-open';
  const args = sistema === 'win32' ? ['/c', 'start', '', url] : [url];
  const filho = spawn(comando, args, { detached: true, stdio: 'ignore' });
  filho.on('error', (erro) => console.error(`aviso: não consegui abrir o navegador: ${String(erro)}. Abra ${url}`));
  filho.unref();
}

export async function servirPreview(opcoes: {
  arquivo: string; token?: string; registroDir?: string; cacheDir?: string; pid?: number; contexto?: ContextoPreview;
}): Promise<{ registro: RegistroPreview; url: string; fechar(): Promise<void> }> {
  const source = resolveFormSource(opcoes.arquivo);
  const preview = await startPreviewCore(opcoes.arquivo, {
    ...(opcoes.cacheDir === undefined ? {} : { cacheDir: opcoes.cacheDir }),
    ...(opcoes.contexto === undefined ? {} : { contexto: opcoes.contexto }),
  });
  const registro: RegistroPreview = {
    version: 1,
    arquivo: source.html,
    raiz: source.root,
    pid: opcoes.pid ?? process.pid,
    port: preview.port,
    token: preview.token,
  };
  const caminho = arquivoDoRegistro(source.html, opcoes.registroDir);
  salvarRegistro(registro, caminho);
  let fechamento: Promise<void> | undefined;
  const fechar = (): Promise<void> => {
    fechamento ??= (async () => {
      await preview.close();
      rmSync(caminho, { force: true });
    })();
    return fechamento;
  };
  return { registro, url: urlDoRegistro(registro), fechar };
}

export async function abrirPreview(opcoes: {
  arquivo: string; abrirNavegador?: boolean; foreground?: boolean;
  registroDir?: string; cacheDir?: string; servidorAlias?: string; cli?: string; contexto?: ContextoPreview;
}): Promise<{ registro: RegistroPreview; url: string; reutilizada: boolean }> {
  // O cache efetivo é resolvido aqui e repassado ao filho: sem isso o preview
  // em segundo plano não receberia o diretório padrão e serviria 404 no Style Guide.
  const cacheDir = opcoes.cacheDir ?? diretorioDoCache();
  // Sem cache não há preview: exige o bootstrap explícito, sem baixar nada sozinho.
  if (lerManifesto(cacheDir) === undefined) {
    throw new ErroFluigctl(mensagemCacheAusente(opcoes.servidorAlias), 3);
  }
  const source = resolveFormSource(opcoes.arquivo);
  const anterior = lerRegistro(source.html, opcoes.registroDir);
  if (anterior && await registroAtivo(anterior)) {
    const url = urlDoRegistro(anterior);
    if (opcoes.abrirNavegador !== false) abrirNavegador(url);
    return { registro: anterior, url, reutilizada: true };
  }
  if (anterior) rmSync(arquivoDoRegistro(source.html, opcoes.registroDir), { force: true });

  const comum = {
    arquivo: source.html,
    cacheDir,
    contexto: opcoes.contexto ?? CONTEXTO_PADRAO,
    ...(opcoes.registroDir === undefined ? {} : { registroDir: opcoes.registroDir }),
  };

  if (opcoes.foreground) {
    const instancia = await servirPreview(comum);
    if (opcoes.abrirNavegador !== false) abrirNavegador(instancia.url);
    return { registro: instancia.registro, url: instancia.url, reutilizada: false };
  }

  const token = randomBytes(24).toString('hex');
  const cli = opcoes.cli ?? process.argv[1];
  if (!cli) throw new ErroFluigctl('não consegui localizar o executável do fluigctl para iniciar o preview', 1);
  const args = [cli, 'form', 'serve', source.html, '--token', token];
  if (opcoes.registroDir) args.push('--registry-dir', opcoes.registroDir);
  args.push('--cache-dir', cacheDir);
  const contexto = opcoes.contexto ?? CONTEXTO_PADRAO;
  args.push('--modo', contexto.modo, '--atividade', String(contexto.atividade), '--usuario', contexto.usuario);
  if (contexto.processo !== undefined) args.push('--processo', String(contexto.processo));
  if (contexto.empresa !== undefined) args.push('--empresa', String(contexto.empresa));
  const filho = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  filho.unref();

  const limite = Date.now() + 5_000;
  let registro: RegistroPreview | undefined;
  while (Date.now() < limite) {
    await new Promise((ok) => setTimeout(ok, 40));
    registro = lerRegistro(source.html, opcoes.registroDir);
    if (registro && registro.pid === filho.pid) break;
    if (filho.exitCode !== null) break;
  }
  if (!registro || registro.pid !== filho.pid) {
    try { process.kill(filho.pid!, 'SIGTERM'); } catch { /* já terminou */ }
    throw new ErroFluigctl('o preview não iniciou em 5 segundos', 1);
  }
  const url = urlDoRegistro(registro);
  if (opcoes.abrirNavegador !== false) abrirNavegador(url);
  return { registro, url, reutilizada: false };
}

export async function fecharPreview(arquivo: string, registroDir?: string): Promise<RegistroPreview | undefined> {
  let alvo: string;
  try { alvo = resolveFormSource(arquivo).html; } catch { alvo = resolve(arquivo); }
  const registro = lerRegistro(alvo, registroDir);
  if (!registro) return undefined;
  // Um PID pode ser reciclado pelo sistema. Só o mata depois que o endpoint com
  // token confirmou que ele serve exatamente o arquivo deste registro.
  if (await registroAtivo(registro)) {
    try { process.kill(registro.pid, 'SIGTERM'); } catch { /* corrida: ele já saiu */ }
  }
  rmSync(arquivoDoRegistro(alvo, registroDir), { force: true });
  return registro;
}

/** Só o subcomando interno usa: mantém o filho vivo e limpa o registro ao sair. */
export async function executarServidorPreview(opcoes: {
  arquivo: string; token?: string; registroDir?: string; cacheDir?: string; contexto?: ContextoPreview;
}): Promise<never> {
  const instancia = await servirPreview(opcoes);
  const encerrar = async () => {
    await instancia.fechar();
    process.exit(0);
  };
  process.once('SIGTERM', () => void encerrar());
  process.once('SIGINT', () => void encerrar());
  return new Promise<never>(() => undefined);
}
