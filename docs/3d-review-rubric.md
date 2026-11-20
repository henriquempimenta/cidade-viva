# Rubrica de Revisão Visual e Arquitetural — Modelos 3D do Cidade Viva

Este documento padroniza o ciclo iterativo de criação e avaliação para todas as frentes de modelos 3D procedurais/paramétricos do projeto.

## 1. Convenções Técnicas Obrigatórias
- **Orientação**: frente do objeto aponta para **`+X`**, cima é **`+Y`**, simetria lateral em torno de **`Z = 0`**.
- **Escala**: `1 unidade = 1 metro` (coerente com `VTYPE_LEN`, `LANE_WIDTH = 3.2`, alturas de edifícios e pedestres).
- **Contato com o solo**: `minY` próximo de `0.00` (tolerância `[-0.02, +0.03]` m) — nada flutuando ou enterrado.
- **Instancing em 1 draw call**: usar `MeshBuilder` e `SURF` de `src/render/meshKit.ts`:
  - `SURF.paint` (`aTint = 1`) apenas nas partes que recebem cor dinâmica (`instanceColor`).
  - `SURF.glass`, `SURF.rubber`, `SURF.metal`, `SURF.paintFixed`, `SURF.matte` (`aTint = 0`) nas partes com cor fixa.
  - Emissivos (faróis, lanternas, janelas acesas, giroflex) em malha pareada `glow` com offset mínimo (`~0.01–0.03m`) para evitar Z-fighting.
- **Arquitetura paramétrica**: um gerador genérico parametrizado por especificação/DNA (`Spec`) que abstrai múltiplos casos concretos, já aceitando `detail?: AssetDetail` (`'high' | 'med' | 'low'`) para suportar LOD futuro sem refatoração.

## 2. Captura Automatizada (Mundo de Demo Isolado)
Cada frente registra suas variantes em `src/workbench/registry.ts` e gera capturas padronizadas via:
```bash
npm run capture -- --family <familia> --variants <id1,id2,...>
```
Isso produz automaticamente:
- Alinhamento completo da família em **Dia** e **Noite** (coerência de escala relativa e emissivos).
- Grade de **Close-Ups** cobrindo todas as variantes da família.
- Folhas de contato **2×3** para variantes representativas: Close-Up 3/4 Frente (Dia), 3/4 Traseira (Dia), Perfil Lateral (`Y=0`), 3/4 Frente (Noite + Emissivos), Distância de Cidade (~35 m) e Variação de Cores (`aTint × 4`).

## 3. Rubrica de Avaliação (Notas de 0 a 10)
O agente avaliador inspeciona **tanto as imagens renderizadas quanto o código do gerador** e atribui notas (0–10, precisas até 0,5) em 6 critérios:

1. **Silhueta & Proporções** — leitura estrutural, equilíbrio de volumes, escala relativa entre variantes.
2. **Qualidade no Close-Up** — vincos, chanfros, para-brisas, rodas/arcos, detalhes sem aspecto de "caixa empilhada".
3. **Leitura à Distância de Cidade** — contraste, identidade instantânea entre tipos na visão aérea/média (~35 m).
4. **Materiais, Cor & Iluminação (Dia/Noite)** — separação limpa de pintura/vidro/borracha/metal (`aTint` sem manchar detalhes), faróis/emissivos alinhados à noite.
5. **Higiene Geométrica & Orçamento** — orientação `+X`, contato `Y=0`, zero faces invertidas/Z-fighting/buracos, dentro do orçamento de triângulos.
6. **Generalização Paramétrica & Código** — quão limpo, reutilizável e abstrato é o gerador (pouca duplicação, fácil adicionar novos casos concretos e preparar LOD).

## 4. Critério de Veredito e Ciclo Iterativo
- **Qualquer nota < 7,0** → `VERDICT: REJECTED_ITERATE` (listar defeitos concretos por critério; o agente modelador corrige e recaptura).
- **Todas as notas ≥ 7,0** (com alguma < 8,5) → `VERDICT: APPROVED_WITH_RESERVATIONS` (aprovado com ressalvas claras para eventual ciclo de polimento).
- **Todas as notas ≥ 8,5** → `VERDICT: APPROVED` (pronto para aprovação final do usuário e junção à `master`).
