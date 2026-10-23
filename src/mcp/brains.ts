/**
 * The workspace's brains, served by the local trail MCP server.
 *
 * Once this machine is connected to a Trail workspace (`trail init --connect`,
 * or `trail login`), the one `trail` MCP entry Claude Code already has also
 * answers the workspace connector's brain tools: `list_brains`,
 * `get_context`, `search_rules` and `get_rules`. Each call is passed to the
 * workspace connector (`<trail>/api/v1/mcp`, MCP over streamable HTTP) with
 * the stored token, and its answer comes back as is: every result names the
 * brain and the rule it came from.
 *
 * The repo tools never wait on this. Not connected, the brain tools aren't
 * listed; connected but offline, they're listed and answer with a soft error,
 * while the repo tools keep working.
 */
import type { ToolDef } from './tools.js';
import { readCloud, type Cloud } from '../cloud/workspace.js';

/** The workspace connector's brain tools, the only ones passed through. */
export const BRAIN_TOOLS = ['list_brains', 'get_context', 'search_rules', 'get_rules'] as const;

export function isBrainTool(name: string): boolean {
  return (BRAIN_TOOLS as readonly string[]).includes(name);
}

/**
 * What's listed when the connector can't be asked for its own list (offline,
 * slow): the same four tools, as the workspace connector describes them.
 */
export const BRAIN_TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_brains',
    description:
      "Your Trail workspace's brains (team knowledge: brand, product, conventions, decisions), with how many rules each has. Use it to pick a brain for get_rules.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_context',
    description:
      "The rules from your Trail workspace's brains that apply to a task, each naming its brain and rule. Ask before writing anything that has to follow the team's brand, product or conventions.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the task or question, in a short phrase' },
        brain: { type: 'string', description: "optional: one brain's name, slug or id; leave out to search every brain" },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_rules',
    description: "Search the rules in your Trail workspace's brains by meaning. Each result names its brain and rule.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to look for' },
        brain: { type: 'string', description: "optional: one brain's name, slug or id; leave out to search every brain" },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_rules',
    description: "Every rule in one of your Trail workspace's brains.",
    inputSchema: {
      type: 'object',
      properties: { brain: { type: 'string', description: "the brain's name, slug or id, as list_brains shows it" } },
      required: ['brain'],
    },
  },
];

/** The workspace connector for a connection: TRAIL_MCP_URL, else `<trail>/api/v1/mcp`. */
export function connectorUrl(cloud: Cloud, env: NodeJS.ProcessEnv = process.env): string {
  return (env.TRAIL_MCP_URL || `${cloud.url.replace(/\/+$/, '')}/api/v1/mcp`).replace(/\/+$/, '');
}

export interface CallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

type Fetch = typeof fetch;

/** The JSON-RPC message answering `id`, from a JSON body or an SSE stream. */
function pickReply(contentType: string, text: string, id: number): any {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && msg.id === id) return msg;
      } catch {
        /* a partial event */
      }
    }
    return null;
  }
  try {
    const msg = JSON.parse(text);
    if (Array.isArray(msg)) return msg.find((m) => m?.id === id) ?? null;
    return msg;
  } catch {
    return null;
  }
}

/**
 * A small MCP client for the workspace connector. One per server process:
 * it initializes once, keeps a session id if the connector hands one out
 * (it runs stateless today, so it usually doesn't), and reads the connection
 * from `~/.trail/cloud.json` on every call, so `trail logout` or a new
 * `--connect` takes effect without restarting the agent.
 */
export class BrainProxy {
  private nextId = 1;
  private session: { token: string; id?: string; protocol: string } | null = null;
  private listing: Promise<ToolDef[]> | null = null;

  constructor(
    private readonly opts: { env?: NodeJS.ProcessEnv; fetchImpl?: Fetch; timeoutMs?: number; version?: string } = {},
  ) {}

  private cloud(): Cloud | null {
    return readCloud(this.opts.env);
  }

  /** Whether this machine is connected to a workspace, so the brain tools are offered. */
  connected(): boolean {
    return this.cloud() !== null;
  }

  private async rpc(cloud: Cloud, method: string, params: object | undefined, notify = false): Promise<any> {
    const f = this.opts.fetchImpl ?? fetch;
    const id = this.nextId++;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${cloud.token}`,
    };
    if (this.session?.id) headers['mcp-session-id'] = this.session.id;
    if (this.session) headers['mcp-protocol-version'] = this.session.protocol;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    const res = await f(connectorUrl(cloud, this.opts.env), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    if (notify) return null;
    if (res.status === 401 || res.status === 403) throw new Error('your Trail workspace token was not accepted; run `trail init --connect <code>` with a new code from team.trailhq.com');
    if (!res.ok) throw new Error(`the Trail workspace answered ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid && this.session) this.session.id = sid;
    const msg = pickReply(res.headers.get('content-type') ?? '', text, id);
    if (!msg) throw new Error('the Trail workspace sent an answer trail could not read');
    if (msg.error) throw new Error(msg.error.message ?? 'the Trail workspace returned an error');
    return msg.result;
  }

  /** Initialize once per token: a new connection starts a new session. */
  private async ready(cloud: Cloud): Promise<void> {
    if (this.session?.token === cloud.token) return;
    this.session = null;
    const f = this.opts.fetchImpl ?? fetch;
    const id = this.nextId++;
    const res = await f(connectorUrl(cloud, this.opts.env), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${cloud.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trail', version: this.opts.version ?? '0' } },
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('your Trail workspace token was not accepted; run `trail init --connect <code>` with a new code from team.trailhq.com');
    if (!res.ok) throw new Error(`the Trail workspace answered ${res.status}`);
    const msg = pickReply(res.headers.get('content-type') ?? '', text, id);
    const protocol = typeof msg?.result?.protocolVersion === 'string' ? msg.result.protocolVersion : '2025-06-18';
    this.session = { token: cloud.token, id: res.headers.get('mcp-session-id') ?? undefined, protocol };
    await this.rpc(cloud, 'notifications/initialized', undefined, true).catch(() => {});
  }

  /**
   * The brain tools to list: the connector's own definitions of the four
   * when it answers in time, else the built-in ones. Empty when not connected.
   * Asked once per process; the answer is reused.
   */
  listTools(): Promise<ToolDef[]> {
    const cloud = this.cloud();
    if (!cloud) return Promise.resolve([]);
    this.listing ??= (async () => {
      try {
        await this.ready(cloud);
        const result = await this.rpc(cloud, 'tools/list', {});
        const remote = (Array.isArray(result?.tools) ? result.tools : []) as ToolDef[];
        const brains = remote.filter((t) => t && isBrainTool(t.name));
        if (brains.length === 0) return BRAIN_TOOL_DEFS;
        return brains.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' } }));
      } catch {
        return BRAIN_TOOL_DEFS;
      }
    })();
    return this.listing;
  }

  /** Pass one brain tool call to the workspace. Never throws: a failure is a soft error the agent can read. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const cloud = this.cloud();
    if (!cloud) {
      return { content: [{ type: 'text', text: 'not connected to a Trail workspace · run `trail init --connect <code>` with the code from team.trailhq.com' }], isError: true };
    }
    try {
      await this.ready(cloud);
      const result = await this.rpc(cloud, 'tools/call', { name, arguments: args });
      const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result ?? null) }];
      const out: CallResult = { content, isError: result?.isError === true };
      if (result?.structuredContent !== undefined) out.structuredContent = result.structuredContent;
      return out;
    } catch (err) {
      // A dropped session is worth one fresh start.
      this.session = null;
      const why = err instanceof Error && err.name !== 'TimeoutError' && err.name !== 'AbortError' && !/fetch failed/.test(err.message) ? err.message : "couldn't reach your Trail workspace";
      return { content: [{ type: 'text', text: `${why} · the repo tools still work` }], isError: true };
    }
  }
}
