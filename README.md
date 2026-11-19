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
main thread (render)                         Web Worker (simulação, passo fixo de 0,5 s)
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

## Tempo

Os agentes andam em velocidade real (m/s), mas o calendário é comprimido: 1 dia de jogo dura 2.400 s de movimento, 1 ano tem 12 dias e 4 estações. As velocidades são 1×, 10×, 100× e time‑lapse (400×), além de um modo automático controlado pelo diretor.

## Desempenho

- Prédios prontos são mesclados por chunk espacial; prédios em obra são desenhados um a um.
- Veículos, pedestres, árvores, postes e trens usam `InstancedMesh`.
- Pedestres só são transmitidos perto da câmera.
- Acima de cerca de 1.800 veículos, viagens longe da câmera viram "virtuais": continuam contando volume nas vias, mas não são simuladas fisicamente.
- O roteamento usa árvores de Dijkstra reversas em cache, com atualização rolante e orçamento por passo.

**Não implementado:** impostores para prédios distantes e túneis.

**Determinismo:** a mesma seed com os mesmos parâmetros gera a mesma cidade. Com mais de cerca de 1.800 veículos, o LOD que depende da câmera pode alterar trajetórias individuais.
