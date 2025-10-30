import { z } from 'zod';

/**
 * Dynamic Tool Registry
 * ---------------------
 * All former static / pre-registered tools have been removed to ensure a purely
 * dynamic environment. On server boot the registry starts empty. Tools can be
 * added at runtime via:
 *   1. External MCP servers (their tools are proxied, not inserted here)
 *   2. The admin HTTP endpoint POST /admin/tools/register which calls addTool()
 *   3. Direct programmatic calls to addTool() from custom initialization code
 *
 * This file intentionally contains NO default addTool(...) invocations so that
 * deployments never expose unintended capabilities. If you need a default
 * tool, create a separate initializer module and call addTool there, or use an
 * environment-driven configuration step.
 */

// Tool usage log (in-memory). Each entry: { name, args, startedAt, finishedAt, error, summary }
const TOOL_USAGE_LOG = [];

// Mutable registry object kept for compatibility with existing imports that reference TOOL_DEFS
export const TOOL_DEFS = {};

// Programmatic APIs to manage tools at runtime
export function addTool(def) {
  if (!def || typeof def !== 'object') throw new Error('Invalid tool definition');
  if (!def.name || typeof def.name !== 'string') throw new Error('Tool definition must include a string `name`');
  // Preserve optional origin for later pruning (e.g. when external MCP server removed)
  if (def.origin && typeof def.origin === 'string') {
    def.__origin = def.origin; // internal marker (avoid exposing externally unintentionally)
    delete def.origin; // normalize public shape
  }
  TOOL_DEFS[def.name] = def;
  return def;
}

export function removeTool(name) {
  if (!name || typeof name !== 'string') return false;
  if (TOOL_DEFS[name]) { delete TOOL_DEFS[name]; return true; }
  return false;
}

// Bulk removal helper: prune tools that originated from a given server name
export function removeToolsByOrigin(originName) {
  if (!originName) return 0;
  let removed = 0;
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    if (def?.__origin === originName || (name.startsWith(originName + ':'))) {
      delete TOOL_DEFS[name];
      removed++;
    }
  }
  return removed;
}

export function listToolDefs() {
  return Object.values(TOOL_DEFS);
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
  // Reset mapping each build to avoid stale entries when tools removed
  globalThis.__anthropicToolNameMap = { originalToSanitized: new Map(), sanitizedToOriginal: new Map() };
  const map = globalThis.__anthropicToolNameMap;
  const usedSanitized = new Set();
  const tools = [];
  for (const def of Object.values(TOOL_DEFS)) {
    const shape = (def.inputSchema)._def.shape();
    const properties = {}; const required = [];
    for (const [key, schema] of Object.entries(shape)) {
      const t = schema._def.typeName;
      const typeMap = { ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodEnum: 'string' };
      properties[key] = { type: typeMap[t] || 'string', description: schema.description || '' };
      if (!schema.isOptional()) required.push(key);
    }
    let original = def.name;
    let sanitized = original;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sanitized)) sanitized = original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,128);
    if (map.sanitizedToOriginal.has(sanitized) && map.sanitizedToOriginal.get(sanitized) !== original) {
      let i = 2; let candidate = sanitized.slice(0,120) + '_' + i;
      while (usedSanitized.has(candidate)) { i++; candidate = sanitized.slice(0,120) + '_' + i; }
      sanitized = candidate;
    }
    map.originalToSanitized.set(original, sanitized);
    map.sanitizedToOriginal.set(sanitized, original);
    usedSanitized.add(sanitized);
    tools.push({ name: sanitized, description: def.description, input_schema: { type: 'object', properties, required } });
  }
  return tools;
}

export function mapAnthropicToolNameBack(name) {
  if (!globalThis.__anthropicToolNameMap) return name;
  const m = globalThis.__anthropicToolNameMap.sanitizedToOriginal;
  return m.get(name) || name;
}

export function mapAnthropicToolNameForward(original) {
  if (!globalThis.__anthropicToolNameMap) return original;
  const m = globalThis.__anthropicToolNameMap.originalToSanitized;
  return m.get(original) || original;
}

// Expose log accessors
export function getToolUsageLog() { return [...TOOL_USAGE_LOG]; }
export function clearToolUsageLog() { TOOL_USAGE_LOG.length = 0; }
