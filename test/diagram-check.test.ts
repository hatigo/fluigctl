import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { checarDiagrama, type Achado } from '../src/diagram/check.js';
import { removerNoXml } from '../src/diagram/remove.js';

/**
 * O `diagram check` existe porque o agente edita o `.process` direto. Cada teste
 * parte do diagrama de contratação, que segue o padrão e tem a estrutura
 * consistente, e quebra uma coisa só.
 */

const fixture = (nome: string) => readFileSync(fileURLToPath(new URL(`./fixtures/diagrams/${nome}`, import.meta.url)), 'latin1');
const CONTRATACAO = fixture('contratacao.process');

const erros = (a: Achado[]) => a.filter((x) => x.nivel === 'erro');
const trocar = (texto: string, de: string, para: string) => {
  assert.ok(texto.includes(de), `a fixture tem ${de}`);
  return texto.replace(de, para);
};

test('o diagrama que segue o padrão e foi salvo pelo Studio passam limpos', () => {
  assert.deepEqual(checarDiagrama(CONTRATACAO, { grupo: 'suporte_processos' }), []);
  assert.deepEqual(erros(checarDiagrama(fixture('processoTeste.process'))), []);
  assert.deepEqual(erros(checarDiagrama(fixture('subprocessoTeste.process'))), []);
});

test('referência por posição que não resolve é erro de estrutura', () => {
  const quebrado = trocar(CONTRATACAO, 'end="/0/@children.2/@anchors.0"', 'end="/0/@children.99/@anchors.0"');
  const a = erros(checarDiagrama(quebrado));
  assert.ok(a.some((x) => x.grupo === 'estrutura' && /aponta para \/0\/@children\.99\/@anchors\.0, que não existe/.test(x.mensagem)));
});

test('estilo quebrado só muda a aparência: aviso, não erro', () => {
  const comEstilo = trocar(CONTRATACAO, '<graphicsAlgorithm xsi:type="al:Rectangle" lineWidth="1" width="1700"', '<graphicsAlgorithm xsi:type="al:Rectangle" style="/0/@styles.7" lineWidth="1" width="1700"');
  const a = checarDiagrama(comEstilo, { grupo: 'suporte_processos' });
  assert.deepEqual(erros(a), []);
  assert.ok(a.some((x) => x.nivel === 'aviso' && /@styles\.7/.test(x.mensagem)));
});

test('âncora que não lista a conexão é acusada nos dois sentidos', () => {
  // A âncora do início deixa de listar a conexão 0, que continua começando nela.
  const quebrado = trocar(CONTRATACAO, 'outgoingConnections="/0/@connections.0"/>', '/>');
  assert.ok(erros(checarDiagrama(quebrado)).some((x) => /não lista \/0\/@connections\.0 em outgoingConnections/.test(x.mensagem)));
});

test('conexão desenhada entre formas diferentes das do modelo é acusada', () => {
  const quebrado = trocar(CONTRATACAO, 'sourceRef="startevent1" targetRef="task2"', 'sourceRef="startevent1" targetRef="servicetask3"');
  const mensagens = erros(checarDiagrama(quebrado)).map((x) => `${x.onde}: ${x.mensagem}`);
  assert.ok(mensagens.some((m) => /^flow16: o desenho chega em task2, mas o modelo diz targetRef="servicetask3"/.test(m)), mensagens.join('\n'));
});

test('incoming que sobrou de uma edição antiga é acusado', () => {
  // O caso real: flow30 tinha ficado no incoming de task5 depois de mudar de destino.
  const quebrado = trocar(CONTRATACAO, 'id="task5" name="Aprovar" incoming="flow19"', 'id="task5" name="Aprovar" incoming="flow19 flow30"');
  const a = erros(checarDiagrama(quebrado));
  assert.equal(a.length, 1);
  assert.equal(a[0]!.onde, 'task5');
  assert.match(a[0]!.mensagem, /incoming lista flow30, mas o targetRef dele é servicetask4/);
});

test('fluxo do modelo sem desenho é erro', () => {
  const a = erros(checarDiagrama(fixture('processoFase1.process')));
  assert.ok(a.some((x) => /SequenceFlow sem desenho/.test(x.mensagem)));
});

test('pictogramLinks que aponta para algo que não é <link> é erro', () => {
  const quebrado = trocar(CONTRATACAO, 'snapToGrid="true" version="0.16.0">', 'snapToGrid="true" version="0.16.0" pictogramLinks="/0/@children.1/@link /0/@children.1/@anchors.0">');
  const a = erros(checarDiagrama(quebrado));
  assert.equal(a.length, 1);
  assert.match(a[0]!.mensagem, /\/0\/@children\.1\/@anchors\.0 é um <anchors>, não um <link>/);
});

test('service task síncrona é erro, salvo exceção explícita', () => {
  const sincrona = CONTRATACAO.replace(/(id="servicetask3"[^\n]*?)executionType="1"/, '$1executionType="0"');
  assert.notEqual(sincrona, CONTRATACAO);
  const a = erros(checarDiagrama(sincrona));
  assert.ok(a.some((x) => x.onde.startsWith('servicetask3') && /executionType="0"/.test(x.mensagem)));
  assert.deepEqual(erros(checarDiagrama(sincrona, { excecoes: ['servicetask3'] })), []);
});

test('service task sem evento de erro é erro de padrão', () => {
  const semPai = trocar(CONTRATACAO, 'parentTask="servicetask3"', 'parentTask=""');
  assert.ok(erros(checarDiagrama(semPai)).some((x) => x.grupo === 'padrao' && x.onde.startsWith('servicetask3') && /sem evento de erro/.test(x.mensagem)));
});

test('tratamento que avança o processo em vez de voltar à service task é erro', () => {
  const avanca = trocar(CONTRATACAO, 'sourceRef="task13" targetRef="servicetask3"', 'sourceRef="task13" targetRef="servicetask4"');
  const a = erros(checarDiagrama(avanca));
  assert.ok(a.some((x) => x.onde.startsWith('task13') && /não volta para servicetask3/.test(x.mensagem)));
  assert.ok(a.some((x) => x.onde.startsWith('task13') && /também segue para servicetask4/.test(x.mensagem)));
});

test('grupo do tratamento é conferido contra --group, e admin não passa', () => {
  const admin = CONTRATACAO.replace('&lt;groupId>suporte_processos&lt;/groupId>', '&lt;groupId>admin&lt;/groupId>');
  assert.notEqual(admin, CONTRATACAO);
  assert.deepEqual(erros(checarDiagrama(admin)), [], 'sem --group, qualquer grupo serve');
  assert.ok(erros(checarDiagrama(admin, { grupo: 'suporte_processos' })).some((x) => /grupo "admin"; o esperado é "suporte_processos"/.test(x.mensagem)));
});

test('tratamento fora do Pool Grupo é erro', () => {
  const usuario = CONTRATACAO.replace(/(id="task13"[^\n]*?)managerMechanism="Pool Grupo"/, '$1managerMechanism="Usuário"');
  assert.notEqual(usuario, CONTRATACAO);
  assert.ok(erros(checarDiagrama(usuario)).some((x) => x.onde.startsWith('task13') && /Pool Grupo/.test(x.mensagem)));
});

test('desenho fora da receita: bolinha longe do canto e tratamento em outra raia', () => {
  // Bolinha de servicetask3 longe do canto: aviso.
  const longe = trocar(CONTRATACAO, 'width="35" height="35" x="573" y="276">', 'width="35" height="35" x="20" y="276">');
  const a = checarDiagrama(longe);
  assert.deepEqual(erros(a), []);
  assert.ok(a.some((x) => x.nivel === 'aviso' && x.onde.startsWith('intermediateerror12') && /canto inferior direito/.test(x.mensagem)));

  // Tratamento de servicetask3 subindo para a raia Solicitante: erro.
  const outraRaia = trocar(CONTRATACAO, 'width="140" height="67" x="450" y="326"/>\n      <link businessObjects="task13"/>', 'width="140" height="67" x="450" y="30"/>\n      <link businessObjects="task13"/>');
  assert.ok(erros(checarDiagrama(outraRaia)).some((x) => x.onde.startsWith('task13') && /mesma raia/.test(x.mensagem)));
});

test('elemento sem saída ou sem entrada é erro: a solicitação para ou nunca chega', () => {
  const { xml } = removerNoXml(CONTRATACAO, 'flow19');
  const achados = erros(checarDiagrama(xml)).filter((a) => /sem (saída|entrada)/.test(a.mensagem));
  assert.deepEqual(
    achados.map((a) => `${a.onde.split(' ')[0]}: ${a.mensagem.split(':')[0]}`).sort(),
    ['servicetask4: sem saída', 'task5: sem entrada'],
  );
  // Fim, início e o erro anexado não entram na regra; o acervo do Studio passa.
  assert.deepEqual(erros(checarDiagrama(fixture('processoTeste.process'))), []);
});
