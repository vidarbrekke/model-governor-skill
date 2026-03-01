#!/usr/bin/env node
/**
 * Gateway proxy: sits in front of the OpenClaw gateway.
 *
 * HTTP requests:
 *   POST /v1/chat/completions with model=router → governor handle()
 *     - mode=respond  → return synthetic OpenAI completion
 *     - mode=handoff  → return synthetic completion with announcement + X-Governor-* headers
 *   GET /health       → proxy health/status JSON
 *   everything else   → forwarded to backend as-is
 *
 * WebSocket:
 *   Message-level interception of OpenClaw's JSON-RPC (v3) protocol.
 *   The proxy maintains two classes of WS connections to the backend:
 *
 *   1. Client tunnels — one per browser/TUI client, forwarding all traffic
 *      transparently. Used to track model-per-session from sessions.patch
 *      and sessions.list responses. Cannot call sessions.patch (webchat restriction).
 *
 *   2. Admin connection — a single persistent connection owned by this proxy,
 *      connecting as mode="cli" with the gateway auth token. It is NOT a webchat
 *      client, so it CAN call sessions.patch. When a handoff is decided, the proxy
 *      calls sessions.patch via the admin connection, then forwards the original
 *      chat.send through the client tunnel (which backend now processes with the
 *      switched model).
 *
 * Env:
 *   OPENCLAW_GATEWAY_PROXY_PORT    (default 18789)
 *   OPENCLAW_GATEWAY_BACKEND_URL   (default http://127.0.0.1:18790)
 *   OPENCLAW_CONFIG_PATH           (override path to openclaw.json)
 *   OPENCLAW_HOME                  (base dir; config at <OPENCLAW_HOME>/openclaw.json)
 */

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { handle } from "./index.js";
import { loadPolicy } from "./policy.js";

const PORT = parseInt(process.env.OPENCLAW_GATEWAY_PROXY_PORT ?? "18789", 10);
const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_BACKEND_URL ?? "http://127.0.0.1:18790").replace(/\/$/, "");
const backendUrl = new URL(GATEWAY_URL);
const BACKEND_HOST = backendUrl.hostname;
const BACKEND_PORT = parseInt(backendUrl.port || "80", 10);
const BACKEND_WS_URL = `ws://${BACKEND_HOST}:${BACKEND_PORT}`;

const policy = loadPolicy();

// ─── Read gateway auth token from openclaw.json ──────────────────────────────
// Needed for the admin WS connection (mode=cli requires auth when gateway.auth.mode=token).

function readGatewayToken(): string | null {
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH ??
    (process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, "openclaw.json") : null) ??
    path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const auth = (config?.gateway as Record<string, unknown> | undefined)?.auth as Record<string, unknown> | undefined;
    const token = auth?.token;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

const GATEWAY_TOKEN = readGatewayToken();

// ─── Router model pattern matching ───────────────────────────────────────────

const ROUTER_MODEL_PATTERNS: string[] = [];
try {
  const modelsPath = new URL("../../config/models.json", import.meta.url).pathname;
  const models: Record<string, string> = JSON.parse(readFileSync(modelsPath, "utf8"));
  const routerRef = models[policy.router_alias];
  if (routerRef) {
    ROUTER_MODEL_PATTERNS.push(routerRef);
    const parts = routerRef.split("/");
    if (parts.length >= 2) ROUTER_MODEL_PATTERNS.push(parts.slice(-1)[0]);
  }
} catch { /* fall back to alias-only matching */ }
ROUTER_MODEL_PATTERNS.push(policy.router_alias);

function isRouterModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return ROUTER_MODEL_PATTERNS.some(p => m === p.toLowerCase() || m.endsWith("/" + p.toLowerCase()));
}

// ─── Admin gateway connection ─────────────────────────────────────────────────
//
// A single persistent connection to the backend gateway, using mode="cli"
// (not webchat). This is allowed to call sessions.patch to switch models.
// Reconnects automatically with exponential backoff.

type PendingRequest = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class AdminGatewayConnection {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private backoffMs = 1000;
  private closed = false;
  private ready = false;

  start() {
    if (this.closed) return;
    const ws = new WebSocket(BACKEND_WS_URL);
    this.ws = ws;
    this.ready = false;

    ws.on("message", (data) => {
      const raw = (data as Buffer).toString("utf8");
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw); } catch { return; }

      // Respond to connect.challenge with our connect request
      if (frame.event === "connect.challenge") {
        const params: Record<string, unknown> = {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "router-governor-proxy",
            displayName: "Router Governor Proxy",
            version: "0.1.0",
            platform: process.platform,
            mode: "cli"
          },
          caps: [],
          role: "operator",
          scopes: ["operator.admin"]
        };
        if (GATEWAY_TOKEN) params.auth = { token: GATEWAY_TOKEN };
        const id = randomUUID();
        const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
        p.then(() => {
          this.ready = true;
          this.backoffMs = 1000;
          console.error("[governor proxy] admin WS connected (cli mode; sessions.patch available)");
        }).catch(err => {
          console.error("[governor proxy] admin WS connect failed:", String(err));
          ws.close();
        });
        ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
        return;
      }

      // Ignore tick/event frames
      if (frame.event) return;

      // Response frame
      if (typeof frame.id === "string") {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.payload);
        else p.reject(new Error((frame.error as Record<string, unknown> | undefined)?.message as string ?? "unknown error"));
      }
    });

    ws.on("close", () => {
      this.ws = null;
      this.ready = false;
      this.flushErrors(new Error("admin WS closed"));
      if (!this.closed) {
        setTimeout(() => this.start(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    });

    ws.on("error", (err) => {
      // Only log non-ECONNREFUSED errors (ECONNREFUSED happens at gateway startup and is expected)
      if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
        console.error("[governor proxy] admin WS error:", err.message);
      }
    });
  }

  async patchSession(sessionKey: string, model: string): Promise<void> {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("admin WS not ready");
    }
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ type: "req", id, method: "sessions.patch", params: { key: sessionKey, model } }));
    await result;
  }

  private flushErrors(err: Error) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  stop() { this.closed = true; this.ws?.close(); }
}

const adminConn = new AdminGatewayConnection();
adminConn.start();

// ─── HTTP helpers ────────────────────────────────────────────────────────────

type Message = { role: string; content: string | Array<{ type: string; text?: string }> };
type ChatBody = { model?: string; messages?: Message[]; stream?: boolean; [k: string]: unknown };

function extractLastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) {
      const part = c.find((p) => p?.type === "text" && p.text != null);
      if (part && "text" in part) return String(part.text).trim();
    }
    break;
  }
  return "";
}

function openAiCompletion(
  content: string, model: string, stream: boolean, extraHeaders?: Record<string, string>
): { payload: unknown; headers: Record<string, string> } {
  const id = `gov-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const headers: Record<string, string> = {
    "Content-Type": stream ? "text/event-stream" : "application/json",
    ...extraHeaders
  };
  const base = { id, created: Math.floor(Date.now() / 1000), model };
  if (stream) {
    return { payload: { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] }, headers };
  }
  return {
    payload: { ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    headers
  };
}

function forward(method: string, reqPath: string, headers: http.IncomingHttpHeaders, body: Buffer | null, res: http.ServerResponse): void {
  const req = http.request({ hostname: BACKEND_HOST, port: BACKEND_PORT, path: reqPath || "/", method, headers: { ...headers, host: backendUrl.host } }, (backendRes) => {
    res.writeHead(backendRes.statusCode ?? 500, backendRes.headers);
    backendRes.pipe(res);
  });
  req.on("error", (err) => {
    console.error("[governor proxy] forward error:", err);
    if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Bad Gateway", type: "gateway_error" } })); }
  });
  if (body) req.write(body);
  req.end();
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const reqPath = req.url ?? "/";
  const method = req.method ?? "GET";

  if (reqPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "router-governor-proxy", backend: GATEWAY_URL, proxy_port: PORT }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const bodyBuf = Buffer.concat(chunks);

  if (method !== "POST" || reqPath !== "/v1/chat/completions") { forward(method, reqPath, req.headers, bodyBuf.length ? bodyBuf : null, res); return; }

  let body: ChatBody;
  try { body = JSON.parse(bodyBuf.toString("utf8")) as ChatBody; } catch { forward(method, reqPath, req.headers, bodyBuf, res); return; }

  if (typeof body.model !== "string" || body.model.trim() !== "router") { forward(method, reqPath, req.headers, bodyBuf, res); return; }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = extractLastUserText(messages);
  if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "router model requires at least one user message", type: "invalid_request" } })); return; }

  try {
    const out = await handle({ text }, {});
    const stream = Boolean(body.stream);
    if (out.mode === "respond") {
      const { payload, headers } = openAiCompletion(out.text, "router", stream);
      res.writeHead(200, headers);
      res.end(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload));
      return;
    }
    const content = out.announcement ?? `[→ ${out.chosenAlias}]`;
    const { payload, headers } = openAiCompletion(content, out.chosenAlias, stream, { "X-Governor-Chosen-Alias": out.chosenAlias, "X-Governor-Handoff": "true" });
    res.writeHead(200, headers);
    res.end(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload));
  } catch (err) {
    console.error("[governor proxy] handle error:", err);
    if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Governor error", type: "internal_error" } })); }
  }
});

// ─── WebSocket interception ───────────────────────────────────────────────────
//
// Client tunnels: one per browser/TUI client.
// - All frames forwarded transparently.
// - We read model-per-session from sessions.patch params and sessions.list responses.
// - On chat.send for a router-model session: run handle(), then use the admin
//   connection (not the client's connection) to call sessions.patch.

type SessionModelMap = Map<string, string>;

function extractModelFromPayload(payload: Record<string, unknown>): string | null {
  const entry = payload.entry as Record<string, unknown> | undefined;
  const resolved = payload.resolved as Record<string, unknown> | undefined;
  const defaults = payload.defaults as Record<string, unknown> | undefined;
  return (
    (resolved && typeof resolved.model === "string" ? resolved.model : null) ??
    (entry && typeof entry.model === "string" ? entry.model : null) ??
    (defaults && typeof defaults.model === "string" ? defaults.model : null) ??
    null
  ) || null;
}

function extractSessionKeyFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.key === "string") return payload.key;
  const entry = payload.entry as Record<string, unknown> | undefined;
  return entry && typeof entry.key === "string" ? entry.key : null;
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const wsUrl = `${BACKEND_WS_URL}${req.url ?? "/"}`;
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl === "host" || kl === "upgrade" || kl === "connection" || kl === "sec-websocket-key" || kl === "sec-websocket-version" || kl === "sec-websocket-extensions") continue;
      if (v) forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    const backendWs = new WebSocket(wsUrl, { headers: forwardHeaders });
    const sessionModels: SessionModelMap = new Map();
    const pendingSend: Buffer[] = [];
    let backendOpen = false;

    function sendToBackend(data: string | Buffer) {
      if (backendOpen && backendWs.readyState === WebSocket.OPEN) backendWs.send(data);
      else pendingSend.push(typeof data === "string" ? Buffer.from(data) : data);
    }

    backendWs.on("open", () => { backendOpen = true; for (const buf of pendingSend) backendWs.send(buf); pendingSend.length = 0; });

    // Client → Backend
    clientWs.on("message", async (rawData, isBinary) => {
      if (isBinary) { sendToBackend(rawData as Buffer); return; }
      const raw = (rawData as Buffer).toString("utf8");
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw); } catch { sendToBackend(raw); return; }

      if (frame.type !== "req" || typeof frame.method !== "string") { sendToBackend(raw); return; }

      const method = frame.method as string;
      const params = (frame.params ?? {}) as Record<string, unknown>;

      // Track model from sessions.patch (client-side intent)
      if (method === "sessions.patch" && typeof params.key === "string" && typeof params.model === "string") {
        const model = params.model.trim();
        if (model) sessionModels.set(params.key, model);
      }

      // Intercept chat.send for router sessions
      if (method === "chat.send" && typeof params.sessionKey === "string" && typeof params.message === "string") {
        const sessionKey = params.sessionKey;
        const currentModel = sessionModels.get(sessionKey) ?? null;
        const message = params.message.trim();

        if (isRouterModel(currentModel) && message) {
          try {
            const result = await handle({ text: message }, { sessionId: sessionKey });

            if (result.mode === "handoff") {
              // Use the admin connection (cli mode) to patch the session — not the client's webchat connection
              try {
                await adminConn.patchSession(sessionKey, result.chosenAlias);
                sessionModels.set(sessionKey, result.chosenAlias);
                console.error(
                  `[governor proxy] WS handoff via admin conn: session=${sessionKey} → ${result.chosenAlias}` +
                  ` (intent=${result.handoff?.intent ?? "?"}, reasons=${JSON.stringify(result.handoff?.reason_codes ?? [])})`
                );
              } catch (patchErr) {
                console.error(`[governor proxy] admin sessions.patch failed: ${String(patchErr)}`);
              }
              // Forward chat.send — backend now uses the switched model
              sendToBackend(raw);
              return;
            }
            // mode === "respond": let the router LLM handle it normally
          } catch (err) {
            console.error("[governor proxy] WS handle error:", err);
          }
        }
      }

      sendToBackend(raw);
    });

    // Backend → Client
    backendWs.on("message", (rawData, isBinary) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (isBinary) { clientWs.send(rawData); return; }

      const raw = (rawData as Buffer).toString("utf8");
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw); } catch { clientWs.send(raw); return; }

      // Track model info from response payloads
      if (frame.ok && frame.payload && typeof frame.payload === "object") {
        const payload = frame.payload as Record<string, unknown>;
        const key = extractSessionKeyFromPayload(payload);
        const model = extractModelFromPayload(payload);
        if (key && model) sessionModels.set(key, model);
        const sessions = payload.sessions as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            const sk = typeof s.key === "string" ? s.key : null;
            const sm = (typeof s.model === "string" ? s.model : null) ?? (typeof (s as Record<string, unknown>).modelOverride === "string" ? (s as Record<string, unknown>).modelOverride as string : null);
            if (sk && sm) sessionModels.set(sk, sm);
          }
        }
      }

      clientWs.send(raw);
    });

    clientWs.on("close", () => { try { backendWs.close(); } catch {} });
    clientWs.on("error", () => { try { backendWs.close(); } catch {} });
    backendWs.on("close", () => { try { clientWs.close(); } catch {} });
    backendWs.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
        console.error("[governor proxy] WS backend error:", err);
      }
      try { clientWs.close(); } catch {}
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[governor proxy] listening on ${PORT}, backend ${GATEWAY_URL}`);
  console.error(`[governor proxy] router model patterns: ${ROUTER_MODEL_PATTERNS.join(", ")}`);
  console.error(`[governor proxy] admin WS: connecting to ${BACKEND_WS_URL} (cli mode${GATEWAY_TOKEN ? ", token auth" : ", no token"})`);
});
