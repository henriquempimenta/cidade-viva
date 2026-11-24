# TODO — Modelos 3D Paramétricos (Backlog de Polimento & Frentes)

Este arquivo registra ressalvas aprovadas para iteração futura e o backlog de polimento visual das famílias 3D do *Cidade Viva*.

---

## TODO 1 — Ressalvas Pontuais do Piloto 1: Veículos (`src/render/vehicleGeom.ts`)
*Origem: Avaliação Visual Rodada 2 (`APPROVED_WITH_RESERVATIONS`, média **8,3 / 10**, todas as notas ≥ 7,5).*

- [x] **`ambulance` — Z-fighting na lanterna traseira direita** (`src/render/vehicleGeom.ts` ~linha 1042):
  - A faixa vermelha traseira (`xRear - 0.012`) fica coplanar com o `glow` das lanternas traseiras (`xRear - 0.012`), causando artefato diagonal e encobrindo placa/molduras.
  - *Correção*: recuar a faixa traseira para `xRear - 0.004` (atrás de molduras/placa/lanternas) ou segmentá-la entre as lanternas.
- [x] **`fire` — Estribo traseiro flutuante e caixas de roda encobertas** (`src/render/vehicleGeom.ts` ~linhas 1137, 1350, 1421):
  - A plataforma metálica traseira (`Y = 0.52..0.66`) flutua ~28 cm abaixo da carroceria (`Y = 0.94`) porque o chassi foi omitido para `fire`. Conectar o estribo à carroceria/chassi com suportes ou longarinas.
  - Usar `cabWall` para a caixa de roda dianteira e ajustar a ordem de profundidade em `Z` da `fire-stripe` vs. caixas de roda para que os recortes das rodas apareçam limpos no perfil lateral.
- [x] **`bus` / `tourbus` — Ordem de profundidade faixa lateral vs. caixa de roda**:
  - A faixa lateral (`+0.010 m`) passa na frente do topo da caixa de roda escura (`+0.006 m`), cortando o arco escuro no perfil lateral. Elevar o offset da caixa de roda acima da faixa (ou segmentar a faixa sobre os eixos).
  - *Opcional (`tourbus`)*: adicionar montantes intermediários no corrimão cromado superior para não depender apenas das extremidades.
- [x] **Integração de sirenes/giroflex independentes de faróis noturnos**:
  - Hoje os giroflex fixos fazem parte da malha `glow` compartilhada com faróis/lanternas (além do pulso dinâmico de `sirens` em `agentsLayer.ts`). Separar ou modular o emissivo de emergência (`VEH_FLAG_SIREN`) para brilhar com intensidade total também durante o dia sem acender faróis de carros normais.

---

## TODO 2 — Polimento Visual Extra em Veículos Específicos (Futuro)
- [ ] **Motociclista sobre a `moto`** no tráfego urbano (silhueta estilizada de piloto + capacete acompanhando a motocicleta).
- [ ] **Luzes de freio dinâmicas** conectadas a `VEH_FLAG_BRAKE` (usando malha/emissivo dedicado ou instância de freio no engarrafamento/semáforo).
- [ ] **Novas variantes civis e de transporte** aproveitando `VehicleSpec` ortogonal:
  - Perua/Station Wagon, Coupé esportivo, Furgo/Kombi clássica para a Era 0, Ônibus Articulado (BRT) e Caminhão Tanque/Betoneira.
- [ ] **Refinamento de brilho especular noturno** nos capôs (reduzir leve brilho claro sob luz de lua em alguns presets).
- [ ] **Ativação de LOD em tempo real (`high` / `med` / `low`)**: o gerador já entrega os 3 níveis (`low` reduz 28–49% dos triângulos), pronto para plugar quando o projeto evoluir para malhas mais ricas/realistas no futuro.

---

## Próximas Frentes 3D *(agendadas para a entrega depois da próxima — cada frente em um loop distinto: agente dedicado + bancada + avaliador independente com notas ≥ 7)*
- [x] **Frente 2 — Material Rodante Ferroviário e Metrô** (`src/render/railGeom.ts`, `src/render/agentsLayer.ts`): 6 tipos paramétricos (locomotiva diesel-elétrica com truques de 3 eixos e limpa-trilhos, carro de passageiros com teto abaulado, vagão porta-contêineres corrugados ISO 20 pés, hopper chanfrado com carga a granel, vagão-tanque cilíndrico real com calotas/passarela/escada e trem de metrô aerodinâmico com pantógrafo articulado 3D), rodas na bitola exata `±0,75 m` apoiadas no topo do boleto do trilho, LOD em 3 níveis (`<90m / 90–220m / >220m`) e malhas `glow` noturnas pareadas.
- [ ] **Frente 3 — Árvores e Vegetação** (`src/render/trees.ts`): gerador paramétrico de troncos, galhos e copas em camadas compatível com `swayMaterial()` e chunks 400×400 m.
- [x] **Frente 4a — Pedestres, Ciclistas & Acessórios com LOD em Tempo Real** (`src/render/pedGeom.ts`, `src/render/pedMaterial.ts`, `src/render/agentsLayer.ts`): 10 arquétipos humanos paramétricos (cânone 7,5 cabeças, penteados 3D, guarda-roupa, animação GPU Mesh2Motion + IK 2-ossos para pedalada), bicicleta tubular com farol/lanterna `glow`, guarda-chuva recortado ancorado na mão e mala de rodinhas em 3 níveis de LOD (`high` / `med` / `low`).
- [ ] **Frente 4b — Mobiliário Urbano**: postes, semáforos de 3 lentes, cancelas listradas e máquinas de obra.
- [ ] **Frente 5 — Edificações e Marcos** (`src/render/buildingGeom.ts`): módulos arquitetônicos paramétricos preservando `aWin`, degradação e chunks 300×300 m.
