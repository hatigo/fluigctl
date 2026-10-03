import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Requisicao {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** O corpo como chegou, para o que não é texto (multipart com binário). */
  corpo: Buffer;
}

export interface RotaResposta {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
}

export interface FakeFluig {
  url: string;
  requests: Requisicao[];
  close(): Promise<void>;
}

/** Sobe um Fluig de mentira em 127.0.0.1 numa porta livre. */
export async function fakeFluig(
  rotas: Record<string, RotaResposta | ((req: Requisicao) => RotaResposta)>,
): Promise<FakeFluig> {
  const requests: Requisicao[] = [];

  const server: Server = createServer((req: IncomingMessage, res) => {
    const pedacos: Buffer[] = [];
    req.on('data', (c: Buffer) => pedacos.push(c));
    req.on('end', () => {
      const caminho = (req.url ?? '').split('?')[0] ?? '';
      const registro: Requisicao = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(pedacos).toString('utf8'),
        corpo: Buffer.concat(pedacos),
      };
      requests.push(registro);

      const rota = rotas[caminho];
      if (!rota) {
        res.writeHead(404).end('rota não registrada: ' + caminho);
        return;
      }
      const resposta = typeof rota === 'function' ? rota(registro) : rota;
      res.writeHead(resposta.status ?? 200, resposta.headers ?? {});
      res.end(resposta.body ?? '');
    });
  });

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
