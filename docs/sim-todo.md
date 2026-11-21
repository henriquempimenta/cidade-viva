# TODO — Realismo Urbano e Simulação (Backlog Pós-Ciclo 1 & Ciclo 2)

## Ressalvas Pontuais do Ciclo 1 (`APPROVED_WITH_RESERVATIONS`, média 8,66 / 10)
- [ ] **Linha de parada vs. faixa de pedestres renderizada (`src/sim/traffic.ts` / `src/shared/roadGeom.ts`)**: `Traffic.trim()` usa `n.radius` (`~6 m`) enquanto `RoadsLayer` pinta a faixa em `nodeRenderR * 0.92 + CROSSWALK_INSET + 1.4` (`~12,4 m`), fazendo o 1º veículo parado no vermelho avançar ~2,7–3,1 m sobre a zebra. Alinhar o recuo de parada de `Traffic` ao recuo real da faixa pintada.
- [ ] **Calçada em encostas transversais (`src/render/roadsLayer.ts`)**: em terrenos inclinados (`terrain=vale`), a calçada do lado aclive pode ficar parcialmente coberta pela malha do terreno porque a altura usa o `y` da linha central da via (e em esquinas agudas um lábio de calçada avança levemente sobre a boca da via adjacente).
- [ ] **Threshold de faixa em quadras curtas (`src/sim/trips.ts:300-301`)**: alinhar `totalLen > 30` com `len > 20` usado em `hasEndCrosswalk()` (`src/shared/roadGeom.ts`).

## Ressalvas Pontuais da Estabilização da Base (`APPROVED_WITH_RESERVATIONS`, média 8,92 / 10)
- [x] **`splitEdge` + recuo forçado para `sEntry - 0.06` (`src/sim/traffic.ts`)**: `sPre` gravado no início do tick impede puxar `this.s[i]` para trás abaixo de `sPre` quando `splitEdge` cria nó atrás de veículo além do novo `sEntry` + teste de regressão em `tests/cycle2Safety.test.ts`.
- [ ] **Recuo visual de parada antes da faixa de pedestres (`src/sim/traffic.ts`)**: reforço do item do Ciclo 1 acima — recuar `sEntry` antes da zebra (`CROSSWALK_INSET + 1.5 m`) quando houver faixa pintada no nó.
- [ ] **Recorte de calçada em declive lateral e esquina aguda (`src/render/roadsLayer.ts`)**: reforço do item do Ciclo 1 acima — evitar afloramento do terreno sobre abrigos/calçadas em encosta transversal e lábio de calçada em ângulos agudos.
- [x] **Endurecimento de testes e evacuação em `revalidateLines` (`tests/stabilityGates.test.ts`, `src/sim/transit.ts`)**: gate de 40 dias de `despawnsRedLight` apertado para `=== 0`, `phase = 3` exercitado explicitamente no teste de `onEdgeSplit` e `evacuateLine()` replicada quando `revalidateLines` zera `l.fleet`.

---

## Ciclo 2 — Segurança Viária, Emergências Avançadas & Ciclo de Vida da Frota
- [x] **Colisões e acidentes viários emergentes** (carro–carro sob chuva/neblina/velocidade/frenagem/volume, carro–pedestre em conflito de via e panes mecânicas por desgaste de carro/ônibus, com eventos na Crônica e inspetor atualizado).
- [x] **Interdição temporária de faixa/via** com sinalização visual 3D real (cones laranja/branco, cavalete/barreira listrada e halo/pisca âmbar/emergência), desvio de faixa em vias múltiplas e desvio automático de rotas no roteador enquanto o incidente bloqueia o trecho.
- [x] **Emergências cortando trânsito e avançando sinal vermelho com segurança** (`Ambulance`, `Fire`, `Police` com sirene: corredor lateral, troca ativa de faixa para ultrapassar filas lentas e preempção segura em cruzamentos com velocidade de cautela e retenção do tráfego transversal).
- [x] **Atendimento coordenado + guincho/reboque (`VType.Tow`)** (modelo 3D paramétrico prancha/guincho em `vehicleGeom.ts`, polícia, ambulância evacuando ferido ao hospital com tratamento de saúde, bombeiros em colisão grave, guincho removendo veículo para reabrir a via e fail-safe determinístico em Era 0 / timeout).
- [x] **Ciclo de vida veicular, estacionamento, frota e manutenção** (idade, km rodados, desgaste por km/estrada de terra, manutenção periódica paga circulando na economia local, oficina pós-pane/acidente, renovação gradual da frota privada aposentando modelos `vintage` e renovação/manutenção de ônibus).
- [x] **Loop de revisão independente** com `npm run capture:field` + avaliador independente na rubrica [sim-review-rubric.md](./sim-review-rubric.md) (`APPROVED_WITH_RESERVATIONS`, média 8,90 / 10, todos os critérios ≥ 8,3).

## Ressalvas Pontuais do Ciclo 2 (`APPROVED_WITH_RESERVATIONS`, média 8,90 / 10)
- [ ] **Aproximação do guincho/viatura na mesma pista em vias com canteiro central (`src/sim/incidents.ts:621-656`)**: `syncBlockage(inc)` aplica `+900 s` de `incidentPenalty` em `inc.edge * 2 + inc.dir` antes de `dispatchUnits(inc)` rotear as viaturas, fazendo `carPlanEdges` às vezes encaminhar guincho/polícia para a pista contrária do canteiro central em avenidas/rodovias (`cls >= RoadClass.Avenue`). Desconsiderar temporariamente a penalidade da própria ocorrência em `planToIncident` para que a viatura aproxime-se a montante na mesma mão.
- [ ] **Recuo do cavalete a montante para veículos longos (`src/render/overlays.ts:362-368`)**: ajustar `lx = -7.2` para `~-8.5` (ou proporcional ao comprimento do veículo sinistrado) para ampliar a folga visual atrás de ônibus/caminhões de 10–12 m.

---

## Entrega Futura — Revisão Completa de Estradas, Ferrovias & Conformação de Terreno (Terraforming)
*Planejada para uma entrega dedicada posterior, resolvendo pela raiz os bugs visuais de malha viária/ferroviária e sobreposição com o relevo:*
- [ ] **Conformação automática do terreno (*terraforming* / terraplenagem)** ao construir ou atualizar estradas, junções, ferrovias e edifícios: nivelamento suave do heightmap sob o leito da via/trilho/lote com taludes (*cut/fill embankments*) ou muros de arrimo nas bordas, eliminando afloramento de grama/terreno sobre asfalto, calçadas em encosta transversal, abrigos de ônibus e fundações de prédios.
- [ ] **Geometria limpa de junções e esquinas viárias (`src/render/roadsLayer.ts`, `src/shared/roadGeom.ts`)**: eliminar falhas de costura em cruzamentos, lábios de calçada invadindo vias em ângulo agudo, degraus de altura em nós com múltiplas declividades e desalinhamento entre linha de parada (`Traffic.trim`) e faixa de pedestres pintada.
- [ ] **Revisão visual e geométrica das ferrovias (`src/render/railLayer.ts`, `src/sim/rail.ts`)**: corrigir leito/lastro em encostas, transições de pontes/viadutos/trincheiras, passagens em nível (cancelas/cruzamentos rodoferroviários) e conexões limpas com estações e pátios.
- [ ] **Sincronização do terreno modificado (`WorldDiff.heights`) e determinismo**: garantir que a terraplenagem seja 100% determinística, eficiente para o heightmap/chunks em tempo real e coberta por capturas em terrenos acidentados (`terrain=vale`, encostas e cruzamentos agudos) + revisão independente.
