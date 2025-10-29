// server.js
// Make sure your package.json has: { "type": "module" }

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, TOOL_DEFS, addTool, removeTool, buildOpenAiTools, buildAnthropicTools, getCurrentWeatherFn, getToolUsageLog, clearToolUsageLog } from "./registerTools.js";
import { z } from 'zod';
import OpenAI from "openai";
import cors from "cors";

const SEP = "---";
function createServer() {
  const server = new McpServer({ name: "weather-server", version: "1.0.0", capabilities: { tools: {}, resources: {} } });
  registerTools(server);
  return server;
}

const app = express();
// Custom tolerant JSON parser (replaces express.json()) so we can repair common escaping mistakes
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return next();
  if (!['POST','PUT','PATCH'].includes(req.method)) return next();

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    req.rawBody = raw;
    if (!raw.trim()) return next();
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
    let parsed = tryParse(raw);
    if (!parsed && raw.startsWith('\\{')) {
      // User likely sent escaped JSON like \{"jsonrpc"...} from PowerShell quoting mistakes.
      const repaired = raw.replace(/^\\+/, '').replace(/\\"/g, '"');
      parsed = tryParse(repaired);
      if (parsed) console.warn('[JSON parser] repaired leading backslash-escaped JSON');
    }
    if (!parsed && /\\"jsonrpc\\"/.test(raw)) {
      // Attempt broad unescape of backslash-escaped quotes (but keep escaped backslashes first)
      const repaired2 = raw.replace(/\\"/g, '"');
      parsed = tryParse(repaired2);
      if (parsed) console.warn('[JSON parser] repaired quote escaping in JSON');
    }
    if (!parsed) {
      return res.status(400).json({
        error: 'Invalid JSON',
        details: 'Could not parse request body as JSON',
        hint: 'Remove unnecessary backslashes. Example: {"jsonrpc":"2.0",...} (not \\{"jsonrpc"...})',
        rawPreview: raw.slice(0, 120)
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
const ALLOWED_ORIGIN_RAW = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_RAW.split(',').map(o => o.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow non-browser requests (like curl / server-side) which send no Origin
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      console.warn(`[CORS] Blocked origin ${origin}. Allowed: ${ALLOWED_ORIGINS.join(' | ')}`);
      return cb(new Error('CORS origin not allowed'), false);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "mcp-session-id", "mcp-protocol-version"],
    exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
  })
);

// Clean 204 for preflight
app.options("/mcp", (req, res) => res.sendStatus(204));

// sessionId -> transport
const transports = new Map();
// sessionId -> server (active McpServer instances created for sessions)
const sessionServers = new Map();

app.post("/mcp", async (req, res) => {
  let transport;
  const sessionId = req.header("mcp-session-id") ?? undefined;
  console.log("sessionId:", sessionId);

  if (sessionId) transport = transports.get(sessionId);
  console.log("sessionId 1 :", sessionId);

  if (!transport) {
    // First request of a session: build a brand-new transport and bind it to the map
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onSessionInitialized: (sid) => {
        transports.set(sid, t);
      },
      onSessionTerminated: (sid) => {
        transports.delete(sid);
        // also remove any server mapping for this session
        sessionServers.delete(sid);
      },
    });
    transport = t;

    const server = createServer();
    await server.connect(transport);
    // When the transport later initializes a session id it will trigger onSessionInitialized;
    // however we also want to capture the server associated with this transport when the
    // transport emits a session id. Listen for the same callback by wrapping the transport
    // onSessionInitialized to also map sid -> server.
    // (StreamableHTTPServerTransport will call our provided onSessionInitialized above.)
    // To ensure the mapping exists, we poll once for any existing sessions already set on the transport.
    // Note: the transport will call onSessionInitialized with the chosen sid; we update sessionServers in that callback below.
    // Monkey-patch: attach a listener to the transport instance to capture sid -> server mapping when initialized.
    const originalInit = t._onSessionInitialized;
    // If transport exposes a public hook, use that; otherwise rely on the fact we set onSessionInitialized above.
    // We'll also attempt to read any active session ids from the transport via t.sessionId if present.
    try {
      if (typeof t.sessionId === 'string' && t.sessionId) {
        sessionServers.set(t.sessionId, server);
      }
    } catch {}
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(405).end(); // No session for SSE
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(404).end();

  transports.delete(sessionId);
  await transport.handleRequest(req, res);
});

// ---------------------- Tool usage logs endpoints --------------------------
app.get('/logs/tools', (req, res) => {
  return res.json({ logs: getToolUsageLog() });
});
app.post('/logs/tools/clear', (req, res) => {
  clearToolUsageLog();
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Anthropic Streaming Proxy (Claude) -> /anthropic/chat
// Accepts { prompt, model?, max_tokens? } and streams tokens as SSE
// Requires process.env.ANTHROPIC_API_KEY (do NOT expose client key)
app.post("/anthropic/chat", async (req, res) => {
  console.log("[Anthropic proxy] incoming request body:", req.body);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[Anthropic proxy] missing API key");
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  }
  const { prompt, model: requestedModel, max_tokens = 1024 } = req.body || {};
  // Allow override via env ANTHROPIC_MODEL, fallback to request or a safe default
  const defaultModel =
    process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  let model = requestedModel || defaultModel;
  if (typeof prompt !== "string" || !prompt.trim()) {
    console.warn("[Anthropic proxy] invalid prompt");
    return res.status(400).json({ error: "Invalid prompt" });
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
          messages: [{ role: "user", content: prompt }],
          stream: true,
        }),
      });
    }

    let upstream = await callAnthropic(model);
    if (upstream.status === 404) {
      const tried = [model];
      const fallbacks = new Set();
      // Derived fallbacks
      if (/\d{8}$/.test(model)) {
        const noDate = model.replace(/-\d{8}$/, "");
        fallbacks.add(noDate);
        fallbacks.add(noDate + "-latest");
      } else if (!model.endsWith("-latest")) {
        fallbacks.add(model + "-latest");
      }
      // Additional known public model IDs (ordered by recency / breadth)
      [
        "claude-3-5-sonnet-latest",
        "claude-3-5-haiku-latest",
        "claude-3-opus-latest",
        "claude-3-sonnet-20240229",
        "claude-3-haiku-20240307",
        "claude-2.1",
        "claude-instant-1.2",
      ].forEach((m) => fallbacks.add(m));

      for (const fb of fallbacks) {
        if (tried.includes(fb)) continue;
        console.warn("[Anthropic proxy] retrying with fallback model:", fb);
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
      console.error(
        "[Anthropic proxy] upstream error status:",
        upstream.status,
        details
      );
      return res
        .status(upstream.status)
        .json({
          error: `Anthropic upstream error ${upstream.status}`,
          modelTried: model,
          details,
        });
    }
    console.log("[Anthropic proxy] streaming response started");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
          }
        } catch {
          /* ignore */
        }
      }
    }
    // finalize if upstream ends without [DONE]
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[Anthropic proxy] error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "Proxy failure", details: String(err?.message || err) });
    }
  }
});

// Debug endpoint for local Node server: show Anthropic tool schema that would be sent
app.get('/anthropic/debug/tools', (req, res) => {
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
    res
      .status(500)
      .json({
        error: "Failed to list models",
        details: String(e?.message || e),
      });
  }
});

// ---------------------------------------------------------------------------
// OpenAI Streaming Proxy -> /openai/chat
// Accepts { prompt, model?, max_tokens? } and streams choices[0].delta.content
app.post("/openai/chat", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Server missing OPENAI_API_KEY" });
  const { prompt, model = "gpt-4o-mini", max_tokens = 512 } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Invalid prompt" });
  }
  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        stream: true,
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return res
        .status(upstream.status)
        .json({ error: `OpenAI upstream error ${upstream.status}` });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
          const delta = payload?.choices?.[0]?.delta?.content;
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        } catch {
          /* ignore */
        }
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[OpenAI proxy] error:", err);
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Proxy failure", details: String(err?.message || err) });
  }
});

// Allow port override for cloud platforms (Render, Railway, etc.)
const PORT = process.env.PORT || 3100;
// ---------------------- LLM tool-calling endpoint --------------------------
const openaiApiKey = process.env.OPENAI_API_KEY;
let openAiClient = undefined;
if (openaiApiKey) {
  openAiClient = new OpenAI({ apiKey: openaiApiKey });
}

app.post('/ai/chat', async (req, res) => {
  const { prompt, model = 'gpt-4o-mini', max_iterations = 3 } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Invalid prompt' });
  const tools = buildOpenAiTools(); // now empty (no registered MCP tools)
  const steps = [];

  // Mock mode bypasses OpenAI API entirely
  const mockMode = process.env.OPENAI_MOCK === '1' || !openAiClient;
  if (mockMode) {
    // Simple heuristic: if prompt includes 'forecast' or any tool name, call the forecast tool
  // Removed unused variable toolInvoked
    if (/forecast|weather/i.test(prompt)) {
      const location = /for\s+([A-Za-z ,]+)/i.exec(prompt)?.[1]?.trim() || 'Unknown';
      try {
        const live = await getCurrentWeatherFn({ location });
        const out = `Current weather for ${live.location}: ${live.temperature ?? 'N/A'}°${live.unit === 'celsius' ? 'C' : 'F'} Wind ${live.windSpeed ?? 'N/A'} Direction ${live.windDirection ?? 'N/A'}`;
        steps.push({ type: 'live_weather', args: { location }, output: out });
        return res.json({ text: out, steps, model, mode: 'mock-live-weather' });
      } catch (e) {
        steps.push({ type: 'weather_error', error: String(e?.message || e) });
        return res.json({ text: 'Mock mode failed to fetch weather.', steps, model, mode: 'mock-error' });
      }
    }
    // No tool trigger
    return res.json({ text: 'Mock answer (no tool needed).', steps, model, mode: 'mock' });
  }

  const messages = [ { role: 'user', content: [ { type: 'text', text: prompt } ] } ];
  let finalText = '';
  try {
    for (let i = 0; i < max_iterations; i++) {
      const completion = await openAiClient.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto'
      });
      const choice = completion.choices[0];
      const assistantContent = choice.message?.content;
      const toolCalls = choice.message?.tool_calls || [];
      if (assistantContent) {
        messages.push({ role: 'assistant', content: assistantContent });
        finalText = assistantContent;
      }
      if (!toolCalls.length) break;
      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const def = TOOL_DEFS[toolName];
        if (!def) {
          steps.push({ type: 'tool_error', tool: toolName, error: 'Unknown tool' });
          messages.push({ role: 'assistant', content: `Tool ${toolName} is not available.` });
          continue;
        }
        let toolResult;
        console.log('[LLM TOOL CALL][OpenAI]', toolName, 'args=', args);
        try { toolResult = await def.handler(args); } catch (e) {
          const errMsg = String(e?.message || e);
          steps.push({ type: 'tool_error', tool: toolName, error: errMsg });
          messages.push({ role: 'assistant', content: `Error calling tool ${toolName}: ${errMsg}` });
          continue;
        }
        console.log('[LLM TOOL RESULT][OpenAI]', toolName, 'args=', args);
        const textOut = (toolResult.content || []).map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
        steps.push({ type: 'tool_call', tool: toolName, args, output: textOut });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: textOut });
        const follow = await openAiClient.chat.completions.create({ model, messages });
        const followText = follow.choices[0]?.message?.content;
        if (followText) {
          messages.push({ role: 'assistant', content: followText });
          finalText = followText;
        }
      }
    }
    return res.json({ text: finalText, steps, model, mode: 'tool-assisted' });
  } catch (e) {
    return res.status(500).json({ error: 'LLM tool orchestration failed', details: String(e?.message || e) });
  }
});

// ---------------------- Anthropic tool-calling endpoint -------------------
// Accepts { prompt, model?, max_iterations? } and invokes Claude with tools.
// Requires ANTHROPIC_API_KEY. Uses the static forecast tool when appropriate.
app.post('/anthropic/ai/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mockMode = process.env.ANTHROPIC_MOCK === '1' || !apiKey;
  if (!apiKey && !mockMode) return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY' });
  const { prompt, model: requestedModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest', max_iterations = 3 } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Invalid prompt' });

  // Build Anthropic tool schema
  const tools = buildAnthropicTools(); // includes get_current_weather
  let currentModel = requestedModel;
  const steps = [];
  // Represent user prompt as content block array for consistency
  const messages = [
    { role: 'user', content: [ { type: 'text', text: prompt } ] }
  ];
  const system = `You are a helpful assistant.
If the user:
 - asks for current weather: CALL get_current_weather (args: location, unit) then summarize.
 - asks to summarize / explain / extract info from an http(s) URL: CALL http_get with that URL (and set maxBytes to 30000 if long article) BEFORE answering, then write a concise answer using the fetched content. Do not fabricate details not in the fetched text.
For all other queries, reply normally. Always keep answers concise and relevant.`;
  let finalText = '';

  async function anthropicCall(toolResults=[]) {
    // Anthropic expects messages with role user/assistant only. Tool results are passed via content blocks of type 'tool_result'.
    const body = {
      model: currentModel,
      max_tokens: 512,
      system,
      messages: messages.concat(toolResults),
      tools,
      // Use "auto" tool choice implicitly; Anthropic will decide
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      // Retry fallbacks on 404 model not found
      if (r.status === 404 && /not_found_error/.test(await r.clone().text())) {
        const tried = [model];
        const candidates = [
          'claude-3-5-sonnet-latest',
          'claude-3-5-haiku-latest',
          'claude-3-opus-latest'
        ].filter(m => !tried.includes(m));
        for (const cand of candidates) {
          const r2 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify({ ...body, model: cand })
          });
          if (r2.ok) {
            currentModel = cand; // update outer variable so response JSON reflects working model
            return await r2.json();
          }
        }
      }
      let details = '';
      try { details = await r.text(); } catch {}
      throw new Error(`Anthropic upstream error ${r.status}: ${details}`);
    }
    return await r.json();
  }

  // Mock path: directly decide whether to call tool
  if (mockMode) {
    const steps = [];
    let finalText = '';
    const needsWeather = /weather|forecast/i.test(prompt);
    if (needsWeather) {
      // crude location extraction
      const locMatch = /weather (in|for) ([A-Za-z ,]+)/i.exec(prompt);
      const locationRaw = locMatch?.[2]?.trim() || 'Unknown';
      const location = locationRaw.replace(/[?.!]+$/, '');
      try {
        const live = await getCurrentWeatherFn({ location });
        finalText = `Current weather for ${live.location}: ${live.temperature ?? 'N/A'}°${live.unit === 'celsius' ? 'C' : 'F'} Wind ${live.windSpeed ?? 'N/A'} Direction ${live.windDirection ?? 'N/A'}`;
        steps.push({ type: 'live_weather', args: { location }, output: finalText });
        return res.json({ text: finalText, steps, model: 'mock-anthropic', mode: 'anthropic-mock-live' });
      } catch (e) {
        steps.push({ type: 'weather_error', error: String(e?.message || e) });
        return res.json({ text: 'Mock Anthropic mode failed fetching weather.', steps, model: 'mock-anthropic', mode: 'anthropic-mock-error' });
      }
    }
  return res.json({ text: 'Anthropic API key missing (mock mode). Set ANTHROPIC_API_KEY on the server to receive real Claude responses.', steps, model: 'mock-anthropic', mode: 'anthropic-mock' });
  }

  try {
    for (let i = 0; i < max_iterations; i++) {
      const response = await anthropicCall();
      const contentBlocks = response.content || [];
      if (contentBlocks.length) {
        messages.push({ role: 'assistant', content: contentBlocks });
        const textParts = contentBlocks.filter(c => c.type === 'text').map(t => t.text).join('\n').trim();
        if (textParts) finalText = textParts;
      }
      break; // tools removed; single iteration
    }
  return res.json({ text: finalText, steps, model: currentModel, mode: 'anthropic-tool-assisted' });
  } catch (e) {
    return res.status(500).json({ error: 'Anthropic tool orchestration failed', details: String(e?.message || e) });
  }
});

// ---------------------- Anthropic tool-calling streaming SSE --------------
// Emits events: tool_use, tool_result, assistant_text, done
app.post('/anthropic/ai/chat-stream', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mockMode = process.env.ANTHROPIC_MOCK === '1' || !apiKey;
  if (!apiKey && !mockMode) return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY' });
  const { prompt, model: requestedModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest', max_iterations = 3 } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Invalid prompt' });
  // Initialize currentModel before logging to avoid ReferenceError
  let currentModel = requestedModel;
  console.log('[Anthropic stream] prompt:', prompt, 'model:', currentModel, 'mockMode:', mockMode);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const tools = buildAnthropicTools(); // includes get_current_weather + http_get
  // Use Anthropic content block format
  const messages = [ { role: 'user', content: [ { type: 'text', text: prompt } ] } ];
  const system = `You are a helpful assistant.
If the user needs current weather, CALL get_current_weather.
If the user wants a summary or information about a provided http(s) URL (e.g. 'summarize https://...'), first CALL http_get with that URL (increase maxBytes to 30000 for long articles) then produce the answer using ONLY the fetched content plus general common knowledge. If content appears truncated, note it briefly and still answer.
Otherwise, respond directly.`;
  let finalText = '';

  function send(eventObj) { try { res.write(`data: ${JSON.stringify(eventObj)}\n\n`); } catch {} }

  async function anthropicCall(extra=[]) {
    if (mockMode) {
      // Simulate a tool_use if query needs weather
      const needsWeather = /weather|forecast/i.test(prompt) && !extra.length;
      if (needsWeather) {
        return { content: [ { type: 'tool_use', id: 'mock_tool_1', name: 'get_current_weather', input: { location: 'Milan', unit: 'celsius' } } ] };
      }
  return { content: [ { type: 'text', text: 'Anthropic API key missing (mock mode). Set ANTHROPIC_API_KEY on the server to receive real Claude responses.' } ] };
    }
  const body = { model: currentModel, max_tokens: 512, system, messages: messages.concat(extra), tools };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      if (r.status === 404) {
        let errText=''; try{errText=await r.clone().text();}catch{}
        if (/not_found_error/.test(errText)) {
          const tried = [currentModel];
            const candidates = [ 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest' ].filter(c=>!tried.includes(c));
          for (const cand of candidates) {
            const r2 = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              body: JSON.stringify({ ...body, model: cand })
            });
              if (r2.ok) { currentModel = cand; return await r2.json(); }
          }
        }
      }
      let details=''; try{details=await r.text();}catch{}; throw new Error(`Anthropic upstream error ${r.status}: ${details}`);
    }
    return await r.json();
  }

  (async () => {
    try {
      for (let i=0;i<max_iterations;i++) {
        const response = await anthropicCall();
        const blocks = response.content || [];
        // Store assistant message with full blocks including tool_use so tool_result can reference ids
        if (blocks.length) {
          messages.push({ role: 'assistant', content: blocks });
          const textParts = blocks.filter(b=>b.type==='text').map(t=>t.text).join('\n').trim();
          if (textParts) {
            finalText = textParts;
            send({ type: 'assistant_text', text: textParts });
          }
        }
        const toolUses = blocks.filter(b=>b.type==='tool_use');
        if (!toolUses.length) break;
        const toolResultMessages = [];
        for (const tu of toolUses) {
          send({ type: 'tool_use', tool: tu.name, args: tu.input });
          const def = TOOL_DEFS[tu.name];
            if (!def) { send({ type: 'tool_error', tool: tu.name, error: 'Unknown tool' }); continue; }
          console.log('[LLM TOOL CALL][Anthropic-Stream]', tu.name, 'args=', tu.input);
          try {
            const result = await def.handler(tu.input||{});
            const outText = (result.content||[]).map(c=>c.type==='text'?c.text:JSON.stringify(c)).join('\n');
            send({ type: 'tool_result', tool: tu.name, output: outText });
            // Anthropic expects tool results as a new user message with tool_result block
            toolResultMessages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  content: outText
                }
              ]
            });
            console.log('[LLM TOOL RESULT][Anthropic-Stream]', tu.name, 'args=', tu.input);
          } catch (e) {
            send({ type: 'tool_error', tool: tu.name, error: String(e?.message||e) });
          }
        }
        if (!toolResultMessages.length) break;
        const follow = await anthropicCall(toolResultMessages);
        const followBlocks = follow.content||[];
        if (followBlocks.length) {
          messages.push({ role: 'assistant', content: followBlocks });
          const followText = followBlocks.filter(c=>c.type==='text').map(t=>t.text).join('\n').trim();
          if (followText) {
            finalText = followText;
            send({ type: 'assistant_text', text: followText });
          }
        }
        const followToolUses = (follow.content||[]).filter(c=>c.type==='tool_use');
        if (!followToolUses.length) break;
      }
      send({ type: 'done', text: finalText });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      send({ type: 'error', error: String(e?.message||e) });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  })();
});

app.listen(PORT, () => {
  const originDisplay = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.join(', ');
  console.log(
    `MCP Streamable HTTP Server listening at http://localhost:${PORT}/mcp (allowed origins: ${originDisplay})`
  );
});

// ---------------------- Runtime tool registration endpoints ------------------
// Simple admin endpoints to register proxy tools at runtime.
// POST /admin/tools/register
//   body: { name, description, inputs: { key: 'string'|'number'|'boolean' }, invokeUrl }
// GET /admin/tools -> list currently registered tool names
// DELETE /admin/tools/:name -> remove from registry (affects new sessions)

app.post('/admin/tools/register', express.json(), async (req, res) => {
  const { name, description, inputs = {}, invokeUrl } = req.body || {};
  if (!name || !invokeUrl) return res.status(400).json({ error: 'Missing name or invokeUrl' });
  try {
    // Build a zod object schema from inputs map
    const shape = {};
    for (const [k, t] of Object.entries(inputs || {})) {
      if (t === 'string') shape[k] = z.string();
      else if (t === 'number') shape[k] = z.number();
      else if (t === 'boolean') shape[k] = z.boolean();
      else shape[k] = z.any();
    }
    const inputSchema = z.object(shape);

    // Create a proxy handler that forwards args to the provided invokeUrl
    const handler = async (args = {}) => {
      try {
        const r = await fetch(invokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
        const text = await r.text();
        // Try parse JSON to make nicer output
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const out = parsed ? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed)) : text;
        return { content: [ { type: 'text', text: String(out) } ] };
      } catch (e) {
        return { content: [ { type: 'text', text: `Invocation error: ${String(e?.message || e)}` } ] };
      }
    };

    const def = { name, description: description || '', inputSchema, handler };
    addTool(def);

    // Register on active session servers so new tools are available immediately
    for (const srv of sessionServers.values()) {
      try { srv.tool(def.name, def.description, def.inputSchema, def.handler); } catch (err) { /* ignore per-server register errors */ }
    }

    return res.json({ ok: true, tool: name });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get('/admin/tools', (req, res) => {
  try { return res.json({ tools: Object.keys(TOOL_DEFS) }); } catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
});

app.delete('/admin/tools/:name', (req, res) => {
  const { name } = req.params || {};
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const ok = removeTool(name);
  return res.json({ ok, removed: name });
});

// Optional export for serverless adapters or test harnesses
export { app };
