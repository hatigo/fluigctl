import { createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Server } from './config.js';

/**
 * Senhas da extensão Fluiggers (`.vscode/servers.json`).
 *
 * A extensão grava a senha em AES-256-CBC, com a chave derivada por scrypt do
 * `telemetry.machineId` do VS Code — o do `storage.json` do perfil, não o
 * arquivo `machineid`. O blob é base64 de um JSON `{ salt, iv, text }`, tudo em
 * hex. Mesmo formato que a skill publicar-fluig decifra.
 *
 * A senha decifrada só volta para quem chamou: nada aqui imprime, grava ou
 * registra o valor.
 */

export interface ArquivoServidores {
  path: string;
  conteudo: string;
}

export interface SenhaDoVscode {
  senha: string;
  /** O servers.json de onde a senha saiu. */
  origem: string;
}

interface EntradaComSenha {
  host?: string;
  port?: number;
  ssl?: boolean;
  username?: string;
  password?: string;
}

/** Onde o VS Code (e o Cursor, que é um fork) guardam o storage.json do perfil. */
function caminhosStorage(home: string, plataforma: NodeJS.Platform): string[] {
  const relativos =
    plataforma === 'darwin'
      ? [
          'Library/Application Support/Code/User/globalStorage/storage.json',
          'Library/Application Support/Code - Insiders/User/globalStorage/storage.json',
          'Library/Application Support/Cursor/User/globalStorage/storage.json',
        ]
      : plataforma === 'win32'
        ? [
            'AppData/Roaming/Code/User/globalStorage/storage.json',
            'AppData/Roaming/Code - Insiders/User/globalStorage/storage.json',
            'AppData/Roaming/Cursor/User/globalStorage/storage.json',
          ]
        : [
            '.config/Code/User/globalStorage/storage.json',
            '.config/Code - Insiders/User/globalStorage/storage.json',
            '.config/Cursor/User/globalStorage/storage.json',
            '.config/VSCodium/User/globalStorage/storage.json',
          ];
  return relativos.map((r) => join(home, r));
}

/** Os machineIds dos editores instalados — qualquer um deles pode ter cifrado a senha. */
export function machineIds(
  home: string = homedir(),
  plataforma: NodeJS.Platform = process.platform,
): string[] {
  const ids: string[] = [];
  for (const arquivo of caminhosStorage(home, plataforma)) {
    try {
      const dados = JSON.parse(readFileSync(arquivo, 'utf8')) as Record<string, unknown>;
      const id = dados['telemetry.machineId'];
      if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
    } catch {
      // editor não instalado, ou arquivo ilegível: tenta o próximo
    }
  }
  return ids;
}

function blob(texto: string): { salt: string; iv: string; text: string } | undefined {
  try {
    const dados = JSON.parse(Buffer.from(texto, 'base64').toString('utf8')) as Record<string, unknown>;
    const { salt, iv, text } = dados;
    if (typeof salt === 'string' && typeof iv === 'string' && typeof text === 'string') {
      return { salt, iv, text };
    }
  } catch {
    // não é base64 de JSON: senha em claro
  }
  return undefined;
}

export function pareceCifrada(texto: string): boolean {
  return blob(texto) !== undefined;
}

/** Decifra com um machineId. Lança se a chave não for a certa. */
export function decifrar(texto: string, machineId: string): string {
  const dados = blob(texto);
  if (!dados) throw new Error('a senha não está no formato da extensão');
  const chave = scryptSync(machineId, Buffer.from(dados.salt, 'hex'), 32);
  const decifrador = createDecipheriv('aes-256-cbc', chave, Buffer.from(dados.iv, 'hex'));
  return Buffer.concat([
    decifrador.update(Buffer.from(dados.text, 'hex')),
    decifrador.final(),
  ]).toString('utf8');
}

/** Mesma identidade do `server import`: host, porta, ssl e usuário. */
function mesmoServidor(entrada: EntradaComSenha, server: Server): boolean {
  const ssl = entrada.ssl ?? false;
  const porta = entrada.port ?? (ssl ? 443 : 80);
  return (
    (entrada.host ?? '').toLowerCase() === server.host.toLowerCase() &&
    porta === server.port &&
    ssl === server.ssl &&
    (entrada.username ?? '').toLowerCase() === server.username.toLowerCase()
  );
}

/**
 * Procura a senha de `server` nos servers.json dados.
 *
 * O primeiro arquivo cuja entrada casa E decifra vence. Uma entrada que casa mas
 * não decifra (cifrada noutra máquina) é pulada — outro projeto pode ter a mesma
 * senha cifrada com a chave desta.
 */
export function senhaNosArquivos(
  server: Server,
  arquivos: readonly ArquivoServidores[],
  ids: readonly string[],
): SenhaDoVscode | undefined {
  for (const arquivo of arquivos) {
    let entradas: EntradaComSenha[];
    try {
      entradas =
        (JSON.parse(arquivo.conteudo) as { configurations?: EntradaComSenha[] }).configurations ?? [];
    } catch {
      continue;
    }

    for (const entrada of entradas) {
      if (!mesmoServidor(entrada, server) || !entrada.password) continue;

      if (!pareceCifrada(entrada.password)) {
        return { senha: entrada.password, origem: arquivo.path };
      }
      for (const id of ids) {
        try {
          return { senha: decifrar(entrada.password, id), origem: arquivo.path };
        } catch {
          // chave de outro editor ou de outra máquina
        }
      }
    }
  }
  return undefined;
}

/** Os `.vscode/servers.json` de `inicio` para cima, do mais próximo ao mais distante. */
export function serversJsonAcima(inicio: string): ArquivoServidores[] {
  const achados: ArquivoServidores[] = [];
  let dir = inicio;
  for (;;) {
    const arquivo = join(dir, '.vscode', 'servers.json');
    if (existsSync(arquivo)) {
      try {
        achados.push({ path: arquivo, conteudo: readFileSync(arquivo, 'utf8') });
      } catch {
        // ilegível: ignora
      }
    }
    const pai = dirname(dir);
    if (pai === dir) return achados;
    dir = pai;
  }
}
