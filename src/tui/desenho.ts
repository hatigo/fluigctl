import { quebrar } from './terminal.js';
import { atalhos, CAMPOS_DO_FORM, type Atalho, type Estado, type Tela } from './servidores.js';

/**
 * O desenho da tela de servidores: `Estado` → texto. Função pura, de propósito:
 * dá para conferir o que aparece em cada tela num teste, sem terminal.
 *
 * As decisões de forma, que valem para todas as telas:
 *
 * - Duas réguas, uma sob o título e outra acima do rodapé. Dão hierarquia sem
 *   gastar as bordas de uma caixa, e o olho acha o conteúdo e os atalhos sem
 *   procurar.
 * - O que é secundário fica apagado (`FRACO`): variável de senha, cabeçalho de
 *   coluna, dica de campo. O que importa fica forte.
 * - O aviso de erro, de sucesso e de espera ganha símbolo além de cor: quem não
 *   distingue cor (ou está num terminal sem cor) continua entendendo.
 * - Terminal estreito perde coluna inteira, nunca corta no meio: a senha some
 *   antes do usuário, e o usuário antes do endereço.
 */

const R = '\x1b[0m';
const FORTE = '\x1b[1m';
const FRACO = '\x1b[2m';
const CIANO = '\x1b[36m';
const VERDE = '\x1b[32m';
const VERMELHO = '\x1b[31m';
const AMARELO = '\x1b[33m';

const ROTULO: Record<(typeof CAMPOS_DO_FORM)[number], string> = {
  nome: 'nome',
  host: 'host',
  porta: 'porta',
  ssl: 'ssl',
  usuario: 'usuário',
  senha: 'senha',
};

/** As teclas iguais às do rodapé, com a explicação que não cabe lá. */
const AJUDA: [string, string][] = [
  ['a', 'cadastrar um servidor novo'],
  ['⏎', 'rever e corrigir o servidor em foco'],
  ['t', 'testar a credencial: login, ping e identidade'],
  ['p', 'marcar ou desmarcar produção (marcar pede confirmação)'],
  ['x', 'remover do cadastro (pede confirmação)'],
  ['i', 'trazer os servidores dos workspaces da extensão Fluiggers'],
  ['↑↓', 'mover o foco'],
  ['?', 'esta ajuda'],
  ['q', 'sair'],
];

/** Símbolo e cor de cada tom de recado. O símbolo é o que não depende de cor. */
const TOM = {
  ok: { marca: '✓', cor: VERDE },
  erro: { marca: '✗', cor: VERMELHO },
  aviso: { marca: '!', cor: AMARELO },
} as const;

const visivel = (texto: string) => texto.replace(/\x1b\[[0-9;]*m/g, '').length;

/**
 * Corta em `largura` visíveis, contando escape como invisível e **sem partir
 * uma sequência no meio**.
 *
 * Cortar por índice de string era o defeito: a linha de 28 numa tela de 24
 * saía com uma sequência de cor partida (`\x1b[`), que o terminal exibe como
 * lixo e o teste enxerga como texto. O laço abaixo anda em caractere visível e
 * copia o escape inteiro — ou não copia nada.
 */
function corta(texto: string, largura: number): string {
  if (largura <= 0) return '';
  if (visivel(texto) <= largura) return texto;

  const limite = largura - 1; // um lugar para a reticência
  let saida = '';
  let n = 0;
  let i = 0;
  while (i < texto.length && n < limite) {
    if (texto[i] === '\x1b') {
      const fim = texto.indexOf('m', i);
      if (fim === -1) break;
      saida += texto.slice(i, fim + 1);
      i = fim + 1;
      continue;
    }
    saida += texto[i];
    n += 1;
    i += 1;
  }
  // O reset fecha o que estava aberto: a linha pode ter sido cortada no meio.
  return `${saida}…${R}`;
}

/** Preenche até `largura` visíveis. */
function completa(texto: string, largura: number): string {
  const falta = largura - visivel(texto);
  return falta > 0 ? texto + ' '.repeat(falta) : texto;
}

export function desenhar(estado: Estado, colunas: number, linhas: number): string {
  const largura = Math.max(24, colunas);
  const regua = `${FRACO}${'─'.repeat(largura)}${R}`;
  const cabecalho = [
    ` ${FORTE}fluigctl${R} ${FRACO}·${R} ${FORTE}servidores${R}` + contexto(estado, largura),
    regua,
  ];

  const corpo = miolo(estado, largura);

  // O recado e o rodapé nunca são cortados: o motivo de uma falha é a última
  // coisa que pode sumir da tela.
  const recado: string[] = estado.recado
    ? ['', ...quebrar(estado.recado.texto, largura - 6).map((l, i) => recadoLinha(estado.recado!, l, i === 0, largura))]
    : [];
  const rodape = ['', regua, ` ${atalhosDaTela(estado.tela, largura)}`];

  const sobra = Math.max(1, linhas - cabecalho.length - recado.length - rodape.length);
  return [...cabecalho, ...corpo.slice(0, sobra), ...recado, ...rodape].join('\n');
}

function contexto(estado: Estado, largura: number): string {
  const tela = estado.tela;
  const texto =
    tela.tipo === 'form'
      ? tela.form.novo
        ? 'novo servidor'
        : `revisando ${tela.form.original}`
      : tela.tipo === 'importar'
        ? 'importar da extensão'
        : tela.tipo === 'confirmar'
          ? 'confirmar'
          : tela.tipo === 'ajuda'
            ? 'ajuda'
            : estado.servidores.length === 0
              ? 'nenhum cadastrado'
              : `${estado.servidores.length} cadastrado${estado.servidores.length > 1 ? 's' : ''}`;
  const prefixo = ' fluigctl · servidores';
  const espaco = largura - visivel(prefixo) - visivel(texto) - 2;
  return espaco > 0 ? `${' '.repeat(espaco)}${FRACO}${texto}${R} ` : '';
}

/** O símbolo vem na primeira linha e as seguintes ficam alinhadas com o texto. */
function recadoLinha(r: { tom: 'ok' | 'erro' | 'aviso' }, texto: string, primeira: boolean, largura: number): string {
  const { marca, cor } = TOM[r.tom];
  // O `quebrar` já partiu em linhas; o corte é a rede para uma palavra maior
  // que a tela inteira.
  return corta(primeira ? `   ${cor}${marca}${R} ${texto}` : `     ${texto}`, largura);
}

/**
 * Tecla forte, rótulo apagado. Se não couber, saem os atalhos não essenciais
 * **inteiros**, um a um, até caber: perder o rótulo de todos deixaria uma fila
 * de letras soltas, que é pior do que mostrar menos teclas explicadas.
 */
function atalhosDaTela(tela: Tela, largura: number): string {
  const todos = atalhos(tela);
  const desenha = (lista: Atalho[]) =>
    lista.map(({ t, r }) => `${FORTE}${t}${R} ${FRACO}${r}${R}`).join(` ${FRACO}·${R} `);

  let lista = todos;
  if (visivel(desenha(lista)) > largura - 2) {
    for (const cortado of [...todos].reverse().filter((a) => !a.essencial)) {
      lista = lista.filter((a) => a !== cortado);
      if (visivel(desenha(lista)) <= largura - 2) break;
    }
  }
  return corta(desenha(lista), largura - 2);
}

function miolo(estado: Estado, largura: number): string[] {
  switch (estado.tela.tipo) {
    case 'lista':
      return lista(estado, largura);
    case 'form':
      return formulario(estado.tela, largura);
    case 'confirmar':
      return confirmacao(estado.tela, largura);
    case 'importar':
      return importacao(estado.tela, largura);
    case 'ajuda':
      return ajuda(largura);
  }
}

/**
 * A lista como tabela de colunas de verdade.
 *
 * O plano sai das larguras reais do conteúdo, não de números redondos: o nome
 * recebe a maior largura de nome, o endereço a maior URL, e assim por diante. A
 * coluna do endereço é a que **absorve a sobra**, então nenhuma linha estoura a
 * tela e nenhuma coluna precisa ser cortada quando o conteúdo é o normal.
 *
 * Prioridade, e é ela que decide o que sai quando a tela é estreita: marcador,
 * nome, endereço, [selo de produção], usuário, variável de senha. O selo fica
 * logo depois do nome — perto de quem ele qualifica — e **antes** do endereço,
 * então nunca é o que o corte come. Ordem do sacrifício: variável de senha,
 * usuário.
 */
const SELO = 9; // "PRODUÇÃO"

interface Plano {
  nome: number;
  endereco: number;
  usuario: number;
  senha: number;
  comSelo: boolean;
  comUsuario: boolean;
  comSenha: boolean;
}

const urlDe = (s: { ssl: boolean; host: string; porta: number }) =>
  `${s.ssl ? 'https' : 'http'}://${s.host}:${s.porta}`;

function plano(largura: number, servidores: readonly Linha[]): Plano {
  const nome = Math.max('NOME'.length, ...servidores.map((s) => s.nome.length));
  const endereco = Math.max('ENDEREÇO'.length, ...servidores.map((s) => urlDe(s).length));
  const usuario = Math.max('USUÁRIO'.length, ...servidores.map((s) => s.usuario.length));
  const senha = Math.max('VARIÁVEL DE SENHA'.length, ...servidores.map((s) => s.senhaEnv.length));
  const comSelo = servidores.some((s) => s.prod);

  // marcador, espaço, nome, espaço, selo, espaço, endereço
  let usado = 3 + nome + 1 + (comSelo ? SELO + 1 : 0) + endereco;
  const comUsuario = usado + 2 + usuario <= largura;
  if (comUsuario) usado += 2 + usuario;
  const comSenha = comUsuario && usado + 2 + senha <= largura;
  if (comSenha) usado += 2 + senha;

  return {
    nome,
    // A sobra toda vai para o endereço: é a coluna que mais sofre se ficar curta.
    endereco: endereco + Math.max(0, largura - usado),
    usuario,
    senha,
    comSelo,
    comUsuario,
    comSenha,
  };
}

/** Célula com largura: preenche, corta se passar, e colore depois da conta. */
function celula(texto: string, largura: number, estilo = ''): string {
  const cortado = visivel(texto) > largura ? corta(texto, largura) : texto;
  const t = completa(cortado, largura);
  return estilo === '' ? t : `${estilo}${t}${R}`;
}

type Linha = { nome: string; usuario: string; senhaEnv: string; prod: boolean; ssl: boolean; host: string; porta: number };

function lista(estado: Estado, largura: number): string[] {
  if (estado.servidores.length === 0) {
    return [
      '',
      `   ${FORTE}Nenhum servidor cadastrado.${R}`,
      '',
      `   ${FRACO}Comece por${R} ${FORTE}a${R} ${FRACO}para cadastrar o primeiro, ou por${R} ${FORTE}i${R} ${FRACO}para trazer${R}`,
      `   ${FRACO}os que já estão nos workspaces da extensão Fluiggers.${R}`,
    ];
  }

  const p = plano(largura, estado.servidores);
  const seloDe = (s: Linha) => (p.comSelo ? ` ${celula(s.prod ? 'PRODUÇÃO' : '', SELO, `${VERMELHO}${FORTE}`)}` : '');

  // Cabeçalho apagado: é ele que ensina o que é cada coluna.
  const cabecalho =
    `   ${celula('NOME', p.nome)}${p.comSelo ? ` ${celula('', SELO)}` : ''} ${celula('ENDEREÇO', p.endereco)}` +
    (p.comUsuario ? `  ${celula('USUÁRIO', p.usuario)}` : '') +
    (p.comSenha ? `  ${celula('VARIÁVEL DE SENHA', p.senha)}` : '');

  const saida = [corta(`${FRACO}${cabecalho}${R}`, largura), ''];

  estado.servidores.forEach((s, i) => {
    const foco = i === estado.foco;
    const linha =
      ` ${foco ? `${CIANO}▶${R}` : ' '} ` +
      celula(s.nome, p.nome, foco ? FORTE : '') +
      seloDe(s) +
      ' ' +
      celula(urlDe(s), p.endereco, FRACO) +
      (p.comUsuario ? `  ${celula(s.usuario, p.usuario)}` : '') +
      (p.comSenha ? `  ${celula(s.senhaEnv, p.senha, FRACO)}` : '');
    saida.push(corta(linha, largura));
  });

  return saida;
}

function formulario(tela: Extract<Tela, { tipo: 'form' }>, largura: number): string[] {
  const v = tela.form.valores;
  const larguraRotulo = 8;
  const saida: string[] = [''];
  const ultimo = CAMPOS_DO_FORM.at(-1)!;

  for (const campo of CAMPOS_DO_FORM) {
    const focado = campo === tela.form.foco;
    // A senha nunca aparece; só o tamanho, para a pessoa saber que digitou.
    const bruto = campo === 'senha' ? '•'.repeat(v[campo].length) : v[campo];
    const etiqueta = `${focado ? CIANO : FRACO}${ROTULO[campo].padEnd(larguraRotulo)}${R}`;
    // O campo em foco ganha um cursor no fim, que é onde a tecla vai cair.
    const conteudo = focado ? `${bruto}${CIANO}▏${R}` : bruto === '' ? `${FRACO}—${R}` : bruto;
    const dica =
      campo === 'ssl'
        ? `${FRACO}espaço alterna${R}`
        : campo === 'porta'
          ? `${FRACO}vazio usa ${v.ssl === 'sim' ? 443 : 80}${R}`
          : campo === 'senha'
            ? `${FRACO}vazio usa a variável de ambiente ou o servers.json da extensão${R}`
            : '';
    saida.push(corta(`   ${etiqueta}${conteudo}${dica === '' ? '' : `   ${dica}`}`, largura));
    // Um respiro entre os grupos: identificação, conexão, credencial.
    if (campo === 'nome' || campo === 'ssl') saida.push('');
    void ultimo;
  }

  if (tela.erro) {
    const linhas = quebrar(tela.erro, largura - 6);
    linhas.forEach((l, i) =>
      saida.push(corta(i === 0 ? `   ${VERMELHO}✗${R} ${l}` : `     ${l}`, largura)),
    );
  }

  if (tela.form.enviando) {
    saida.push(
      '',
      corta(
        `   ${AMARELO}⋯${R} ${FRACO}falando com o servidor — o cadastro só é gravado se a credencial valer${R}`,
        largura,
      ),
    );
  }

  return saida;
}

function confirmacao(tela: Extract<Tela, { tipo: 'confirmar' }>, largura: number): string[] {
  const linhas = quebrar(tela.pergunta, largura - 6);
  return [
    '',
    ...linhas.map((l) => corta(`   ${l}`, largura)),
    '',
    corta(`   ${FORTE}s${R} ${FRACO}sim${R}      ${FORTE}n${R} ${FRACO}não${R}      ${FRACO}esc volta${R}`, largura),
  ];
}

function importacao(tela: Extract<Tela, { tipo: 'importar' }>, largura: number): string[] {
  const saida: string[] = ['', corta(`   ${FRACO}de${R} ${tela.dir}`, largura), ''];
  if (tela.candidatos.length === 0) {
    saida.push(`   ${AMARELO}!${R} ${FRACO}nenhum servidor encontrado nesse diretório.${R}`);
    return saida;
  }

  const larguraNome = Math.max(...tela.candidatos.map((c) => c.nome.length));
  const marcados = tela.candidatos.filter((c) => c.marcado && !c.jaExiste).length;

  tela.candidatos.forEach((c, i) => {
    const foco = i === tela.foco;
    // `=` no que já existe: não é escolha, é estado.
    const caixa = c.jaExiste ? `${FRACO}=${R}` : c.marcado ? `${VERDE}✓${R}` : ' ';
    const nome = foco ? `${FORTE}${completa(c.nome, larguraNome)}${R}` : completa(c.nome, larguraNome);
    const selo = c.prod ? ` ${VERMELHO}${FORTE}PRODUÇÃO${R}` : '';
    const nota = c.jaExiste ? `  ${FRACO}já cadastrado${R}` : '';
    const seta = foco ? `${CIANO}▶${R}` : ' ';
    saida.push(corta(` ${seta} [${caixa}] ${nome}  ${FRACO}${c.url}${R}  ${c.usuario}${selo}${nota}`, largura));
  });

  saida.push(
    '',
    corta(
      `   ${FRACO}${marcados} marcado${marcados === 1 ? '' : 's'}   ·   senhas:${R} ` +
        (tela.comSenhas ? `${VERDE}sim, copiar${R}` : `${FRACO}não${R}`),
      largura,
    ),
  );
  return saida;
}

function ajuda(largura: number): string[] {
  return [
    '',
    ...AJUDA.map(([tecla, texto]) => corta(`   ${FORTE}${tecla.padEnd(4)}${R} ${texto}`, largura)),
  ];
}

/** O que a tela mostra, sem escapes: é o que os testes conferem. */
export function semCores(quadro: string): string {
  return quadro.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}
