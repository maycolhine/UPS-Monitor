---
description: Identidade visual, acessibilidade e regras dos gauges
globs: ["src/frontend/**/*.tsx", "src/frontend/**/*.css"]
alwaysApply: true
---

# 30 — UI/UX

Detalhes: [docs/design-system.md](../../docs/design-system.md).

## Paleta

| Token | Cor | Uso |
|---|---|---|
| `--brand` | `#FF3D03` | Ações principais, foco, destaque de identidade, selo de estimativa |
| `--ink-strong` | `#000032` | Títulos e valores |
| `--ink-secondary` | `#424449` | Texto secundário, rótulos |
| `--line` | `#C5CAD2` | Bordas, divisórias, marcações |
| `--surface` | `#FFFFFF` | Fundo geral (**sempre branco**) |

A cor principal **não** domina a interface. Não usar fundo geral escuro.

## Semântica dos gauges (exceção à paleta)

Vermelho (`--sem-critical`) = ruim/crítico · Âmbar (`--sem-warning`) = atenção · Verde
(`--sem-good`) = normal. Essa exceção vale para os gauges e indicadores operacionais.

## Regras obrigatórias

1. **A cor nunca é o único sinal de estado.** Todo gauge e todo aviso combina cor + valor numérico +
   rótulo textual.
2. **Valor ausente/inválido nunca vira `0`.** Mostrar "Sem dados"; leitura fora de validade mostra o
   número com o rótulo "Desatualizado".
3. **Percentual de bateria com o selo da origem**: "estimativa" quando o protocolo estima
   (`megatec-q1`); "informada pelo equipamento" quando o próprio equipamento reporta (`sms-1phase`).
   A tensão da bateria aparece em campo separado.
4. **Não inferir "rede normal".** Sem estados ativos, exibir "Nenhum estado ativo informado pelo
   equipamento nesta leitura".
5. **Estados de carregamento, erro e ausência de dados** são obrigatórios em toda tela.
6. **Responsividade**: sem rolagem horizontal; grades fluidas (`auto-fit`/`minmax`); breakpoints em
   720 px e 420 px; valores e unidades legíveis no celular.
7. **Acessibilidade**: foco visível (`:focus-visible`), contraste adequado, `aria-label` nos gauges,
   rótulos em `dt`/`dd`, `caption`/`th scope` nas tabelas, `role="status"` nos avisos.
8. **Sem animação de valor** nem mudança de cor sem alteração real de estado.
9. **Faixas dos gauges são provisórias**: cada cartão mostra a nota do critério e a interface exibe
   aviso enquanto `threshold_problems` não estiver vazio. Nunca apresentar limite inventado como
   recomendação oficial do fabricante.
10. **Dados simulados** só em modo demonstração (`VITE_ENABLE_DEMO=true`, apenas em
    `.env.development`) e sempre com a faixa "MODO DEMONSTRAÇÃO" visível.
11. **Quadrante de Teste de Bateria em três blocos** (controle, gráficos, resumo). O bloco de
    gráficos usa **blocos selecionáveis** na barra lateral (um por métrica: tensão de saída,
    frequência, temperatura interna e carga da bateria) com `aria-pressed`, e cada bloco já resume a
    oscilação da própria métrica (`deltas.metrics`). O gráfico é **SVG próprio** (sem biblioteca),
    com `role="img"` e `aria-label`, eixo com **escala automática com folga** (não a escala do gauge)
    para não esconder oscilações pequenas, e o mesmo formato de rótulo de tempo em todo o eixo. A
    linha do alvo aparece **tracejada e rotulada**. Série não publicada → "série indisponível" e
    explicação; **nunca** uma linha reta em zero.
