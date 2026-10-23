/**
 * Servidor HTTP falso que imita a API de telemetria para os testes automatizados.
 * Ele NÃO abre porta serial: apenas responde o que cada teste configurar.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  url: string;
  /** Corpo já lido em texto (vazio nos GET) — prova o que o viewer enviou. */
  body: string;
}

export type FakeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  requests: RecordedRequest[],
) => void;

export interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  setHandler(handler: FakeHandler): void;
  close(): Promise<void>;
}

export function json(handler: FakeHandler): FakeHandler {
  return (req, res, requests) => handler(req, res, requests);
}

export async function startFakeUpstream(handler: FakeHandler): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  let current = handler;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      current(req, res, requests);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("não foi possível obter a porta do servidor falso");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setHandler: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/** Rota simples por caminho, com fallback 404 do contrato. */
export function routeByPath(
  routes: Record<string, { status: number; payload: unknown }>,
  fallback: { status: number; payload: unknown },
): FakeHandler {
  return (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const route = routes[path];
    if (route) {
      respondJson(res, route.status, route.payload);
      return;
    }
    respondJson(res, fallback.status, fallback.payload);
  };
}
