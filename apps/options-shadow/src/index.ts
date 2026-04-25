import { createServer } from "node:http";

import {
  AuditLogRepository,
  ExecutionReportRepository,
  ShadowBookRepository,
  assertOrderTicket,
  createId,
  loadLocalEnv,
  notFound,
  openTradingDatabase,
  readJsonBody,
  resolveRepoRoot,
  resolveRuntimePaths,
  sendJson,
  toJsonValue
} from "@packages/shared-types";

import { OptionsShadowEngine } from "./engine.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);
const book = new ShadowBookRepository(db);
const audit = new AuditLogRepository(db);
const reports = new ExecutionReportRepository(db);
const engine = new OptionsShadowEngine(book);

const port = Number(process.env.OPTIONS_SHADOW_PORT ?? 4313);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "options-shadow",
        openPositions: book.listOpenPositions().length
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/shadow/positions") {
      sendJson(res, 200, { positions: book.listOpenPositions() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/shadow/orders") {
      const body = await readJsonBody<{ ticket: unknown }>(req);
      assertOrderTicket(body.ticket);

      if (body.ticket.environment !== "shadow" || body.ticket.assetClass !== "option") {
        sendJson(res, 422, {
          error: "Shadow engine only accepts option tickets in the shadow environment."
        });
        return;
      }

      const result = engine.execute(body.ticket);
      const reportId = createId("report");
      reports.save({
        id: reportId,
        category: "trade",
        title: `Shadow execution report for ${body.ticket.symbol}`,
        body: result.reasons.join("\n"),
        metadata: {
          ticketId: body.ticket.id,
          result: toJsonValue(result)
        },
        createdAt: new Date().toISOString()
      });

      audit.write("options-shadow", "order.simulated", {
        ticketId: body.ticket.id,
        reportId,
        result
      });

      sendJson(res, 200, {
        ...result,
        reportId
      });
      return;
    }

    const expireMatch = req.method === "POST" ? url.pathname.match(/^\/v1\/shadow\/positions\/(.+)\/expire$/) : null;
    if (expireMatch) {
      const body = await readJsonBody<{ settlementPrice?: number }>(req);
      const position = engine.expirePosition(expireMatch[1] ?? "", body.settlementPrice);
      sendJson(res, 200, { position });
      return;
    }

    const assignMatch = req.method === "POST" ? url.pathname.match(/^\/v1\/shadow\/positions\/(.+)\/assign$/) : null;
    if (assignMatch) {
      const body = await readJsonBody<{ settlementPrice?: number }>(req);
      const position = engine.assignPosition(assignMatch[1] ?? "", body.settlementPrice);
      sendJson(res, 200, { position });
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 500, {
      error: (error as Error).message
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`options-shadow listening on http://127.0.0.1:${port}`);
});
