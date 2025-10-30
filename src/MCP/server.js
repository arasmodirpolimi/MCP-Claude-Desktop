// server.js
// Make sure your package.json has: { "type": "module" }

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  registerTools,
  TOOL_DEFS,
  addTool,
  removeTool,
  buildAnthropicTools,
  getToolUsageLog,
} from "./registerTools.js";
import { StdioMcpClient, waitForReady } from "./stdioClient.js";
import { z } from "zod";
import cors from "cors";

const SEP = "---";
function createServer() {
  const server = new McpServer({
    name: "weather-server",
    version: "1.0.0",
    capabilities: { tools: {}, resources: {} },
  });
  registerTools(server);
  return server;
}

const app = express();
// Custom tolerant JSON parser (replaces express.json()) so we can repair common escaping mistakes
app.use((req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("application/json")) return next();
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    req.rawBody = raw;
    if (!raw.trim()) return next();
    const tryParse = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    let parsed = tryParse(raw);
    if (!parsed && raw.startsWith("\\{")) {
      // User likely sent escaped JSON like \{"jsonrpc"...} from PowerShell quoting mistakes.
      const repaired = raw.replace(/^\\+/, "").replace(/\\"/g, '"');
      parsed = tryParse(repaired);
      if (parsed)
        console.warn("[JSON parser] repaired leading backslash-escaped JSON");
    }
    if (!parsed && /\\"jsonrpc\\"/.test(raw)) {
      // Attempt broad unescape of backslash-escaped quotes (but keep escaped backslashes first)
      const repaired2 = raw.replace(/\\"/g, '"');
      parsed = tryParse(repaired2);
      if (parsed) console.warn("[JSON parser] repaired quote escaping in JSON");
    }
    if (!parsed) {
      return res.status(400).json({
        error: "Invalid JSON",
        details: "Could not parse request body as JSON",
        hint: 'Remove unnecessary backslashes. Example: {"jsonrpc":"2.0",...} (not \\{"jsonrpc"...})',
        rawPreview: raw.slice(0, 120),
      });
    }
    req.body = parsed;
    return next();
  });
});

// With the Vite proxy, CORS is not required; leaving it enabled is harmless.
// If you access the server directly from the browser (no proxy), this will help.
// Allow overriding allowed origins via env. Support comma-separated list or '*'.
// Example: ALLOWED_ORIGIN="https://arasmodirpolimi.github.io,http://localhost:5173"
const ALLOWED_ORIGIN_RAW =
  process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_RAW.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin))
        return cb(null, true);
      return cb(new Error("Origin not allowed"));
    },
    credentials: true,
  })
);

// ---------------- MCP session management endpoints -----------------
// Maintain per-session MCP servers so tools registered dynamically are isolated per browser tab.
// Persist sessions across potential hot-reload / dev restarts by stashing on globalThis.
const globalKey = "__mcp_session_servers__";
const sessionServers =
  globalThis[globalKey] instanceof Map ? globalThis[globalKey] : new Map();
globalThis[globalKey] = sessionServers; // ensure future reloads reuse
console.log(
  "[MCP] sessionServers init. Existing entries:",
  sessionServers.size
);

// ---------------- Chat Memory Store ----------------------------------------
// Per-session conversational memory. In-memory Map (can swap to Redis or DB later).
// Shape: memoryMap[sessionId] = { messages: [ { role, content, ts } ], summaries: [ { content, ts } ], chars }
const memoryKey = "__chat_memory_store__";
const memoryMap =
  globalThis[memoryKey] instanceof Map ? globalThis[memoryKey] : new Map();
globalThis[memoryKey] = memoryMap;
const MAX_MEMORY_CHARS = 12000; // rough cap before summarization
const SUMMARY_TARGET = 6000; // after summarizing prune to this size

function estimateChars(arr) {
  return arr.reduce((n, m) => n + (m.content?.length || 0), 0);
}
function buildMemoryContext(sessionId) {
  const entry = memoryMap.get(sessionId);
  if (!entry) return [];
  // Convert stored messages + summaries to Anthropic style earlier context.
  const ctx = [];
  for (const s of entry.summaries)
    ctx.push({
      role: "assistant",
      content: [{ type: "text", text: "(summary) " + s.content }],
    });
  for (const m of entry.messages)
    ctx.push({ role: m.role, content: [{ type: "text", text: m.content }] });
  return ctx;
}

function summarizeOldMessages(entry) {
  if (!entry || entry.messages.length < 6) return; // require some depth
  const half = Math.floor(entry.messages.length / 2);
  const toSummarize = entry.messages.slice(0, half);
  const summaryText = toSummarize
    .map((m) =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`.slice(0, 300)
    )
    .join("\n");
  entry.summaries.push({ content: summaryText, ts: Date.now() });
  entry.messages = entry.messages.slice(half); // keep recent half
}

// Shared helper to store memory messages internally or via HTTP endpoint.
function storeMemoryMessage(sessionId, role, content) {
  if (!sessionId || typeof sessionId !== "string")
    return { error: "Missing sessionId" };
  if (!["user", "assistant", "system"].includes(role))
    return { error: "Invalid role" };
  if (typeof content !== "string" || !content.trim())
    return { error: "Invalid content" };
  const entry = memoryMap.get(sessionId) || {
    messages: [],
    summaries: [],
    chars: 0,
  };
  const now = Date.now();
  const last = entry.messages[entry.messages.length - 1];
  // Deduplicate identical consecutive messages of same role within short window (5s)
  if (
    last &&
    last.role === role &&
    last.content === content &&
    now - last.ts < 5000
  ) {
    return {
      ok: true,
      sessionId,
      deduped: true,
      counts: {
        messages: entry.messages.length,
        summaries: entry.summaries.length,
      },
      chars: entry.chars,
    };
  }
  entry.messages.push({ role, content, ts: now });
  entry.chars = estimateChars(entry.messages) + estimateChars(entry.summaries);
  if (entry.chars > MAX_MEMORY_CHARS) {
    summarizeOldMessages(entry);
    entry.chars =
      estimateChars(entry.messages) + estimateChars(entry.summaries);
    if (entry.chars > MAX_MEMORY_CHARS) {
      entry.messages.shift();
      entry.chars =
        estimateChars(entry.messages) + estimateChars(entry.summaries);
    }
  }
  memoryMap.set(sessionId, entry);
  return {
    ok: true,
    sessionId,
    counts: {
      messages: entry.messages.length,
      summaries: entry.summaries.length,
    },
    chars: entry.chars,
  };
}

app.post("/memory/append", async (req, res) => {
  const { sessionId, role, content } = req.body || {};
  const result = storeMemoryMessage(sessionId, role, content);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

app.get("/memory/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  const entry = memoryMap.get(sessionId) || {
    messages: [],
    summaries: [],
    chars: 0,
  };
  return res.json({
    sessionId,
    messages: entry.messages,
    summaries: entry.summaries,
    chars: entry.chars,
  });
});

app.post("/memory/clear", (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  memoryMap.delete(sessionId);
  return res.json({ ok: true, sessionId });
});

// Removed static filesystem tool definitions; rely solely on dynamic registry (registerTools.js)

app.post("/api/mcp/servers", async (req, res) => {
  const {
    name = "default",
    type = "embedded",
    args = [],
    command = "",
    cwd = process.cwd(),
  } = req.body || {};
  const id = randomUUID();
  if (type === "embedded") {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
    await server.connect(transport);
    sessionServers.set(id, { server, transport, name, type, baseUrl: null });
    console.log("[MCP] created embedded server", id, name);
    return res.json({
      server: { id, name, type, path: `/mcp/${id}`, baseUrl: null },
    });
  }
  if (type === "filesystem") {
    // Launch external filesystem MCP server via npx @modelcontextprotocol/server-filesystem .
    // Windows requires npx.cmd; attempt cross-platform resolution
    let cmd = command || "npx";
    if (process.platform === "win32") {
      // If user passed just 'npx', use npx.cmd to avoid ENOENT
      if (cmd.toLowerCase() === "npx") cmd = "npx.cmd";
    }
    const fullArgs = args.length
      ? args
      : ["-y", "@modelcontextprotocol/server-filesystem", "."];
    let proc;
    const spawnAttempts = [];
    const trySpawn = (label, c, a) => {
      try {
        const p = spawn(c, a, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        p._spawnLabel = label;
        spawnAttempts.push({ label, command: c, args: a, ok: true });
        return p;
      } catch (err) {
        spawnAttempts.push({
          label,
          command: c,
          args: a,
          ok: false,
          error: String(err?.message || err),
        });
        return null;
      }
    };
    // Attempt sequence: primary cmd, if win32 also try alternative npx/npx.cmd, then npm exec
    proc = trySpawn("primary", cmd, fullArgs);
    if (!proc && process.platform === "win32" && cmd !== "npx.cmd") {
      proc = trySpawn("win-npx-cmd", "npx.cmd", fullArgs);
    }
    if (!proc) {
      const altCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      proc = trySpawn("npm-exec", altCmd, [
        "exec",
        "@modelcontextprotocol/server-filesystem",
        ".",
      ]);
    }
    // Final fallback: attempt direct node module resolution of package bin
    if (!proc) {
      try {
        const require = createRequire(import.meta.url);
        const pkgPath = require.resolve(
          "@modelcontextprotocol/server-filesystem/package.json"
        );
        const pkgDir = path.dirname(pkgPath);
        const raw = await fs.readFile(pkgPath, "utf8");
        const pkgJson = JSON.parse(raw);
        const candidates = [];
        if (typeof pkgJson.bin === "string")
          candidates.push(path.join(pkgDir, pkgJson.bin));
        if (pkgJson.bin && typeof pkgJson.bin === "object") {
          for (const v of Object.values(pkgJson.bin)) {
            candidates.push(path.join(pkgDir, v));
          }
        }
        // heuristic extra paths
        candidates.push(path.join(pkgDir, "index.js"));
        candidates.push(path.join(pkgDir, "dist", "index.js"));
        let script = null;
        for (const c of candidates) {
          try {
            await fs.access(c);
            script = c;
            break;
          } catch {}
        }
        if (script) {
          proc = trySpawn("direct-node", process.execPath, [script, "."]);
        } else {
          spawnAttempts.push({
            label: "direct-node",
            ok: false,
            error: "No viable bin script found",
            candidates,
          });
        }
      } catch (e) {
        spawnAttempts.push({
          label: "direct-node",
          ok: false,
          error: "Resolution failed: " + String(e?.message || e),
        });
      }
    }
    if (!proc) {
      // Try in-process import fallback if module is installed
      let inprocOk = false;
      try {
        const require = createRequire(import.meta.url);
        const mod = require("@modelcontextprotocol/server-filesystem");
        if (mod && typeof mod.createServer === "function") {
          const server = new McpServer({
            name: "filesystem-server-inproc",
            version: "1.0.0",
            capabilities: { tools: {}, resources: {} },
          });
          const transport = new StreamableHTTPServerTransport({
            path: `/mcp/${id}`,
          });
          await server.connect(transport);
          sessionServers.set(id, {
            server,
            transport,
            name,
            type: "filesystem-inproc",
            spawnAttempts,
            baseUrl: null,
            note: "Using in-process imported filesystem server; tools proxied locally.",
          });
          console.log("[MCP] created filesystem-inproc server", id, name);
          inprocOk = true;
          return res
            .status(200)
            .json({
              server: {
                id,
                name,
                type: "filesystem-inproc",
                path: `/mcp/${id}`,
                baseUrl: null,
                attempts: spawnAttempts,
                note: "In-process import fallback active.",
              },
            });
        }
      } catch {}
      if (!inprocOk) {
        // Degraded mode
        const server = new McpServer({
          name: "filesystem-server-degraded",
          version: "1.0.0",
          capabilities: { tools: {}, resources: {} },
        });
        const transport = new StreamableHTTPServerTransport({
          path: `/mcp/${id}`,
        });
        await server.connect(transport);
        sessionServers.set(id, {
          server,
          transport,
          name,
          type: "filesystem-degraded",
          spawnAttempts,
          baseUrl: null,
          warning:
            "All spawn attempts failed; static in-process file tools active.",
        });
        console.log("[MCP] created filesystem-degraded server", id, name);
        return res
          .status(200)
          .json({
            server: {
              id,
              name,
              type: "filesystem-degraded",
              path: `/mcp/${id}`,
              baseUrl: null,
              warning:
                "All spawn attempts failed; static in-process file tools active.",
              attempts: spawnAttempts,
            },
          });
      }
    }
    let started = false;
    let stderrBuf = "";
    let stdoutBuf = "";
    const birth = Date.now();
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      if (!started && /"root"|read_file|list_directory/.test(stdoutBuf))
        started = true;
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (/Error|ENOENT|EACCES|ECONNREFUSED/i.test(text))
        console.warn("[filesystem-mcp][stderr]", text.trim());
    });
    proc.on("exit", (code) => {
      console.log(
        "[filesystem-mcp] process exited",
        code,
        "label",
        proc._spawnLabel
      );
      const lifespan = Date.now() - birth;
      if (lifespan < 2000 && !started) {
        // Convert to degraded if process died immediately
        for (const [sid, entry] of sessionServers.entries()) {
          if (entry.proc === proc && entry.type === "filesystem") {
            console.warn(
              "[filesystem-mcp] external process exited too quickly; switching to degraded for server",
              sid
            );
            entry.type = "filesystem-degraded";
            entry.warning =
              "External process exited immediately; degraded static tools active.";
            entry.spawnAttempts = spawnAttempts;
            entry.stderr = stderrBuf.slice(-4000);
            entry.stdout = stdoutBuf.slice(-4000);
          }
        }
      }
    });
    proc.on("error", (err) => {
      console.error("[filesystem-mcp] spawn error", err);
    });
    // Create a local MCP client server wrapper to expose tools list via our HTTP transport
    const server = new McpServer({
      name: "filesystem-server",
      version: "1.0.0",
      capabilities: { tools: {}, resources: {} },
    });
    const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
    await server.connect(transport);
    // We do NOT register our own tools; external server is separate. We'll proxy its list.
    // Wrap external process with stdio JSON-RPC client (lazy init)
    let stdioClient = null;
    try {
      stdioClient = new StdioMcpClient(proc, { timeoutMs: 8000 });
    } catch (e) {
      console.warn("[filesystem-mcp] failed creating StdioMcpClient:", e);
    }
    sessionServers.set(id, {
      server,
      transport,
      name,
      type,
      proc,
      stdioClient,
      external: { command: cmd, args: fullArgs, cwd },
      baseUrl: null,
      stdout: () => stdoutBuf.slice(-4000),
      stderr: () => stderrBuf.slice(-4000),
    });
    // Attempt readiness probe (non-blocking)
    (async () => {
      if (!stdioClient) return;
      const ready = await waitForReady(stdioClient).catch(() => false);
      if (!ready) {
        console.warn(
          "[filesystem-mcp] readiness probe timed out; tools may be unavailable yet"
        );
      } else {
        console.log("[filesystem-mcp] external server reported tools list");
      }
    })();
    console.log("[MCP] created filesystem external server", id, name);
    return res.json({
      server: {
        id,
        name,
        type,
        path: `/mcp/${id}`,
        baseUrl: null,
        external: { command: cmd, args: fullArgs, cwd },
      },
    });
  }
  return res.status(400).json({ error: "Unsupported server type" });
});

app.get("/api/mcp/servers", (req, res) => {
  const servers = [...sessionServers.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    type: v.type,
    path: `/mcp/${id}`,
    baseUrl: v.baseUrl || null,
    warning: v.warning || null,
    attempts: v.spawnAttempts ? v.spawnAttempts.slice(-10) : undefined,
  }));
  return res.json({ servers });
});

// Diagnostics for a single server (spawn attempts, stderr/stdout buffers if captured later)
app.get("/api/mcp/servers/:id/diagnostics", (req, res) => {
  const { id } = req.params;
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: "Server not found" });
  return res.json({
    id,
    name: entry.name,
    type: entry.type,
    warning: entry.warning || null,
    attempts: entry.spawnAttempts || [],
    external: entry.external || null,
    stdout:
      typeof entry.stdout === "function"
        ? entry.stdout()
        : entry.stdout || null,
    stderr:
      typeof entry.stderr === "function"
        ? entry.stderr()
        : entry.stderr || null,
  });
});

app.delete("/api/mcp/servers/:id", (req, res) => {
  const { id } = req.params || {};
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  try {
    entry.transport.close?.();
  } catch {}
  sessionServers.delete(id);
  return res.json({ ok: true });
});

app.get("/api/mcp/servers/:id/tools", async (req, res) => {
  const { id } = req.params || {};
  const entry = sessionServers.get(id);
  if (!entry) {
    console.warn(
      "[MCP] tools request for missing server id",
      id,
      "current size",
      sessionServers.size
    );
    return res.status(404).json({ error: "Server not found" });
  }
  if (entry.type === "embedded") {
    const tools = Object.values(TOOL_DEFS).map((def) => ({
      name: def.name,
      description: def.description,
    }));
    return res.json({ tools });
  }
  if (entry.type === "filesystem") {
    // Use JSON-RPC tools/list via StdioMcpClient
    const client = entry.stdioClient;
    if (!client) {
      return res
        .status(500)
        .json({ error: "MCP stdio client not available (spawn failure?)" });
    }
    try {
      const tools = await client.listTools({ forceRefresh: true });
      return res.json({ tools });
    } catch (e) {
      console.warn("[MCP] tools/list error via stdio client:", e);
      return res.json({
        tools: [],
        warning:
          "Failed JSON-RPC tools/list; no fallback static list (removed).",
      });
    }
  }
  if (entry.type === "filesystem-degraded") {
    return res.json({
      tools: [],
      warning: "Process spawn failed; degraded mode without static tool list.",
    });
  }
  if (entry.type === "filesystem-inproc") {
    return res.json({
      tools: Object.values(TOOL_DEFS).map((def) => ({
        name: def.name,
        description: def.description,
      })),
      note: "In-process fallback exposing dynamic registry tools only.",
    });
  }
  return res.status(400).json({ error: "Unsupported server type" });
});

app.post("/api/mcp/servers/:id/tool-call", async (req, res) => {
  const { id } = req.params || {};
  const { toolName, tool, arguments: args = {} } = req.body || {};
  const name = toolName || tool;
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: "Server not found" });
  // If external filesystem server, prefer JSON-RPC call
  if (entry.type === "filesystem") {
    const client = entry.stdioClient;
    if (!client)
      return res
        .status(500)
        .json({ error: "Missing stdio client for external server" });
    try {
      const result = await client.callTool(name, args || {});
      return res.json({ result, tool: name, transport: "json-rpc" });
    } catch (e) {
      console.warn(
        "[MCP] tools/call JSON-RPC failed; attempting local fallback:",
        e
      );
      // Fallback to local TOOL_DEFS if available
      const def = TOOL_DEFS[name];
      if (!def)
        return res
          .status(500)
          .json({
            error: "JSON-RPC call failed and no local fallback tool",
            details: String(e?.message || e),
          });
      try {
        const r = await def.handler(args || {});
        return res.json({ result: r, tool: name, transport: "fallback-local" });
      } catch (e2) {
        return res
          .status(500)
          .json({
            error: "Both JSON-RPC and fallback local handler failed",
            details: String(e2?.message || e2),
          });
      }
    }
  } else {
    // Local embedded or degraded/inproc: use TOOL_DEFS directly
    const def = TOOL_DEFS[name];
    if (!def) return res.status(404).json({ error: "Tool not found" });
    try {
      const r = await def.handler(args || {});
      return res.json({ result: r, tool: name, transport: "local" });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }
});

// ---------------- Anthropic basic streaming proxy ------------------
// SSE endpoint: /anthropic/chat { prompt, model?, max_tokens? }
app.post("/anthropic/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const {
    prompt,
    model: requestedModel,
    max_tokens = 512,
    sessionId,
  } = req.body || {};
  const defaultModel =
    process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  let model = requestedModel || defaultModel;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Invalid prompt" });
  }
  // Prepend memory context if provided
  const memoryMessages = sessionId ? buildMemoryContext(sessionId) : [];
  if (sessionId) {
    // Store user message before model call
    storeMemoryMessage(sessionId, "user", prompt);
  }
  let aggregatedAssistant = "";
  if (!apiKey) {
    // Mock stream fallback for local dev without key
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const fake = [
      "Mock response: no ANTHROPIC_API_KEY set.",
      "Set the key to receive real Claude streaming tokens.",
    ];
    for (const chunk of fake) {
      res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      await new Promise((r) => setTimeout(r, 300));
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  try {
    async function callAnthropic(modelName) {
      return await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens,
          messages: memoryMessages.concat([{ role: "user", content: prompt }]),
          stream: true,
        }),
      });
    }
    let upstream = await callAnthropic(model);
    if (upstream.status === 404) {
      const tried = [model];
      const fallbacks = [
        "claude-3-5-sonnet-latest",
        "claude-3-5-haiku-latest",
        "claude-3-opus-latest",
      ];
      for (const fb of fallbacks) {
        if (tried.includes(fb)) continue;
        const attempt = await callAnthropic(fb);
        if (attempt.ok) {
          upstream = attempt;
          model = fb;
          break;
        }
        tried.push(fb);
      }
    }
    if (!upstream.ok || !upstream.body) {
      let details = "";
      try {
        details = await upstream.text();
      } catch {}
      return res
        .status(upstream.status)
        .json({
          error: `Anthropic upstream error ${upstream.status}`,
          details,
        });
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const reader = upstream.body.getReader();
    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
      try {
        reader.cancel();
      } catch {}
    });
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (cancelled) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line === "data: [DONE]") {
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        if (!line.startsWith("data:")) continue;
        try {
          const payload = JSON.parse(line.slice(5));
          const delta =
            payload?.delta?.text ||
            payload?.content_block?.text ||
            payload?.text ||
            (payload?.type === "content_block_delta" &&
            payload?.delta?.type === "text_delta"
              ? payload?.delta?.text
              : "");
          if (delta) {
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            if (sessionId) {
              // Accumulate assistant text for memory after stream completes
              aggregatedAssistant += delta;
            }
          }
        } catch {}
      }
    }
    if (sessionId && aggregatedAssistant.trim()) {
      storeMemoryMessage(sessionId, "assistant", aggregatedAssistant.trim());
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Proxy failure", details: String(e?.message || e) });
  }
});

// ---------------- Anthropic tool-aware streaming (multi-turn) -------------
// Emits structured events: model_used, tool_use, tool_result, tool_error, assistant_text, done
// Strategy: iterative non-stream Anthropic calls to capture tool_use blocks; final answer streamed in chunks.
app.post("/anthropic/ai/chat-stream", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const {
    prompt,
    model: requestedModel,
    sessionId,
    max_iterations = 5,
  } = req.body || {};
  const defaultModel =
    process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  let model = requestedModel || defaultModel;
  if (typeof prompt !== "string" || !prompt.trim())
    return res.status(400).json({ error: "Invalid prompt" });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!apiKey) {
    send({ type: "model_used", model: "mock-anthropic" });
    send({
      type: "assistant_text",
      text: "Mock (no key). " + prompt.slice(0, 160),
    });
    send({ type: "done" });
    return res.end();
  }

  if (sessionId) storeMemoryMessage(sessionId, "user", prompt);
  const tools = buildAnthropicTools();
  const toolListForSystem = Object.values(TOOL_DEFS)
    .map((def) => `- ${def.name}: ${def.description}`)
    .join("\n");
  const system = `You are a helpful assistant.
You currently have access to the following runtime tools (enumerate ONLY when asked):\n${toolListForSystem || "- (no tools registered)"}\nInstructions:\n- When needing external data (weather, URLs, filesystem), invoke appropriate tool with correct arguments.\n- After receiving tool results, incorporate them faithfully without fabrication.`;
  let messages = (sessionId ? buildMemoryContext(sessionId) : []).concat([
    { role: "user", content: prompt },
  ]);

  async function anthropicOnce(currentModel) {
    const body = {
      model: currentModel,
      max_tokens: 512,
      system,
      messages,
      tools,
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (r.status === 404) {
        const fallbacks = [
          "claude-3-5-sonnet-latest",
          "claude-3-5-haiku-latest",
          "claude-3-opus-latest",
        ];
        for (const fb of fallbacks) {
          if (fb === currentModel) continue;
          const r2 = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...body, model: fb }),
          });
          if (r2.ok) {
            model = fb;
            return await r2.json();
          }
        }
      }
      const txt = await r.text().catch(() => "");
      throw new Error(
        `Anthropic upstream error ${r.status} ${txt.slice(0, 160)}`
      );
    }
    return await r.json();
  }

  send({ type: "model_used", model });
  let finalText = "";
  for (let iter = 0; iter < max_iterations; iter++) {
    let response;
    try {
      response = await anthropicOnce(model);
    } catch (e) {
      send({ type: "error", error: String(e?.message || e) });
      break;
    }
    const contentBlocks = response.content || [];
    const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
    const textBlocks = contentBlocks.filter((b) => b.type === "text");
    // If there are tool uses, execute them then append results and loop
    if (toolUses.length) {
      // Append tool_use blocks (assistant role)
      messages.push({ role: "assistant", content: contentBlocks });
      const collectedResults = [];
      for (const t of toolUses) {
        const toolName = t.name;
        const toolArgs = t.input || {};
        const toolId = t.id || t.tool_use_id || `${toolName}-${Date.now()}`;
        send({
          type: "tool_use",
          tool: toolName,
          args: toolArgs,
          id: toolId,
          iteration: iter,
        });
        const def = TOOL_DEFS[toolName];
        if (!def) {
          send({
            type: "tool_error",
            tool: toolName,
            error: "Tool not registered",
          });
          continue;
        }
        try {
          const result = await def.handler(toolArgs);
          // result.content is an array of blocks; convert to string snippet
          const textOut = Array.isArray(result?.content)
            ? result.content.map((c) => c.text || "").join("\n")
            : JSON.stringify(result);
          send({
            type: "tool_result",
            tool: toolName,
            id: toolId,
            output: textOut.slice(0, 4000),
          });
          collectedResults.push({
            type: "tool_result",
            tool_use_id: toolId,
            content: [{ type: "text", text: textOut.slice(0, 8000) }],
          });
        } catch (err) {
          send({
            type: "tool_error",
            tool: toolName,
            id: toolId,
            error: String(err?.message || err),
          });
        }
      }
      if (collectedResults.length) {
        // Anthropic requires tool_result blocks inside a user role message
        messages.push({ role: "user", content: collectedResults });
      }
      // Continue loop to let model observe tool results
      continue;
    }
    // No tool uses: finalize with text
    if (textBlocks.length) {
      finalText = textBlocks.map((tb) => tb.text).join("\n");
      // Stream in pseudo-chunks for client consistency
      const chunkSize = 200;
      let i = 0;
      while (i < finalText.length) {
        send({
          type: "assistant_text",
          text: finalText.slice(i, i + chunkSize),
        });
        i += chunkSize;
      }
      break;
    } else {
      // If no text and no tools, we are done
      break;
    }
  }
  if (sessionId && finalText.trim())
    storeMemoryMessage(sessionId, "assistant", finalText.trim());
  send({ type: "done", final: finalText.slice(0, 8000) });
  return res.end();
});

// Debug endpoint for local Node server: show Anthropic tool schema that would be sent
app.get("/anthropic/debug/tools", (req, res) => {
  try {
    // buildAnthropicTools maps registered TOOL_DEFS to Anthropic schema
    const tools = buildAnthropicTools();
    // Also return current runtime TOOL_DEFS keys for inspection
    const runtimeToolNames = Object.keys(TOOL_DEFS || {});
    return res.json({ ok: true, tools, runtimeToolNames });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Anthropic Models listing -> /anthropic/models (diagnostic helper)
app.get("/anthropic/models", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({
      error: "Failed to list models",
      details: String(e?.message || e),
    });
  }
});

// Allow port override for cloud platforms (Render, Railway, etc.)
const PORT = process.env.PORT || 3100;

// ---------------------- Anthropic tool-calling endpoint -------------------
// Accepts { prompt, model?, max_iterations? } and invokes Claude with tools.
// Requires ANTHROPIC_API_KEY. Uses the static forecast tool when appropriate.
app.post("/anthropic/ai/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mockMode = process.env.ANTHROPIC_MOCK === "1" || !apiKey;
  if (!apiKey && !mockMode)
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  const {
    prompt,
    model: requestedModel = process.env.ANTHROPIC_MODEL ||
      "claude-3-5-sonnet-latest",
    max_iterations = 3,
    sessionId,
  } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim())
    return res.status(400).json({ error: "Invalid prompt" });

  // Build Anthropic tool schema
  const tools = buildAnthropicTools();
  let currentModel = requestedModel;
  const steps = [];
  // Represent user prompt as content block array for consistency
  const messages = (sessionId ? buildMemoryContext(sessionId) : []).concat([
    { role: "user", content: [{ type: "text", text: prompt }] },
  ]);
  if (sessionId) storeMemoryMessage(sessionId, "user", prompt);
  // Dynamic system prompt: enumerate runtime tools for capability questions
  const toolListForSystem = Object.values(TOOL_DEFS)
    .map((def) => `- ${def.name}: ${def.description}`)
    .join("\n");
  const system = `You are a helpful assistant.
You currently have access to the following runtime tools (enumerate them ONLY when the user asks what tools/capabilities you have):\n${toolListForSystem || "- (no tools registered)"}\nIf the user:
For capability/tool questions: list ONLY the tools above with brief descriptions; do NOT invent tools. For all other queries, reply normally. Keep answers concise and relevant.`;
  let finalText = "";

  async function anthropicCall(toolResults = []) {
    // Anthropic expects messages with role user/assistant only. Tool results are passed via content blocks of type 'tool_result'.
    const body = {
      model: currentModel,
      max_tokens: 512,
      system,
      messages: messages.concat(toolResults),
      tools,
      // Use "auto" tool choice implicitly; Anthropic will decide
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // Retry fallbacks on 404 model not found
      if (r.status === 404 && /not_found_error/.test(await r.clone().text())) {
        const tried = [currentModel];
        const candidates = [
          "claude-3-5-sonnet-latest",
          "claude-3-5-haiku-latest",
          "claude-3-opus-latest",
        ].filter((m) => !tried.includes(m));
        for (const cand of candidates) {
          const r2 = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...body, model: cand }),
          });
          if (r2.ok) {
            currentModel = cand; // update outer variable so response JSON reflects working model
            return await r2.json();
          }
        }
      }
      let details = "";
      try {
        details = await r.text();
      } catch {}
      throw new Error(`Anthropic upstream error ${r.status}: ${details}`);
    }
    return await r.json();
  }

  // Mock path: directly decide whether to call tool
  if (mockMode) {
    const steps = [];
    let finalText = "";
    return res.json({
      text: "Anthropic API key missing (mock mode). Set ANTHROPIC_API_KEY on the server to receive real Claude responses.",
      steps,
      model: "mock-anthropic",
      mode: "anthropic-mock",
    });
  }

  try {
    for (let i = 0; i < max_iterations; i++) {
      const response = await anthropicCall();
      const contentBlocks = response.content || [];
      if (contentBlocks.length) {
        messages.push({ role: "assistant", content: contentBlocks });
        const textParts = contentBlocks
          .filter((c) => c.type === "text")
          .map((t) => t.text)
          .join("\n")
          .trim();
        if (textParts) finalText = textParts;
      }
      break; // tools removed; single iteration
    }
    return res.json({
      text: finalText,
      steps,
      model: currentModel,
      mode: "anthropic-tool-assisted",
      memory: sessionId ? { sessionId } : undefined,
    });
  } catch (e) {
    console.error("[anthropic/ai/chat] failure:", e);
    return res
      .status(500)
      .json({
        error: "Anthropic tool orchestration failed",
        details: String(e?.message || e),
      });
  }
});

app.listen(PORT, () => {
  const originDisplay = ALLOWED_ORIGINS.includes("*")
    ? "*"
    : ALLOWED_ORIGINS.join(", ");
  console.log(
    `MCP Streamable HTTP Server listening at http://localhost:${PORT} (allowed origins: ${originDisplay})`
  );
});

// ---------------------- Runtime tool registration endpoints ------------------
// Simple admin endpoints to register proxy tools at runtime.
// POST /admin/tools/register
//   body: { name, description, inputs: { key: 'string'|'number'|'boolean' }, invokeUrl }
// GET /admin/tools -> list currently registered tool names
// DELETE /admin/tools/:name -> remove from registry (affects new sessions)

app.post("/admin/tools/register", express.json(), async (req, res) => {
  const { name, description, inputs = {}, invokeUrl } = req.body || {};
  if (!name || !invokeUrl)
    return res.status(400).json({ error: "Missing name or invokeUrl" });
  try {
    // Build a zod object schema from inputs map
    const shape = {};
    for (const [k, t] of Object.entries(inputs || {})) {
      if (t === "string") shape[k] = z.string();
      else if (t === "number") shape[k] = z.number();
      else if (t === "boolean") shape[k] = z.boolean();
      else shape[k] = z.any();
    }
    const inputSchema = z.object(shape);

    // Create a proxy handler that forwards args to the provided invokeUrl
    const handler = async (args = {}) => {
      try {
        const r = await fetch(invokeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        const text = await r.text();
        // Try parse JSON to make nicer output
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const out = parsed
          ? typeof parsed === "string"
            ? parsed
            : JSON.stringify(parsed)
          : text;
        return { content: [{ type: "text", text: String(out) }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Invocation error: ${String(e?.message || e)}`,
            },
          ],
        };
      }
    };

    const def = { name, description: description || "", inputSchema, handler };
    addTool(def);

    // Register on active session servers so new tools are available immediately
    for (const srv of sessionServers.values()) {
      try {
        srv.tool(def.name, def.description, def.inputSchema, def.handler);
      } catch (err) {
        /* ignore per-server register errors */
      }
    }

    return res.json({ ok: true, tool: name });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/admin/tools", (req, res) => {
  try {
    return res.json({ tools: Object.keys(TOOL_DEFS) });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.delete("/admin/tools/:name", (req, res) => {
  const { name } = req.params || {};
  if (!name) return res.status(400).json({ error: "Missing name" });
  const ok = removeTool(name);
  return res.json({ ok, removed: name });
});

// Tool usage log endpoint (in-memory; resets on server restart)
app.get("/admin/tools/usage", (req, res) => {
  try {
    const log = getToolUsageLog();
    return res.json({ entries: log.slice(-200) }); // cap size
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Optional export for serverless adapters or test harnesses
export { app };
