import { lerDiagrama } from '../push/diagram/modelo.js';
import { ConflitoEdicao, EdicaoInvalida, trocarCoordenada } from './edit.js';

/**
 * Redimensionar raias e pool sem o Studio.
 *
 * As raias moram dentro da pool, com x/y relativos a ela; os elementos e as
 * dobras das ligações são soltos no diagrama, com coordenadas absolutas. Mudar
 * a altura de uma raia, então, mexe em quatro coisas: a raia (e o rótulo dela),
 * as raias de baixo (y relativo), a pool (e o rótulo dela) e tudo o que está
 * desenhado abaixo da raia (y absoluto dos elementos e das dobras).
 */

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;

interface Tag {
  inicio: number;
  tag: string;
}

interface Forma {
  id?: string | undefined;
  profundidade: number;
  ga?: Tag;
  /** Os al:Text filhos diretos: o rótulo girado da raia ou da pool. */
  textos: Tag[];
}

/** Toda forma do pictograma (inclusive as aninhadas), com a tag do seu graphicsAlgorithm e dos rótulos. */
function formas(xml: string): Forma[] {
  const lista: Forma[] = [];
  const pilha: { nome: string; forma?: Forma; rotulo?: boolean }[] = [];
  let dentroDoDiagrama = false;
  for (const m of xml.matchAll(TOKEN)) {
    const [inteiro, fecha, nome] = m;
    if (nome === undefined) continue;
    const vazia = m[4] === '/';
    if (fecha) {
      pilha.pop();
      if (nome === 'pi:Diagram') dentroDoDiagrama = false;
      continue;
    }
    const pai = pilha.at(-1);
    let entrada: { nome: string; forma?: Forma; rotulo?: boolean } = { nome };
    if (nome === 'pi:Diagram') dentroDoDiagrama = true;
    else if (dentroDoDiagrama && nome === 'children') {
      const container = /xsi:type="pi:ContainerShape"/.test(inteiro);
      if (container) {
        const f: Forma = { profundidade: pilha.filter((p) => p.forma).length, textos: [] };
        lista.push(f);
        entrada = { nome, forma: f };
      } else if (pai?.forma) {
        entrada = { nome, rotulo: true, forma: pai.forma };
      }
    } else if (nome === 'graphicsAlgorithm' && pai?.forma) {
      if (pai.rotulo) {
        if (/xsi:type="al:Text"/.test(inteiro)) pai.forma.textos.push({ inicio: m.index, tag: inteiro });
      } else if (!pai.forma.ga) {
        pai.forma.ga = { inicio: m.index, tag: inteiro };
      }
    } else if (nome === 'link' && pai?.forma && !pai.rotulo) {
      pai.forma.id = /\sbusinessObjects="([^"]*)"/.exec(inteiro)?.[1];
    }
    if (!vazia) pilha.push(entrada);
  }
  return lista;
}

function attrNum(tag: string, attr: string): number {
  return Number(new RegExp(`\\s${attr}="(-?\\d+)"`).exec(tag)?.[1] ?? 0);
}

function trocarNum(tag: string, attr: 'width' | 'height', valor: number): string {
  return tag.replace(new RegExp(`\\s${attr}="\\d+"`), ` ${attr}="${valor}"`);
}

/** Aplica as trocas de tag do fim para o começo, para os índices continuarem válidos. */
function aplicar(xml: string, trocas: { inicio: number; antes: string; depois: string }[]): string {
  let texto = xml;
  for (const t of [...trocas].sort((a, b) => b.inicio - a.inicio)) {
    if (t.antes === t.depois) continue;
    texto = texto.slice(0, t.inicio) + t.depois + texto.slice(t.inicio + t.antes.length);
  }
  return texto;
}

const MINIMO = 60;

export function redimensionarRaiaNoXml(xml: string, raiaId: string, altura: number): string {
  if (!Number.isInteger(altura) || altura < MINIMO || altura > 20000) throw new EdicaoInvalida(`a altura da raia vai de ${MINIMO} a 20000 px`);
  const d = lerDiagrama(xml);
  const raia = d.objetos.find((o) => o.attrs['id'] === raiaId);
  if (!raia) throw new ConflitoEdicao('elemento-removido', `a raia ${raiaId} não existe mais`);
  if (raia.tipo !== 'BpmnSwimLane') throw new EdicaoInvalida(`${raiaId} não é uma raia`);
  const caixaRaia = d.caixas.get(raiaId)!;
  const poolId = caixaRaia.pai;
  const pool = poolId ? d.caixas.get(poolId) : undefined;
  if (!poolId || !pool) throw new EdicaoInvalida('a raia não está dentro de uma pool');
  const delta = altura - caixaRaia.altura;
  if (delta === 0) throw new EdicaoInvalida('nada mudou');

  const topo = caixaRaia.absY;
  const fundoAntes = topo + caixaRaia.altura;
  const fundoDepois = topo + altura;
  const todas = formas(xml);
  const soltas = todas.filter((f) => f.profundidade === 0 && f.id && f.id !== poolId);

  // Encolher não corta nada que está dentro da raia.
  if (delta < 0) {
    for (const f of soltas) {
      const c = d.caixas.get(f.id!);
      if (!c) continue;
      const cy = c.absY + c.altura / 2;
      const fundo = c.absY + c.altura;
      // Só o que hoje cabe inteiro na raia e passaria a ficar cortado; o que já atravessava a borda, o Studio deixou assim.
      if (cy >= topo && cy < fundoAntes && fundo <= fundoAntes && fundo > fundoDepois) {
        const nome = d.objetos.find((o) => o.attrs['id'] === f.id)?.attrs['name'] || f.id;
        throw new EdicaoInvalida(`"${nome}" ficaria cortado; mova-o para cima ou escolha uma altura maior`);
      }
    }
  }

  const trocas: { inicio: number; antes: string; depois: string }[] = [];
  const trocar = (t: Tag, novo: string) => trocas.push({ inicio: t.inicio, antes: t.tag, depois: novo });
  for (const f of todas) {
    if (!f.ga || !f.id) continue;
    const c = d.caixas.get(f.id);
    if (!c) continue;
    if (f.id === raiaId) {
      trocar(f.ga, trocarNum(f.ga.tag, 'height', altura));
      for (const t of f.textos) trocar(t, trocarNum(t.tag, 'height', altura));
    } else if (f.id === poolId) {
      trocar(f.ga, trocarNum(f.ga.tag, 'height', pool.altura + delta));
      for (const t of f.textos) trocar(t, trocarNum(t.tag, 'height', pool.altura + delta));
    } else if (c.pai === poolId && c.absY >= fundoAntes) {
      // Raia de baixo: y relativo à pool.
      trocar(f.ga, trocarCoordenada(f.ga.tag, 'y', attrNum(f.ga.tag, 'y') + delta));
    } else if (f.profundidade === 0 && c.absY + c.altura / 2 >= fundoAntes) {
      // Elemento abaixo da raia: y absoluto.
      trocar(f.ga, trocarCoordenada(f.ga.tag, 'y', attrNum(f.ga.tag, 'y') + delta));
    }
  }
  let texto = aplicar(xml, trocas);
  // Dobras abaixo da raia acompanham (são absolutas).
  texto = texto.replace(/<bendpoints\b([^>]*?)\/>/g, (tag, attrs: string) => {
    const y = Number(/\sy="(-?\d+)"/.exec(attrs)?.[1] ?? 0);
    if (y < fundoAntes) return tag;
    const novo = y + delta;
    const semY = attrs.replace(/\sy="-?\d+"/, '');
    return `<bendpoints${semY}${novo === 0 ? '' : ` y="${novo}"`}/>`;
  });
  return texto;
}

export function redimensionarPoolNoXml(xml: string, poolId: string, largura: number): string {
  if (!Number.isInteger(largura) || largura < 200 || largura > 50000) throw new EdicaoInvalida('a largura da pool vai de 200 a 50000 px');
  const d = lerDiagrama(xml);
  const pool = d.objetos.find((o) => o.attrs['id'] === poolId);
  if (!pool) throw new ConflitoEdicao('elemento-removido', `a pool ${poolId} não existe mais`);
  if (pool.tipo !== 'BpmnPool') throw new EdicaoInvalida(`${poolId} não é uma pool`);
  const c = d.caixas.get(poolId)!;
  if (largura === c.largura) throw new EdicaoInvalida('nada mudou');
  const direita = c.absX + largura;
  for (const o of d.objetos) {
    const cx = d.caixas.get(o.attrs['id'] ?? '');
    if (!cx || cx.pai || o.tipo === 'BpmnPool') continue;
    if (cx.absX + cx.largura > direita && cx.absX < c.absX + c.largura) {
      throw new EdicaoInvalida(`"${o.attrs['name'] || o.attrs['id']}" ficaria fora da pool; mova-o para a esquerda ou escolha uma largura maior`);
    }
  }
  const trocas: { inicio: number; antes: string; depois: string }[] = [];
  for (const f of formas(xml)) {
    if (!f.ga || !f.id) continue;
    if (f.id === poolId) trocas.push({ inicio: f.ga.inicio, antes: f.ga.tag, depois: trocarNum(f.ga.tag, 'width', largura) });
    else if (d.caixas.get(f.id)?.pai === poolId) {
      // A raia começa depois da faixa do rótulo da pool e vai até a borda direita.
      const x = attrNum(f.ga.tag, 'x');
      trocas.push({ inicio: f.ga.inicio, antes: f.ga.tag, depois: trocarNum(f.ga.tag, 'width', largura - x) });
    }
  }
  return aplicar(xml, trocas);
}
