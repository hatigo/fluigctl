/**
 * Lê o `.metadata` que o Fluig Studio grava na pasta de cada formulário.
 *
 * É um `FormularioServerDto` em serialização Java: a lista de exportações já
 * feitas (`dtos`, uma por servidor, com o documentId), o servidor da última
 * (`lastServerName`) e o arquivo principal. É o único lugar do repositório que
 * diz em QUAL formulário do servidor a pasta foi publicada — o nome da pasta não
 * diz: `forms/formReembolso` é o documentId 902 ("formSolicitacaoReembolso") no
 * HML da Cetenco, e o 676 ("formReembolso") é outro formulário.
 *
 * O decodificador cobre só o que esse arquivo usa (objeto, descritor de classe,
 * string, referência, nulo, bloco de dados, campos primitivos). Qualquer coisa
 * fora disso vira erro, e quem chama trata o arquivo como ausente: um palpite
 * errado aqui publicaria no formulário errado.
 */

export interface ExportacaoStudio {
  documentId: number;
  documentDescription: string;
  /** O campo descritor do formulário (o `cardDescription` do DTO do Studio). */
  cardDescription: string;
  /** Nome do servidor no Studio — rótulo local, não bate com o do fluigctl. */
  serverName: string;
  /** Dataset do formulário. */
  serviceName: string;
}

export interface MetadataStudio {
  exportacoes: ExportacaoStudio[];
  lastServerName: string;
  principalFileName: string;
}

const MAGIC = 0xaced;
const TC_NULL = 0x70;
const TC_REFERENCE = 0x71;
const TC_CLASSDESC = 0x72;
const TC_OBJECT = 0x73;
const TC_STRING = 0x74;
const TC_BLOCKDATA = 0x77;
const TC_ENDBLOCKDATA = 0x78;
const BASE_HANDLE = 0x7e0000;
const SC_WRITE_METHOD = 0x01;

interface Campo {
  tipo: string;
  nome: string;
}

interface Classe {
  nome: string;
  flags: number;
  campos: Campo[];
  superclasse: Classe | null;
}

interface Objeto {
  classe: string;
  campos: Record<string, unknown>;
  /** Objetos gravados por writeObject depois dos campos (ex.: elementos do ArrayList). */
  extras: unknown[];
}

class Leitor {
  private pos = 0;
  private readonly handles: unknown[] = [];

  constructor(private readonly b: Buffer) {}

  private u8(): number {
    if (this.pos >= this.b.length) throw new Error('fim inesperado');
    return this.b[this.pos++]!;
  }

  private u16(): number {
    const v = this.b.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  private i32(): number {
    const v = this.b.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  private utf(): string {
    const n = this.u16();
    const s = this.b.subarray(this.pos, this.pos + n).toString('utf8');
    this.pos += n;
    return s;
  }

  private novoHandle(valor: unknown): number {
    this.handles.push(valor);
    return this.handles.length - 1;
  }

  inicio(): unknown {
    if (this.u16() !== MAGIC) throw new Error('não é serialização Java');
    this.u16(); // versão do stream
    return this.conteudo();
  }

  private conteudo(): unknown {
    const tc = this.u8();
    switch (tc) {
      case TC_NULL:
        return null;
      case TC_REFERENCE: {
        const h = this.i32() - BASE_HANDLE;
        if (h < 0 || h >= this.handles.length) throw new Error(`referência ${h} inválida`);
        return this.handles[h];
      }
      case TC_STRING: {
        const s = this.utf();
        this.novoHandle(s);
        return s;
      }
      case TC_OBJECT:
        return this.objeto();
      case TC_CLASSDESC:
        return this.classeNova();
      case TC_BLOCKDATA: {
        const n = this.u8();
        const dados = this.b.subarray(this.pos, this.pos + n);
        this.pos += n;
        return { bloco: dados };
      }
      default:
        throw new Error(`tipo 0x${tc.toString(16)} não suportado na posição ${this.pos - 1}`);
    }
  }

  private descritor(): Classe | null {
    const v = this.conteudo();
    if (v === null) return null;
    if (typeof v === 'object' && v !== null && 'campos' in v && 'flags' in v) return v as Classe;
    throw new Error('esperava um descritor de classe');
  }

  private classeNova(): Classe {
    const nome = this.utf();
    this.pos += 8; // serialVersionUID
    const classe: Classe = { nome, flags: 0, campos: [], superclasse: null };
    this.novoHandle(classe);
    classe.flags = this.u8();

    const total = this.u16();
    for (let i = 0; i < total; i++) {
      const tipo = String.fromCharCode(this.u8());
      const nomeCampo = this.utf();
      if (tipo === 'L' || tipo === '[') this.conteudo(); // nome da classe do campo
      classe.campos.push({ tipo, nome: nomeCampo });
    }

    this.anotacoes();
    classe.superclasse = this.descritor();
    return classe;
  }

  private anotacoes(): unknown[] {
    const lidos: unknown[] = [];
    for (;;) {
      if (this.b[this.pos] === TC_ENDBLOCKDATA) {
        this.pos++;
        return lidos;
      }
      lidos.push(this.conteudo());
    }
  }

  private primitivo(tipo: string): unknown {
    switch (tipo) {
      case 'I':
        return this.i32();
      case 'Z':
        return this.u8() !== 0;
      case 'B':
        return (this.u8() << 24) >> 24;
      case 'S':
        return (this.u16() << 16) >> 16;
      case 'C':
        return String.fromCharCode(this.u16());
      case 'J': {
        const v = this.b.readBigInt64BE(this.pos);
        this.pos += 8;
        return v;
      }
      case 'F': {
        const v = this.b.readFloatBE(this.pos);
        this.pos += 4;
        return v;
      }
      case 'D': {
        const v = this.b.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
      }
      default:
        throw new Error(`campo de tipo ${tipo} não suportado`);
    }
  }

  private objeto(): Objeto {
    const classe = this.descritor();
    if (!classe) throw new Error('objeto sem classe');
    const obj: Objeto = { classe: classe.nome, campos: {}, extras: [] };
    this.novoHandle(obj);

    // Dados de cada classe da hierarquia, da superclasse para a subclasse.
    const hierarquia: Classe[] = [];
    for (let c: Classe | null = classe; c; c = c.superclasse) hierarquia.unshift(c);

    for (const c of hierarquia) {
      for (const campo of c.campos) {
        obj.campos[campo.nome] =
          campo.tipo === 'L' || campo.tipo === '[' ? this.conteudo() : this.primitivo(campo.tipo);
      }
      if (c.flags & SC_WRITE_METHOD) obj.extras.push(...this.anotacoes());
    }

    return obj;
  }
}

function ehObjeto(v: unknown): v is Objeto {
  return typeof v === 'object' && v !== null && 'classe' in v && 'campos' in v;
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** O valor de um `java.lang.Integer` serializado. */
function inteiro(v: unknown): number | undefined {
  if (!ehObjeto(v) || v.classe !== 'java.lang.Integer') return undefined;
  const n = v.campos['value'];
  return typeof n === 'number' ? n : undefined;
}

/**
 * Decodifica o `.metadata`. Lança se o arquivo não for o que se espera —
 * `lerMetadataStudio` transforma isso em "sem metadata".
 */
export function parseMetadataStudio(bytes: Buffer): MetadataStudio {
  const raiz = new Leitor(bytes).inicio();
  if (!ehObjeto(raiz) || !raiz.classe.endsWith('FormularioServerDto')) {
    throw new Error('não é um FormularioServerDto');
  }

  const lista = raiz.campos['dtos'];
  const elementos = ehObjeto(lista) ? lista.extras.filter(ehObjeto) : [];

  const exportacoes: ExportacaoStudio[] = [];
  for (const dto of elementos) {
    const documentId = inteiro(dto.campos['documentId']);
    if (documentId === undefined || documentId <= 0) continue;
    exportacoes.push({
      documentId,
      documentDescription: texto(dto.campos['documentDescription']),
      cardDescription: texto(dto.campos['cardDescription']),
      serverName: texto(dto.campos['serverName']),
      serviceName: texto(dto.campos['serviceName']),
    });
  }

  return {
    exportacoes,
    lastServerName: texto(raiz.campos['lastServerName']),
    principalFileName: texto(raiz.campos['principalFileName']),
  };
}

/** Como `parseMetadataStudio`, mas arquivo ilegível vira `undefined`. */
export function lerMetadataStudio(bytes: Buffer | undefined): MetadataStudio | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  try {
    return parseMetadataStudio(bytes);
  } catch {
    return undefined;
  }
}
