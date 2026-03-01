#!/usr/bin/env node
/**
 * Gateway proxy: sits in front of OpenClaw gateway. When model === "router",
 * calls the governor handle() and either returns the governor's response as a
 * completion or forwards the request to the real gateway with model = chosenAlias.
 * All other requests are forwarded as-is.
 *
 * Run with gateway on a different port (e.g. 18790); proxy listens on the
 * public port (e.g. 18789). Set OPENCLAW_GATEWAY_PROXY_PORT and
 * OPENCLAW_GATEWAY_BACKEND_URL (default http://127.0.0.1:18790).
 */

import http from "node:http";
import { handle } from "./index.js";

const PORT = parseInt(process.env.OPENCLAW_GATEWAY_PROXY_PORT ?? "18789", 10);
const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_BACKEND_URL ?? "http://127.0.0.1:18790").replace(
  /\/$/,
  ""
);

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

function openAiCompletion(content: string, model: string, stream: boolean): unknown {
  const id = `gov-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (stream) {
    return {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }]
    };
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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
    hostname: new URL(GATEWAY_URL).hostname,
    port: new URL(GATEWAY_URL).port || 80,
    path: path || "/",
    method,
    headers: { ...headers, host: new URL(GATEWAY_URL).host }
  };
  const req = http.request(opts, (backendRes) => {
    res.writeHead(backendRes.statusCode ?? 500, backendRes.headers);
    backendRes.pipe(res);
  });
  req.on("error", (err) => {
    console.error("[router-governor proxy] Forward error:", err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Bad Gateway", type: "gateway_error" } }));
  });
  if (body) req.write(body);
  req.end();
}

const server = http.createServer(async (req, res) => {
  const path = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health check — no forwarding, no body read
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "router-governor-proxy",
        backend: GATEWAY_URL,
        proxy_port: PORT
      })
    );
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
    res.end(
      JSON.stringify({
        error: { message: "router model requires at least one user message", type: "invalid_request" }
      })
    );
    return;
  }

  try {
    const out = await handle({ text }, {});
    const stream = Boolean(body.stream);

    if (out.mode === "respond") {
      const payload = openAiCompletion(out.text, "router", stream);
      res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" });
      if (stream) {
        res.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
        res.end();
      } else {
        res.end(JSON.stringify(payload));
      }
      return;
    }

    const handoffBody: ChatBody = { ...body, model: out.chosenAlias };
    if (out.announcement && Array.isArray(handoffBody.messages) && handoffBody.messages.length > 0) {
      handoffBody.messages = [
        ...handoffBody.messages,
        {
          role: "assistant",
          content: out.announcement
        }
      ];
    }
    const newBodyBuf = Buffer.from(JSON.stringify(handoffBody), "utf8");
    const newHeaders = { ...req.headers, "content-length": String(newBodyBuf.length) };
    forward("POST", "/v1/chat/completions", newHeaders, newBodyBuf, res);
  } catch (err) {
    console.error("[router-governor proxy] handle error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Governor error", type: "internal_error" }
      })
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[router-governor proxy] listening on ${PORT}, backend ${GATEWAY_URL}`);
});
