import { quebrar } from './terminal.js';
import { atalhos, CAMPOS_DO_FORM, type Estado, type Tela } from './servidores.js';

/**
 * O desenho da tela de servidores: `Estado` → texto. Função pura, de propósito:
 * dá para conferir o que aparece em cada tela num teste, sem terminal.
 *
 * A janela é pequena de propósito (80×24 é o padrão), então tudo é montado
 * dentro de `colunas` e cortado em `linhas` — nada de deixar o terminal rolar.
 */

const ROTULO: Record<(typeof CAMPOS_DO_FORM)[number], string> = {
  nome: 'nome',
  host: 'host',
  porta: 'porta',
  ssl: 'ssl',
  usuario: 'usuário',
  senha: 'senha',
};

const AJUDA: [string, string][] = [
  ['a', 'cadastrar um servidor novo'],
  ['enter', 'rever e corrigir o servidor em foco'],
  ['t', 'testar a credencial (login, ping e identidade)'],
  ['p', 'marcar ou desmarcar produção (marcar pede confirmação)'],
  ['x', 'remover do cadastro (pede confirmação)'],
  ['i', 'trazer os servidores dos workspaces da extensão Fluiggers'],
  ['↑ ↓', 'mover o foco'],
  ['q', 'sair'],
];

export function desenhar(estado: Estado, colunas: number, linhas: number): string {
  const largura = Math.max(40, colunas);
  const saida: string[] = [];

  saida.push(titulo(estado, largura));
  saida.push('');

  switch (estado.tela.tipo) {
    case 'lista':
      saida.push(...lista(estado, largura));
      break;
    case 'form':
      saida.push(...formulario(estado.tela, largura));
      break;
    case 'confirmar':
      saida.push(...confirmacao(estado.tela, largura));
      break;
    case 'importar':
      saida.push(...importacao(estado.tela, largura));
      break;
    case 'ajuda':
      saida.push(...ajuda(largura));
      break;
  }

  // O recado fica logo acima dos atalhos, para não empurrar a lista.
  const rodape: string[] = [];
  if (estado.recado) rodape.push('', ...quebrar(estado.recado.texto, largura - 4).map((l) => `  ${l}`));
  rodape.push('', `  ${atalhos(estado.tela).join('   ')}`);

  const disponivel = Math.max(1, linhas - rodape.length);
  const corpo = saida.slice(0, disponivel);
  return [...corpo, ...rodape].join('\n');
}

function titulo(estado: Estado, largura: number): string {
  const n = estado.servidores.length;
  const quantos = n === 0 ? 'nenhum servidor' : `${n} servidor${n > 1 ? 'es' : ''}`;
  const texto = `fluigctl · servidores — ${quantos}`;
  const entra = Math.max(0, Math.floor((largura - texto.length) / 2));
  return `\x1b[7m${' '.repeat(entra)}${texto}${' '.repeat(Math.max(0, largura - entra - texto.length))}\x1b[0m`;
}

/** Corta em `largura` visíveis, contando o escape como invisível. */
function corta(texto: string, largura: number): string {
  const visivel = texto.replace(/\x1b\[[0-9;]*m/g, '');
  return visivel.length <= largura ? texto : texto.slice(0, texto.length - (visivel.length - largura) - 1) + '…';
}

function lista(estado: Estado, largura: number): string[] {
  if (estado.servidores.length === 0) {
    return [
      '  nenhum servidor cadastrado.',
      '',
      '  Pressione "a" para cadastrar o primeiro, ou "i" para trazer os que já',
      '  estão nos workspaces da extensão Fluiggers.',
    ];
  }

  const larguraNome = Math.max(...estado.servidores.map((s) => s.nome.length));
  return estado.servidores.map((s, i) => {
    const foco = i === estado.foco;
    const seta = foco ? '▶' : ' ';
    // A marca de produção vem logo depois do nome, e não no fim: numa linha
    // apertada o que sobra é cortado, e o aviso que mais importa não pode ser
    // o primeiro a sumir.
    const marca = s.prod ? ' \x1b[31mPRODUÇÃO\x1b[0m' : '';
    const endereco = `${s.ssl ? 'https' : 'http'}://${s.host}:${s.porta}`;
    const linha = `${seta} ${s.nome.padEnd(larguraNome)}${marca}  ${endereco}  ${s.usuario}  ${s.senhaEnv}`;
    return foco ? `\x1b[1m${corta(linha, largura - 2)}\x1b[0m` : ` ${corta(linha, largura - 2)}`;
  });
}

function formulario(tela: Extract<Tela, { tipo: 'form' }>, largura: number): string[] {
  const saida: string[] = [`  ${tela.form.novo ? 'Cadastrar servidor' : `Rever "${tela.form.original}"`}`, ''];
  for (const campo of CAMPOS_DO_FORM) {
    const focado = campo === tela.form.foco;
    const bruto = tela.form.valores[campo];
    // A senha nunca aparece; só o tamanho, para a pessoa saber que digitou.
    const valor = campo === 'senha' ? '•'.repeat(bruto.length) : bruto;
    const etiqueta = `  ${ROTULO[campo].padEnd(7)}`;
    const conteudo = focado ? `\x1b[7m${valor || ' '}\x1b[0m` : valor;
    saida.push(corta(`${etiqueta}${conteudo}`, largura));
    if (campo === 'ssl') saida.push('           sim | não');
    if (campo === 'senha') {
      saida.push('           opcional: vazio usa a variável de ambiente ou o servers.json da extensão');
    }
    if (campo === 'host' || campo === 'usuario' || campo === 'senha') saida.push('');
  }
  if (tela.erro) saida.push(`  \x1b[31m${tela.erro}\x1b[0m`);
  return saida;
}

function confirmacao(tela: Extract<Tela, { tipo: 'confirmar' }>, largura: number): string[] {
  return ['', ...quebrar(tela.pergunta, largura - 6).map((l) => `  ${l}`), '', '  s = sim     n = não'];
}

function importacao(tela: Extract<Tela, { tipo: 'importar' }>, largura: number): string[] {
  const saida: string[] = [`  Importar de ${tela.dir}`, ''];
  if (tela.candidatos.length === 0) {
    saida.push('  nenhum servidor encontrado nesse diretório.');
    return saida;
  }
  const larguraNome = Math.max(...tela.candidatos.map((c) => c.nome.length));
  tela.candidatos.forEach((c, i) => {
    const foco = i === tela.foco;
    const caixa = c.jaExiste ? '=' : c.marcado ? 'x' : ' ';
    const sufixo = c.jaExiste ? '  (já cadastrado, mantido)' : c.prod ? '  PRODUÇÃO' : '';
    const linha = `[${caixa}] ${c.nome.padEnd(larguraNome)}  ${c.url}  ${c.usuario}${sufixo}`;
    saida.push(foco ? `\x1b[1m${corta(`▶ ${linha}`, largura - 2)}\x1b[0m` : corta(`  ${linha}`, largura - 2));
  });
  saida.push('', `  senhas: ${tela.comSenhas ? 'sim, copiar para o arquivo próprio' : 'não'}   (tecla "s")`);
  return saida;
}

function ajuda(largura: number): string[] {
  return AJUDA.map(([tecla, texto]) => corta(`  ${tecla.padEnd(6)}${texto}`, largura));
}

/** O que a tela mostra, sem escapes: é o que os testes conferem. */
export function semCores(quadro: string): string {
  return quadro.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}
