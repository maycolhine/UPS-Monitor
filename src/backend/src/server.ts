/**
 * HTTP server of the Web Viewer.
 *
 * Two responsibilities:
 *  1. Publish to the interface the validated result of the telemetry API
 *     (`/api/config`, `/api/dashboard`, `/api/devices`) — GET only — and the
 *     battery test actions (`/api/tests...`), the only allowed write.
 *  2. Serve the compiled interface (same origin, no CORS and without exposing
 *     the API address in the browser).
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
  "the Web Viewer only accepts GET, except the battery test request (POST /api/tests)";

/** POST allowed ONLY on the battery test routes of contract 3.0. */
const TEST_WRITE_ROUTE = /^\/api\/tests(\/[^/]+\/abort)?$/;

export function createApp(deps: AppDependencies): Express {
  const { service, config, gauges, gaugeProblems, logger } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");
  app.use(express.json({ limit: "16kb" }));

  // GET-only reads; the only write is the battery test request.
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
    // Health of the container ITSELF (does not depend on the upstream API, so that
    // the Docker healthcheck does not restart the application because of the UPS).
    res.status(200).json({
      status: "ok",
      service: "ups-monitor-viewer",
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
      // `?device_id=` chooses which UPS is displayed (the unified API publishes N).
      // Absent → the backend resolves by default (UPS_DEVICE_ID or the first valid one).
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

  // Battery test (contract 3.0): the backend merely FORWARDS the user's request
  // to the upstream API, which is the one that runs the command on the UPS. No
  // test is triggered autonomously.
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
      error: { code: "not_found", message: "resource not found in this application" },
    });
  });

  // Compiled interface (optional: in development Vite serves the frontend).
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
    logger.warn("interface directory not found; serving only the API", { staticDir });
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("unexpected failure while handling the request", { message: error.message });
    if (res.headersSent) return;
    res.status(500).json({ error: { code: "viewer_internal_error", message: error.message } });
  });

  return app;
}
