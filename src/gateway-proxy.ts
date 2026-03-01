#!/usr/bin/env node
/**
 * Gateway proxy: sits in front of the OpenClaw gateway.
 *
 * HTTP requests:
 *   POST /v1/chat/completions with model=router → governor handle()
 *     - mode=respond  → return synthetic OpenAI completion
 *     - mode=handoff  → return synthetic completion with announcement + X-Governor-* headers
 *                       (HTTP clients get the routing decision; retry with chosenAlias)
 *   GET /health       → proxy health/status JSON
 *   everything else   → forwarded to backend as-is
 *
 * WebSocket upgrades: tunnelled to backend transparently (OpenClaw web UI uses WS).
 *
 * Env:
 *   OPENCLAW_GATEWAY_PROXY_PORT    (default 18789)
 *   OPENCLAW_GATEWAY_BACKEND_URL   (default http://127.0.0.1:18790)
 */

import http from "node:http";
import net from "node:net";
import { handle } from "./index.js";

const PORT = parseInt(process.env.OPENCLAW_GATEWAY_PROXY_PORT ?? "18789", 10);
const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_BACKEND_URL ?? "http://127.0.0.1:18790").replace(
  /\/$/,
  ""
);
const backendUrl = new URL(GATEWAY_URL);
const BACKEND_HOST = backendUrl.hostname;
const BACKEND_PORT = parseInt(backendUrl.port || "80", 10);

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

const server = http.createServer(async (req, res) => {
  const path = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health check
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

    // Handoff: return the routing decision as a synthetic completion.
    // X-Governor-* headers tell HTTP clients which model was chosen and why.
    // OpenClaw web UI clients connect via WebSocket and never see this path;
    // for them, the governor skill text in SKILL.md guides routing instead.
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

// WebSocket pass-through: tunnel upgrade requests to the backend transparently.
// OpenClaw's web UI connects over WS; this ensures those sessions are not dropped.
server.on("upgrade", (req, socket, head) => {
  const backendSocket = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const upgradeReq = [
      `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`,
      `Host: ${backendUrl.host}`,
      ...Object.entries(req.headers)
        .filter(([k]) => k.toLowerCase() !== "host")
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`),
      "",
      ""
    ].join("\r\n");
    backendSocket.write(upgradeReq);
    if (head && head.length) backendSocket.write(head);
  });

  backendSocket.on("error", (err) => {
    console.error("[governor proxy] WS tunnel error:", err);
    socket.destroy();
  });
  socket.on("error", () => backendSocket.destroy());

  backendSocket.pipe(socket);
  socket.pipe(backendSocket);
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[governor proxy] listening on ${PORT}, backend ${GATEWAY_URL}`);
});
