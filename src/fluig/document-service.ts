import { ErroFluigctl } from '../errors.js';

/**
 * Versão ativa de um documento (REST `activedocument`). O SOAP do formulário
 * exige a versão para devolver um anexo e recusa qualquer outra, e nenhuma
 * operação dele a informa. Começa em 1000 e o `--new-version` soma 1000.
 */
export async function versaoAtiva(baseUrl: string, cookie: string, documentId: number): Promise<number> {
  const resposta = await fetch(`${baseUrl}/api/public/ecm/document/activedocument/${documentId}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const texto = await resposta.text();
  let versao: unknown;
  try {
    versao = (JSON.parse(texto) as { content?: { version?: unknown } }).content?.version;
  } catch {
    versao = undefined;
  }
  if (typeof versao !== 'number' || !Number.isInteger(versao)) {
    throw new ErroFluigctl(
      `o servidor não informou a versão do documento ${documentId} (HTTP ${resposta.status})`,
      7,
    );
  }
  return versao;
}
