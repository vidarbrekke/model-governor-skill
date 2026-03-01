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
 *   Message-level interception of OpenClaw's JSON-RPC protocol.
 *   - Tracks model per session from sessions.patch / sessions.resolve / sessions.list
 *   - When chat.send arrives for a session using the router model, runs handle()
 *   - On handoff: injects sessions.patch to switch model before forwarding chat.send
 *   - On respond / non-router: forwards transparently
 *
 * Env:
 *   OPENCLAW_GATEWAY_PROXY_PORT    (default 18789)
 *   OPENCLAW_GATEWAY_BACKEND_URL   (default http://127.0.0.1:18790)
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { handle } from "./index.js";
import { loadPolicy } from "./policy.js";

const PORT = parseInt(process.env.OPENCLAW_GATEWAY_PROXY_PORT ?? "18789", 10);
const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_BACKEND_URL ?? "http://127.0.0.1:18790").replace(
  /\/$/,
  ""
);
const backendUrl = new URL(GATEWAY_URL);
const BACKEND_HOST = backendUrl.hostname;
const BACKEND_PORT = parseInt(backendUrl.port || "80", 10);

const policy = loadPolicy();

// Build set of patterns that identify the router model
const ROUTER_MODEL_PATTERNS: string[] = [];
try {
  const modelsPath = new URL("../../config/models.json", import.meta.url).pathname;
  const models: Record<string, string> = JSON.parse(
    (await import("node:fs")).readFileSync(modelsPath, "utf8")
  );
  const routerRef = models[policy.router_alias];
  if (routerRef) {
    ROUTER_MODEL_PATTERNS.push(routerRef);
    const parts = routerRef.split("/");
    if (parts.length >= 2) ROUTER_MODEL_PATTERNS.push(parts.slice(-1)[0]);
  }
} catch { /* models.json not found; fall back to alias-only matching */ }
ROUTER_MODEL_PATTERNS.push(policy.router_alias);

function isRouterModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return ROUTER_MODEL_PATTERNS.some(p => m === p.toLowerCase() || m.endsWith("/" + p.toLowerCase()));
}

// ─── HTTP types and helpers ──────────────────────────────────────────────────

type Message = { role: string; content: string | Array<{ type: string; text?: string }> };
type ChatBody = {
  model?: string;
  messages?: Message[];
  stream?: boolean;
  [k: string]: unknown;
};

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
  content: string,
  model: string,
  stream: boolean,
  extraHeaders?: Record<string, string>
): { payload: unknown; headers: Record<string, string> } {
  const id = `gov-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const headers: Record<string, string> = {
    "Content-Type": stream ? "text/event-stream" : "application/json",
    ...extraHeaders
  };
  const base = { id, created: Math.floor(Date.now() / 1000), model };
  if (stream) {
    return {
      payload: { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] },
      headers
    };
  }
  return {
    payload: {
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    },
    headers
  };
}

function forward(
  method: string,
  path: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer | null,
  res: http.ServerResponse
): void {
  const opts: http.RequestOptions = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: path || "/",
    method,
    headers: { ...headers, host: backendUrl.host }
  };
  const req = http.request(opts, (backendRes) => {
    res.writeHead(backendRes.statusCode ?? 500, backendRes.headers);
    backendRes.pipe(res);
  });
  req.on("error", (err) => {
    console.error("[governor proxy] forward error:", err);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad Gateway", type: "gateway_error" } }));
    }
  });
  if (body) req.write(body);
  req.end();
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const path = req.url ?? "/";
  const method = req.method ?? "GET";

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "router-governor-proxy", backend: GATEWAY_URL, proxy_port: PORT }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const bodyBuf = Buffer.concat(chunks);

  if (method !== "POST" || path !== "/v1/chat/completions") {
    forward(method, path, req.headers, bodyBuf.length ? bodyBuf : null, res);
    return;
  }

  let body: ChatBody;
  try {
    body = JSON.parse(bodyBuf.toString("utf8")) as ChatBody;
  } catch {
    forward(method, path, req.headers, bodyBuf, res);
    return;
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model !== "router") {
    forward(method, path, req.headers, bodyBuf, res);
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = extractLastUserText(messages);
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "router model requires at least one user message", type: "invalid_request" } }));
    return;
  }

  try {
    const out = await handle({ text }, {});
    const stream = Boolean(body.stream);

    if (out.mode === "respond") {
      const { payload, headers } = openAiCompletion(out.text, "router", stream);
      res.writeHead(200, headers);
      if (stream) {
        res.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
      } else {
        res.write(JSON.stringify(payload));
      }
      res.end();
      return;
    }

    const content = out.announcement ?? `[→ ${out.chosenAlias}]`;
    const { payload, headers } = openAiCompletion(content, out.chosenAlias, stream, {
      "X-Governor-Chosen-Alias": out.chosenAlias,
      "X-Governor-Handoff": "true"
    });
    res.writeHead(200, headers);
    if (stream) {
      res.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    } else {
      res.write(JSON.stringify(payload));
    }
    res.end();
  } catch (err) {
    console.error("[governor proxy] handle error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Governor error", type: "internal_error" } }));
    }
  }
});

// ─── WebSocket interception ──────────────────────────────────────────────────
//
// OpenClaw gateway protocol (v3): JSON-RPC over WebSocket
//   Request:  { type: "req", id, method, params }
//   Response: { ok, id, payload, error? }
//   Event:    { event, payload, seq }
//
// Model is set per session via sessions.patch({ key, model }).
// Chat messages go via chat.send({ sessionKey, message }) with no model field.
// We track model per session and intercept chat.send for router sessions.

type SessionModelMap = Map<string, string>;

function extractModelFromPayload(payload: Record<string, unknown>): string | null {
  const entry = payload.entry as Record<string, unknown> | undefined;
  const resolved = payload.resolved as Record<string, unknown> | undefined;
  const defaults = payload.defaults as Record<string, unknown> | undefined;
  const model =
    (resolved && typeof resolved.model === "string" ? resolved.model : null) ??
    (entry && typeof entry.model === "string" ? entry.model : null) ??
    (defaults && typeof defaults.model === "string" ? defaults.model : null);
  return model?.trim() || null;
}

function extractSessionKeyFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.key === "string") return payload.key;
  const entry = payload.entry as Record<string, unknown> | undefined;
  if (entry && typeof entry.key === "string") return entry.key;
  return null;
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const wsUrl = `ws://${BACKEND_HOST}:${BACKEND_PORT}${req.url ?? "/"}`;
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "host") continue;
      if (k.toLowerCase() === "upgrade" || k.toLowerCase() === "connection") continue;
      if (k.toLowerCase() === "sec-websocket-key" || k.toLowerCase() === "sec-websocket-version") continue;
      if (k.toLowerCase() === "sec-websocket-extensions") continue;
      if (v) forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    const backendWs = new WebSocket(wsUrl, { headers: forwardHeaders });

    const sessionModels: SessionModelMap = new Map();
    const injectedIds = new Set<string>();
    const pendingSend: Buffer[] = [];
    let backendOpen = false;

    function flushPending() {
      for (const buf of pendingSend) backendWs.send(buf);
      pendingSend.length = 0;
    }

    function sendToBackend(data: string | Buffer) {
      if (backendOpen && backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(data);
      } else {
        pendingSend.push(typeof data === "string" ? Buffer.from(data) : data);
      }
    }

    backendWs.on("open", () => {
      backendOpen = true;
      flushPending();
    });

    // Client → Backend
    clientWs.on("message", async (rawData, isBinary) => {
      if (isBinary) { sendToBackend(rawData as Buffer); return; }

      const raw = (rawData as Buffer).toString("utf8");
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw); } catch { sendToBackend(raw); return; }

      if (frame.type !== "req" || typeof frame.method !== "string") {
        sendToBackend(raw);
        return;
      }

      const method = frame.method as string;
      const params = (frame.params ?? {}) as Record<string, unknown>;

      // Track model changes from sessions.patch
      if (method === "sessions.patch" && typeof params.key === "string" && typeof params.model === "string") {
        const model = params.model.trim();
        if (model) sessionModels.set(params.key, model);
      }

      // Intercept chat.send for router sessions
      if (method === "chat.send" && typeof params.sessionKey === "string") {
        const sessionKey = params.sessionKey;
        const currentModel = sessionModels.get(sessionKey) ?? null;

        if (isRouterModel(currentModel) && typeof params.message === "string") {
          const message = params.message.trim();
          if (message) {
            try {
              const result = await handle({ text: message }, { sessionId: sessionKey });

              if (result.mode === "handoff") {
                // Switch model via sessions.patch before forwarding
                const patchId = randomUUID();
                const patchFrame = {
                  type: "req",
                  id: patchId,
                  method: "sessions.patch",
                  params: { key: sessionKey, model: result.chosenAlias }
                };
                injectedIds.add(patchId);
                sendToBackend(JSON.stringify(patchFrame));
                sessionModels.set(sessionKey, result.chosenAlias);

                console.error(
                  `[governor proxy] WS handoff: session=${sessionKey} → ${result.chosenAlias}` +
                  ` (intent=${result.handoff?.intent ?? "?"}, reasons=${JSON.stringify(result.handoff?.reason_codes ?? [])})`
                );

                // Forward original chat.send (backend processes with new model)
                sendToBackend(raw);
                return;
              }
              // mode === "respond": let the router LLM handle it
            } catch (err) {
              console.error("[governor proxy] WS handle error:", err);
            }
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

      // Suppress responses to our injected requests
      if (typeof frame.id === "string" && injectedIds.has(frame.id)) {
        injectedIds.delete(frame.id);
        if (!frame.ok) {
          console.error("[governor proxy] injected sessions.patch failed:", frame.error);
        }
        return;
      }

      // Track model info from responses (sessions.patch, sessions.resolve, sessions.list, chat.history)
      if (frame.ok && frame.payload && typeof frame.payload === "object") {
        const payload = frame.payload as Record<string, unknown>;
        const key = extractSessionKeyFromPayload(payload);
        const model = extractModelFromPayload(payload);
        if (key && model) {
          sessionModels.set(key, model);
        }

        // sessions.list: track models for all returned sessions
        const sessions = payload.sessions as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            const sk = typeof s.key === "string" ? s.key : null;
            const sm =
              (typeof s.model === "string" ? s.model : null) ??
              (typeof (s as Record<string, unknown>).modelOverride === "string"
                ? (s as Record<string, unknown>).modelOverride as string : null);
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
      console.error("[governor proxy] WS backend error:", err);
      try { clientWs.close(); } catch {}
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[governor proxy] listening on ${PORT}, backend ${GATEWAY_URL}`);
  console.error(`[governor proxy] router model patterns: ${ROUTER_MODEL_PATTERNS.join(", ")}`);
  console.error(`[governor proxy] WS interception: tracking sessions.patch + chat.send for router sessions`);
});
