# Rubrica de Revisão Comportamental e Visual — Simulação Urbana do Cidade Viva

Este documento padroniza o ciclo iterativo de auditoria em campo (capturas ao longo do tempo + telemetria + análise de código) e avaliação por agente independente para comportamentos de cidadãos, pedestres, trânsito e transporte público.

## 1. Captura de Campo Automatizada
Executar capturas reais da simulação rodando em tempo real (seguindo cidadãos, paradas de ônibus, ônibus e cruzamentos centrais em múltiplos instantes):
```bash
npm run capture:field -- --seed 1234 --terrain vale --warmup 40 --out .review/field
```
Complementar com checagens quantitativas em simulação headless (testes Vitest/scripts) medindo:
- Fração de segmentos/posições de pedestres sobre calçadas/faixas vs. asfalto irregular ou dentro de footprints de edifícios;
- Distância de pontos de ônibus e passageiros em espera em relação ao meio-fio e ao centro de cruzamentos;
- Sobreposições físicas entre para-choques de veículos (`overlap === 0`);
- Consistência modal / posse e estacionamento de automóvel (zero teletransporte de carro entre viagens desconexas);
- Cobrança real de tarifas, filas FIFO e resolução de emergências/interdições.

## 2. Rubrica de Avaliação (Notas de 0 a 10)
O agente avaliador independente inspeciona **tanto as capturas PNG de campo quanto o código e os testes** e atribui notas (0–10) em 6 critérios:

1. **Calçadas, Faixas & Colisão com Edifícios** — pedestres caminham sobre calçadas reais, atravessam em faixas nos cruzamentos e nunca cortam por dentro de prédios.
2. **Pontos de Ônibus, Filas & Transporte Público** — abrigos e passageiros ficam na calçada junto ao meio-fio (nunca no meio do cruzamento), ônibus param corretamente, filas e embarque/desembarque são coerentes, tarifas são cobradas e refletidas na economia/escolha modal.
3. **Física de Trânsito & Espaçamento de Veículos** — zero para-choques invadindo outros veículos (mesmo caminhão/ônibus atrás de carro pequeno), respeito a faixas, curvas limpas e semáforos/cancelas coerentes.
4. **Coerência de Rotina & Modal dos Cidadãos/Turistas** — posse e localização real do automóvel (estacionamento, uso consistente de carro vs. ônibus/a pé), inspetor/agenda fiéis à realidade (ex.: turista mostrando hotel corretamente).
5. **Emergências, Colisões & Ciclo de Vida Veicular** *(quando no escopo do ciclo)* — colisões/acidentes realistas, interdição temporária de via, atendimento de ambulância/polícia/bombeiros/reboque, emergência ultrapassando limite e furando sinal vermelho com segurança, manutenção/frota.
6. **Determinismo, Performance & Cobertura de Testes** — zero regressões de determinismo, `typecheck`, `test` e `build` limpos, sem impacto negativo relevante em FPS ou CPU.

## 3. Veredito e Ciclo Iterativo
- **Qualquer nota < 7,0** → `VERDICT: REJECTED_ITERATE` (listar falhas concretas observadas nas fotos/telemetria/código; o implementador corrige e recaptura).
- **Todas as notas ≥ 7,0** (com alguma < 8,5) → `VERDICT: APPROVED_WITH_RESERVATIONS`.
- **Todas as notas ≥ 8,5** → `VERDICT: APPROVED`.
