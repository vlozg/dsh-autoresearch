import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerAutoResearchHttp, type ConnectionLookup } from "../src/host/infra/http";

interface RecordedRequest {
  headers: Record<string, string>;
  method: string;
  url: string;
  body?: string;
}

interface RecordedResponse {
  status: number | null;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeService() {
  return {
    listSnapshots: () => [{ sessionId: "s1" }],
    subscribe: (_fn: unknown) => () => {},
    stopExperiment: (_id: string) => true,
    setLoop: (_id: string, on: boolean, _reason?: string) => on,
    detect: (_sessionId?: string) => ({ attached: [{ sessionId: "s1" }], unattached: [{ workDir: "/tmp/past" }] }),
  };
}

function makePair(reqSpec: RecordedRequest): { req: IncomingMessage; res: ServerResponse; out: RecordedResponse; emit: () => void } {
  const out: RecordedResponse = { status: null, headers: {}, body: "", ended: false };
  const listeners = new Map<string, (chunk: unknown) => void>();
  const req = {
    headers: reqSpec.headers,
    method: reqSpec.method,
    url: reqSpec.url,
    on(event: string, fn: (chunk: unknown) => void) {
      listeners.set(event, fn);
    },
    destroy() {},
  } as unknown as IncomingMessage;
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
    },
    write(chunk: string) {
      out.body += chunk;
    },
    end(chunk?: string) {
      if (chunk !== undefined) out.body += chunk;
      out.ended = true;
    },
    on() {},
  } as unknown as ServerResponse;
  const emit = () => {
    if (reqSpec.body !== undefined) {
      listeners.get("data")?.(reqSpec.body);
      listeners.get("end")?.(undefined);
    }
  };
  return { req, res, out, emit };
}

const LOOPBACK = { host: "127.0.0.1:3080" };

describe("GET /autoresearch/detect", () => {
  it("answers with the detect result", async () => {
    const out = await drive(() => {}, { headers: LOOPBACK, method: "GET", url: "/autoresearch/detect" });
    expect(out.status).toBe(200);
    expect(out.ended).toBe(true);
    expect(JSON.parse(out.body)).toEqual({
      attached: [{ sessionId: "s1" }],
      unattached: [{ workDir: "/tmp/past" }],
    });
  });

  it("scopes the scan when sessionId is given", async () => {
    const seen: (string | undefined)[] = [];
    const service = {
      ...fakeService(),
      detect: (sessionId?: string) => {
        seen.push(sessionId);
        return { attached: [], unattached: [], scoped: sessionId ?? null };
      },
    };
    const out = await drive(() => {}, { headers: LOOPBACK, method: "GET", url: "/autoresearch/detect?sessionId=s2" }, service);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body) as { scoped: string | null };
    expect(body.scoped).toBe("s2");
    expect(seen).toEqual(["s2"]);
  });

  it("still answers inside the scan when the fence passes", async () => {
    const out = await drive(() => {}, {
      headers: { ...LOOPBACK, origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin" },
      method: "GET",
      url: "/autoresearch/detect?sessionId=s1",
    });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toHaveProperty("attached");
  });

  it("surfaces a detect() throw as a 500 JSON error instead of a bare 400", async () => {
    const service = {
      ...fakeService(),
      detect: () => {
        throw new Error("boom in detect");
      },
    };
    const out = await drive(() => {}, { headers: LOOPBACK, method: "GET", url: "/autoresearch/detect" }, service);
    expect(out.status).toBe(500);
    expect(out.ended).toBe(true);
    expect(JSON.parse(out.body)).toEqual({ error: "boom in detect" });
  });
});

async function drive(
  _handler: unknown,
  reqSpec: RecordedRequest,
  service: ReturnType<typeof fakeService> = fakeService(),
  connection?: ConnectionLookup,
): Promise<RecordedResponse> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  const webServer = {
    register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
      routes.set(route.path, route.handler);
      return () => {};
    },
  };
  registerAutoResearchHttp(
    { get: (name: string) => (name === "webServer" ? webServer : undefined) } as never,
    service as never,
    connection,
  );
  const handler = routes.get(reqSpec.url.split("?")[0]);
  if (handler === undefined) throw new Error(`no route registered for ${reqSpec.url}`);
  const { req, res, out, emit } = makePair(reqSpec);
  const pending = handler(req, res);
  emit();
  await pending;
  return out;
}

describe("autoresearch http", () => {
  it("answers GET /state with a snapshot when the fence passes", async () => {
    const out = await drive(() => {}, { headers: LOOPBACK, method: "GET", url: "/autoresearch/state?sessionId=s1" });
    expect(out.status).toBe(200);
    expect(out.ended).toBe(true);
    expect(JSON.parse(out.body)).toEqual({ snapshots: [{ sessionId: "s1" }] });
  });

  it("refuses cross-site requests with 403", async () => {
    const out = await drive(() => {}, { headers: { host: "evil.example:80", origin: "https://evil.example:80", "sec-fetch-site": "cross-site" }, method: "GET", url: "/autoresearch/state" });
    expect(out.status).toBe(403);
  });

  it("answers non-POST on action routes with 405 instead of hanging", async () => {
    const out = await drive(() => {}, { headers: LOOPBACK, method: "GET", url: "/autoresearch/stop" });
    expect(out.status).toBe(405);
    expect(out.ended).toBe(true);
  });

  it("answers POST /resume with ok", async () => {
    const out = await drive(() => {}, { headers: { ...LOOPBACK, "content-type": "application/json" }, method: "POST", url: "/autoresearch/resume", body: JSON.stringify({ sessionId: "s1" }) });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ ok: true });
  });
});

/** Stub of the dsh-client-connection seam: loopback or a declared trusted authority. */
function seam(trustedHosts: readonly string[], authenticated = true): ConnectionLookup {
  return () => ({
    requestRejection: ({ headers }) => {
      const raw = headers.host;
      const host = typeof raw === "string" ? raw : "";
      const loopback = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/.test(host);
      if (!loopback && !trustedHosts.includes(host)) return 403;
      return authenticated ? undefined : 401;
    },
  });
}

// Regression: the dashboard must open on the Tailscale/LAN authority the web UI
// is reached by (--trusted-host), not loopback alone — a hand-copied loopback
// fence answered "host is not a loopback authority" on the phone.
describe("deployment trust seam", () => {
  const TRUSTED = "panel.example-tailnet.ts.net";

  it("serves the dashboard from a declared trusted authority", async () => {
    const out = await drive(() => {}, { headers: { host: TRUSTED }, method: "GET", url: "/autoresearch/state" }, fakeService(), seam([TRUSTED]));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ snapshots: [{ sessionId: "s1" }] });
  });

  it("refuses an authority the deployment never declared", async () => {
    const out = await drive(() => {}, { headers: { host: "evil.example" }, method: "GET", url: "/autoresearch/state" }, fakeService(), seam([TRUSTED]));
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toContain("host is not a trusted authority");
  });

  it("surfaces a missing browser session as 401, not 403", async () => {
    const out = await drive(() => {}, { headers: { host: TRUSTED }, method: "GET", url: "/autoresearch/state" }, fakeService(), seam([TRUSTED], false));
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).error).toContain("unauthorized");
  });

  it("keeps the loopback-only fence when no connection service is loaded", async () => {
    const out = await drive(() => {}, { headers: { host: TRUSTED }, method: "GET", url: "/autoresearch/state" });
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toContain("host is not a loopback authority");
  });

  it("still requires a JSON body for POST on a trusted authority", async () => {
    const out = await drive(() => {}, { headers: { host: TRUSTED, "content-type": "text/plain" }, method: "POST", url: "/autoresearch/resume", body: "{}" }, fakeService(), seam([TRUSTED]));
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toContain("application/json");
  });
});
