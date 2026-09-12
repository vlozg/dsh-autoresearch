/**
 * Dashboard HTTP API — served on the DSH web server:
 *
 *   GET  /autoresearch/state    one-shot snapshot (?sessionId= filters)
 *   GET  /autoresearch/events   SSE push of snapshots + running tails
 *   POST /autoresearch/stop     abort the running experiment + loop off
 *   POST /autoresearch/resume   re-arm the loop
 *
 * The BrowserSkill security fence (loopback host, origin check,
 * sec-fetch-site, JSON content-type) is copied from dsh-plugin-browserskill.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ExperimentService } from "./experiment";

/** Structural view of the dsh-host-webserver route seam. */
export interface WebServerLike {
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/**
 * Browser-trust fence, mirroring the one dsh applies to its /api routes (our
 * routes live outside that prefix, so the checks are replicated here):
 * loopback Host authority; a present Origin must match Host;
 * sec-fetch-site: cross-site is refused; POST must be application/json.
 */
function fenceViolation(req: IncomingMessage): string | undefined {
  const host = req.headers.host ?? "";
  const hostname = /^\[.*\](?::\d+)?$/.test(host)
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!isLoopback) return "host is not a loopback authority";
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "unparseable Origin header";
    }
    if (originHost !== host) return "Origin does not match Host";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "sec-fetch-site: cross-site";
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] ?? "";
    if (!/^\s*application\/json\s*(;|$)/.test(contentType)) {
      return "POST requires an application/json body";
    }
  }
  return undefined;
}

/** Run the fence; returns true when the request was rejected (handled). */
function fenceRejected(req: IncomingMessage, res: ServerResponse): boolean {
  const violation = fenceViolation(req);
  if (violation === undefined) return false;
  sendJson(res, 403, { error: `forbidden: ${violation}` });
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function statePayload(req: IncomingMessage, res: ServerResponse, service: ExperimentService): void {
  // fenceRejected is true when the request was already answered (403); only
  // then may this handler return without sending the snapshot payload.
  if (fenceRejected(req, res)) return;
  const url = new URL(req.url ?? "/autoresearch/state", "http://" + (req.headers.host ?? "localhost"));
  const sessionId = url.searchParams.get("sessionId");
  const snapshots = service
    .listSnapshots()
    .filter((snap) => sessionId === null || snap.sessionId === sessionId);
  sendJson(res, 200, { snapshots });
}

/**
 * Register the dashboard routes. No-op (with a console note) when the
 * composition has no web server.
 * @returns disposer removing the routes.
 */
export function registerAutoResearchHttp(ctx: Context, service: ExperimentService): () => void {
  const webServer = ctx.get("webServer") as WebServerLike | undefined;
  if (webServer === undefined) {
    return () => {};
  }

  const disposers: (() => void)[] = [];

  // One-shot snapshot per session (all sessions when sessionId is absent).
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/autoresearch/state",
      handler: (req, res) => {
        statePayload(req, res, service);
      },
    }),
  );

  // SSE: initial snapshots, then every state change + running tails.
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/autoresearch/events",
      handler: (req, res) => {
        if (fenceRejected(req, res)) return;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");

        const heartbeat = setInterval(() => {
          try { res.write(": heartbeat\n\n"); } catch { /* closed */ }
        }, 15_000);

        const unsubscribe = service.subscribe((event) => {
          try {
            res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
          } catch { /* closed */ }
        });

        // Prime the stream with current snapshots.
        for (const snap of service.listSnapshots()) {
          res.write(`event: state\ndata: ${JSON.stringify({ kind: "state", sessionId: snap.sessionId, snapshot: snap })}\n\n`);
        }

        res.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        res.on("error", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      },
    }),
  );

  const dashboardAction = (action: "stop" | "resume") =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "POST required" });
        return;
      }
      if (fenceRejected(req, res)) return;
      let sessionId: string | undefined;
      try {
        const body = await readBody(req);
        if (body.trim() !== "") sessionId = (JSON.parse(body) as { sessionId?: string }).sessionId;
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (typeof sessionId !== "string" || sessionId === "") {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      if (action === "stop") {
        const aborted = service.stopExperiment(sessionId);
        service.setLoop(sessionId, false, "stopped from dashboard");
        sendJson(res, 200, { ok: true, aborted });
      } else {
        const ok = service.setLoop(sessionId, true);
        if (!ok) sendJson(res, 404, { error: `unknown session "${sessionId}"` });
        else sendJson(res, 200, { ok: true });
      }
    };

  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/autoresearch/stop",
      handler: (req, res) => { void dashboardAction("stop")(req, res); },
    }),
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/autoresearch/resume",
      handler: (req, res) => { void dashboardAction("resume")(req, res); },
    }),
  );

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
