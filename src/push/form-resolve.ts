import { ErroFluigctl } from '../errors.js';
import type { FormNoServidor } from '../fluig/cardindex-service.js';
import type { MetadataStudio } from './studio-metadata.js';

export interface EntradaDecisao {
  nome: string;
  catalogo: readonly FormNoServidor[];
  documentId?: number;
  documentIdDaPasta?: number;
  /** O `.metadata` do Studio na pasta do formulário, quando existe e é legível. */
  studio?: MetadataStudio;
  create?: boolean;
}

export type DecisaoForm =
  | { acao: 'update'; documentId: number; avisos: string[] }
  | { acao: 'create'; avisos: string[] };

function listaCandidatos(formularios: readonly FormNoServidor[]): string {
  return formularios
    .map((f) => `    ${f.documentId}  ${f.documentDescription}  (${f.datasetName})`)
    .join('\n');
}

/**
 * Descobre em qual formulário do servidor publicar.
 *
 * Função pura: recebe o catálogo já lido. A regra é resolver sozinha quando
 * houver um único candidato e parar com instrução quando houver dúvida —
 * publicar no documentId errado sobrescreve outro formulário.
 */
export function decideForm(entrada: EntradaDecisao): DecisaoForm {
  const { nome, catalogo, create } = entrada;
  const avisos: string[] = [];

  // 1. Escolha explícita do usuário. Confia, mas confere que existe.
  if (entrada.documentId !== undefined) {
    const alvo = catalogo.find((f) => f.documentId === entrada.documentId);
    if (!alvo) {
      throw new ErroFluigctl(
        `o documentId ${entrada.documentId} não existe neste servidor, ` +
          `ou não é visível para este usuário.`,
        6,
      );
    }
    return { acao: 'update', documentId: alvo.documentId, avisos };
  }

  const exatos = catalogo.filter((f) => f.documentDescription === nome);
  const porCaixa = catalogo.filter(
    (f) => f.documentDescription.toLowerCase() === nome.toLowerCase(),
  );

  // 2. Prefixo numérico da pasta — só vale se a descrição também bater.
  if (entrada.documentIdDaPasta !== undefined) {
    const alvo = catalogo.find((f) => f.documentId === entrada.documentIdDaPasta);

    if (alvo && alvo.documentDescription === nome) {
      return { acao: 'update', documentId: alvo.documentId, avisos };
    }
    if (alvo) {
      throw new ErroFluigctl(
        `o prefixo da pasta aponta para o documentId ${alvo.documentId}, que no ` +
          `servidor se chama "${alvo.documentDescription}" — mas a pasta é ` +
          `"${nome}". Provavelmente a pasta foi copiada de outro projeto. ` +
          `Use --document-id para confirmar o alvo.`,
        6,
      );
    }
    avisos.push(
      `o prefixo da pasta indica documentId ${entrada.documentIdDaPasta}, ` +
        `que não existe neste servidor — pode ser id de outro ambiente. ` +
        `Resolvendo pelo nome.`,
    );
  }

  // 3. O .metadata do Studio: o documentId em que a pasta já foi publicada.
  const pelaPasta = decidePeloStudio(entrada);
  if (pelaPasta) {
    if (create) {
      throw new ErroFluigctl(
        `--create foi pedido, mas o .metadata do Studio diz que esta pasta já é o ` +
          `formulário ${pelaPasta.documentId} neste servidor. Remova --create para atualizá-lo.`,
        6,
      );
    }
    const peloNome = exatos.length === 1 ? exatos[0]! : undefined;
    if (peloNome && peloNome.documentId !== pelaPasta.documentId) {
      pelaPasta.avisos.push(
        `pelo nome da pasta seria o ${peloNome.documentId} ("${peloNome.documentDescription}", ` +
          `${peloNome.datasetName}), mas o .metadata do Studio aponta o ${pelaPasta.documentId}.`,
      );
    }
    return { acao: 'update', documentId: pelaPasta.documentId, avisos: [...avisos, ...pelaPasta.avisos] };
  }
  if (entrada.studio && entrada.studio.exportacoes.length > 0) {
    avisos.push(
      `nenhum documentId do .metadata do Studio (` +
        entrada.studio.exportacoes.map((e) => e.documentId).join(', ') +
        `) é este formulário neste servidor — devem ser de outro ambiente. Resolvendo pelo nome.`,
    );
  }

  // 4. Casamento por nome.
  if (exatos.length === 1) {
    if (create) {
      throw new ErroFluigctl(
        `--create foi pedido, mas o formulário "${nome}" já existe ` +
          `(documentId ${exatos[0]!.documentId}). Remova --create para atualizá-lo.`,
        6,
      );
    }
    return { acao: 'update', documentId: exatos[0]!.documentId, avisos };
  }

  if (exatos.length > 1) {
    throw new ErroFluigctl(
      `há ${exatos.length} formulários chamados "${nome}" neste servidor. ` +
        `Escolha com --document-id:\n${listaCandidatos(exatos)}`,
      6,
    );
  }

  if (porCaixa.length === 1) {
    if (create) {
      throw new ErroFluigctl(
        `--create foi pedido, mas já existe "${porCaixa[0]!.documentDescription}" ` +
          `(documentId ${porCaixa[0]!.documentId}), que difere só na capitalização.`,
        6,
      );
    }
    avisos.push(
      `a pasta chama-se "${nome}" e o formulário no servidor, ` +
        `"${porCaixa[0]!.documentDescription}" — difere só na capitalização.`,
    );
    return { acao: 'update', documentId: porCaixa[0]!.documentId, avisos };
  }

  if (porCaixa.length > 1) {
    throw new ErroFluigctl(
      `há ${porCaixa.length} formulários cujo nome difere de "${nome}" só na ` +
        `capitalização. Escolha com --document-id:\n${listaCandidatos(porCaixa)}`,
      6,
    );
  }

  if (create) return { acao: 'create', avisos };

  throw new ErroFluigctl(
    `o formulário "${nome}" não existe neste servidor. ` +
      `Para criá-lo: --create --parent-id <pasta> --dataset-name <ds> ` +
      `--persistence-type form|list`,
    6,
  );
}

/**
 * Escolhe pelo `.metadata` do Studio.
 *
 * Cada exportação guarda o documentId de UM servidor, e os ids não valem de um
 * ambiente para outro (o formAprovacaoMovimento é o 7 no HML e o 6 em
 * produção — e o 6 do HML é outro formulário). Por isso só conta a exportação
 * cujo documentId existe aqui E é o mesmo formulário: mesmo dataset ou mesma
 * descrição. Sobrando mais de uma, desempata o servidor da última exportação;
 * sem desempate, para.
 */
function decidePeloStudio(
  entrada: EntradaDecisao,
): { documentId: number; avisos: string[] } | undefined {
  const studio = entrada.studio;
  if (!studio || studio.exportacoes.length === 0) return undefined;

  const confere = studio.exportacoes.filter((e) => {
    const alvo = entrada.catalogo.find((f) => f.documentId === e.documentId);
    if (!alvo) return false;
    return (
      (e.serviceName !== '' && alvo.datasetName === e.serviceName) ||
      (e.documentDescription !== '' && alvo.documentDescription === e.documentDescription)
    );
  });

  const ids = [...new Set(confere.map((e) => e.documentId))];
  if (ids.length === 0) return undefined;
  if (ids.length === 1) {
    return { documentId: ids[0]!, avisos: [`formulário ${ids[0]} escolhido pelo .metadata do Studio.`] };
  }

  const daUltima = [
    ...new Set(
      confere.filter((e) => e.serverName === studio.lastServerName).map((e) => e.documentId),
    ),
  ];
  const candidatos = entrada.catalogo.filter((f) => ids.includes(f.documentId));
  if (daUltima.length === 1) {
    const outros = ids.filter((id) => id !== daUltima[0]);
    return {
      documentId: daUltima[0]!,
      avisos: [
        `o .metadata do Studio tem ${ids.length} formulários desta pasta neste servidor; ` +
          `vale o ${daUltima[0]}, da última exportação ("${studio.lastServerName}"). ` +
          `Os outros (${outros.join(', ')}) ficam como estão.`,
      ],
    };
  }

  throw new ErroFluigctl(
    `o .metadata do Studio tem ${ids.length} formulários desta pasta neste servidor e ` +
      `nenhum desempate. Escolha com --document-id:\n${listaCandidatos(candidatos)}`,
    6,
  );
}

export interface EscolhaVersao {
  create?: boolean;
  keepVersion?: boolean;
  newVersion?: boolean;
}

/**
 * Traduz as flags de versão em `versionOption`.
 *
 * Num update a escolha é obrigatória: `"0"` sobrescreve a versão ativa no
 * lugar e `"2"` cria a próxima. Sobrescrever é irreversível, então não pode
 * ser o que acontece quando ninguém disse nada.
 *
 * Na criação não há o que escolher — `createSimpleCardIndexWithDatasetPersisteType`
 * não tem o parâmetro.
 */
export function decideVersionOption(escolha: EscolhaVersao): '0' | '2' | undefined {
  const { create, keepVersion, newVersion } = escolha;

  if (keepVersion && newVersion) {
    throw new ErroFluigctl(
      'não dá para pedir --keep-version e --new-version ao mesmo tempo',
      2,
    );
  }

  if (create) {
    if (keepVersion || newVersion) {
      throw new ErroFluigctl(
        'na criação de um formulário não se escolhe versão: ' +
          '--keep-version e --new-version só valem para atualizar',
        2,
      );
    }
    return undefined;
  }

  if (keepVersion) return '0';
  if (newVersion) return '2';

  throw new ErroFluigctl(
    'escolha o que fazer com a versão do formulário:\n' +
      '  --keep-version  sobrescreve a versão ativa no lugar (layout, eventos, campo que já existe)\n' +
      '  --new-version   cria a próxima versão, preservando a atual (obrigatório com campo novo:\n' +
      '                  cada campo é uma coluna na tabela do formulário)\n' +
      'O --dry-run compara os campos com o formulário publicado e diz se há campo novo.',
    2,
  );
}
