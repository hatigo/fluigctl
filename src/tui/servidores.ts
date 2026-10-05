import type { Tecla } from './terminal.js';

/**
 * O modelo da tela de servidores: estado, redutor e desenho.
 *
 * O redutor é puro de propósito — recebe uma tecla ou o resultado de uma ação e
 * devolve o estado novo mais os **efeitos** a executar. Quem fala com o disco e
 * com o servidor é o shell (`server-ui.ts`), que só obedece. É o que torna a
 * tela testável sem terminal: os testes chamam `reduzir` e conferem o estado e
 * os efeitos, sem pty e sem rede.
 *
 * O TUI não reimplementa nada do `server`: ele chama `addServer`, `removeServer`,
 * `setProd` e `testServer`, os mesmos que o CLI. Uma implementação, dois
 * front-ends.
 */

export interface LinhaServidor {
  nome: string;
  host: string;
  porta: number;
  ssl: boolean;
  usuario: string;
  companyId: number;
  userCode: string;
  senhaEnv: string;
  prod: boolean;
}

export const CAMPOS_DO_FORM = ['nome', 'host', 'porta', 'ssl', 'usuario', 'senha'] as const;
export type CampoDoForm = (typeof CAMPOS_DO_FORM)[number];

export interface Formulario {
  /** Valores digitados, por campo. */
  valores: Record<CampoDoForm, string>;
  foco: CampoDoForm;
  /** `true` quando é o cadastro de um novo servidor; `false` ao rever um. */
  novo: boolean;
  /** Nome original, no caso de renomear pela tela. */
  original?: string | undefined;
  /** Já pediu para salvar e está esperando o servidor responder. */
  enviando?: boolean | undefined;
}

export interface Teste {
  nome: string;
  ok: boolean;
  /** Linhas já prontas para mostrar. */
  detalhe: string[];
}

export interface CandidatoImport {
  nome: string;
  url: string;
  usuario: string;
  prod: boolean;
  /** Já existe na config: fica fora da importação, como no `server import`. */
  jaExiste: boolean;
  marcado: boolean;
}

export type Tela =
  | { tipo: 'lista' }
  | { tipo: 'form'; form: Formulario; erro?: string | undefined }
  | { tipo: 'confirmar'; pergunta: string; sim: Escolha }
  | { tipo: 'importar'; dir: string; candidatos: CandidatoImport[]; foco: number; comSenhas: boolean }
  | { tipo: 'ajuda' };

/** O que a confirmação faz se a resposta for sim. */
export type Escolha =
  | { tipo: 'remover'; nome: string }
  | { tipo: 'marcarProd'; nome: string }
  | { tipo: 'descartarForm' }
  /** Carrega o que importar: a tela de importação já saiu do estado. */
  | { tipo: 'importar'; dir: string; nomes: string[]; comSenhas: boolean }
  | { tipo: 'sair' };

export interface Estado {
  servidores: LinhaServidor[];
  foco: number;
  tela: Tela;
  /** Última resposta da tela: aviso, erro ou nada. */
  recado?: { tom: 'ok' | 'erro' | 'aviso'; texto: string } | undefined;
  /** De onde veio a última leitura do diretório de importação. */
  dirPadrao: string;
  sair: boolean;
}

export type Evento =
  | { tipo: 'tecla'; tecla: Tecla }
  | { tipo: 'servidores'; servidores: LinhaServidor[] }
  | { tipo: 'recado'; tom: 'ok' | 'erro' | 'aviso'; texto: string }
  | { tipo: 'candidatos'; dir: string; candidatos: CandidatoImport[] }
  | { tipo: 'teste'; teste: Teste }
  /**
   * Desfecho do `salvar`. Enquanto ele não chega, o formulário fica na tela com
   * o que foi digitado: perder o preenchimento porque o login falhou obrigaria a
   * digitar tudo de novo.
   */
  | { tipo: 'salvo'; ok: boolean; texto: string };

export type Efeito =
  | { tipo: 'recarregar' }
  | { tipo: 'sair' }
  | { tipo: 'salvar'; nome: string; original: string | undefined; host: string; porta: number; ssl: boolean; usuario: string; senha: string | undefined; prod: boolean }
  | { tipo: 'remover'; nome: string }
  | { tipo: 'alternarProd'; nome: string; prod: boolean }
  | { tipo: 'testar'; nome: string }
  | { tipo: 'listarParaImportar'; dir: string }
  | { tipo: 'importar'; dir: string; nomes: string[]; comSenhas: boolean };

export interface Reduzido {
  estado: Estado;
  efeitos: Efeito[];
}

export function estadoInicial(servidores: LinhaServidor[], dirPadrao: string): Estado {
  return { servidores, foco: 0, tela: { tipo: 'lista' }, dirPadrao, sair: false };
}

const LIMITE = (n: number, max: number) => Math.max(0, Math.min(n, max - 1));
const recado = (tom: 'ok' | 'erro' | 'aviso', texto: string) => ({ tom, texto }) as const;

export function formVazio(): Formulario {
  return {
    valores: { nome: '', host: '', porta: '', ssl: 'não', usuario: '', senha: '' },
    foco: 'nome',
    novo: true,
  };
}

export function formDe(s: LinhaServidor): Formulario {
  return {
    valores: {
      nome: s.nome,
      host: s.host,
      porta: String(s.porta),
      ssl: s.ssl ? 'sim' : 'não',
      usuario: s.usuario,
      senha: '',
    },
    foco: 'nome',
    novo: false,
    original: s.nome,
  };
}

export function reduzir(estado: Estado, evento: Evento): Reduzido {
  if (evento.tipo === 'servidores') {
    const foco = LIMITE(estado.foco, Math.max(1, evento.servidores.length));
    return { estado: { ...estado, servidores: evento.servidores, foco }, efeitos: [] };
  }
  if (evento.tipo === 'recado') {
    return { estado: { ...estado, recado: recado(evento.tom, evento.texto) }, efeitos: [] };
  }
  if (evento.tipo === 'teste') {
    const s = estado.servidores.find((x) => x.nome === evento.teste.nome);
    return {
      estado: {
        ...estado,
        recado: recado(
          evento.teste.ok ? 'ok' : 'erro',
          `${evento.teste.nome}: ${evento.teste.detalhe.join(' · ')}` + (s ? '' : ' (não está mais cadastrado)'),
        ),
      },
      efeitos: [],
    };
  }
  if (evento.tipo === 'salvo') {
    const tela = estado.tela;
    if (evento.ok) {
      return { estado: { ...estado, tela: { tipo: 'lista' }, recado: recado('ok', evento.texto) }, efeitos: [] };
    }
    // Falhou: fica no formulário, com o que foi digitado e o motivo.
    if (tela.tipo === 'form') {
      const { enviando: _sai, ...form } = tela.form;
      return { estado: { ...estado, tela: { tipo: 'form', form, erro: evento.texto } }, efeitos: [] };
    }
    return { estado: { ...estado, recado: recado('erro', evento.texto) }, efeitos: [] };
  }
  if (evento.tipo === 'candidatos') {
    return {
      estado: {
        ...estado,
        tela: { tipo: 'importar', dir: evento.dir, candidatos: evento.candidatos, foco: 0, comSenhas: false },
      },
      efeitos: [],
    };
  }

  const { tecla } = evento;
  if (tecla.tipo === 'ctrl-c') return { estado: { ...estado, sair: true }, efeitos: [{ tipo: 'sair' }] };

  switch (estado.tela.tipo) {
    case 'ajuda':
      // Qualquer tecla volta.
      return { estado: { ...estado, tela: { tipo: 'lista' } }, efeitos: [] };

    case 'confirmar':
      return reduzirConfirmacao(estado, estado.tela, tecla);

    case 'form':
      return reduzirForm(estado, estado.tela, tecla);

    case 'importar':
      return reduzirImportacao(estado, estado.tela, tecla);

    case 'lista':
      return reduzirLista(estado, tecla);
  }
}

/**
 * As teclas de cada tela, em pares tecla/rótulo, para o desenho montar a linha
 * de atalhos (e saber o que cortar quando a tela é estreita).
 *
 * Fica aqui, junto do redutor, porque é a mesma decisão: se uma tecla entra no
 * redutor, ela aparece no rodapé — e o teste confere as duas coisas juntas.
 */
export interface Atalho {
  t: string;
  r: string;
  /**
   * Sem ele a tela fica sem saída óbvia. Quando o rodapé não cabe, os não
   * essenciais saem inteiros — com rótulo e tudo —, em vez de sair o rótulo de
   * todos: `a t p x i ?` sem explicação não ajuda ninguém.
   */
  essencial?: boolean;
}

export function atalhos(tela: Tela): Atalho[] {
  if (tela.tipo === 'lista') {
    return [
      { t: '↑↓', r: 'mover', essencial: true },
      { t: '⏎', r: 'rever', essencial: true },
      { t: 'a', r: 'novo', essencial: true },
      { t: 't', r: 'testar' },
      { t: 'p', r: 'produção' },
      { t: 'x', r: 'remover' },
      { t: 'i', r: 'importar' },
      { t: '?', r: 'ajuda', essencial: true },
      { t: 'q', r: 'sair', essencial: true },
    ];
  }
  if (tela.tipo === 'form') {
    // O rótulo do `⏎` diz o que ele faz agora: avançar ou concluir.
    const ultimo = CAMPOS_DO_FORM.at(-1);
    const conclui = tela.form.foco === ultimo && !tela.form.enviando;
    return [
      { t: 'tab', r: 'próximo' },
      { t: '⏎', r: conclui ? 'concluir' : 'seguir' },
      { t: 'esc', r: 'cancelar' },
    ];
  }
  if (tela.tipo === 'confirmar') {
    return [
      { t: 's', r: 'sim' },
      { t: 'n', r: 'não' },
      { t: 'esc', r: 'voltar' },
    ];
  }
  if (tela.tipo === 'importar') {
    return [
      { t: '↑↓', r: 'mover' },
      { t: 'espaço', r: 'marcar' },
      { t: 'a', r: 'todos' },
      { t: 's', r: 'senhas' },
      { t: '⏎', r: 'importar' },
      { t: 'esc', r: 'voltar' },
    ];
  }
  return [{ t: 'qualquer tecla', r: 'volta' }];
}

function reduzirLista(estado: Estado, tecla: Tecla): Reduzido {
  const total = estado.servidores.length;
  const atual = estado.servidores[estado.foco];

  if (tecla.tipo === 'cima') return { estado: { ...estado, foco: LIMITE(estado.foco - 1, Math.max(1, total)) }, efeitos: [] };
  if (tecla.tipo === 'baixo') return { estado: { ...estado, foco: LIMITE(estado.foco + 1, Math.max(1, total)) }, efeitos: [] };

  const semRecado: Estado = { ...estado, recado: undefined };

  // `enter` abre o servidor em foco; por isso vem antes da guarda de caractere.
  if (tecla.tipo === 'enter') {
    if (!atual) return { estado: semRecado, efeitos: [] };
    return { estado: { ...semRecado, tela: { tipo: 'form', form: formDe(atual) } }, efeitos: [] };
  }
  if (tecla.tipo !== 'caractere') return { estado, efeitos: [] };

  switch (tecla.valor) {
    case 'q':
      return { estado: { ...estado, sair: true }, efeitos: [{ tipo: 'sair' }] };
    case '?':
      return { estado: { ...semRecado, tela: { tipo: 'ajuda' } }, efeitos: [] };
    case 'a': {
      return { estado: { ...semRecado, tela: { tipo: 'form', form: formVazio() } }, efeitos: [] };
    }
    case 'i':
      return { estado: semRecado, efeitos: [{ tipo: 'listarParaImportar', dir: estado.dirPadrao }] };
    case 't':
      if (!atual) return { estado: semRecado, efeitos: [] };
      return { estado: semRecado, efeitos: [{ tipo: 'testar', nome: atual.nome }] };
    case 'p': {
      if (!atual) return { estado: semRecado, efeitos: [] };
      // Marcar produção é o que muda o comportamento do push: confirmar sempre
      // que for ligar, e nunca quando for desligar (desligar não esconde nada).
      if (!atual.prod) {
        return {
          estado: {
            ...semRecado,
            tela: {
              tipo: 'confirmar',
              pergunta: `Marcar "${atual.nome}" como PRODUÇÃO? O push passa a exigir a senha digitada no terminal.`,
              sim: { tipo: 'marcarProd', nome: atual.nome },
            },
          },
          efeitos: [],
        };
      }
      return { estado: semRecado, efeitos: [{ tipo: 'alternarProd', nome: atual.nome, prod: false }] };
    }
    case 'x': {
      if (!atual) return { estado: semRecado, efeitos: [] };
      return {
        estado: {
          ...semRecado,
          tela: {
            tipo: 'confirmar',
            pergunta: `Remover "${atual.nome}" do cadastro? A senha no arquivo próprio não é tocada.`,
            sim: { tipo: 'remover', nome: atual.nome },
          },
        },
        efeitos: [],
      };
    }
    default:
      return { estado, efeitos: [] };
  }
}

function reduzirConfirmacao(estado: Estado, tela: Extract<Tela, { tipo: 'confirmar' }>, tecla: Tecla): Reduzido {
  const volta: Estado = { ...estado, tela: { tipo: 'lista' }, recado: undefined };
  if (tecla.tipo === 'escape') return { estado: volta, efeitos: [] };
  if (tecla.tipo !== 'caractere') return { estado, efeitos: [] };

  const sim = tecla.valor.toLowerCase() === 's';
  if (!sim && tecla.valor.toLowerCase() !== 'n') return { estado, efeitos: [] };
  if (!sim) return { estado: volta, efeitos: [] };

  const escolha = tela.sim;
  switch (escolha.tipo) {
    case 'remover':
      return { estado: volta, efeitos: [{ tipo: 'remover', nome: escolha.nome }] };
    case 'marcarProd':
      return { estado: volta, efeitos: [{ tipo: 'alternarProd', nome: escolha.nome, prod: true }] };
    case 'descartarForm':
      return { estado: volta, efeitos: [] };
    case 'importar':
      return { estado: volta, efeitos: [{ tipo: 'importar', dir: escolha.dir, nomes: escolha.nomes, comSenhas: escolha.comSenhas }] };
    case 'sair':
      return { estado: { ...estado, sair: true }, efeitos: [{ tipo: 'sair' }] };
  }
}

function reduzirForm(estado: Estado, tela: Extract<Tela, { tipo: 'form' }>, tecla: Tecla): Reduzido {
  const { form } = tela;
  const semErro: Extract<Tela, { tipo: 'form' }> = { tipo: 'form', form };
  const comErro = (erro: string): Reduzido => ({ estado: { ...estado, tela: { ...tela, erro } }, efeitos: [] });

  // Enquanto o servidor responde, só o cancelar passa: teclar de novo não pode
  // disparar um segundo cadastro.
  if (form.enviando) {
    if (tecla.tipo === 'escape') return { estado, efeitos: [] };
    return { estado, efeitos: [] };
  }

  if (tecla.tipo === 'escape') {
    return {
      estado: {
        ...estado,
        tela: {
          tipo: 'confirmar',
          pergunta: 'Descartar o preenchimento e voltar?',
          sim: { tipo: 'descartarForm' },
        },
      },
      efeitos: [],
    };
  }

  if (tecla.tipo === 'tab') {
    const i = CAMPOS_DO_FORM.indexOf(form.foco);
    const proximo = CAMPOS_DO_FORM[(i + 1) % CAMPOS_DO_FORM.length]!;
    // Trocar de campo limpa o erro: ele era do campo anterior.
    return { estado: { ...estado, tela: { tipo: 'form', form: { ...form, foco: proximo } } }, efeitos: [] };
  }

  if (tecla.tipo === 'backspace') {
    const valores = { ...form.valores, [form.foco]: form.valores[form.foco].slice(0, -1) };
    return { estado: { ...estado, tela: { ...semErro, form: { ...form, valores } } }, efeitos: [] };
  }

  if (tecla.tipo === 'caractere') {
    // No campo do ssl não se digita: espaço alterna. É menos uma coisa para
    // lembrar ("sim"? "não"? "true"?) e não tem estado inválido.
    if (form.foco === 'ssl' && tecla.valor === ' ') {
      const valores = { ...form.valores, ssl: form.valores.ssl === 'sim' ? 'não' : 'sim' };
      return { estado: { ...estado, tela: { ...semErro, form: { ...form, valores } } }, efeitos: [] };
    }
    if (form.foco === 'ssl' && tecla.valor !== ' ') return { estado, efeitos: [] };
    const valores = { ...form.valores, [form.foco]: form.valores[form.foco] + tecla.valor };
    return { estado: { ...estado, tela: { ...semErro, form: { ...form, valores } } }, efeitos: [] };
  }

  if (tecla.tipo !== 'enter') return { estado, efeitos: [] };

  // `enter` no meio do formulário passa para o próximo campo; no último,
  // conclui. É o que a mão espera de um formulário em passos, e o rodapé diz
  // qual dos dois vai acontecer.
  if (form.foco !== 'senha') {
    const i = CAMPOS_DO_FORM.indexOf(form.foco);
    const proximo = CAMPOS_DO_FORM[i + 1]!;
    return { estado: { ...estado, tela: { tipo: 'form', form: { ...form, foco: proximo } } }, efeitos: [] };
  }

  // Concluir: valida o que dá para validar sem rede, e devolve o efeito.
  const v = form.valores;
  const nome = v.nome.trim();
  if (nome === '') return comErro('o nome do servidor é obrigatório');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(nome)) return comErro('nome inválido: use minúsculas, números e hífen (ex.: cetenco-prod)');
  if (v.host.trim() === '') return comErro('o host é obrigatório');
  if (v.usuario.trim() === '') return comErro('o usuário é obrigatório');
  const porta = v.porta.trim() === '' ? (v.ssl === 'sim' ? 443 : 80) : Number(v.porta);
  if (!Number.isInteger(porta) || porta <= 0 || porta > 65535) return comErro('porta inválida: use um número de 1 a 65535');
  const outro = estado.servidores.find((s) => s.nome === nome && s.nome !== form.original);
  if (outro) return comErro(`já existe um servidor chamado "${nome}"`);

  return {
    estado: { ...estado, tela: { tipo: 'form', form: { ...form, enviando: true } } },
    efeitos: [
      {
        tipo: 'salvar',
        nome,
        original: form.original,
        host: v.host.trim(),
        porta,
        ssl: v.ssl === 'sim',
        usuario: v.usuario.trim(),
        senha: v.senha === '' ? undefined : v.senha,
        prod: false,
      },
    ],
  };
}

function reduzirImportacao(estado: Estado, tela: Extract<Tela, { tipo: 'importar' }>, tecla: Tecla): Reduzido {
  const total = tela.candidatos.length;
  if (tecla.tipo === 'escape') return { estado: { ...estado, tela: { tipo: 'lista' } }, efeitos: [] };
  if (tecla.tipo === 'cima' || tecla.tipo === 'baixo') {
    const passo = tecla.tipo === 'cima' ? -1 : 1;
    return { estado: { ...estado, tela: { ...tela, foco: LIMITE(tela.foco + passo, Math.max(1, total)) } }, efeitos: [] };
  }
  if (tecla.tipo !== 'caractere') {
    // `enter` confirma a importação; por isso vem antes da guarda de caractere.
    if (tecla.tipo !== 'enter') return { estado, efeitos: [] };
    const nomes = tela.candidatos.filter((c) => c.marcado && !c.jaExiste).map((c) => c.nome);
    if (nomes.length === 0) {
      return { estado: { ...estado, recado: recado('aviso', 'nenhum candidato marcado (use espaço)') }, efeitos: [] };
    }
    const senhas = tela.comSenhas ? ' Também vai copiar as senhas para o arquivo próprio.' : '';
    return {
      estado: {
        ...estado,
        tela: {
          tipo: 'confirmar',
          pergunta: `Gravar ${nomes.length} servidor(es) no cadastro: ${nomes.join(', ')}.${senhas}`,
          sim: { tipo: 'importar', dir: tela.dir, nomes, comSenhas: tela.comSenhas },
        },
      },
      efeitos: [],
    };
  }

  const atual = tela.candidatos[tela.foco];
  if (tecla.valor === ' ') {
    if (!atual || atual.jaExiste) return { estado, efeitos: [] };
    const candidatos = tela.candidatos.map((c, i) => (i === tela.foco ? { ...c, marcado: !c.marcado } : c));
    return { estado: { ...estado, tela: { ...tela, candidatos } }, efeitos: [] };
  }
  if (tecla.valor === 's') {
    return { estado: { ...estado, tela: { ...tela, comSenhas: !tela.comSenhas } }, efeitos: [] };
  }
  if (tecla.valor === 'a') {
    // Marca ou desmarca todos os que podem ser importados.
    const marcar = tela.candidatos.some((c) => !c.jaExiste && !c.marcado);
    const candidatos = tela.candidatos.map((c) => (c.jaExiste ? c : { ...c, marcado: marcar }));
    return { estado: { ...estado, tela: { ...tela, candidatos } }, efeitos: [] };
  }
  return { estado, efeitos: [] };
}
