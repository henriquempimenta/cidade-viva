# Cidade Viva

Tech demo 3D de uma cidade procedural que nasce como vila e cresce sozinha. O usuário não constrói nada: ele assiste. Uma câmera auto‑diretora mostra os acontecimentos mais interessantes, e um painel de parâmetros muda as regras ao vivo.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # determinismo, geometria viária, rejeição NIMBY
```

Parâmetros pela URL, por exemplo `?seed=42&terrain=litoral&warmup=20`. O `warmup` avança N dias antes de abrir a cena.

## Arquitetura

```
main thread (render)                         Web Worker (simulação, passo fixo de 0,5 s) ──► pool de workers de rotas (1–4)
────────────────────                         ───────────────────────────────────────────
App ─ SceneRig (Three.js, céu, sombras,      SimHost ─ loop com orçamento de CPU, velocidade
      bloom, GTAO, tilt-shift, DOF)              │
    ─ TerrainView, Water, Trees                  World
    ─ RoadsLayer, RailLayer                        ├ Terrain        relevo, rio, litoral, lagos, florestas, áreas alagáveis
    ─ BuildingsLayer (chunks + obras animadas)     ├ Fields         campos escalares: valor do solo, poluições, ruído, crime...
    ─ AgentsLayer (InstancedMesh + interpolação)   ├ RoadNetwork    grafo viário, árvores de Dijkstra em cache, BPR
    ─ Effects (chuva, fogos, enchente, linhas)     ├ Buildings      lotes, estágios de obra, capacidade
    ─ Overlays (mapas de calor, OD, metrô)         ├ Market         utilidade = Σ(peso × campo) − custos − rejeição
    ─ Director (câmera auto-diretora)               ├ RoadGrowth     crescimento orgânico/grade, fechamento de laços
    ─ Hud / Inspector / Params / Charts            ├ Citizens       identidade, necessidades, Utility AI, ciclo de vida
    ─ AudioEngine (Web Audio procedural)           ├ Economy        empregos, moradia, imigração, falências, demanda RCI
                                                   ├ Traffic / Peds IDM, faixas, semáforos, pedestres
         ◄── snapshots (~20 Hz, arrays            ├ Utilities      energia, água, esgoto, lixo, apagões
             transferíveis) e diffs do mundo      ├ Services       crime emergente, bombeiros, ambulâncias, patrulhas
         ──► velocidade, parâmetros, inspeção,    ├ CityHall       orçamento, necessidades → projetos → custo-benefício
             câmera (LOD), eventos injetados      ├ RoadUpgrades   alternativas simuladas para congestionamento
                                                   ├ Transit / Rail ônibus/BRT pela matriz OD, trens, estações, metrô
                                                   ├ Tourism        atratividade, hotéis, roteiros, excesso de turismo
                                                   └ Happenings     festivais, réveillon, jogos, enchentes, epidemias
                                                   EventBus → Director + Crônica
```

## Emergência em vez de regras fixas

Nenhum código diz "indústria longe de casas" ou "cemitério na periferia". Cada construção (do mercado ou da prefeitura) amostra lotes ao longo das ruas, ou fora da malha com custo de acesso, e calcula:

`utilidade = Σ(peso × campo) − custo do terreno − custo de conexão − rejeição dos vizinhos`

- **NIMBY.** A rejeição soma o "potencial de reclamação" (moradores × valor do solo) num raio. Para quem polui, a soma segue a pluma, que o vento dominante advecta. Por isso a indústria tende a ficar a sotavento e fora das áreas nobres.
- **Retroalimentação.** A poluição baixa o valor do solo. Moradia barata se instala ali, desemprego e desigualdade alimentam o crime, e a prefeitura reage com uma delegacia no foco. Quando o valor do solo sobe, há gentrificação e redensificação. Galpões abandonados viram lofts ou parques.
- **"Por que aqui?"** Clicar em qualquer construção mostra a decomposição da escolha e as alternativas que perderam, marcadas no mapa. Clicar numa rua mostra "Por que congestionado?" (pares origem→destino) e a decisão de upgrade, com as opções avaliadas.

## Integridade e corrupção

A corrupção não é uma regra do tipo "ponha X aqui". É um índice que enfraquece os ciclos de retroalimentação que já existem na cidade (`src/sim/corruption.ts`).

- **Pressão:** propensão de base (parâmetro), desigualdade, baixa escolaridade, aperto no orçamento, dinheiro de obras (valorização do solo) e a honestidade de quem ocupa a prefeitura.
- **Controle:** transparência e imprensa (parâmetro), cobertura de cultura e educação, escolaridade, confiança social e investigações recentes.
- **Campo local `corruption`:** cresce onde há canteiros de obra, crime, pouca polícia e pouca cultura. Tem camada própria no mapa.
- **Efeitos, todos por mecanismos existentes:**
  - Obras públicas são superfaturadas. O desvio aparece nos lançamentos da Prefeitura.
  - Algumas obras param no esqueleto, sem guindaste, por meses ou anos, até serem retomadas.
  - Licenças são facilitadas: a rejeição dos vizinhos pesa menos, e o termo **"Licença facilitada (corrupção)"** aparece em "Por que aqui?". Usos indesejados chegam mais perto das casas, e o painel mostra o motivo.
  - Propina dilui a cobertura policial, então o crime sobe.
  - A confiança social cai, o que reduz a felicidade e o investimento em escritórios.
- **Abandono duradouro:** onde as instituições funcionam, imóveis abandonados são desapropriados em semanas. Onde há corrupção, ninguém fiscaliza. O imóvel encarde, cria musgo, perde as janelas e pode virar ocupação. Pega fogo com mais facilidade. Depois de 10 a 15 anos de jogo o topo começa a ruir, e ele pode desabar sozinho.
- **Saídas:** operações de investigação (prisões, retomada de obras, afastamento de quem governa) e eleições a cada 4 anos. A honestidade do novo prefeito ou da nova prefeita varia. Tudo vira manchete na Crônica, na categoria "Política e integridade".

## Junções suaves

A ideia veio da versão alternativa (v14) e foi adaptada ao nosso estilo. Cada cruzamento é um polígono cujos meios-fios são curvas de Bézier entre as bocas das vias vizinhas. Calçadas e meios-fios acompanham essas curvas na esquina. Dobras de via (nós de grau 2) ganham um trecho curvo contínuo. A superfície segue o relevo para nunca afundar sob o terreno.

## A ferrovia como barreira urbana

Outra ideia adaptada da v14: lá, a ferrovia é traçada respeitando a cidade. Aqui fizemos o contrário: é a cidade que respeita a ferrovia que chegou primeiro.

- **Cruzar os trilhos tem regras.** Uma rua nova só cruza quase em ângulo reto, longe de esquinas, fora das plataformas e do pátio de cargas, sem correr colada aos trilhos e a pelo menos 150 m de outra passagem de nível. Avenidas e vias expressas nunca ganham cancelas: os trilhos sobem sobre elas. O resultado é o "outro lado da linha", com poucas ruas de ligação que concentram o tráfego.
- **Pressão, não pico.** As cancelas medem quantos minutos de veículos ficam parados a cada dia. Só depois de vários dias saturados a prefeitura considera uma obra, e o motivo aparece em "Por que congestionado?".
- **Viaduto ou trincheira.** Se há espaço para rampas longas (cerca de 3%), os trilhos sobem. Passagens de nível vizinhas entram no mesmo elevado, em vez de virar uma montanha-russa. Perto de estações e do pátio, onde não dá para elevar, a rua desce numa passagem inferior.
- **Visual.** Painel de borracha na travessia, faixas de retenção, postes com cruz de Santo André e luzes vermelhas alternadas, cancelas que baixam sobre a faixa de quem chega, aterros com taludes, e trilhos nivelados com a rua na travessia. O material rodante tem truques e rodas, vagões-tanque com cintas, hoppers com nervuras, contêineres, e janelas e faróis acesos à noite.
- **Obra e ruído.** O metrô é construído trecho a trecho ao longo de cerca de 14 dias, e mais devagar quando há corrupção. Só opera depois de pronto, com frota proporcional ao comprimento da linha. O barulho dos trens entra no campo de ruído, proporcional aos trens de carga e passageiros do dia.

## Elevados e túneis emergentes

Nenhuma estrutura é desenhada por decreto, e ela não disputa espaço com a rua: o próprio trecho da via vira elevado ou túnel. Durante a obra a rua continua aberta e "travada" (nada novo se conecta a ela). Na inauguração, o trecho no chão entre as rampas é desativado e a via passa a seguir pela estrutura. As ruas transversais continuam no chão e cruzam por baixo (ou por cima, no túnel), sem semáforo. Os lotes que davam para o trecho desativado se religam à rua mais próxima. Quem precisava virar ali encontra outro caminho, e o roteamento se reorganiza sozinho.

O evento injetável **"Verba federal para obra viária"** banca uma estrutura no pior gargalo, que é como a maioria delas sai na vida real. A cidade escolhe onde e que tipo; só não paga.

- **Quando surge:** num cruzamento que continua travado mesmo depois do semáforo e do semáforo inteligente, atravessado por um eixo largo e contínuo. Também numa passagem de nível de uma via larga cujas cancelas seguem saturadas, caso em que a via passa por cima dos trilhos.
- **Custos realistas, por isso raros:** uma faixa nova de superfície custa ~4,5 $/m e uma ponte ~20–25 $/m. Um elevado custa 45 $/m (×1,4 com duas faixas por sentido), um túnel em vala coberta 130 $/m e um túnel escavado em rocha 160 $/m. A manutenção diária vale 6× (elevado) e 15× (túnel) a de uma rua do mesmo comprimento. Obras grandes precisam se pagar: os minutos de veículo poupados, valorizados a ~0,5 $/min, têm de cobrir a obra em ~10 anos (120 dias de jogo). O caixa ainda precisa de folga de 30%, e só uma estrutura fica em obra por vez. Numa cidade de poucos milhares de habitantes isso quase nunca fecha, como na vida real. Elevados e túneis aparecem quando o congestionamento é grande de verdade.
- **Forma do elevado:** rampas de cerca de 125 m, vão a 7,5 m, curvas suaves da via acompanhadas, e extensão sobre cruzamentos travados em sequência, como um "Minhocão". Sob ele o terreno perde valor por sombra e ruído.
- **Elevado ou túnel:** corredores valorizados ou densos recusam o elevado e, com caixa, a via desce num túnel em vala coberta.
- **Túnel sob o morro:** quando bairros separados por um morro de verdade só se ligam por um desvio de mais de 2,2 vezes a linha reta, a prefeitura fura um túnel reto.
- **Escavação real no desenho:** as células do terreno cruzadas por um corte são substituídas por um remendo de malha fina. Ele segue exatamente os planos do terreno nas bordas (sem frestas) e afunda até o piso da via dentro do corte. A pista desce na altura real entre muros de arrimo contínuos e entra num emboque de concreto encostado no terreno.
- **Regras:** nada se conecta a um tabuleiro ou túnel. Ruas novas passam por baixo do vão ou por cima do túnel, nunca numa rampa. Os trilhos não sobem onde um viaduto rodoviário passa por cima.

## Tempo

Os agentes andam em velocidade real (m/s), mas o calendário é comprimido: 1 dia de jogo dura 2.400 s de movimento, 1 ano tem 12 dias e 4 estações. As velocidades são 1×, 10×, 100× e time‑lapse (400×), além de um modo automático controlado pelo diretor.

## Desempenho

- **Várias threads.** A simulação roda num Web Worker. Ele abre um pool de 1 a 4 workers de roteamento (núcleos livres − 2). As árvores de caminho mínimo usam um grafo compacto (CSR) com custos em arrays transferíveis e são recalculadas em lotes nesse pool.
- **Determinismo com threads.** Cada lote é instalado num passo fixo (8 passos depois do pedido). Se os workers ainda não terminaram, o loop espera. Assim a cidade é idêntica com 0 ou N threads. Um teste cobre isso com um backend que responde atrasado.
- **Pedestres analíticos.** Pedestres não interagem entre si. A posição de cada um é calculada a partir do tempo, e as chegadas saem de uma fila de prioridade. O custo por passo é O(chegadas), não O(pedestres).
- **Sem limite rígido de população.** Cidadãos, veículos e pedestres usam arrays que crescem sob demanda. O que limita a cidade é moradia, emprego e espaço viário. A renderização tem orçamentos próprios de instâncias por quadro.
- **Tráfego.** As listas de faixas são arrays indexados, não `Map`. A potência do IDM é calculada sem `Math.pow`. Os campos usam kernels sem `hypot` por célula.
- Prédios prontos são mesclados por chunk espacial; prédios em obra são desenhados um a um.
- Veículos, pedestres, árvores, postes e trens usam `InstancedMesh`.
- Pedestres só são avaliados e transmitidos perto da câmera.
- Acima de cerca de 1.800 veículos, viagens longe da câmera viram "virtuais": continuam contando volume nas vias, mas não são simuladas fisicamente.
- **Guarda de HDR.** Um passe limpa NaN e Inf do buffer antes do bloom. Antes, um pixel inválido (disco do sol, reflexo especular) se espalhava em blocos pretos. Nuvens não ficam mais escuras que o céu, e partículas encostadas na lente somem.

Medido no navegador com a seed padrão e cerca de 2,8 mil habitantes: 100× e 400× sustentados, em 3 threads. No modo headless, um dia de jogo com 5 mil habitantes caiu de cerca de 42 s para cerca de 16 s de CPU numa única thread.

**Não implementado:** impostores para prédios distantes e túneis.

**Determinismo:** a mesma seed com os mesmos parâmetros gera a mesma cidade. Com mais de cerca de 1.800 veículos, o LOD que depende da câmera pode alterar trajetórias individuais.
