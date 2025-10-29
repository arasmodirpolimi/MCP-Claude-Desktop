// server.js
// Make sure your package.json has: { "type": "module" }

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools, TOOL_DEFS, addTool, removeTool, buildAnthropicTools, getCurrentWeatherFn, getToolUsageLog } from "./registerTools.js";
import { z } from 'zod';
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
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'));
    },
    credentials: true
  })
);

// ---------------- MCP session management endpoints -----------------
// Maintain per-session MCP servers so tools registered dynamically are isolated per browser tab.
const sessionServers = new Map(); // sessionId -> { server, transport }

app.post('/api/mcp/servers', async (req, res) => {
  const { name = 'default', baseUrl } = req.body || {};
  // For local embedded server, ignore baseUrl and create new instance
  const id = randomUUID();
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
  await server.connect(transport);
  sessionServers.set(id, { server, transport, name });
  return res.json({ server: { id, name, path: `/mcp/${id}` } });
});

app.get('/api/mcp/servers', (req, res) => {
  const servers = [...sessionServers.entries()].map(([id, v]) => ({ id, name: v.name, path: `/mcp/${id}` }));
  return res.json({ servers });
});

app.delete('/api/mcp/servers/:id', (req, res) => {
  const { id } = req.params || {};
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  try { entry.transport.close?.(); } catch {}
  sessionServers.delete(id);
  return res.json({ ok: true });
});

app.get('/api/mcp/servers/:id/tools', (req, res) => {
  const { id } = req.params || {};
  if (!sessionServers.has(id)) return res.status(404).json({ error: 'Server not found' });
  const tools = Object.values(TOOL_DEFS).map(def => ({ name: def.name, description: def.description }));
  return res.json({ tools });
});

app.post('/api/mcp/servers/:id/tool-call', async (req, res) => {
  const { id } = req.params || {};
  const { toolName, arguments: args = {} } = req.body || {};
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: 'Server not found' });
  const def = TOOL_DEFS[toolName];
  if (!def) return res.status(404).json({ error: 'Tool not found' });
  try {
    const r = await def.handler(args || {});
    return res.json({ result: r });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------------- Anthropic basic streaming proxy ------------------
// SSE endpoint: /anthropic/chat { prompt, model?, max_tokens? }
app.post('/anthropic/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { prompt, model: requestedModel, max_tokens = 512 } = req.body || {};
  const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  let model = requestedModel || defaultModel;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }
  if (!apiKey) {
    // Mock stream fallback for local dev without key
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.flushHeaders?.();
    const fake = [ 'Mock response: no ANTHROPIC_API_KEY set.', 'Set the key to receive real Claude streaming tokens.' ];
    for (const chunk of fake) {
      res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      await new Promise(r=>setTimeout(r, 300));
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  try {
    async function callAnthropic(modelName) {
      return await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: modelName, max_tokens, messages: [{ role: 'user', content: prompt }], stream: true })
      });
    }
    let upstream = await callAnthropic(model);
    if (upstream.status === 404) {
      const tried = [model];
      const fallbacks = [ 'claude-3-5-sonnet-latest','claude-3-5-haiku-latest','claude-3-opus-latest' ];
      for (const fb of fallbacks) {
        if (tried.includes(fb)) continue;
        const attempt = await callAnthropic(fb);
        if (attempt.ok) { upstream = attempt; model = fb; break; }
        tried.push(fb);
      }
    }
    if (!upstream.ok || !upstream.body) {
      let details = '';
      try { details = await upstream.text(); } catch {}
      return res.status(upstream.status).json({ error: `Anthropic upstream error ${upstream.status}`, details });
    }
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.flushHeaders?.();
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/); buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        if (line === 'data: [DONE]') { res.write('data: [DONE]\n\n'); return res.end(); }
        if (!line.startsWith('data:')) continue;
        try {
          const payload = JSON.parse(line.slice(5));
          const delta = payload?.delta?.text || payload?.content_block?.text || payload?.text || (payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta' ? payload?.delta?.text : '');
          if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        } catch {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Proxy failure', details: String(e?.message || e) });
  }
});

// ---------------- Anthropic tool-aware streaming (simplified) -------------
// Client expects structured events; here we only stream text as assistant_text.
// TODO: Integrate real tool orchestration if needed (currently handled client-side / non-stream endpoint).
app.post('/anthropic/ai/chat-stream', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { prompt, model: requestedModel } = req.body || {};
  const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  let model = requestedModel || defaultModel;
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Invalid prompt' });

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!apiKey) {
    // Mock deterministic response
    send({ type: 'assistant_text', text: 'Mock (no API key): ' + prompt.slice(0,80) });
    send({ type: 'done' });
    return res.end();
  }
  try {
    async function call(modelName) {
      return await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelName, max_tokens: 512, messages: [{ role: 'user', content: prompt }], stream: true })
      });
    }
    let upstream = await call(model);
    if (upstream.status === 404) {
      const fallbacks = [ 'claude-3-5-sonnet-latest','claude-3-5-haiku-latest','claude-3-opus-latest' ];
      for (const fb of fallbacks) {
        if (fb === model) continue;
        const attempt = await call(fb);
        if (attempt.ok) { model = fb; upstream = attempt; break; }
      }
    }
    if (!upstream.ok || !upstream.body) {
      let details=''; try { details = await upstream.text(); } catch {}
      send({ type: 'error', error: `Anthropic upstream error ${upstream.status}`, details: details.slice(0,160) });
      send({ type: 'done' });
      return res.end();
    }
    send({ type: 'model_used', model });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/); buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        if (line === 'data: [DONE]') { send({ type: 'done' }); return res.end(); }
        if (!line.startsWith('data:')) continue;
        try {
          const payload = JSON.parse(line.slice(5));
          // Anthropic streaming payload shapes vary; extract text deltas
            const delta = payload?.delta?.text || payload?.content_block?.text || payload?.text || (payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta' ? payload?.delta?.text : '');
          if (delta) send({ type: 'assistant_text', text: delta });
        } catch { /* ignore line parse */ }
      }
    }
    send({ type: 'done' });
    res.end();
  } catch (e) {
    send({ type: 'error', error: String(e?.message || e) });
    send({ type: 'done' });
    res.end();
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

// Allow port override for cloud platforms (Render, Railway, etc.)
const PORT = process.env.PORT || 3100;

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
        const tried = [currentModel];
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
    console.error('[anthropic/ai/chat] failure:', e);
    return res.status(500).json({ error: 'Anthropic tool orchestration failed', details: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  const originDisplay = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.join(', ');
  console.log(`MCP Streamable HTTP Server listening at http://localhost:${PORT} (allowed origins: ${originDisplay})`);
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

// Tool usage log endpoint (in-memory; resets on server restart)
app.get('/admin/tools/usage', (req, res) => {
  try {
    const log = getToolUsageLog();
    return res.json({ entries: log.slice(-200) }); // cap size
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Optional export for serverless adapters or test harnesses
export { app };
