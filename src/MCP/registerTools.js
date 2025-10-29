import { z } from 'zod';

// Tool usage log (in-memory). Each entry: { name, args, startedAt, finishedAt, error, summary }
const TOOL_USAGE_LOG = [];

// Mutable registry object kept for compatibility with existing imports that reference TOOL_DEFS
export const TOOL_DEFS = {};

// Programmatic APIs to manage tools at runtime
export function addTool(def) {
  if (!def || typeof def !== 'object') throw new Error('Invalid tool definition');
  if (!def.name || typeof def.name !== 'string') throw new Error('Tool definition must include a string `name`');
  TOOL_DEFS[def.name] = def;
  return def;
}

export function removeTool(name) {
  if (!name || typeof name !== 'string') return false;
  if (TOOL_DEFS[name]) { delete TOOL_DEFS[name]; return true; }
  return false;
}

export function listToolDefs() {
  return Object.values(TOOL_DEFS);
}

// Register the built-in get_current_weather tool using the dynamic API so it can be
// removed/replaced by calling removeTool/addTool at runtime if desired.
addTool({
  name: 'get_current_weather',
  description: 'Fetch current weather for a location using Open-Meteo (geocode + current conditions).',
  inputSchema: z.object({
    location: z.string().describe("Location name (e.g. 'Berlin' or 'Milan, Italy')"),
    unit: z.enum(['celsius','fahrenheit']).default('celsius').describe('Temperature unit preference')
  }),
  handler: async ({ location, unit = 'celsius' }) => {
    console.log('[TOOL CALL] get_current_weather invoked with', { location, unit });
    const startedAt = Date.now();
    let error; let result; let summary;
    try {
      result = await getCurrentWeatherFn({ location, unit });
      if (result.error) {
        error = result.error;
      }
      summary = result.error ? `Error: ${result.error}` : `${result.location}: ${result.temperature}°${unit === 'celsius' ? 'C' : 'F'} wind ${result.windSpeed ?? 'N/A'}`;
      console.log('[TOOL RESULT] get_current_weather success', { location, unit, summary });
      return { content: [ { type: 'text', text: summary } ] };
    } catch (e) {
      error = String(e?.message || e);
      summary = `Failure fetching weather for ${location}: ${error}`;
      console.warn('[TOOL ERROR] get_current_weather failed', { location, unit, error });
      return { content: [ { type: 'text', text: summary } ] };
    } finally {
      TOOL_USAGE_LOG.push({
        name: 'get_current_weather',
        args: { location, unit },
        startedAt,
        finishedAt: Date.now(),
        error,
        summary
      });
    }
  }
});

// Lightweight http_get tool for arbitrary GET requests. Exposes:
// { url: string, headers?: Record<string,string>, maxBytes?: number }
addTool({
  name: 'http_get',
  description: 'Fetch a URL (http/https) and return response text (truncated). Use this BEFORE summarizing or answering questions about a webpage; increase maxBytes for longer pages.',
  inputSchema: z.object({
    url: z.string().describe('URL to fetch (must be http or https)'),
    headers: z.record(z.string()).optional().describe('Optional headers object'),
    maxBytes: z.number().optional().describe('Max bytes to return (default 10000)')
  }),
  handler: async ({ url, headers = {}, maxBytes = 10000 }) => {
    const startedAt = Date.now();
    let error; let summary;
    try {
      if (typeof url !== 'string') throw new Error('Invalid url');
      const parsed = (() => { try { return new URL(url); } catch { return null; } })();
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs are allowed');

      // Perform the fetch; limit size by reading text and truncating
      const resp = await fetch(url, { method: 'GET', headers: headers || {} });
      const ct = resp.headers.get('content-type') || '';
      let text = await resp.text();
      if (typeof text === 'string' && text.length > maxBytes) {
        text = text.slice(0, maxBytes) + `\n...TRUNCATED (${text.length} bytes total)`;
      }
      summary = `HTTP ${resp.status} ${resp.statusText} (${ct.split(';')[0] || 'unknown'})`;
      return { content: [ { type: 'text', text: `--- ${summary} ---\n${text}` } ] };
    } catch (e) {
      error = String(e?.message || e);
      summary = `http_get error: ${error}`;
      return { content: [ { type: 'text', text: summary } ] };
    } finally {
      TOOL_USAGE_LOG.push({ name: 'http_get', args: { url, maxBytes }, startedAt, finishedAt: Date.now(), error: error || null, summary });
    }
  }
});

// High-level dynamic weather fetcher.
// Params: location (string), unit ('celsius' | 'fahrenheit')
// Return shape: { location, temperature, unit, windSpeed, windDirection, time, raw }
export async function getCurrentWeatherFn({ location, unit = 'celsius' }) {
  if (!location || typeof location !== 'string') {
    return { location, error: 'Invalid location', temperature: null, unit, windSpeed: null, windDirection: null, time: null };
  }
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  try {
    const geoResp = await fetch(geoUrl, { headers: { 'accept': 'application/json' } });
    const geoData = await geoResp.json();
    const first = geoData.results?.[0];
    if (!first) {
      return { location, error: 'Geocoding failed', temperature: null, unit, windSpeed: null, windDirection: null, time: null };
    }
    const { latitude, longitude, name, country } = first;
    const tempUnitParam = unit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=${tempUnitParam}`;
    const wResp = await fetch(weatherUrl, { headers: { 'accept': 'application/json' } });
    const wData = await wResp.json();
    const cw = wData.current_weather || {};
    return {
      location: `${name}${country ? ', '+country : ''}`,
      temperature: cw.temperature ?? null,
      unit,
      windSpeed: cw.windspeed ?? null,
      windDirection: cw.winddirection ?? null,
      time: cw.time ?? null,
      raw: { geo: first, current_weather: cw }
    };
  } catch (e) {
    return { location, error: String(e?.message || e), temperature: null, unit, windSpeed: null, windDirection: null, time: null };
  }
}

// No-op registration (kept for compatibility where registerTools(server) was called)
export function registerTools(server) {
  for (const def of Object.values(TOOL_DEFS)) {
    server.tool(def.name, def.description, def.inputSchema, def.handler);
  }
}

// Map MCP tool defs to OpenAI tool schema
export function buildOpenAiTools() {
  return Object.values(TOOL_DEFS).map(def => {
    const shape = (def.inputSchema)._def.shape();
    const properties = {}; const required = [];
    for (const [key, schema] of Object.entries(shape)) {
      const t = schema._def.typeName;
      const typeMap = { ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodEnum: 'string' };
      properties[key] = { type: typeMap[t] || 'string', description: schema.description || '' };
      if (!schema.isOptional()) required.push(key);
    }
    return { name: def.name, description: def.description, parameters: { type: 'object', properties, required } };
  });
}

// Map MCP tool defs to Anthropic tool schema
export function buildAnthropicTools() {
  return Object.values(TOOL_DEFS).map(def => {
    const shape = (def.inputSchema)._def.shape();
    const properties = {}; const required = [];
    for (const [key, schema] of Object.entries(shape)) {
      const t = schema._def.typeName;
      const typeMap = { ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodEnum: 'string' };
      properties[key] = { type: typeMap[t] || 'string', description: schema.description || '' };
      if (!schema.isOptional()) required.push(key);
    }
    return { name: def.name, description: def.description, input_schema: { type: 'object', properties, required } };
  });
}

// Expose log accessors
export function getToolUsageLog() { return [...TOOL_USAGE_LOG]; }
export function clearToolUsageLog() { TOOL_USAGE_LOG.length = 0; }
