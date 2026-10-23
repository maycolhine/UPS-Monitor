/**
 * Tradução dos estados informados pela API (flags do quadro de status e estado
 * da comunicação) para texto em português, com severidade para a leitura visual.
 *
 * Nenhuma condição é inferida: só é exibido o que a API informa.
 * Em particular, a ausência de `OB` NÃO é apresentada como "rede normal",
 * porque isso exigiria avaliar qualidade e atualidade da leitura.
 *
 * ATENÇÃO (contrato 2.0 — multiprotocolo): os bits do quadro têm significado
 * DIFERENTE conforme o protocolo. b5/b4/b3 são `BOOST`/`FAULT`/`STANDBY` no
 * `megatec-q1` e `BYPASS`/`BOOST`/`UPSOK` no `sms-1phase`. Por isso existem
 * duas tabelas e a tabela é escolhida pelo protocolo que originou o quadro
 * (`data.source`), nunca por suposição.
 */
import { formatAge } from "./format.js";
import type { CommunicationState, DashboardPayload, TelemetryPayload } from "./contract.js";

export type Severity = "critical" | "warning" | "info";

export interface FlagMeta {
  id: string;
  label: string;
  description: string;
  severity: Severity;
}

/**
 * Ordem e significado das flags do `megatec-q1` (TS Shara), conforme monitor/docs/api-unificada.md §6.3.
 *
 * A ordem da lista é FIXA e vai do estado mais tranquilo ao mais crítico. A grade
 * da interface não reordena conforme ativo/inativo: os cards não podem "subir e
 * descer" a cada leitura, senão o usuário não consegue acompanhar a mudança.
 */
export const FLAG_META: FlagMeta[] = [
  {
    id: "BEEP",
    label: "Alarme sonoro",
    description: "Alarme sonoro em operação.",
    severity: "warning",
  },
  {
    id: "BOOST",
    label: "Reforço de tensão",
    description: "Tensão de entrada baixa, com reforço ativo.",
    severity: "warning",
  },
  {
    id: "STANDBY",
    label: "Standby",
    description: "Modo de espera informado pelo equipamento.",
    severity: "info",
  },
  {
    id: "OB",
    label: "Operando na bateria",
    description: "O equipamento está alimentando a carga pela bateria.",
    severity: "warning",
  },
  {
    id: "LB",
    label: "Bateria baixa",
    description: "Bateria abaixo do limite indicado pelo equipamento.",
    severity: "critical",
  },
  {
    id: "FAULT",
    label: "Falha",
    description: "O equipamento informa condição de falha.",
    severity: "critical",
  },
  {
    id: "TEST",
    label: "Teste em andamento",
    description: "O equipamento informa que está executando um teste de bateria.",
    severity: "info",
  },
  {
    id: "FSD",
    label: "Desligamento programado",
    description: "Desligamento programado (fail-safe shutdown) informado pelo equipamento.",
    severity: "warning",
  },
];

/**
 * Flags do `sms-1phase`. b5/b4/b3 significam `BYPASS`/`BOOST`/`UPSOK`, e não os
 * estados do Q1 — reutilizar a tabela do Q1 afirmaria, por exemplo, que o SMS
 * está em "Falha" (bit b4) quando ele informa "Boost/Buck ativo".
 *
 * A ordem da lista também é FIXA: vai do estado mais tranquilo (verde) ao mais
 * crítico (vermelho), passando pelo teste em andamento (azul) e pelo
 * desligamento (amarelo) — a grade não reordena conforme ativo/inativo.
 */
export const SMS_FLAG_META: FlagMeta[] = [
  {
    id: "BYPASS",
    label: "Bypass ativo",
    description: "A carga está ligada diretamente à entrada (bypass).",
    severity: "warning",
  },
  {
    id: "BEEP",
    label: "Alarme sonoro",
    description: "Alarme sonoro em operação.",
    severity: "warning",
  },
  {
    id: "UPSOK",
    label: "Inversor/rede OK",
    description: "Inversor e rede operando sem falha informada.",
    severity: "info",
  },
  {
    id: "BOOST",
    label: "Boost/Buck ativo",
    description: "Correção ativa da tensão de saída.",
    severity: "info",
  },
  {
    id: "OB",
    label: "Rede ausente (na bateria)",
    description: "Rede de entrada ausente; a carga é alimentada pela bateria.",
    severity: "warning",
  },
  {
    id: "LB",
    label: "Bateria baixa",
    description: "Bateria abaixo do limite indicado pelo equipamento.",
    severity: "critical",
  },
  {
    id: "TEST",
    label: "Teste em andamento",
    description: "O equipamento informa que está executando um teste de bateria.",
    severity: "info",
  },
  {
    id: "FSD",
    label: "Desligamento ativo",
    description: "Desligamento (fail-safe) informado pelo equipamento.",
    severity: "warning",
  },
];

/**
 * Tabela de flags aplicável ao protocolo informado pela API (`data.source`).
 * Protocolo desconhecido mantém a tabela do Q1 — o comportamento anterior — e
 * flags fora da tabela seguem listadas como não documentadas.
 */
export function flagMetaForProtocol(protocol?: string | null): FlagMeta[] {
  return protocol === "sms-1phase" ? SMS_FLAG_META : FLAG_META;
}

export interface FlagView extends FlagMeta {
  active: boolean;
}

export function buildFlagViews(
  flags: Record<string, boolean> | undefined,
  active: string[] | undefined,
  protocol?: string | null,
): FlagView[] {
  const activeSet = new Set(active ?? []);
  return flagMetaForProtocol(protocol).map((meta) => {
    const declared = flags?.[meta.id];
    const activeValue = typeof declared === "boolean" ? declared : activeSet.has(meta.id);
    return { ...meta, active: activeValue };
  });
}

/** Flags desconhecidas (outros modelos/marcas) são exibidas como informativas. */
export function buildUnknownFlagViews(
  flags: Record<string, boolean> | undefined,
  active: string[] | undefined,
  protocol?: string | null,
): FlagView[] {
  const known = new Set(flagMetaForProtocol(protocol).map((meta) => meta.id));
  const ids = new Set([...Object.keys(flags ?? {}), ...(active ?? [])]);
  return [...ids]
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({
      id,
      label: id,
      description: "Estado não documentado no contrato atual.",
      severity: "info" as Severity,
      active: flags?.[id] ?? (active ?? []).includes(id),
    }));
}

/**
 * Tom visual de uma flag do quadro de status.
 *
 * Diferente da `severity` genérica (crítico/atenção/informativo), o tom é o que
 * a interface pinta na barra lateral de cada card e segue o combinado com o
 * solicitante: verde = operação normal, laranja = rede ausente, vermelho =
 * bateria baixa / falha, azul = teste em andamento, amarelo = desligamento,
 * cinza = estado inativo (nenhum sinal).
 */
export type FlagTone = "good" | "warning" | "on_battery" | "critical" | "test" | "neutral";

/**
 * Tom de uma flag considerando se ela está ATIVA.
 *
 * Duas regras fogem do "inativo = cinza": `UPSOK` (inversor/rede) e `BOOST`
 * (boost/buck) — para elas a INATIVIDADE é que é a condição de alerta, então a
 * barra fica vermelha. Nas demais, o card inativo fica cinza.
 */
export function flagTone(flag: FlagView): FlagTone {
  if (!flag.active) {
    if (flag.id === "UPSOK" || flag.id === "BOOST") return "critical";
    return "neutral";
  }
  switch (flag.id) {
    case "BYPASS":
    case "BEEP":
    case "UPSOK":
    case "BOOST":
      return "good";
    case "OB":
      return "on_battery";
    case "LB":
    case "FAULT":
      return "critical";
    case "TEST":
      return "test";
    case "FSD":
      return "warning";
    default:
      // Flags ativas fora da tabela conhecida herdam a severidade declarada.
      return flag.severity === "critical" ? "critical" : flag.severity === "warning" ? "warning" : "good";
  }
}

export type CommunicationLevel = "ok" | "warning" | "stale" | "down" | "unknown";

export interface CommunicationView {
  level: CommunicationLevel;
  label: string;
  description: string;
}

const STATE_TEXT: Record<string, { label: string; description: string }> = {
  starting: { label: "Aguardando leitura", description: "O coletor ainda não concluiu a primeira tentativa." },
  ok: { label: "Conectado", description: "Última tentativa de coleta bem-sucedida." },
  stale: {
    label: "Desatualizado",
    description: "Última leitura válida mais antiga que o limite configurado no coletor.",
  },
  port_unavailable: {
    label: "Porta indisponível",
    description: "Porta serial não encontrada ou em uso por outro processo.",
  },
  permission_denied: { label: "Sem permissão", description: "Usuário do coletor sem acesso à porta serial." },
  disconnected: { label: "Desconectado", description: "O equipamento foi desconectado durante a operação." },
  timeout: { label: "Timeout", description: "Sem resposta do equipamento dentro do tempo esperado." },
  invalid_response: { label: "Resposta inválida", description: "Resposta recebida não contém um quadro Q1." },
  incomplete_response: { label: "Resposta incompleta", description: "Quadro truncado/incompleto." },
  checksum_error: {
    label: "Quadro corrompido",
    description: "Checksum do quadro não confere (protocolo SMS); leitura descartada.",
  },
  parse_error: { label: "Erro de leitura", description: "Campo não numérico ou quadro malformado." },
  out_of_range: { label: "Fora de faixa", description: "Valor fora da faixa plausível (sanidade)." },
  serial_error: { label: "Erro serial", description: "Outra falha de I/O na porta serial." },
};

export function describeCommunicationState(state: string): { label: string; description: string } {
  return STATE_TEXT[state] ?? { label: state, description: "Estado não documentado no contrato atual." };
}

export function communicationLevel(state: string): CommunicationLevel {
  if (state === "ok") return "ok";
  if (state === "stale") return "stale";
  if (state === "starting") return "warning";
  return "down";
}

/**
 * Nível da bolinha on/off de cada nobreak na lista de dispositivos.
 *
 * O item de `GET /api/v1/ups` informa `communication_state` e `telemetry_valid`
 * — os dois juntos dizem se aquele equipamento está entregando leitura agora.
 * Nada é inferido além disso.
 */
export function deviceConnectionLevel(device: {
  communication_state?: string | null;
  telemetry_valid?: boolean;
}): CommunicationLevel {
  const level = communicationLevel(device.communication_state ?? "unknown");
  if (level === "ok" && device.telemetry_valid === false) return "warning";
  return level;
}

/** Rótulo acessível da bolinha (`aria-label`), já que a cor não é o único sinal. */
export function deviceConnectionLabel(device: {
  communication_state?: string | null;
  telemetry_valid?: boolean;
}): string {
  const level = deviceConnectionLevel(device);
  const stateText = describeCommunicationState(device.communication_state ?? "unknown");
  const value = level === "ok" ? "Conectado" : level === "warning" ? "Atenção" : "Sem comunicação";
  return `${value}: ${stateText.label}`;
}

/**
 * Níveis visuais da bolinha de status de UM nobreak na lista de dispositivos.
 *
 * São seis, do mais tranquilo ao mais crítico: cinza (sem dados), azul (teste
 * em andamento), verde (tudo OK), amarelo (algum indicador em alerta), laranja
 * (rede ausente / na bateria) e vermelho (bateria baixa ou indicador crítico).
 */
export type DeviceStatusLevel = "unknown" | "ok" | "warning" | "on_battery" | "critical" | "test";

interface DeviceStatusText {
  label: string;
  description: string;
}

/**
 * Texto curto (usado na descrição do item) e longo (`aria-label`) por nível.
 * A cor nunca é o único sinal: o `label` acompanha a bolinha.
 */
const DEVICE_STATUS_TEXT: Record<DeviceStatusLevel, DeviceStatusText> = {
  unknown: {
    label: "Sem comunicação",
    description: "Não conectado, não respondendo ou sem telemetria publicada pela API.",
  },
  ok: {
    label: "Conectado",
    description: "Conectado e com todos os indicadores normais.",
  },
  warning: {
    label: "Atenção",
    description: "Algum indicador está em alerta.",
  },
  on_battery: {
    label: "Na bateria",
    description: "Rede de entrada ausente; a carga é alimentada pela bateria.",
  },
  critical: {
    label: "Alerta crítico",
    description: "Bateria baixa ou indicador de tensão de saída, frequência ou carga em estado crítico.",
  },
  test: {
    label: "Teste em andamento",
    description: "O equipamento está executando um teste de bateria.",
  },
};

export interface DeviceStatusSignals {
  communication_state?: string | null;
  telemetry_valid?: boolean;
  /** `false` quando a API não publicou telemetria utilizável para este equipamento. */
  hasTelemetry?: boolean;
  testRunning?: boolean;
  onBattery?: boolean;
  batteryLow?: boolean;
  /** Indicador de tensão de saída, frequência ou carga em estado crítico. */
  criticalMetric?: boolean;
  /** Qualquer indicador em atenção (não crítico). */
  warningSignal?: boolean;
}

/**
 * Nível da bolinha a partir dos sinais observados. A ordem de prioridade vai do
 * mais específico ao mais genérico: sem comunicação vence tudo; depois teste em
 * andamento, alerta crítico, rede ausente, alerta e, por fim, tudo OK.
 */
export function deviceStatusLevel(input: DeviceStatusSignals): DeviceStatusLevel {
  const connected = deviceConnectionLevel(input) === "ok" && (input.hasTelemetry ?? true);
  if (!connected) return "unknown";
  if (input.testRunning) return "test";
  if (input.batteryLow || input.criticalMetric) return "critical";
  if (input.onBattery) return "on_battery";
  if (input.warningSignal) return "warning";
  return "ok";
}

export interface DeviceStatusView extends DeviceStatusText {
  level: DeviceStatusLevel;
}

export function deviceStatusView(input: DeviceStatusSignals): DeviceStatusView {
  const level = deviceStatusLevel(input);
  return { level, ...DEVICE_STATUS_TEXT[level] };
}

/**
 * Estado de comunicação exibido no cabeçalho, combinando:
 *  - resposta de telemetria da API (com `stale`/`communication`);
 *  - falha de transporte do backend (`viewer.upstream`).
 */
export function describeCommunication(
  telemetry: TelemetryPayload | null,
  payload: Pick<DashboardPayload, "viewer"> | null,
): CommunicationView {
  const upstreamError = payload?.viewer.upstream.error ?? null;
  if (!telemetry) {
    if (upstreamError) {
      return {
        level: "down",
        label: "Sem comunicação com a API",
        description: upstreamError.message,
      };
    }
    return {
      level: "down",
      label: "Sem dados do equipamento",
      description: "A API respondeu, mas não há telemetria utilizável neste momento.",
    };
  }

  const state = telemetry.communication.state;
  const stateText = describeCommunicationState(state);
  const age = telemetry.communication.age_seconds ?? telemetry.data?.age_seconds ?? null;

  if (telemetry.stale) {
    return {
      level: "stale",
      label: "Desatualizado",
      description: `Última leitura válida há ${formatAge(age)}. Exibida como desatualizada.`,
    };
  }
  if (state !== "ok") {
    const level = communicationLevel(state);
    return {
      level: level === "ok" ? "warning" : level,
      label: stateText.label,
      description: stateText.description,
    };
  }
  if (!telemetry.data_available) {
    return {
      level: "warning",
      label: "Sem dados",
      description: "Coleta ativa, mas sem leitura válida publicada pela API.",
    };
  }
  return {
    level: "ok",
    label: "Conectado",
    description: `Leitura válida há ${formatAge(age)}.`,
  };
}

export function communicationStateForDetails(state: CommunicationState | undefined): string {
  if (!state) return "desconhecido";
  return describeCommunicationState(state.state).label;
}
