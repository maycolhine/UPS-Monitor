/**
 * Servidor HTTP do Web Viewer.
 *
 * Duas responsabilidades:
 *  1. Publicar para a interface o resultado validado da API de telemetria
 *     (`/api/config`, `/api/dashboard`, `/api/devices`) — somente GET — e as
 *     ações do teste de bateria (`/api/tests...`), a única escrita admitida.
 *  2. Servir a interface compilada (mesma origem, sem CORS e sem expor o
 *     endereço da API no navegador).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { ViewerConfig } from "./config.js";
import { VIEWER_VERSION, type ViewerService } from "./dashboard.js";
import type { GaugeDefinition } from "./gaugeConfig.js";
import type { Logger } from "./logger.js";

export interface AppDependencies {
  service: ViewerService;
  config: ViewerConfig;
  gauges: GaugeDefinition[];
  gaugeProblems: string[];
  logger: Logger;
  startedAt?: number;
}

const READ_ONLY_MESSAGE =
  "o Web Viewer só aceita GET, exceto o pedido de teste de bateria (POST /api/tests)";

/** POST permitido APENAS nas rotas do teste de bateria do contrato 3.0. */
const TEST_WRITE_ROUTE = /^\/api\/tests(\/[^/]+\/abort)?$/;

export function createApp(deps: AppDependencies): Express {
  const { service, config, gauges, gaugeProblems, logger } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");
  app.use(express.json({ limit: "16kb" }));

  // Leitura somente GET; a única escrita é o pedido de teste de bateria.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isViewerPath = req.path === "/healthz" || req.path.startsWith("/api/");
    if (isViewerPath && req.method !== "GET") {
      const isTestWrite = req.method === "POST" && TEST_WRITE_ROUTE.test(req.path);
      if (!isTestWrite) {
        res.status(405).json({ error: { code: "method_not_allowed", message: READ_ONLY_MESSAGE } });
        return;
      }
    }
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    // Saúde do PRÓPRIO container (não depende da API de origem, para que o
    // healthcheck do Docker não reinicie a aplicação por causa do nobreak).
    res.status(200).json({
      status: "ok",
      service: "ups-web-viewer",
      version: VIEWER_VERSION,
      read_only: true,
      uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get("/api/config", (_req: Request, res: Response) => {
    res.status(200).json({
      viewer: {
        name: "UPS Monitor — Web Viewer",
        version: VIEWER_VERSION,
        read_only: true,
        refresh_interval_ms: config.refreshIntervalMs,
      },
      upstream: { base_url: config.apiBaseUrl },
      device_id: config.deviceId === "" ? null : config.deviceId,
      gauges,
      threshold_problems: gaugeProblems,
    });
  });

  app.get("/api/dashboard", async (req: Request, res: Response, next: NextFunction) => {
    try {
      // `?device_id=` escolhe qual nobreak é exibido (a API unificada publica N).
      // Ausente → o backend resolve pelo padrão (UPS_DEVICE_ID ou o primeiro válido).
      const raw = req.query["device_id"];
      const deviceId = typeof raw === "string" && raw !== "" ? raw : null;
      const { status, body } = await service.getDashboard(deviceId);
      res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/devices", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, body } = await service.getDevices();
      res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  // Teste de bateria (contrato 3.0): o backend apenas REPASSA o pedido do usuário
  // à API de origem, que é quem executa o comando no nobreak. Nenhum teste é
  // disparado de forma autônoma.
  const actionDeviceId = (value: unknown): string | null =>
    typeof value === "string" && value !== "" ? value : null;

  app.post("/api/tests", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = typeof req.body?.type === "string" ? req.body.type : undefined;
      const { status, body } = await service.startBatteryTest(
        actionDeviceId(req.query["device_id"]),
        type,
      );
      res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tests/:testId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const testId = req.params["testId"] ?? "";
      const { status, body } = await service.getBatteryTestReport(
        testId,
        actionDeviceId(req.query["device_id"]),
      );
      res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tests/:testId/abort", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const testId = req.params["testId"] ?? "";
      const { status, body } = await service.abortBatteryTest(
        testId,
        actionDeviceId(req.query["device_id"]),
      );
      res.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: "not_found", message: "recurso não encontrado nesta aplicação" },
    });
  });

  // Interface compilada (opcional: em desenvolvimento o Vite serve o frontend).
  const staticDir = config.staticDir;
  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    app.get("*", (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith("/api/") || req.path === "/healthz") {
        next();
        return;
      }
      res.sendFile(join(staticDir, "index.html"), (error) => {
        if (error) next(error);
      });
    });
  } else if (staticDir) {
    logger.warn("diretório da interface não encontrado; servindo apenas a API", { staticDir });
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("falha inesperada ao atender requisição", { message: error.message });
    if (res.headersSent) return;
    res.status(500).json({ error: { code: "viewer_internal_error", message: error.message } });
  });

  return app;
}
