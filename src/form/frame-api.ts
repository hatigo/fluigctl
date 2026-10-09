export type ModoPreview = 'ADD' | 'MOD' | 'VIEW';

export interface ContextoPreview {
  modo: ModoPreview;
  atividade: number;
  usuario: string;
  processo?: number; // WKNumProces
  empresa?: number; // WKCompany
}

export const CONTEXTO_PADRAO: ContextoPreview = { modo: 'ADD', atividade: 0, usuario: 'preview' };

/** Escapa um valor como literal JS seguro dentro de um <script> inline. */
function literal(valor: unknown): string {
  return JSON.stringify(valor)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Remove um sufixo `___<dígitos>` do fim do nome, se houver. */
export function baseSemSufixo(nome: string): string {
  return nome.replace(/___\d+$/, '');
}

/** Próximo índice pai-filho: maior `___N` + 1, ou 1 quando não há nenhum. */
export function proximoIndice(nomes: readonly string[]): number {
  let maior = 0;
  for (const nome of nomes) {
    const m = /___(\d+)$/.exec(nome);
    if (m) {
      const n = Number(m[1]);
      if (n > maior) maior = n;
    }
  }
  return maior + 1;
}

/** Índices `___N` distintos e ordenados presentes nos nomes. */
export function indicesDeFilho(nomes: readonly string[]): number[] {
  const vistos = new Set<number>();
  for (const nome of nomes) {
    const m = /___(\d+)$/.exec(nome);
    if (m) vistos.add(Number(m[1]));
  }
  return [...vistos].sort((a, b) => a - b);
}

/**
 * Corpo de <script> (IIFE) que simula o contexto de execução do Fluig e a API
 * básica do formulário, injetado no frame antes dos scripts do próprio form.
 */
export function scriptDaApi(contexto: ContextoPreview): string {
  const ctx = literal(contexto);
  return `(function () {
  var contexto = ${ctx};
  var congelado = Object.freeze(contexto);
  window.__fluigPreviewContexto = congelado;
  var diagnosticos = [];
  function diagnosticar(mensagem) {
    diagnosticos.push({ mensagem: String(mensagem), em: new Date().toISOString() });
    try { console.warn('preview: ' + mensagem); } catch (erro) { /* console ausente */ }
  }
  window.__fluigPreview = { contexto: congelado, diagnosticos: diagnosticos, diagnosticar: diagnosticar };
  window.ConstraintType = { MUST: 1, SHOULD: 2, MUST_NOT: 3 };
  var canal = null;
  var pedidos = {};
  var contadorDatasets = 0;
  function enviarPedido(id) {
    var pedido = pedidos[id];
    if (!pedido || !canal) return;
    try {
      canal.postMessage(pedido.mensagem);
    } catch (e) {
      delete pedidos[id];
      if (pedido.opcoes && pedido.opcoes.error) pedido.opcoes.error(new Error('falha ao enviar o pedido de dataset: ' + ((e && e.message) || e)));
    }
  }
  window.DatasetFactory = {
    createConstraint: function (campo, inicial, final, tipo, like) {
      return { campo: campo, inicial: inicial, final: final, tipo: tipo, like: !!like };
    },
    getDataset: function (nome, fields, constraints, order, options) {
      var opcoes = options || {};
      try {
        contadorDatasets += 1;
        var id = 'ds-' + contadorDatasets;
        var mensagem = {
          v: 1,
          type: 'dataset',
          id: id,
          nome: nome,
          campos: fields || [],
          restricoes: (constraints || []).map(function (c) {
            return { campo: c.campo, inicial: c.inicial, final: c.final, tipo: c.tipo, like: !!c.like };
          }),
          ordem: order || []
        };
        pedidos[id] = { opcoes: opcoes, mensagem: mensagem };
        enviarPedido(id);
      } catch (e) {
        if (opcoes.error) opcoes.error(new Error('não consegui montar o pedido de dataset: ' + ((e && e.message) || e)));
      }
    }
  };
  window.__fluigPreview.conectar = function (port) {
    canal = port;
    port.onmessage = function (evento) {
      var m = evento && evento.data;
      if (!m || m.v !== 1 || (m.type !== 'dataset:ok' && m.type !== 'dataset:error')) return;
      var pedido = pedidos[m.id];
      if (!pedido) return;
      delete pedidos[m.id];
      if (m.type === 'dataset:ok') {
        if (pedido.opcoes && pedido.opcoes.success) pedido.opcoes.success({ columns: m.columns, values: m.values });
      } else if (pedido.opcoes && pedido.opcoes.error) {
        pedido.opcoes.error(new Error(m.message));
      }
    };
    var ids = Object.keys(pedidos);
    for (var i = 0; i < ids.length; i++) enviarPedido(ids[i]);
  };
  window.WKNumState = String(contexto.atividade);
  window.WKUser = String(contexto.usuario);
  window.WKMode = String(contexto.modo);
  if (contexto.processo !== undefined) window.WKNumProces = String(contexto.processo);
  if (contexto.empresa !== undefined) window.WKCompany = String(contexto.empresa);
  var NOMES_DE_CONTEXTO = ['WKNumState', 'WKUser', 'WKMode', 'WKNumProces', 'WKCompany'];
  function eDoContexto(nome) { return NOMES_DE_CONTEXTO.indexOf(nome) !== -1; }
  function getValue(nome) {
    if (eDoContexto(nome)) return window[nome] === undefined ? '' : window[nome];
    var elemento = document.querySelector('[name="' + nome + '"]');
    return elemento ? String(elemento.value) : '';
  }
  function setValue(nome, valor) {
    if (eDoContexto(nome)) return;
    var elemento = document.querySelector('[name="' + nome + '"]');
    if (!elemento) {
      elemento = document.createElement('input');
      elemento.type = 'hidden';
      elemento.name = nome;
      var alvo = document.querySelector('form[name="form"]') || document.body;
      if (alvo) alvo.appendChild(elemento);
    }
    elemento.value = valor;
  }
  var baseSemSufixo = ${baseSemSufixo.toString()};
  var proximoIndice = ${proximoIndice.toString()};
  var indicesDeFilho = ${indicesDeFilho.toString()};
  function temNomeSemSufixo(linha) {
    var campos = linha.querySelectorAll('[name]');
    for (var i = 0; i < campos.length; i++) {
      var nome = campos[i].getAttribute('name') || '';
      if (baseSemSufixo(nome) === nome) return true;
    }
    return false;
  }
  function nomesDaTabela(tabela) {
    var campos = tabela.querySelectorAll('[name]');
    var nomes = [];
    for (var i = 0; i < campos.length; i++) nomes.push(campos[i].getAttribute('name') || '');
    return nomes;
  }
  window.wdkAddChild = function (tablename) {
    var tabela = document.querySelector('table[tablename="' + tablename + '"]');
    if (!tabela) {
      window.__fluigPreview.diagnosticar('tabela pai-filho não encontrada: ' + tablename);
      return null;
    }
    var tbody = tabela.querySelector('tbody') || tabela;
    var linhas = tbody.querySelectorAll('tr');
    var modelo = null;
    for (var i = linhas.length - 1; i >= 0; i--) {
      if (temNomeSemSufixo(linhas[i])) { modelo = linhas[i]; break; }
    }
    if (!modelo) {
      window.__fluigPreview.diagnosticar('linha modelo pai-filho não encontrada: ' + tablename);
      return null;
    }
    modelo.style.display = 'none';
    var n = proximoIndice(nomesDaTabela(tabela));
    var clone = modelo.cloneNode(true);
    var campos = clone.querySelectorAll('[name]');
    for (var j = 0; j < campos.length; j++) {
      var el = campos[j];
      var base = baseSemSufixo(el.getAttribute('name') || '');
      el.setAttribute('name', base + '___' + n);
      var id = el.getAttribute('id');
      if (id) el.setAttribute('id', baseSemSufixo(id) + '___' + n);
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
      else el.value = '';
    }
    clone.style.display = '';
    tbody.appendChild(clone);
    return n;
  };
  window.fnWdkRemoveChild = function (el) {
    var linha = el && el.closest ? el.closest('tr') : null;
    if (!linha && el) {
      var no = el;
      while (no && no.nodeName !== 'TR') no = no.parentNode;
      linha = no;
    }
    if (linha && linha.remove) linha.remove();
  };
  window.form = {
    getValue: getValue,
    setValue: setValue,
    getFormMode: function () { return contexto.modo; },
    getChildrenIndexes: function (tablename) {
      var tabela = document.querySelector('table[tablename="' + tablename + '"]');
      if (!tabela) {
        window.__fluigPreview.diagnosticar('tabela pai-filho não encontrada: ' + tablename);
        return [];
      }
      return indicesDeFilho(nomesDaTabela(tabela));
    }
  };
  window.getValue = getValue;
  window.setValue = setValue;
  window.getAtividade = function () { return contexto.atividade; };
  window.getMode = function () { return contexto.modo; };
  window.getUser = function () { return contexto.usuario; };
  window.__fluigPreview.componente = function (nome, alvo, opcoes) {
    if (!window.FLUIGC) {
      diagnosticar('FLUIGC não está disponível (o preview carrega o fluig-style-guide.min.js do cache); ' + nome + ' não foi instanciado');
      return null;
    }
    if (typeof window.FLUIGC[nome] !== 'function') {
      diagnosticar('FLUIGC.' + nome + ' não existe; ' + nome + ' não foi instanciado');
      return null;
    }
    try {
      return window.FLUIGC[nome](alvo, opcoes);
    } catch (e) {
      diagnosticar('falha ao instanciar FLUIGC.' + nome + ': ' + ((e && e.message) || e));
      return null;
    }
  };
  window.__fluigPreview.calendar = function (alvo, opcoes) { return window.__fluigPreview.componente('calendar', alvo, opcoes); };
  window.__fluigPreview.select = function (alvo, opcoes) { return window.__fluigPreview.componente('select', alvo, opcoes); };
  function avisarComponentes() {
    if (window.FLUIGC) diagnosticar('FLUIGC carregado do cache local; componentes que dependem do servidor (datasets) degradam');
    else diagnosticar('componentes FLUIGC do cache não carregaram');
  }
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', avisarComponentes, { once: true });
  } else {
    avisarComponentes();
  }
  diagnosticar('contexto do preview é SIMULADO; eventos de servidor (displayFields/enableFields/validateForm) NÃO são executados');
  diagnosticar('datasets no preview só funcionam com --server; sem servidor a chamada devolve erro explícito (nenhum dado inventado)');
})();`;
}
