/**
 * A stand-in for team.trailhq.com's CLI routes, over real HTTP, for the
 * `init --connect` and MCP proxy tests (and for trying the flow by hand:
 * `node --import tsx test/fake-trail-server.ts 8787`, then
 * `TRAIL_TEST_SERVER=http://127.0.0.1:8787 trail init --connect TRL-GOOD-C0DE`).
 *
 * Shapes follow the onboarding contract (A1: connect, stages, summary; A2:
 * the workspace connector's brain tools over MCP streamable HTTP, stateless
 * and JSON). Everything it's sent is kept in `log`, in order.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const GOOD_CODE = "TRL-GOOD-C0DE";
export const TOKEN = "trl_test_token";

export interface Logged {
  method: string;
  path: string;
  auth?: string;
  body: any;
}

export interface FakeTrail {
  url: string;
  log: Logged[];
  close(): Promise<void>;
}

const BRAIN_TOOLS = [
  { name: "list_brains", description: "Remote: the workspace's brains.", inputSchema: { type: "object", properties: {} } },
  { name: "get_context", description: "Remote: rules that apply to a task.", inputSchema: { type: "object", properties: { query: { type: "string" }, brain: { type: "string" } }, required: ["query"] } },
  { name: "search_rules", description: "Remote: search rules.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_rules", description: "Remote: every rule in a brain.", inputSchema: { type: "object", properties: { brain: { type: "string" } }, required: ["brain"] } },
  // The connector serves agent tools too; only the brain tools may come through.
  { name: "list_agents", description: "Remote: agents.", inputSchema: { type: "object", properties: {} } },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (s += d));
    req.on("end", () => resolve(s));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export async function startFakeTrail(port = 0): Promise<FakeTrail> {
  const log: Logged[] = [];
  const server: Server = createServer(async (req, res) => {
    const text = await readBody(req);
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* kept as null */
    }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const auth = req.headers.authorization;
    log.push({ method: req.method ?? "", path, auth, body });
    const authed = auth === `Bearer ${TOKEN}`;

    if (req.method === "GET" && path === "/__log") return send(res, 200, log);
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    if (path === "/api/public/cli/connect") {
      if (!body?.code || !body?.repo?.name) return send(res, 400, { error: "bad request", error_code: "invalid_request" });
      const bare = String(body.code).toUpperCase().replace(/^TRL-?/, "").replace(/[-\s]/g, "");
      if (`TRL-${bare.slice(0, 4)}-${bare.slice(4)}` !== GOOD_CODE) return send(res, 410, { error: "That code was already used or has expired.", error_code: "code_invalid" });
      const base = `http://${req.headers.host}`;
      return send(res, 200, {
        token: TOKEN,
        user: { id: "u1", name: "Rushabh", email: "rushabh@acme.test" },
        workspace: { id: "w1", name: "Acme", slug: "w1", url: base, invite_url: `${base}/welcome/code/invite` },
        repo: { key: "github.com/acme/retry", ...body.repo },
        repos: ["github.com/acme/retry"],
      });
    }
    if (path === "/api/cli/onboarding/events") {
      if (!authed) return send(res, 401, { error: "invalid token", error_code: "token_invalid" });
      return send(res, 200, { ok: true, stage: body?.stage, repo: body?.repo });
    }
    if (path === "/api/cli/repos/summary") {
      if (!authed) return send(res, 401, { error: "invalid token", error_code: "token_invalid" });
      return send(res, 200, { ok: true, repo: body?.repo, summary_at: new Date().toISOString() });
    }
    if (path === "/api/v1/mcp" || path === "/mcp") {
      if (!authed) return send(res, 401, { error: "invalid_token" });
      if (body?.id === undefined) return send(res, 202, undefined);
      const reply = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "trail-workspace", version: "0" } });
      if (body.method === "tools/list") return reply({ tools: BRAIN_TOOLS });
      if (body.method === "tools/call") {
        const { name, arguments: args } = body.params ?? {};
        if (name === "get_context")
          return reply({ content: [{ type: "text", text: `Brand brain · rule r1: Write "Trail", never "TRAIL". (asked: ${args?.query})` }], structuredContent: { rules: [{ rule_id: "r1", brain: { name: "Brand" } }] } });
        if (name === "list_brains") return reply({ content: [{ type: "text", text: "Brand (12 rules)" }] });
        return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `unknown tool ${name}` } });
      }
      return send(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
    }
    return send(res, 404, { error: "no route" });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    log,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Run by hand: a fake Trail on the port given (default 8787) that prints what it's sent.
if (import.meta.url === `file://${process.argv[1]}`) {
  const t = await startFakeTrail(Number(process.argv[2] ?? 8787));
  console.log(`fake Trail on ${t.url} · code ${GOOD_CODE}`);
  let shown = 0;
  setInterval(() => {
    for (; shown < t.log.length; shown++) {
      const l = t.log[shown]!;
      console.log(`${l.method} ${l.path}${l.auth ? " (bearer)" : ""}\n${JSON.stringify(l.body, null, 2)}`);
    }
  }, 200);
}
