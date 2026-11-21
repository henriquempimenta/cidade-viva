# TODO — Realismo Urbano e Simulação (Backlog Pós-Ciclo 1 & Ciclo 2)

## Ressalvas Pontuais do Ciclo 1 (`APPROVED_WITH_RESERVATIONS`, média 8,66 / 10)
- [ ] **Linha de parada vs. faixa de pedestres renderizada (`src/sim/traffic.ts` / `src/shared/roadGeom.ts`)**: `Traffic.trim()` usa `n.radius` (`~6 m`) enquanto `RoadsLayer` pinta a faixa em `nodeRenderR * 0.92 + CROSSWALK_INSET + 1.4` (`~12,4 m`), fazendo o 1º veículo parado no vermelho avançar ~2,7–3,1 m sobre a zebra. Alinhar o recuo de parada de `Traffic` ao recuo real da faixa pintada.
- [ ] **Calçada em encostas transversais (`src/render/roadsLayer.ts`)**: em terrenos inclinados (`terrain=vale`), a calçada do lado aclive pode ficar parcialmente coberta pela malha do terreno porque a altura usa o `y` da linha central da via.
- [ ] **Threshold de faixa em quadras curtas (`src/sim/trips.ts:300-301`)**: alinhar `totalLen > 30` com `len > 20` usado em `hasEndCrosswalk()` (`src/shared/roadGeom.ts`).

---

## Ciclo 2 — Segurança Viária, Emergências Avançadas & Ciclo de Vida da Frota (Próxima Entrega)
- [ ] **Colisões e acidentes viários emergentes** (carro–carro em chuva/velocidade/conflito e carro–pedestre em conflito de faixa).
- [ ] **Interdição temporária de faixa/via** com sinalização visual (cones/bloqueio) e desvio automático de rotas enquanto o acidente/pane bloqueia o trecho.
- [ ] **Emergências cortando trânsito e avançando sinal vermelho com segurança** (`Ambulance`, `Fire`, `Police` com sirene: corredor de emergência, mudança de faixa para ultrapassar filas travadas e preempção segura em cruzamentos).
- [ ] **Atendimento coordenado + guincho/reboque** (polícia, ambulância levando ferido ao hospital, bombeiros em colisão grave e guincho/reboque removendo veículo sinistrado/quebrado para liberar a via).
- [ ] **Ciclo de vida veicular, estacionamento, frota e manutenção** (desgaste por km, custo periódico de manutenção, panes raras, renovação gradual da frota privada e de ônibus).
- [ ] **Loop de revisão independente** com `npm run capture:field` + avaliador independente na rubrica [sim-review-rubric.md](./sim-review-rubric.md) (notas ≥ 7,0).
