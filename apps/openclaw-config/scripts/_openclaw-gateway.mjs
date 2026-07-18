// P10 ignition: the ONE shared client the three report/research backends use
// to reach the live OpenClaw gateway. Wiring rationale (2026-07-18):
//
//   - Transport = the gateway's documented, stable OpenAI-compatible surface
//     `POST /v1/chat/completions` (docs/gateway/openai-http-api.md, mini
//     runtime 2026.7.1-2). "Requests run as a normal Gateway agent run (same
//     codepath as `openclaw agent`)" — so we get the exact model/agent the
//     controller verified (control agent → codex/gpt-5.5) without spawning a
//     second agent runtime.
//   - Isolation from the user-facing control CONVERSATION: the endpoint is
//     "stateless per request (a new session key is generated each call)" as
//     long as we send NO OpenAI `user` field and NO `x-openclaw-session-key`.
//     Every backend call is therefore a throwaway lane that never reads from
//     or writes to the operator's live control session — which is exactly the
//     "isolated lightweight lane, NOT the control session" the task asks for,
//     achieved through the documented statelessness rather than a bespoke
//     agent id we'd have to keep in sync with render-openclaw-config.mjs.
//   - Auth = shared-secret bearer (`gateway.auth.mode="token"`), the mode
//     render-openclaw-config.mjs emits. Token resolution order:
//     `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` env first, then
//     `gateway.auth.token` / `gateway.auth.password` parsed out of
//     `~/.openclaw/openclaw.json`. The token is a full-operator credential
//     (per the doc's security boundary), so it is NEVER placed in an error
//     message — every error string is passed through `redactToken` first.
//   - Model/agent target defaults to `openclaw/default` (the doc's stable
//     alias for the configured default agent, "safe to hardcode even if the
//     real default agent id changes between environments"). Both the agent
//     target (OPENCLAW_GATEWAY_AGENT) and an optional per-request model
//     override (OPENCLAW_GATEWAY_MODEL → `x-openclaw-model`) are env-tunable so
//     the controller can point a backend at a search-capable agent/model on
//     the mini without a code change.
//
// Everything network-facing is injectable (`fetchImpl`, `config`) so every
// test drives a fake — zero real network in the unit suite. Real-call smoke is
// the controller's job on the mini (see the per-backend `smoke` entrypoints).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789";
const DEFAULT_AGENT_TARGET = "openclaw/default";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

// One prefix for every gateway-originated error so an engine's degrade
// disclosure (and a human reading it) can tell "the gateway lane failed" apart
// from a content/validation degrade. Kept deliberately generic — it never
// carries the token or a raw upstream body verbatim.
export const GATEWAY_ERROR_PREFIX = "openclaw gateway";

// ---------------------------------------------------------------------------
// Config resolution (env-first, then ~/.openclaw/openclaw.json)
// ---------------------------------------------------------------------------

function defaultConfigPath() {
  return join(homedir(), ".openclaw", "openclaw.json");
}

// Resolves { url, token, agent, model } from injectable env + config file.
// `readFile`/`configPath` are injectable so a test never touches a real
// ~/.openclaw/openclaw.json. A missing/unparseable config file is NOT fatal
// here (token simply stays ""); the missing-token error is raised later, at
// call time, with an actionable message — that keeps `createGatewayClient()`
// (called by production wiring with zero args) from throwing on construction.
export function resolveGatewayConfig({ env = process.env, configPath, readFile = readFileSync } = {}) {
  const rawUrl = env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const url = String(rawUrl).replace(/\/+$/u, "");
  const agent = env.OPENCLAW_GATEWAY_AGENT || DEFAULT_AGENT_TARGET;
  const model = env.OPENCLAW_GATEWAY_MODEL || null;

  let token = env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_GATEWAY_PASSWORD || "";
  if (!token) {
    try {
      const parsed = JSON.parse(readFile(configPath || defaultConfigPath(), "utf8"));
      const auth = parsed?.gateway?.auth ?? {};
      token = (typeof auth.token === "string" && auth.token) || (typeof auth.password === "string" && auth.password) || "";
    } catch {
      token = "";
    }
  }

  return { url, token, agent, model };
}

// ---------------------------------------------------------------------------
// Error hygiene
// ---------------------------------------------------------------------------

// Removes the bearer secret from any string before it can reach an error
// message / log. Splitting on the literal token covers the token appearing
// anywhere (header echo, upstream error body, etc.).
function redactToken(text, token) {
  const str = String(text ?? "");
  if (!token) {
    return str;
  }
  return str.split(token).join("[REDACTED]");
}

function gatewayError(message) {
  return new Error(`${GATEWAY_ERROR_PREFIX} ${message}`);
}

// ---------------------------------------------------------------------------
// Response content extraction
// ---------------------------------------------------------------------------

// Chat Completions returns `choices[0].message.content` as a string; a few
// provider transports hand back OpenAI "content parts" arrays instead. Collapse
// either into one plain string (empty string if neither shape is present).
function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// JSON-array extraction for the search/research backends
// ---------------------------------------------------------------------------

// Pulls the results array out of an agent reply that was asked to return a
// JSON array (or `{ "results": [...] }`). Tolerant of a ```json fence or
// leading/trailing prose, but STRICT about the contract: if no JSON array can
// be recovered it THROWS (the engines' degrade trigger) rather than inventing
// an empty list — an honest empty search is the agent returning `[]`, which
// this returns as `[]`; an unparseable reply is a failure, not "no news".
export function extractResultsArray(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    throw gatewayError("error: empty completion (no JSON results)");
  }

  const unfenced = stripCodeFence(raw);

  const direct = tryParse(unfenced);
  const fromDirect = coerceToArray(direct);
  if (fromDirect) {
    return fromDirect;
  }

  // Fall back to the first bracketed span — handles a reply that wrapped the
  // array in explanatory prose the agent was told not to add but sometimes does.
  const sliced = sliceFirstArray(unfenced);
  if (sliced !== null) {
    const parsed = tryParse(sliced);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }

  throw gatewayError("error: completion did not contain a JSON results array");
}

function stripCodeFence(text) {
  const fence = text.match(/^```(?:json|json5)?\s*([\s\S]*?)\s*```$/iu);
  return fence ? fence[1].trim() : text;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function coerceToArray(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.results)) {
    return parsed.results;
  }
  return null;
}

function sliceFirstArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

// createGatewayClient({ config?, fetchImpl?, env?, configPath?, readFile? })
//   -> { complete({ prompt, system?, timeoutMs?, model?, maxTokens? }) -> string, config }
//
// `complete` is a single-turn prompt→text call. It NEVER sends `user` or a
// session key, so each call is a fresh, isolated gateway session. All failure
// modes (missing token, transport error, timeout, non-2xx, non-JSON body,
// empty completion) throw a `GATEWAY_ERROR_PREFIX`-tagged, token-redacted
// Error — which is precisely the degrade trigger each engine already handles.
export function createGatewayClient(options = {}) {
  const config = options.config || resolveGatewayConfig(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw gatewayError("unavailable: no fetch implementation in this runtime");
  }

  async function complete({ prompt, system, timeoutMs = 60000, model, maxTokens } = {}) {
    if (!config.token) {
      throw gatewayError(
        "unavailable: missing gateway token (set OPENCLAW_GATEWAY_TOKEN or gateway.auth.token in ~/.openclaw/openclaw.json)"
      );
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw gatewayError("request error: empty prompt");
    }

    const messages = [];
    if (typeof system === "string" && system.trim() !== "") {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });

    const body = { model: config.agent, messages, stream: false };
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
      body.max_completion_tokens = maxTokens;
    }

    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${config.token}`
    };
    const modelOverride = model || config.model;
    if (modelOverride) {
      headers["x-openclaw-model"] = modelOverride;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 60000));

    let response;
    try {
      response = await fetchImpl(`${config.url}${CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw gatewayError(`error: request timed out after ${Math.max(1, Number(timeoutMs) || 60000)}ms`);
      }
      throw gatewayError(`error: ${redactToken(error?.message ?? String(error), config.token)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response || typeof response.status !== "number") {
      throw gatewayError("error: malformed transport response");
    }
    if (response.status < 200 || response.status >= 300) {
      let detail = "";
      try {
        detail = redactToken(String(await response.text()).slice(0, 200), config.token).trim();
      } catch {
        detail = "";
      }
      throw gatewayError(`error: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw gatewayError("error: response body was not valid JSON");
    }

    const text = extractContent(payload);
    if (typeof text !== "string" || text.trim() === "") {
      throw gatewayError("error: empty completion");
    }
    return text;
  }

  return { complete, config };
}

// ---------------------------------------------------------------------------
// Smoke helpers (shared by the three per-backend `smoke` entrypoints)
// ---------------------------------------------------------------------------

// Minimal `--flag value` parser for the smoke CLIs — positional args are
// ignored, `--flag` with no following value becomes `true`.
export function parseSmokeArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg === "string" && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

// Runs one real backend call and prints the result as JSON, exiting non-zero
// on any error (so `node <engine>.mjs smoke` is a one-command health probe the
// controller can run on the mini). The error is printed already-sanitized
// because it originated from this module's `gatewayError`.
export async function runSmoke(label, invoke) {
  try {
    const result = await invoke();
    process.stdout.write(`${JSON.stringify({ ok: true, backend: label, result }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, backend: label, error: String(error?.message ?? error) }, null, 2)}\n`
    );
    process.exitCode = 1;
  }
}
