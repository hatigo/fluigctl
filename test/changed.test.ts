import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { camposDoHtml, changedArtifacts, comandoSugerido } from '../src/commands/changed.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fluigctl-changed-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  return dir;
}

function escreve(raiz: string, arquivo: string, conteudo: string): void {
  mkdirSync(dirname(join(raiz, arquivo)), { recursive: true });
  writeFileSync(join(raiz, arquivo), conteudo);
}

function commit(raiz: string): void {
  execFileSync('git', ['-C', raiz, 'add', '-A']);
  execFileSync('git', ['-C', raiz, 'commit', '-q', '-m', 'x']);
}

test('camposDoHtml lê os name= do formulário', () => {
  assert.deepEqual([...camposDoHtml(`<input name="a"><select name='b'></select><form name="form">`)].sort(), ['a', 'b', 'form']);
});

test('traduz o working tree em artefatos e comandos, um por artefato', () => {
  const r = repo();
  try {
    escreve(r, 'datasets/reembolso/dsFoo.js', 'function createDataset(){}');
    escreve(r, 'forms/formBar/formBar.html', '<form name="form"><input name="a"></form>');
    escreve(r, 'forms/formBar/.metadata', 'x');
    escreve(r, 'workflow/scripts/reembolso.servicetask20.js', '// a');
    commit(r);

    escreve(r, 'datasets/reembolso/dsFoo.js', 'function createDataset(){ return 1 }');
    escreve(r, 'forms/formBar/formBar.html', '<form name="form"><input name="a"><input name="novo"></form>');
    escreve(r, 'forms/formBar/main.js', '// novo');
    escreve(r, 'workflow/scripts/reembolso.servicetask20.js', '// b');
    escreve(r, 'workflow/scripts/reembolso.beforeStateEntry.js', '// novo');
    escreve(r, 'events/afterProcessCreate.js', '// global');
    escreve(r, 'mechanisms/MEC_ALCADAS.js', 'function resolve() {}');

    const { artefatos } = changedArtifacts(r);
    const linhas = artefatos.map((a) => comandoSugerido(a, 'hml'));

    assert.deepEqual(linhas, [
      'fluigctl push dataset datasets/reembolso/dsFoo.js --server hml --dry-run',
      'fluigctl push form forms/formBar/ --server hml --new-version --dry-run',
      'fluigctl push process reembolso --server hml --dry-run',
      'fluigctl push event events/afterProcessCreate.js --server hml --dry-run',
      'fluigctl push mechanism mechanisms/MEC_ALCADAS.js --server hml --dry-run',
    ]);

    const form = artefatos.find((a) => a.tipo === 'form');
    assert.ok(form?.tipo === 'form');
    assert.deepEqual(form.camposNovos, ['novo']);

    const proc = artefatos.find((a) => a.tipo === 'process');
    assert.ok(proc?.tipo === 'process');
    assert.deepEqual(proc.eventos, ['beforeStateEntry', 'servicetask20']);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('formulário sem campo novo sugere --keep-version; só .metadata não conta', () => {
  const r = repo();
  try {
    escreve(r, 'forms/formBar/formBar.html', '<form name="form"><input name="a"></form>');
    escreve(r, 'forms/formBaz/formBaz.html', '<form name="form"></form>');
    escreve(r, 'forms/formBaz/.metadata', 'x');
    commit(r);

    escreve(r, 'forms/formBar/formBar.html', '<form name="form"><input name="a" class="nova"></form>');
    escreve(r, 'forms/formBaz/.metadata', 'y');

    const linhas = changedArtifacts(r).artefatos.map((a) => comandoSugerido(a, 'hml'));
    assert.deepEqual(linhas, ['fluigctl push form forms/formBar/ --server hml --keep-version --dry-run']);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('--since compara com um commit anterior', () => {
  const r = repo();
  try {
    escreve(r, 'datasets/dsA.js', '1');
    commit(r);
    const base = execFileSync('git', ['-C', r, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    escreve(r, 'datasets/dsA.js', '2');
    commit(r);

    assert.equal(changedArtifacts(r).artefatos.length, 0);
    assert.deepEqual(
      changedArtifacts(r, base).artefatos.map((a) => a.tipo === 'dataset' && a.nome),
      ['dsA'],
    );
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('diagrama alterado sugere push diagram, que leva os scripts dele; .resources é só informativo', () => {
  const r = repo();
  try {
    escreve(r, 'workflow/diagrams/reembolso.process', '<xmi/>');
    escreve(r, 'workflow/scripts/reembolso.servicetask20.js', '// a');
    escreve(r, 'workflow/scripts/compras.beforeStateEntry.js', '// a');
    commit(r);

    escreve(r, 'workflow/diagrams/reembolso.process', '<xmi>novo</xmi>');
    escreve(r, 'workflow/scripts/reembolso.servicetask20.js', '// b');
    escreve(r, 'workflow/scripts/compras.beforeStateEntry.js', '// b');
    escreve(r, 'workflow/.resources/reembolso.ecm30.xml', '<list/>');

    const linhas = changedArtifacts(r).artefatos.map((a) => comandoSugerido(a, 'hml'));
    assert.deepEqual(linhas, [
      // Os scripts do compras mudaram sem o diagrama: push process, como antes.
      'fluigctl push process compras --server hml --dry-run',
      // Os do reembolso vão no push diagram (um push process à parte criaria outra versão).
      'fluigctl push diagram workflow/diagrams/reembolso.process --server hml --dry-run   # inclui os scripts servicetask20',
      '# workflow/.resources/reembolso.ecm30.xml: gerado pelo Studio ao exportar — o push diagram publica a partir do .process',
    ]);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('scripts de processo renomeado: o changed sugere o id que está no .process', () => {
  const r = repo();
  try {
    escreve(r, 'workflow/diagrams/AdiantamentoRessarcimento.process', '<xmi:XMI>\n  <bpmn2:BpmnProcess id="Ressarcimento_v2" name="R"/>\n</xmi:XMI>\n');
    escreve(r, 'workflow/scripts/AdiantamentoRessarcimento.servicetask115.js', '// a');
    commit(r);
    escreve(r, 'workflow/scripts/AdiantamentoRessarcimento.servicetask115.js', '// b');
    assert.deepEqual(changedArtifacts(r).artefatos.map((a) => comandoSugerido(a, 'hml')), [
      'fluigctl push process Ressarcimento_v2 --server hml --dry-run',
    ]);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('layout WCM alterado sugere push layout, e widget continua push widget', () => {
  const r = repo();
  try {
    escreve(r, 'wcm/widget/wdgA/src/main/resources/application.info', 'application.type=widget');
    escreve(r, 'wcm/layout/layoutB/src/main/resources/application.info', 'application.type=layout');
    commit(r);

    escreve(r, 'wcm/widget/wdgA/src/main/resources/application.info', 'application.type=widget\napplication.title=A');
    escreve(r, 'wcm/layout/layoutB/src/main/resources/application.info', 'application.type=layout\napplication.title=B');

    const linhas = changedArtifacts(r).artefatos.map((a) => comandoSugerido(a, 'hml'));
    assert.deepEqual(linhas, [
      'fluigctl push widget wcm/widget/wdgA --server hml --dry-run',
      'fluigctl push layout wcm/layout/layoutB --server hml --dry-run',
    ]);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
