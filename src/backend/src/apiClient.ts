/**
 * Cliente HTTP isolado da API de telemetria.
 *
 * Regras:
 *  - A LEITURA é SOMENTE GET.
 *  - A única escrita admitida é `POST` nas rotas de teste de bateria
 *    (`/api/v1/ups/{device_id}/tests`, `.../tests/{test_id}/abort`), previstas no
 *    contrato 3.0. Qualquer outro método é recusado localmente
 *    (`viewer_invalid_method`), sem tocar a rede.
 *  - Nunca lança exceção para o chamador: devolve um resultado discriminado com
 *    timeout, indisponibilidade, JSON inválido e códigos HTTP separados.
 *  - Não acessa porta serial nem qualquer recurso local do equipamento.
 */

export type UpstreamFailureCode =
  | "upstream_unreachable"
  | "upstream_timeout"
  | "upstream_invalid_json"
  | "upstream_unexpected_status"
  | "upstream_method_not_allowed"
  | "viewer_invalid_method"
  | "viewer_internal_error";

/** Métodos que o Web Viewer pode enviar à API de origem. */
const ALLOWED_METHODS = ["GET", "POST"] as const;

export interface UpstreamSuccess {
  ok: true;
  status: number;
  payload: unknown;
  durationMs: number;
  url: string;
}

export interface UpstreamFailure {
  ok: false;
  code: UpstreamFailureCode;
  message: string;
  status: number | null;
  durationMs: number;
  url: string;
}

export type UpstreamResult = UpstreamSuccess | UpstreamFailure;

export interface UpstreamClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class UpstreamApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UpstreamClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get base(): string {
    return this.baseUrl;
  }

  async get(path: string): Promise<UpstreamResult> {
    return this.request("GET", path);
  }

  /**
   * `POST` reservado às rotas de teste de bateria do contrato 3.0. Corpo vazio
   * equivale a `{}` (o filtro de escrita é feito pelo serviço, que só chama
   * este método para `/tests`).
   */
  async post(path: string, body?: unknown): Promise<UpstreamResult> {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<UpstreamResult> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const startedAt = Date.now();

    if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
      return {
        ok: false,
        code: "viewer_invalid_method",
        message: `o Web Viewer só envia GET (e POST nas rotas de teste); recebido '${method}'`,
        status: null,
        durationMs: 0,
        url,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers:
          method === "POST"
            ? { Accept: "application/json", "Content-Type": "application/json" }
            : { Accept: "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      const durationMs = Date.now() - startedAt;

      let payload: unknown;
      try {
        const text = await response.text();
        payload = text === "" ? null : JSON.parse(text);
      } catch (error) {
        return {
          ok: false,
          code: "upstream_invalid_json",
          message: `resposta não é JSON válido: ${(error as Error).message}`,
          status: response.status,
          durationMs: Date.now() - startedAt,
          url,
        };
      }

      return { ok: true, status: response.status, payload, durationMs, url };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const cause = error as Error & { cause?: { code?: string } };
      const aborted = cause.name === "AbortError" || controller.signal.aborted;
      if (aborted) {
        return {
          ok: false,
          code: "upstream_timeout",
          message: `sem resposta em ${this.timeoutMs} ms`,
          status: null,
          durationMs,
          url,
        };
      }
      return {
        ok: false,
        code: "upstream_unreachable",
        message: `${cause.name}: ${cause.message}${cause.cause?.code ? ` (${cause.cause.code})` : ""}`,
        status: null,
        durationMs,
        url,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
