# Design system e diretrizes de interface

Base: escopo §4 (identidade visual), §5 (UX e layout) e §6 (regras dos gauges), com o **ajuste de
estilo adotado em 2026-10-21** (ver [decisoes-tecnicas.md](./decisoes-tecnicas.md), D16).

> **Divergência registrada.** O escopo §4.1 e 30-ui-ux pediam fundo geral branco (`#FFFFFF`). Por
> solicitação do usuário, a interface passou a seguir a linguagem visual do template de referência
> `torre_de_controle_log_stica_nstech.html`: **fundo escuro, alto contraste e tipografia Barlow**,
> em um painel de quatro quadrantes sem rolagem. As regras de UX (§5 e 30-ui-ux) continuam valendo
> integralmente — em especial: a cor nunca é o único sinal de estado, valor ausente nunca vira zero
> e o percentual de bateria é sempre marcado como estimativa.

## 1. Paleta

| Token | Cor | Uso |
|---|---|---|
| `--brand` | `#FF3D03` | Ações principais, foco, borda de destaque do quadrante de contexto, selo de "estimativa" |
| `--ink-strong` | `#FFFFFF` | Títulos, valores numéricos, hierarquia alta |
| `--ink-secondary` | `#9EA8B8` | Texto secundário, rótulos, descrições |
| `--line` | `#1D2335` | Bordas, divisórias, marcações de escala |
| `--surface` | `#030408` | Fundo geral (palco) |
| `--panel` | `#070913` | Fundo dos quadrantes |
| `--card` | `#0C101F` | Fundo dos cartões de gauge |

A cor principal **não** domina a tela: ela aparece na borda do quadrante de contexto, no botão de
atualização, no foco visível e no selo de estimativa.

### Cores semânticas (exclusivas da leitura operacional)

| Token | Cor | Significado |
|---|---|---|
| `--sem-critical` | `#EF4444` | Condição ruim, crítica ou fora da faixa |
| `--sem-warning` | `#F59E0B` | Atenção, aproximação de limite |
| `--sem-good` | `#10B981` | Condição normal |
| `--sem-unknown` | `#9EA8B8` | Sem dados |

Essas cores valem para os gauges, os indicadores de estado e os avisos — a exceção prevista no
escopo §4.2. Nos demais componentes vale a paleta institucional. Os tons foram escolhidos para
manter contraste ≥ 4,5:1 sobre `--surface`/`--panel` (fundo escuro).

### Acessibilidade da cor

Cada estado é comunicado por **três canais simultâneos**: cor, valor numérico e rótulo textual
(com um ponto colorido como reforço visual). Nenhuma informação depende só da cor.

## 2. Escala dos gauges e faixas semânticas

Definidas em [gaugeConfig.ts](../src/backend/src/gaugeConfig.ts) e publicadas em `GET /api/config`.
As faixas abaixo foram **validadas pelo solicitante** em 2026-10-21 e continuam sobrescrevíveis por
`VIEWER_GAUGE_THRESHOLDS` (JSON). **Nenhum limite é recomendação oficial do fabricante.**

| Métrica | Origem (`sources[]`) | Escala | Faixas | Decimais |
|---|---|---|---|---|
| Tensão de entrada | `data.measurements.input_voltage_v` | 0–250 V | verde 80–127 e 200–225 · vermelho no restante | 0 |
| Tensão de saída | `data.measurements.output_voltage_v` | 0–250 V | verde 80–127 e 200–225 · vermelho no restante | 0 |
| Frequência | `input_frequency_hz` **ou** `output_frequency_hz` (por protocolo) | 20–70 Hz | verde 47–53 e 57–60 · âmbar 42–47, 53–57 e 60–63 · vermelho 20–42 e 63–70 | 1 |
| Temperatura interna | `data.measurements.temperature_c` | 0–50 °C | verde 0–25 · âmbar 25–35 · vermelho 35–50 | 0 |
| Carga da bateria | `data.battery_charge.percent` **ou** `data.battery.charge_percent` (por protocolo) | 0–100 % | vermelho 0–20 · âmbar 20–40 · verde 40–100 | 0 |
| Carga do nobreak | `data.measurements.load_percent` | 0–100 % | verde 0–50 · âmbar 50–75 · vermelho 75–100 | 0 |

Cada métrica pode ter **mais de uma origem** (`sources[]`), porque protocolos diferentes publicam o
mesmo dado em campos diferentes; a interface usa a primeira origem presente no payload.

Observações:

- A faixa de **tensão** cobre as duas janelas nominais adotadas (127 V e 220 V). Para um parque
  exclusivamente 220 V, ajuste por `VIEWER_GAUGE_THRESHOLDS` (exemplo em `.env.example`).
- O fabricante **não** documenta faixa operacional de temperatura nem limites de carga. Os valores
  adotados vêm da validação do solicitante (D3).
- As faixas **não** aparecem mais como texto sob cada gauge: o cartão mostra apenas o medidor, o
  valor e o estado textual. A interface só exibe o aviso de configuração quando
  `threshold_problems` não estiver vazio.

### Como validar/alterar

```bash
# exemplo: nobreak com saída 220 V
VIEWER_GAUGE_THRESHOLDS='{"output_voltage_v":{"scale":{"min":0,"max":300,"ticks":[0,75,150,225,300]},
"bands":[{"level":"critical","from":0,"to":198,"label":"Fora da faixa"},
{"level":"warning","from":198,"to":209,"label":"Atenção: abaixo do ideal"},
{"level":"good","from":209,"to":231,"label":"Faixa esperada (220 V)"},
{"level":"warning","from":231,"to":242,"label":"Atenção: acima do ideal"},
{"level":"critical","from":242,"to":300,"label":"Fora da faixa"}]}}'
```

JSON inválido, métrica desconhecida, faixa fora da escala ou faixas sobrepostas **não** são aceitos
em silêncio: geram entradas em `threshold_problems`, exibidas na interface.

## 3. Anatomia do gauge

Semicírculo de 220 × 132 unidades de viewBox, centro em (110, 110), raio 84, espessura de arco 18,
ponteiro de 66. Componente único:
[Gauge.tsx](../src/frontend/src/components/Gauge.tsx).

Camadas, de baixo para cima:

1. **trilha neutra** (`#192033`) cobrindo toda a escala;
2. **faixas semânticas** — um arco por faixa, colorido por nível;
3. **limites das faixas** — traços e rótulos no **início e no fim de cada faixa** (`bands`, via
   `bandBoundaries`), e não em marcações fixas de `scale.ticks`: assim o usuário lê onde cada
   trecho colorido começa e termina;
4. **ponteiro** — linha do centro até o valor, com eixo;
5. **valor central** — número em 30 px + unidade em 12 px, com halo na cor do cartão (`--card`) para
   permanecer legível sobre o ponteiro;
6. **legenda** — nome da métrica, selo "estimativa" quando aplicável e estado textual com ponto
   colorido.

Estados visuais:

| Estado | Classe | Aparência |
|---|---|---|
| Valor em faixa boa | `gauge--good` | Rótulo em verde |
| Valor em atenção | `gauge--warning` | Rótulo em âmbar |
| Valor crítico | `gauge--critical` | Rótulo em vermelho |
| Sem dados | `gauge--empty` | Faixas e trilha esmaecidas, ponteiro ausente, valor "—", rótulo "Sem dados" |
| Desatualizado | `gauge--stale` | SVG com opacidade reduzida e rótulo "Desatualizado" |

## 4. Composição do dashboard (quatro quadrantes)

O painel ocupa exatamente a janela, em grade 2×2, sem rolagem de página no desktop.

1. **Superior esquerdo — contexto e estado operacional:** título do produto, a **seleção em bloco dos
   nobreaks coletados** (`GET /api/v1/ups`, com **Marca/Modelo** em evidência e o `device_id` como
   descrição, destacando o que está em exibição), o indicador de comunicação, a última leitura
   válida, a idade dos dados, a versão do contrato, o endereço da API e o intervalo da atualização
   automática (não há botão de atualização manual), os avisos (modo demonstração, API indisponível,
   telemetria ausente/desatualizada, configuração das faixas) e, logo abaixo, **todos** os estados do
   quadro Q1 sempre à vista — os **ativos** em destaque e os **inativos** apagados — cada um com a
   descrição e, ao pé, os `raw_bits`.
2. **Superior direito — medições:** grade **2×3** com os seis gauges.
3. **Inferior esquerdo — teste de bateria:** o painel do teste, em três blocos (ver §4.1).
4. **Inferior direito — detalhes e coleta:** identificação, tensão da bateria, estado do coletor,
   idade, último erro e tabela com o resultado de cada consulta HTTP.
5. **Rodapé (faixa inferior):** reforço de que a aplicação é somente leitura (a única escrita é o
   pedido de teste, sempre por ação do usuário) e de que as faixas são configuráveis por
   `VIEWER_GAUGE_THRESHOLDS`.

### 4.1 Quadrante de Teste de Bateria (blocos A, B e C)

O painel segue a divisão da documentação do projeto irmão (`monitor/docs/teste-bateria-quadrante.md`):

- **Bloco A — controle:** seletor de tipo (só aparece quando o equipamento declara **mais de um**
  tipo em `capabilities.battery_test.test_types`), botão disparar/cancelar, guardas pré-clique
  (cooldown, carga mínima, ausência de cancelamento) e o estado corrente.
- **Bloco B — gráficos:** **barra lateral esquerda com quatro blocos selecionáveis** — tensão de
  saída (V), frequência (Hz), temperatura interna (°C) e carga da bateria (%) — e, à direita, o
  gráfico da série escolhida. Cada bloco já resume a oscilação da própria métrica (`deltas.metrics`)
  para que o número seja visível sem trocar de gráfico; o ativo fica em destaque e o botão usa
  `aria-pressed`. Quando a chave não foi publicada em `samples[].normalized`, o bloco mostra "série
  indisponível" e o gráfico explica — **nunca** é desenhada uma linha reta em zero.
- **Bloco C — resumo:** situação do teste, motivo do encerramento (`finish_reason`), contagem de
  amostras, autonomia estimada (com o `reason` quando `estimate.available` é falso) e a observação
  da flag `TEST`. Os testes anteriores aparecem em tabela (com a coluna **Tipo**).

**Gráficos em SVG próprio**, sem biblioteca: trilha de grade discreta, rótulos de eixo em
`--ink-secondary`, linha da série em `--brand` e linha de referência do alvo em `--sem-warning`
tracejada. A escala Y é **automática com folga de 15 %** — as oscilações de tensão e frequência são
pequenas (±2 V, ±0,5 Hz) e uma escala fixa de 0–250 V as esconderia. O eixo X usa `m:ss` quando a
janela tem 60 s ou mais (o teste de descarga dura minutos) e `s.S` no teste curto, com o **mesmo**
formato em todos os rótulos do gráfico. Em telas estreitas, os blocos da barra lateral passam a
uma faixa horizontal acima do gráfico.

### Preparação para múltiplos nobreaks

O quadrante de contexto lista os equipamentos devolvidos pela API (`dashboard.devices.devices`),
destacando o que está **em exibição** e os que estão **disponíveis**. A entrada de novos nobreaks na
rede, portanto, não exige redesenho do painel: a navegação entre equipamentos é uma evolução do
mesmo bloco, sem marca/modelo fixos no código.

## 5. Regras de exibição de ausência e obsolescência

- Valor `null`, ausente ou não numérico → **"Sem dados"**; nunca `0`.
- Leitura `stale` → o número é mostrado com o rótulo **"Desatualizado"** e um aviso no topo com a
  idade da última leitura válida.
- Identidade indisponível → bloco com mensagem explicando que a API não publicou a identificação.
- Sem estados ativos → "Nenhum estado ativo informado pelo equipamento nesta leitura" (jamais
  "rede elétrica normal": ausência de `OB` não é evidência de rede normal).
- API indisponível ≠ telemetria desatualizada: são avisos distintos e com códigos distintos.

## 6. Layout e responsividade

- **Desktop:** palco de 2×2 com `height: 100dvh` e `overflow: hidden` — sem rolagem de página. Cada
  quadrante tem rolagem interna própria (`overflow: hidden auto`) para conteúdos longos.
- **≤ 900 px:** o palco colapsa para uma coluna e a página volta a rolar; os gauges usam grade
  fluida (`auto-fit`/`minmax`).
- **≤ 420 px:** uma coluna.
- Nunca há rolagem horizontal: sem larguras fixas em `px` nos contêineres e `overflow-wrap` no
  endereço da API e nos quadros brutos.
- Foco visível em todos os elementos interativos (`:focus-visible` com contorno `#FF3D03` de 3 px).
- Link "Ir para o conteúdo" para navegação por teclado.
- `prefers-reduced-motion` respeitado (não há animação de valor: o dashboard evita oscilações).

## 7. Tipografia

**Barlow** (Google Fonts, pesos 400–800 e itálico 700) declarada em
[index.html](../src/frontend/index.html), com *fallback* para fontes de sistema
(`system-ui`, `Segoe UI`, `Roboto`, `sans-serif`). Valores numéricos em negrito com a unidade em
corpo menor e alinhamento tabular (`font-variant-numeric: tabular-nums`); caminhos e `raw_bits` em
fonte monoespaçada.
