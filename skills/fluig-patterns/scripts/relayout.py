#!/usr/bin/env python3
"""Reposiciona um .process do Fluig Studio pela receita de layout do fluig-patterns.

Uso:
    python3 -I relayout.py <entrada.process> <spec.json> <saida.process>

Mexe so em geometria (references/workflow.md, "Re-laying out an existing
diagram"): x/y dos shapes de topo, tamanho da pool e das raias, altura dos
rotulos das raias e os <bendpoints> das conexoes. Nao cria nem remove nada, nao
redimensiona tarefas e nao toca no modelo bpmn2. Se o resultado mudar alguma
linha bpmn2:, al:MultiText ou al:RoundedRectangle, recusa e nao grava.

O par de cada service task (evento de erro + tarefa de tratamento) sai do
proprio modelo (parentTask e o fluxo do evento) e nao precisa ir no spec:
    circulo   centrado no canto inferior direito da service task
    tratamento na mesma coluna, 33 px abaixo
    fluxos    evento -> tratamento e tratamento -> service task sem dobras

Spec (JSON), exemplo em validacao_minutas.json:
    lanes      ids das raias, de cima para baixo
    laneHeight altura das raias: um numero vale para todas, uma lista da a de
               cada raia na ordem de "lanes"; cada uma cabe o que tem dentro
               (service task + 33 + tratamento + margem, se houver par)
    poolWidth  largura da pool
    rowOffset  centro da linha principal em relacao ao topo da raia (90)
    nodes      { id: [centro x, indice da raia] } para tudo que esta na linha principal;
               um terceiro valor opcional desce o no para a linha de um ramo
               ("Reprovada"), em px abaixo do centro da linha principal
    bends      { flowId: [[x, y], ...] }; y pode ser numero, "C<n>" (centro da
               linha da raia n) ou "L<n>" (corredor de retorno da raia n, 20 px
               acima da tarefa mais alta)
"""
import json
import re
import sys

GAP = 33           # service task -> tarefa de tratamento
LOOP_ABOVE = 20    # corredor de retorno acima da tarefa mais alta
INTOCAVEL = re.compile(r'bpmn2:|al:MultiText|al:RoundedRectangle')


def attr(line, key):
    m = re.search(r' ' + key + r'="([^"]*)"', line)
    return m.group(1) if m else None


def put(line, key, value):
    if re.search(r' ' + key + r'="-?\d+"', line):
        return re.sub(r' ' + key + r'="-?\d+"', ' %s="%d"' % (key, value), line, count=1)
    # o Studio omite x/y quando valem 0
    return re.sub(r' height="(\d+)"', r' height="\1" %s="%d"' % (key, value), line, count=1)


def main(entrada, spec_path, saida):
    texto = open(entrada, encoding='ascii').read()
    src = texto.split('\n')
    spec = json.load(open(spec_path, encoding='utf-8'))
    lanes = spec['lanes']
    H = spec['laneHeight']
    alturas = list(H) if isinstance(H, list) else [H] * len(lanes)
    if len(alturas) != len(lanes):
        sys.exit('erro: laneHeight tem %d alturas para %d raias' % (len(alturas), len(lanes)))
    inicio = [sum(alturas[:i]) for i in range(len(lanes))]  # topo de cada raia, relativo a pool
    pool_w = spec['poolWidth']

    # modelo: elementos e fluxos (uma linha por elemento no .process do Studio)
    modelo = {}
    for l in src:
        s = l.strip()
        if s.startswith(('<bpmn2:Bpmn', '<bpmn2:SequenceFlow')):
            modelo[attr(s, 'id')] = s

    # shapes de topo do diagrama: linha do graphicsAlgorithm, fim do bloco, tamanho
    shapes = {}
    for i, l in enumerate(src):
        if l.startswith('    <children '):
            j = i + 1
            while not src[j].startswith('      <link '):
                j += 1
            bo = attr(src[j], 'businessObjects')
            fim = next(k for k in range(i + 1, len(src)) if src[k] == '    </children>')
            shapes[bo] = (i + 1, fim, int(attr(src[i + 1], 'width')), int(attr(src[i + 1], 'height')))
    pool = next(bo for bo in shapes if modelo.get(bo, '').startswith('<bpmn2:BpmnPool'))

    # as raias sao relativas a pool; o Studio a poe em (6, 6), outros geradores em outro lugar
    pool_y = int(attr(src[shapes[pool][0]], 'y') or 0)
    tops = [pool_y + y for y in inicio]
    C = [t + spec.get('rowOffset', 90) for t in tops]

    boxes = {}
    for bo, no in spec['nodes'].items():
        cx, lane = no[0], no[1]
        cy = C[lane] + (no[2] if len(no) > 2 else 0)
        _, _, w, h = shapes[bo]
        if modelo[bo].startswith('<bpmn2:BpmnGateway'):
            boxes[bo] = (cx - 30, cy - 30, w, h)   # losango = 60x60 do topo; rotulo pendurado embaixo
        else:
            boxes[bo] = (cx - w // 2, cy - (h + 1) // 2, w, h)

    # pares de erro, a partir do modelo
    sem_dobra = set()
    for ev, linha in modelo.items():
        if attr(linha, 'type') != '43' or not attr(linha, 'parentTask'):
            continue
        st = attr(linha, 'parentTask')
        if st not in boxes:
            sys.exit('erro: %s (pai do evento %s) nao esta em "nodes"' % (st, ev))
        x, y, w, h = boxes[st]
        _, _, d, _ = shapes[ev]
        boxes[ev] = (x + w - d // 2, y + h - d // 2, d, d)
        for f in (attr(linha, 'outgoing') or '').split():
            et = attr(modelo[f], 'targetRef')
            _, _, ew, eh = shapes[et]
            boxes[et] = (x + w // 2 - ew // 2, y + h + GAP, ew, eh)
            sem_dobra.add(f)
            for g in (attr(modelo[et], 'outgoing') or '').split():
                if attr(modelo[g], 'targetRef') == st:
                    sem_dobra.add(g)

    faltando = set(shapes) - set(boxes) - {pool}
    if faltando:
        sys.exit('erro: sem posicao no spec: ' + ', '.join(sorted(faltando)))

    # corredor de retorno: 20 px acima da tarefa mais alta da linha principal, igual em todas as raias
    meia = max([(shapes[bo][3] + 1) // 2 for bo in spec['nodes'] if modelo[bo].startswith('<bpmn2:BpmnTask')] or [38])
    L = [c - meia - LOOP_ABOVE for c in C]

    def coord(v):
        if isinstance(v, str):
            return (C if v[0] == 'C' else L)[int(v[1:])]
        return v

    bends = {f: [(coord(x), coord(y)) for x, y in pts] for f, pts in spec.get('bends', {}).items()}
    conflito = sem_dobra & set(bends)
    if conflito:
        sys.exit('erro: fluxos do par de erro nao levam dobras: ' + ', '.join(sorted(conflito)))

    for bo, (x, y, w, h) in boxes.items():
        ga = shapes[bo][0]
        src[ga] = put(put(src[ga], 'x', x), 'y', y)

    # pool, raias e rotulos
    pga, pfim, _, _ = shapes[pool]
    src[pga] = put(put(src[pga], 'width', pool_w), 'height', sum(alturas))
    for k in range(pga, pfim):
        if src[k].startswith('      <children xsi:type="pi:ContainerShape"'):
            idx = lanes.index(attr(src[k + 2], 'businessObjects'))
            linha = put(put(src[k + 1], 'width', pool_w - 30), 'height', alturas[idx])
            linha = re.sub(r' y="\d+"', '', linha)
            if idx:
                linha = linha.replace(' x="30"', ' x="30" y="%d"' % inicio[idx])
            src[k + 1] = linha
            t = k
            while 'al:Text' not in src[t]:
                t += 1
            src[t] = put(src[t], 'height', alturas[idx])
        if src[k].startswith('      <children visible="true">') and 'al:Text' in src[k + 1]:
            src[k + 1] = put(src[k + 1], 'height', sum(alturas))

    # conexoes: troca as dobras; sem entrada no spec, sem dobras
    out, atual = [], None
    for l in src:
        m = re.match(r'      <link businessObjects="(flow\d+)"/>', l)
        if m:
            atual = m.group(1)
        if atual and l.strip().startswith('<bendpoints'):
            continue
        if atual and l == '    </connections>':
            for x, y in bends.get(atual, []):
                out.append('      <bendpoints x="%d" y="%d"/>' % (round(x), round(y)))
            atual = None
        out.append(l)

    novo = '\n'.join(out)
    antes = [l for l in texto.split('\n') if INTOCAVEL.search(l)]
    depois = [l for l in out if INTOCAVEL.search(l)]
    if antes != depois:
        sys.exit('erro: o resultado mudaria modelo ou textos; nada foi gravado')
    open(saida, 'w', encoding='ascii').write(novo)
    print('ok: %d shapes, %d fluxos com dobras -> %s' % (len(boxes), len(bends), saida))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
