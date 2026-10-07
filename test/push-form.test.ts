import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeFluig } from './helpers/fake-fluig.js';
import { pushForm } from '../src/commands/push-form.js';
import type { Server } from '../src/config.js';
import { ErroFluigctl } from '../src/errors.js';

const WSDL = readFileSync(new URL('./fixtures/wsdl/ECMCardIndexService.wsdl', import.meta.url), 'utf8');
const CAMINHO = '/webdesk/ECMCardIndexService';
const NS = 'http://ws.dm.ecm.technology.totvs.com/';

const env = (c: string) =>
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${c}</soap:Body></soap:Envelope>`;

const LISTA = env(
  `<ns:getCardIndexesWithoutApproverResponse xmlns:ns="${NS}"><result>
     <item><documentId>8</documentId><documentDescription>formSolicitacaoCompras</documentDescription><datasetName>dsformSolicitacaoCompras</datasetName></item>
     <item><documentId>902</documentId><documentDescription>formSolicitacaoReembolso</documentDescription><datasetName>dsformSolicitacaoReembolso</datasetName></item>
   </result></ns:getCardIndexesWithoutApproverResponse>`,
);
const okMsg = (op: string, id = 8) =>
  env(`<ns:${op}Response xmlns:ns="${NS}"><result><item><companyId>1</companyId><documentId>${id}</documentId><version>1</version><webServiceMessage>ok</webServiceMessage></item></result></ns:${op}Response>`);

function pasta(nome: string): string {
  return fileURLToPath(new URL(`./fixtures/forms/${nome}`, import.meta.url));
}

/** A lista do servidor com a pasta de cada formulário (parentDocumentId) e os datasets. */
const listaCom = (itens: [number, string, string, number][]) =>
  env(
    `<ns:getCardIndexesWithoutApproverResponse xmlns:ns="${NS}"><result>${itens
      .map(([id, nome, ds, pasta]) => `<item><documentId>${id}</documentId><documentDescription>${nome}</documentDescription><datasetName>${ds}</datasetName><parentDocumentId>${pasta}</parentDocumentId></item>`)
      .join('')}</result></ns:getCardIndexesWithoutApproverResponse>`,
  );

async function ambiente(lista = LISTA) {
  const fluig = await fakeFluig({
    [CAMINHO]: (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL };
      const op = req.body.includes('createSimpleCardIndex')
        ? 'createSimpleCardIndexWithDatasetPersisteType'
        : 'updateSimpleCardIndexWithDatasetAndGeneralInfo';
      return {
        headers: { 'content-type': 'text/xml' },
        body: req.body.includes('getCardIndexes') ? lista : okMsg(op, op.startsWith('create') ? 23691 : 8),
      };
    },
  });

  const u = new URL(fluig.url);
  const server: Server = {
    host: u.hostname, port: Number(u.port), ssl: false, username: 'integracao',
    companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
  };

  return { fluig, server };
}

const escritas = (f: Awaited<ReturnType<typeof ambiente>>['fluig']) =>
  f.requests.filter((r) => /SimpleCardIndex/.test(r.body));

test('push form atualiza o formulário que casa pelo nome da pasta', async () => {
  const a = await ambiente();

  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0', prompt: async () => '',
    });

    assert.equal(r.acao, 'update');
    assert.equal(r.documentId, 8);
    assert.equal(r.anexos, 3);
    assert.equal(r.eventos, 2);
    assert.equal(escritas(a.fluig).length, 1);
  } finally {
    await a.fluig.close();
  }
});

test('push form não publica o .metadata junto', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0', prompt: async () => '',
    });

    assert.equal(escritas(a.fluig)[0]!.body.includes('.metadata'), false);
  } finally {
    await a.fluig.close();
  }
});

test('push form em dry-run não envia escrita nenhuma', async () => {
  const a = await ambiente();

  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'),
      versionOption: '0', dryRun: true, prompt: async () => '',
    });

    assert.equal(r.acao, 'update');
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form em produção não escreve quando o gate recusa', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () => pushForm({
        server: { ...a.server, prod: true }, senha: 'certa',
        pasta: pasta('formSolicitacaoCompras'), versionOption: '0', prompt: async () => 'errada',
      }),
      /não confere/i,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form cria na pasta dos formulários, com ds<nome> e a persistência do Studio, quando não se diz', async () => {
  const a = await ambiente(listaCom([[8, 'formSolicitacaoCompras', 'dsformSolicitacaoCompras', 2], [902, 'formSolicitacaoReembolso', 'dsformSolicitacaoReembolso', 2]]));
  try {
    const r = await pushForm({ server: a.server, senha: 's', pasta: pasta('formNovoSimples'), create: true, prompt: async () => '' });
    assert.deepEqual(r.criacao, { pasta: 2, dataset: 'dsformNovoSimples', persistencia: 'form' });
    assert.ok(r.avisos.some((x) => /sem flag, vale: pasta 2 .*dataset dsformNovoSimples, persistência form/.test(x)));
    const [criacao] = escritas(a.fluig);
    assert.match(criacao!.body, /<parentDocumentId>2<\/parentDocumentId>/);
    assert.match(criacao!.body, /<datasetName>dsformNovoSimples<\/datasetName>/);
    assert.match(criacao!.body, /<persistenceType>0<\/persistenceType>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form não escolhe a pasta quando os formulários estão em mais de uma, nem repete dataset de outro', async () => {
  const a = await ambiente(listaCom([[8, 'formSolicitacaoCompras', 'dsformNovoSimples', 2], [902, 'formSolicitacaoReembolso', 'dsformSolicitacaoReembolso', 7]]));
  try {
    const criar = (extra: object) => pushForm({ server: a.server, senha: 's', pasta: pasta('formNovoSimples'), create: true, prompt: async () => '', ...extra });
    await assert.rejects(criar({ datasetName: 'dsOutro' }), /--parent-id: os formulários deste servidor estão em mais de uma pasta — pasta 2 \(1 formulário\(s\)\), pasta 7/);
    await assert.rejects(criar({ parentId: 2 }), /o dataset "dsformNovoSimples" já é do formulário 8/);
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form recusa criar sem saber a pasta: o servidor não informou onde estão os formulários', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () => pushForm({
        server: a.server, senha: 's', pasta: pasta('formNovoSimples'),
        create: true, prompt: async () => '',
      }),
      /--parent-id|--dataset-name|--persistence-type/,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form cria e devolve o documentId novo do servidor', async () => {
  const a = await ambiente();

  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formNovoSimples'),
      create: true, parentId: 5, datasetName: 'dsformEditalFiart',
      persistenceType: 'form', prompt: async () => '',
    });

    assert.equal(r.acao, 'create');
    assert.equal(r.documentId, 23691);
  } finally {
    await a.fluig.close();
  }
});

test('push form manda versionOption 2 quando se pede nova versão', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'),
      versionOption: '2', prompt: async () => '',
    });

    assert.match(escritas(a.fluig)[0]!.body, /<versionOption>2<\/versionOption>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form recusa atualizar sem escolha de versão, sem escrever nada', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      () => pushForm({
        server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'),
        prompt: async () => '',
      }),
      /--keep-version|--new-version/,
    );

    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('push form com --description mantém a descrição do servidor em vez do nome da pasta', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0',
      description: 'outroNome', prompt: async () => '',
    });
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<cardDescription>outroNome<\/cardDescription>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form na atualização mantém o dataset do servidor em vez de ds<pasta>', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), documentId: 902, versionOption: '2',
      prompt: async () => '',
    });
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<datasetName>dsformSolicitacaoReembolso<\/datasetName>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form com --dataset-name na atualização usa o nome informado', async () => {
  const a = await ambiente();

  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0',
      datasetName: 'dsOutro', prompt: async () => '',
    });
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<datasetName>dsOutro<\/datasetName>/);
  } finally {
    await a.fluig.close();
  }
});

test('push form recusa, sem escrever, dataset que já é de outro formulário', async () => {
  const a = await ambiente();

  try {
    await assert.rejects(
      pushForm({
        server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), documentId: 902, versionOption: '0',
        datasetName: 'dsformSolicitacaoCompras', prompt: async () => '',
      }),
      (e: Error & { codigo?: number }) => e.codigo === 6 && /dsformSolicitacaoCompras/.test(e.message) && /8/.test(e.message),
    );
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

/** Um servidor cujo catálogo é `itens` (cada item já em XML). */
async function ambienteCom(itens: string) {
  const lista = env(
    `<ns:getCardIndexesWithoutApproverResponse xmlns:ns="${NS}"><result>${itens}</result></ns:getCardIndexesWithoutApproverResponse>`,
  );
  const fluig = await fakeFluig({
    [CAMINHO]: (req) => {
      if (req.method === 'GET') return { headers: { 'content-type': 'text/xml' }, body: WSDL };
      return {
        headers: { 'content-type': 'text/xml' },
        body: req.body.includes('getCardIndexes')
          ? lista
          : okMsg('updateSimpleCardIndexWithDatasetAndGeneralInfo', 902),
      };
    },
  });
  const u = new URL(fluig.url);
  const server: Server = {
    host: u.hostname, port: Number(u.port), ssl: false, username: 'integracao',
    companyId: 1, userCode: 'Integracao.Fluig', passwordEnv: 'FLUIG_T_PASSWORD',
  };
  return { fluig, server };
}

const REEMBOLSO_NO_HML =
  `<item><documentId>676</documentId><documentDescription>formReembolso</documentDescription><datasetName>dsformReembolso</datasetName><cardDescription></cardDescription></item>` +
  `<item><documentId>902</documentId><documentDescription>formSolicitacaoReembolso</documentDescription><datasetName>dsformSolicitacaoReembolso</datasetName><cardDescription>justificativa</cardDescription></item>`;

test('update mantém o nome e o campo descritor do servidor (não renomeia para a pasta)', async () => {
  const a = await ambienteCom(REEMBOLSO_NO_HML);
  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formReembolso'), documentId: 902, versionOption: '0', prompt: async () => '',
    });

    assert.equal(r.nomeEnviado, 'formSolicitacaoReembolso');
    assert.equal(r.descritorEnviado, 'justificativa');
    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<cardDescription>formSolicitacaoReembolso<\/cardDescription>/);
    assert.match(corpo, /<descriptionField>justificativa<\/descriptionField>/);
  } finally {
    await a.fluig.close();
  }
});

test('--description e --description-field ainda mandam sobre o servidor', async () => {
  const a = await ambienteCom(REEMBOLSO_NO_HML);
  try {
    await pushForm({
      server: a.server, senha: 's', pasta: pasta('formReembolso'), documentId: 902, versionOption: '0',
      description: 'novoNome', descriptionField: 'outroCampo', prompt: async () => '',
    });

    const corpo = escritas(a.fluig)[0]!.body;
    assert.match(corpo, /<cardDescription>novoNome<\/cardDescription>/);
    assert.match(corpo, /<descriptionField>outroCampo<\/descriptionField>/);
  } finally {
    await a.fluig.close();
  }
});

test('sem --document-id, o .metadata do Studio leva formReembolso ao 902, não ao 676', async () => {
  const a = await ambienteCom(REEMBOLSO_NO_HML);
  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formReembolso'), versionOption: '0', dryRun: true, prompt: async () => '',
    });

    assert.equal(r.documentId, 902);
    assert.equal(r.nomeEnviado, 'formSolicitacaoReembolso');
    assert.match(r.avisos.join('\n'), /pelo nome da pasta seria o 676/);
    assert.equal(escritas(a.fluig).length, 0);
  } finally {
    await a.fluig.close();
  }
});

test('servidor que não informa o campo descritor: avisa que ele vai vazio', async () => {
  const a = await ambiente();
  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formSolicitacaoCompras'), versionOption: '0', dryRun: true, prompt: async () => '',
    });
    assert.match(r.avisos.join('\n'), /campo descritor/);
  } finally {
    await a.fluig.close();
  }
});

test('campo descritor vazio no servidor (tag vazia) vai vazio, sem aviso', async () => {
  const a = await ambienteCom(
    `<item><documentId>902</documentId><documentDescription>formSolicitacaoReembolso</documentDescription><datasetName>dsformSolicitacaoReembolso</datasetName><cardDescription/></item>`,
  );
  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formReembolso'), documentId: 902, versionOption: '0', dryRun: true, prompt: async () => '',
    });
    assert.equal(r.descritorEnviado, '');
    assert.doesNotMatch(r.avisos.join('\n'), /campo descritor/);
  } finally {
    await a.fluig.close();
  }
});

/** Pasta de formulário temporária com um anexo de nome acentuado. */
function pastaComAcento(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'fluigctl-acento-'));
  const p = join(raiz, 'formAcento');
  mkdirSync(p);
  writeFileSync(join(p, 'formAcento.html'), '<html><body><form name="form"><input name="campo"></form></body></html>');
  writeFileSync(join(p, 'Requisitos Formulário gestão.md'), '# requisitos\n');
  return p;
}

test('anexo com nome fora do ASCII: o dry-run avisa, e a recusa do servidor diz qual arquivo renomear', async () => {
  const p = pastaComAcento();
  const recusa = env(`<ns:createSimpleCardIndexWithDatasetPersisteTypeResponse xmlns:ns="${NS}"><result><item>` +
    '<webServiceMessage>Malformed input or input contains unmappable characters: /var/fluig-volume/upload/admin/Requisitos Formulário gestão.md</webServiceMessage>' +
    `</item></result></ns:createSimpleCardIndexWithDatasetPersisteTypeResponse>`);
  const fluig = await fakeFluig({
    [CAMINHO]: (req) => ({
      headers: { 'content-type': 'text/xml' },
      body: req.method === 'GET' ? WSDL : req.body.includes('getCardIndexes') ? LISTA : recusa,
    }),
  });
  const u = new URL(fluig.url);
  const server: Server = { host: u.hostname, port: Number(u.port), ssl: false, username: 'u', companyId: 1, userCode: 'u', passwordEnv: 'X' };
  try {
    const simulado = await pushForm({
      server, senha: 's', pasta: p, create: true, parentId: 5, datasetName: 'dsformAcento', persistenceType: 'form',
      dryRun: true, prompt: async () => '',
    });
    assert.match(simulado.avisos.join('\n'), /nome fora do ASCII \(Requisitos Formulário gestão\.md\)/);

    const erro = await pushForm({
      server, senha: 's', pasta: p, create: true, parentId: 5, datasetName: 'dsformAcento', persistenceType: 'form',
      prompt: async () => '',
    }).then(() => undefined, (e: unknown) => e as ErroFluigctl);
    assert.equal(erro?.codigo, 7);
    assert.match(erro!.message, /não aceitou anexo com nome fora do ASCII: Requisitos Formulário gestão\.md\. Renomeie/);
  } finally {
    await fluig.close();
  }
});

test('anexos só com nome ASCII não geram o aviso', async () => {
  const a = await ambiente();
  try {
    const r = await pushForm({
      server: a.server, senha: 's', pasta: pasta('formNovoSimples'), create: true, parentId: 5,
      datasetName: 'dsformEditalFiart', persistenceType: 'form', dryRun: true, prompt: async () => '',
    });
    assert.ok(!r.avisos.some((x) => /ASCII/.test(x)));
  } finally {
    await a.fluig.close();
  }
});
