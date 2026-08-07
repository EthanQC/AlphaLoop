/**
 * Platform-side TS port of apps/openclaw-config/scripts/memoryd-mirror.mjs
 * (Phase 7 Task 2) - NOT an import, for the same cross-app-boundary reason
 * documented in data/strategy-write.ts's header (and data/news.ts's). Any
 * change to the type-mapping / scope derivation / fire-and-forget semantics
 * here MUST be mirrored in memoryd-mirror.mjs (or vice versa).
 *
 * Architecture reminder (plan's Global Constraints): "SQL 是可见性与结构化
 * 数据的唯一真源；memoryd 只做全文镜像（fire-and-forget，不可用不影响任何 SQL
 * 路径与纪律硬检查）" - by the time mirrorRecord below runs, the caller's SQL
 * write (routes/api-strategy.ts, via data/strategy-write.ts) has ALREADY
 * COMMITTED. Every failure mode this module can observe (backend throws
 * synchronously, backend's returned promise rejects, backend resolves with
 * `{ok:false}`) degrades to a warned, honestly labeled
 * `{mirrored:false, reason}` instead of propagating. The loopback call is
 * timeout-bounded and can never unwind the write it mirrors.
 */

// memoryd's mem_save tool accepts exactly six `type` values: session /
// decision / preference / fact / playbook / warning. This codebase's four
// mirrored record kinds map onto four of those six, per the plan's explicit
// mapping ("策略卡→playbook / 纪律→warning / 论点·判断→decision") - identical
// to memoryd-mirror.mjs's own MEMORYD_TYPE_BY_RECORD.
export const MEMORYD_TYPE_BY_RECORD: Record<string, string> = {
  strategy_card: "playbook",
  discipline_rule: "warning",
  thesis: "decision",
  thesis_judgment: "decision",
  monthly_review: "decision"
};

// Any record type NOT in the map above degrades to memoryd's generic 'fact'
// type rather than throwing - the fire-and-forget contract holds even for an
// unrecognized record type, not just for backend failures.
const DEFAULT_MEMORYD_TYPE = "fact";

function resolveMemorydType(recordType: string): string {
  return MEMORYD_TYPE_BY_RECORD[recordType] ?? DEFAULT_MEMORYD_TYPE;
}

/** Deterministic per-owner memoryd scope. Percent-encoding preserves ordinary
 * ids while preventing slash-bearing imported ids from traversing memoryd's
 * scope directory. Identical formula to memoryd-mirror.mjs's scopeForOwner. */
function encodeScopeComponent(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(String(value ?? ""))) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || [0x21, 0x27, 0x28, 0x29, 0x2a, 0x2d, 0x2e, 0x5f, 0x7e].includes(byte);
    encoded += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

export function scopeForOwner(ownerId: string): string {
  return `alphaloop-member-${encodeScopeComponent(ownerId)}`;
}

export interface MemorydBackendArgs {
  scope: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
}

export interface MemorydBackendResult {
  ok: boolean;
  memoryId?: string;
  reason?: string;
}

/** Injected, never constructed by mirrorRecord itself - matches memoryd's own
 * mem_save tool shape (scope/type/title/content/tags), so the real MCP
 * backend is a thin wrapper with no shape translation. */
export type MemorydBackend = (args: MemorydBackendArgs) => Promise<MemorydBackendResult>;

export interface MirrorRecordInput {
  ownerId: string;
  recordType: string;
  title: string;
  content: string;
  visibility: string;
}

export type MirrorResult = { mirrored: true; memoryId: string | null } | { mirrored: false; reason: string };

/**
 * Mirrors ONE already-committed strategy-memory record into memoryd via the
 * injected `backend`. Never throws / never rejects - see module header.
 */
export async function mirrorRecord(backend: MemorydBackend, record: MirrorRecordInput): Promise<MirrorResult> {
  const { ownerId, recordType, title, content, visibility } = record;
  const scope = scopeForOwner(ownerId);
  const type = resolveMemorydType(recordType);
  // Tags carry the visibility tier and the source record type alongside the
  // full-text mirror ("可见性档位写进 memoryd tags（但读永远从 SQL，tags 只是
  // 镜像）") - never read back by any SQL-facing code path to make an
  // access-control decision.
  const tags = [`visibility:${visibility}`, `record:${recordType}`];

  try {
    const result = await backend({ scope, type, title, content, tags });

    if (result?.ok) {
      return { mirrored: true, memoryId: result.memoryId ?? null };
    }

    const reason = result?.reason ? String(result.reason) : "memoryd backend returned ok:false";
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  }
}

export interface MemorydBackendOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MEMORYD_MCP_URL = "http://127.0.0.1:8766/mcp";
const DEFAULT_MEMORYD_TIMEOUT_MS = 2_500;
const MCP_PROTOCOL_VERSION = "2025-06-18";

function requireLoopbackMcpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`memoryd MCP URL is invalid: ${value}`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error(`memoryd MCP URL must use loopback HTTP, received ${url.origin}`);
  }
  return url.toString();
}

function parseMcpResponse(text: string): any {
  const source = text.trim();
  if (!source) throw new Error("memoryd MCP response was empty");
  if (source.startsWith("{")) return JSON.parse(source);
  for (const line of source.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data) return JSON.parse(data);
  }
  throw new Error("memoryd MCP response did not contain a JSON event");
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function mcpHeaders(sessionId?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function postMcp(
  fetchImpl: typeof fetch,
  url: string,
  payload: unknown,
  timeoutMs: number,
  sessionId?: string | null
): Promise<Response> {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: JSON.stringify(payload)
  }, timeoutMs);
  if (!response.ok) {
    throw new Error(`memoryd MCP request failed: HTTP ${response.status} ${response.statusText}`.trim());
  }
  return response;
}

function toolResultFromMcp(message: any): MemorydBackendResult {
  if (message?.error) {
    throw new Error(`memoryd MCP error: ${message.error.message ?? JSON.stringify(message.error)}`);
  }
  const result = message?.result;
  let structured = result?.structuredContent;
  if (!structured && typeof result?.content?.[0]?.text === "string") {
    try {
      structured = JSON.parse(result.content[0].text);
    } catch {
      // A display-only string cannot prove that the write succeeded.
    }
  }
  if (result?.isError || structured?.ok !== true) {
    const reason = structured?.reason
      ?? result?.content?.find?.((item: any) => item?.type === "text")?.text
      ?? "memoryd mem_save returned no successful structured result";
    return { ok: false, reason: String(reason) };
  }
  return { ok: true, memoryId: structured.memory_id ?? structured.memoryId };
}

/** Real, loopback-only MCP backend. SQL has already committed before this
 * runs, so transport/protocol failures still degrade in mirrorRecord. */
export function createMemorydBackend(options: MemorydBackendOptions = {}): MemorydBackend {
  const url = requireLoopbackMcpUrl(options.url ?? process.env.MEMORYD_MCP_URL ?? DEFAULT_MEMORYD_MCP_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.MEMORYD_MCP_TIMEOUT_MS ?? DEFAULT_MEMORYD_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_MEMORYD_TIMEOUT_MS;

  return async function memorydBackend(args: MemorydBackendArgs): Promise<MemorydBackendResult> {
    let sessionId: string | null = null;
    try {
      const initializeResponse = await postMcp(fetchImpl, url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "alphaloop", version: "1" }
        }
      }, timeoutMs);
      sessionId = initializeResponse.headers.get("mcp-session-id");
      const initialized = parseMcpResponse(await initializeResponse.text());
      if (initialized?.error || initialized?.result?.serverInfo?.name !== "memoryd" || !sessionId) {
        throw new Error("memoryd MCP initialize response was invalid");
      }

      await postMcp(fetchImpl, url, {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      }, timeoutMs, sessionId);

      const callResponse = await postMcp(fetchImpl, url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mem_save", arguments: args }
      }, timeoutMs, sessionId);
      return toolResultFromMcp(parseMcpResponse(await callResponse.text()));
    } finally {
      if (sessionId) {
        try {
          await fetchWithTimeout(fetchImpl, url, {
            method: "DELETE",
            headers: mcpHeaders(sessionId)
          }, timeoutMs);
        } catch {
          // Cleanup is best-effort and cannot hide the write result.
        }
      }
    }
  };
}
