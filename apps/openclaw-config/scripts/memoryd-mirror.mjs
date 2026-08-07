// Phase 7 Task 2 (2026-07-15 plan): memoryd 镜像后端 (fire-and-forget,
// injectable) - the layer that mirrors a SQL-first strategy-memory write
// (strategy-store.mjs's theses / discipline_rules / strategy_cards, Task 1)
// into memoryd as a full-text memory, for later semantic recall.
//
// Architecture reminder (plan's Global Constraints): "SQL 是可见性与结构化
// 数据的唯一真源；memoryd 只做全文镜像（fire-and-forget，不可用不影响任何 SQL
// 路径与纪律硬检查）" - by the time mirrorRecord below is ever called, the
// caller's SQL write has ALREADY COMMITTED. memoryd being slow, unreachable,
// or altogether unconfigured must never surface as an error to that caller or
// roll back anything. The bounded loopback call therefore degrades to an
// honest result instead of becoming a SQL-path dependency - hence
// every failure mode this module can observe (backend throw, backend
// rejection, backend returning {ok:false}) degrades to a warned, honestly
// labeled `{mirrored:false, reason}` instead of propagating.
//
// createMemorydBackend below is the real dedicated-instance integration. It
// speaks Streamable HTTP MCP over loopback only, validates the memoryd server
// identity and mem_save result, and bounds every transport step with a timeout.
//
// Backend interface (injected, never constructed by mirrorRecord itself):
//   async ({ scope, type, title, content, tags }) => { ok: boolean, memoryId?: string, reason?: string }
// matching memoryd's own mem_save tool shape (scope/type/title/content/tags),
// so the real MCP backend is a thin wrapper with no shape translation.

// ---------------------------------------------------------------------------
// Type mapping: strategy-memory record type -> memoryd mem_save `type`
// ---------------------------------------------------------------------------

// memoryd's mem_save tool accepts exactly six `type` values: session /
// decision / preference / fact / playbook / warning (memoryd fact sheet).
// This codebase's five mirrored record kinds map onto three of those six per
// the plan's explicit mapping ("策略卡→playbook / 纪律→warning /
// 论点·判断→decision"), extended by Phase 9 Task 3's review flywheel plan
// ("确认时写复盘结论...type=decision"):
//   - strategy_card (a saved playbook: scene/entry/risk/exit)   -> playbook
//   - discipline_rule (a self-imposed trading constraint)        -> warning
//   - thesis (an initial bull/bear call on a symbol)              -> decision
//   - thesis_judgment (a later append-only note on that thesis)  -> decision
//   - monthly_review (a confirmed per-owner monthly review)       -> decision
// Exported so callers (strategy.mjs's CLI, Phase 9's reviews.mjs CLI, a
// future bearer-gated API) and this module's own tests share ONE literal
// mapping rather than each re-typing the record-type strings independently.
export const MEMORYD_TYPE_BY_RECORD = {
  strategy_card: "playbook",
  discipline_rule: "warning",
  thesis: "decision",
  thesis_judgment: "decision",
  monthly_review: "decision"
};

// Any record type NOT in the map above (a future record kind not yet wired
// into this mapping, or a caller typo) degrades to memoryd's generic 'fact'
// type rather than throwing - mirrorRecord's fire-and-forget contract holds
// even for an UNRECOGNIZED record type, not just for backend failures.
const DEFAULT_MEMORYD_TYPE = "fact";

function resolveMemorydType(recordType) {
  return MEMORYD_TYPE_BY_RECORD[recordType] ?? DEFAULT_MEMORYD_TYPE;
}

// ---------------------------------------------------------------------------
// scopeForOwner: deterministic per-owner memoryd scope
// ---------------------------------------------------------------------------

// Derives a stable memoryd `scope` string for one AlphaLoop member, so every
// mirrored memory for owner X lands in a scope namespace that never
// collides with owner Y's (plan: "per-owner scope" - system-visible records
// must never leak across members even inside memoryd's own storage, not
// just at the SQL read layer). Deliberately a PURE string template over
// `ownerId` (no hashing/randomness). Percent-encoding preserves ordinary
// UUID-like ids byte-for-byte while preventing a slash-bearing imported id
// from becoming a filesystem traversal inside memoryd's scope directory.
// The same `ownerId` in must always produce the SAME scope out, forever, so a later mirror call for the same owner
// (e.g. a second thesis judgment) lands in the SAME memoryd scope as the
// first, and so tests can assert the exact literal without depending on
// this module's internals.
function encodeScopeComponent(value) {
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

export function scopeForOwner(ownerId) {
  return `alphaloop-member-${encodeScopeComponent(ownerId)}`;
}

// ---------------------------------------------------------------------------
// mirrorRecord: the single entry point callers use (fire-and-forget)
// ---------------------------------------------------------------------------

// Mirrors ONE already-committed strategy-memory record into memoryd via the
// injected `backend`. This is deliberately the ONLY exported "do the mirror"
// function - there is no separate mirrorRecord/mirrorRecordSafe split. Every
// call site (strategy.mjs's CLI commands, the bearer-gated write API, Tasks
// 3-4) calls this SAME function with an already-injected backend; there is
// no lower-level "unsafe" variant that could throw and get called by mistake
// where the safe one was intended.
//
// Callers pass an explicitly-injected backend in tests and the real loopback
// MCP backend in production. The SQL write this mirrors has already committed,
// and memoryd remains a best-effort full-text mirror rather than a dependency
// of any SQL path or discipline hard-check.
//
// Never throws / never rejects - every failure mode below (backend throws
// synchronously, backend's returned promise rejects, backend resolves with
// `{ok:false}`) is caught here and converted into a warned, honest
// `{mirrored:false, reason}` return value instead of propagating to the
// caller.
//
// @param {(args: {scope:string, type:string, title:string, content:string, tags:string[]}) => Promise<{ok:boolean, memoryId?:string, reason?:string}>} backend
// @param {{ownerId:string, recordType:string, title:string, content:string, visibility:string}} record
// @returns {Promise<{mirrored:true, memoryId:string|null}|{mirrored:false, reason:string}>}
export async function mirrorRecord(backend, { ownerId, recordType, title, content, visibility }) {
  const scope = scopeForOwner(ownerId);
  const type = resolveMemorydType(recordType);
  // Tags carry the visibility tier and the source record type alongside the
  // full-text mirror - plan: "可见性档位写进 memoryd tags（但读永远从 SQL，
  // tags 只是镜像）". These tags are NEVER read back by any SQL-facing code
  // path to make an access-control decision; they exist purely so a human
  // (or a future memoryd search) can filter/recognize what a mirrored memory
  // is, while SQL alone remains the enforcement layer for who may see what.
  const tags = [`visibility:${visibility}`, `record:${recordType}`];

  try {
    // The backend call itself is INSIDE this try (not just the await) so a
    // backend that throws SYNCHRONOUSLY (never returns a promise at all,
    // e.g. a misconfigured/non-async fake) is caught exactly the same way as
    // one whose returned promise rejects - both are just "the backend call
    // failed" from this function's point of view.
    const result = await backend({ scope, type, title, content, tags });

    if (result?.ok) {
      return { mirrored: true, memoryId: result.memoryId ?? null };
    }

    const reason = result?.reason ? String(result.reason) : "memoryd backend returned ok:false";
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  } catch (error) {
    const reason = String(error?.message ?? error);
    console.warn(`memoryd mirror skipped (record=${recordType}, owner=${ownerId}): ${reason}`);
    return { mirrored: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Real loopback MCP backend
// ---------------------------------------------------------------------------

const DEFAULT_MEMORYD_MCP_URL = "http://127.0.0.1:8766/mcp";
const DEFAULT_MEMORYD_TIMEOUT_MS = 2_500;
const MCP_PROTOCOL_VERSION = "2025-06-18";

function requireLoopbackMcpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`memoryd MCP URL is invalid: ${String(value)}`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error(`memoryd MCP URL must use loopback HTTP, received ${url.origin}`);
  }
  return url.toString();
}

function parseMcpResponse(text) {
  const source = String(text ?? "").trim();
  if (!source) throw new Error("memoryd MCP response was empty");
  if (source.startsWith("{")) return JSON.parse(source);
  for (const line of source.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data) return JSON.parse(data);
  }
  throw new Error("memoryd MCP response did not contain a JSON event");
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function mcpHeaders(sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function postMcp(fetchImpl, url, payload, timeoutMs, sessionId = null) {
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

function toolResultFromMcp(message) {
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
      ?? result?.content?.find?.((item) => item?.type === "text")?.text
      ?? "memoryd mem_save returned no successful structured result";
    return { ok: false, reason: String(reason) };
  }
  return { ok: true, memoryId: structured.memory_id ?? structured.memoryId };
}

export function createMemorydBackend(options = {}) {
  const url = requireLoopbackMcpUrl(options.url ?? process.env.MEMORYD_MCP_URL ?? DEFAULT_MEMORYD_MCP_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = Number(options.timeoutMs ?? process.env.MEMORYD_MCP_TIMEOUT_MS ?? DEFAULT_MEMORYD_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_MEMORYD_TIMEOUT_MS;

  return async function memorydBackend(args) {
    let sessionId = null;
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
          // Session cleanup is best-effort and cannot change the SQL-first
          // mirror result.
        }
      }
    }
  };
}
