// Multi-server MCP client facade using Worker dynamic endpoints.
// Provides CRUD for external MCP servers plus tool listing and invocation.
// Streaming kept minimal: a single call yields its result textually.

const API_BASE = import.meta.env?.VITE_API_BASE || window.location.origin;

function buildUrl(path) {
  return `${API_BASE.replace(/\/$/, '')}${path}`;
}

// ---- Server CRUD ----
export async function listServers() {
  const r = await fetch(buildUrl('/api/mcp/servers'));
  if (!r.ok) throw new Error(`listServers failed ${r.status}`);
  return (await r.json()).servers || [];
}

export async function addServer({ name, baseUrl }) {
  const r = await fetch(buildUrl('/api/mcp/servers'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseUrl })
  });
  if (!r.ok) throw new Error(`addServer failed ${r.status}`);
  return (await r.json()).server;
}

export async function deleteServer(id) {
  const r = await fetch(buildUrl(`/api/mcp/servers/${id}`), { method: 'DELETE' });
  if (!r.ok) throw new Error(`deleteServer failed ${r.status}`);
  return await r.json();
}

// ---- Tools ----
export async function listTools(serverId) {
  const r = await fetch(buildUrl(`/api/mcp/servers/${serverId}/tools`));
  if (!r.ok) throw new Error(`listTools failed ${r.status}`);
  return (await r.json()).tools || [];
}

export async function callTool(serverId, toolName, args = {}, options = {}) {
  // options: { integrateWithAnthropic: boolean, userPrompt?: string, model?: string }
  const r = await fetch(buildUrl(`/api/mcp/servers/${serverId}/tool-call`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolName, arguments: args })
  });
  if (!r.ok) throw new Error(`callTool failed ${r.status}`);
  const toolResult = (await r.json()).result;

  // If integration requested, forward the tool result to the Anthropic tool-aware endpoint
  if (options && options.integrateWithAnthropic) {
    try {
      const userPrompt = String(options.userPrompt || '').trim();
      const model = options.model || undefined;
      // Build a short, structured prompt so Anthropic can compose an answer using the tool output
      const toolText = (typeof toolResult === 'object') ? JSON.stringify(toolResult) : String(toolResult);
      const composedPrompt = userPrompt
        ? `The following tool was executed to help answer the user's request. Tool: ${toolName}\n\nTool output:\n${toolText}\n\nUser's original request:\n${userPrompt}\n\nPlease incorporate the tool output into a concise, helpful answer.`
        : `The following tool was executed: ${toolName}\n\nTool output:\n${toolText}\n\nPlease summarize the result in plain language for the user.`;

      const anthUrl = buildUrl('/anthropic/ai/chat');
      const ar = await fetch(anthUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: composedPrompt, model })
      });
      if (!ar.ok) {
        let t = '';
        try { t = await ar.text(); } catch {}
        return { toolResult, anthropicError: `Anthropic proxy error ${ar.status} ${t.slice(0,160)}` };
      }
  const ajson = await ar.json();
  // Debug: surface raw Anthropic response in the browser console
  try { console.debug('[mcpClient] Anthropic response:', ajson); } catch {}
  return { toolResult, anthropic: ajson };
    } catch (e) {
      return { toolResult, anthropicError: String(e?.message || e) };
    }
  }

  return toolResult;
}

// ---- Simple streaming facade (single emission) ----
export async function *streamToolOnce(serverId, toolName, args = {}) {
  let result;
  try { result = await callTool(serverId, toolName, args); }
  catch (e) { yield `Error: ${e?.message || e}`; return; }
  if (result == null) { yield 'No result'; return; }
  if (Array.isArray(result?.content)) {
    yield result.content.map(c => (c && typeof c === 'object' && 'text' in c ? c.text : JSON.stringify(c))).join('\n');
  } else if (typeof result === 'object') {
    yield JSON.stringify(result, null, 2);
  } else { yield String(result); }
}

// Backwards compatible Assistant wrapper.
export class Assistant {
  constructor(serverId, toolName = 'get_current_weather') { this.serverId = serverId; this.toolName = toolName; }
  async *chatStream(content) { yield* streamToolOnce(this.serverId, this.toolName, { location: content, unit: 'celsius' }); }
}

// HMR cleanup placeholder
if (import.meta.hot) { import.meta.hot.dispose(() => { /* no cached state */ }); }
