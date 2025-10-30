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
