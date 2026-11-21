# TODO — Realismo Urbano e Simulação (Backlog Pós-Ciclo 1 & Ciclo 2)

## Ressalvas Pontuais do Ciclo 1 (`APPROVED_WITH_RESERVATIONS`, média 8,66 / 10)
- [ ] **Linha de parada vs. faixa de pedestres renderizada (`src/sim/traffic.ts` / `src/shared/roadGeom.ts`)**: `Traffic.trim()` usa `n.radius` (`~6 m`) enquanto `RoadsLayer` pinta a faixa em `nodeRenderR * 0.92 + CROSSWALK_INSET + 1.4` (`~12,4 m`), fazendo o 1º veículo parado no vermelho avançar ~2,7–3,1 m sobre a zebra. Alinhar o recuo de parada de `Traffic` ao recuo real da faixa pintada.
- [ ] **Calçada em encostas transversais (`src/render/roadsLayer.ts`)**: em terrenos inclinados (`terrain=vale`), a calçada do lado aclive pode ficar parcialmente coberta pela malha do terreno porque a altura usa o `y` da linha central da via (e em esquinas agudas um lábio de calçada avança levemente sobre a boca da via adjacente).
- [ ] **Threshold de faixa em quadras curtas (`src/sim/trips.ts:300-301`)**: alinhar `totalLen > 30` com `len > 20` usado em `hasEndCrosswalk()` (`src/shared/roadGeom.ts`).

## Ressalvas Pontuais da Estabilização da Base (`APPROVED_WITH_RESERVATIONS`, média 8,92 / 10)
- [ ] **`splitEdge` + recuo forçado para `sEntry - 0.06` (`src/sim/traffic.ts:685, 695, 714`)**: quando um `splitEdge` cria um novo nó atrás de um veículo que já está além do novo `sEntry`, evitar puxar `this.s[i]` para trás (limitar apenas o avanço `ds` do tick atual ou respeitar o veículo de trás) + adicionar teste de regressão.
- [ ] **Recuo visual de parada antes da faixa de pedestres (`src/sim/traffic.ts`)**: reforço do item do Ciclo 1 acima — recuar `sEntry` antes da zebra (`CROSSWALK_INSET + 1.5 m`) quando houver faixa pintada no nó.
- [ ] **Recorte de calçada em declive lateral e esquina aguda (`src/render/roadsLayer.ts`)**: reforço do item do Ciclo 1 acima — evitar afloramento do terreno sobre abrigos/calçadas em encosta transversal e lábio de calçada em ângulos agudos.
- [ ] **Endurecimento de testes e evacuação em `revalidateLines` (`tests/stabilityGates.test.ts:90, 633-654`, `src/sim/transit.ts:617-628`)**: apertar o gate de 40 dias de `despawnsRedLight` para `=== 0`, exercitar `phase = 3` explicitamente no teste de `onEdgeSplit` e replicar a evacuação de `rides` caso `revalidateLines` zere `l.fleet`.

---

## Ciclo 2 — Segurança Viária, Emergências Avançadas & Ciclo de Vida da Frota (Próxima Entrega)
- [ ] **Colisões e acidentes viários emergentes** (carro–carro em chuva/velocidade/conflito e carro–pedestre em conflito de faixa).
- [ ] **Interdição temporária de faixa/via** com sinalização visual (cones/bloqueio) e desvio automático de rotas enquanto o acidente/pane bloqueia o trecho.
- [ ] **Emergências cortando trânsito e avançando sinal vermelho com segurança** (`Ambulance`, `Fire`, `Police` com sirene: corredor de emergência, mudança de faixa para ultrapassar filas travadas e preempção segura em cruzamentos).
- [ ] **Atendimento coordenado + guincho/reboque** (polícia, ambulância levando ferido ao hospital, bombeiros em colisão grave e guincho/reboque removendo veículo sinistrado/quebrado para liberar a via).
- [ ] **Ciclo de vida veicular, estacionamento, frota e manutenção** (desgaste por km, custo periódico de manutenção, panes raras, renovação gradual da frota privada e de ônibus).
- [ ] **Loop de revisão independente** com `npm run capture:field` + avaliador independente na rubrica [sim-review-rubric.md](./sim-review-rubric.md) (notas ≥ 7,0).
