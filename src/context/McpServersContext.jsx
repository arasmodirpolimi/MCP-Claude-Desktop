import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

// Backend endpoints implemented in Cloudflare Worker
// /api/mcp/servers (GET, POST) /api/mcp/servers/:id (DELETE)
// /api/mcp/servers/:id/tools (GET) /api/mcp/servers/:id/tool-call (POST)

const McpServersContext = createContext(null);

export function McpServersProvider({ children }) {
  const [servers, setServers] = useState([]); // [{id,name,baseUrl,createdAt}]
  const [activeServerId, setActiveServerId] = useState(null);
  const [toolsByServer, setToolsByServer] = useState({}); // serverId -> tools array
  const [enabledToolsByServer, setEnabledToolsByServer] = useState(() => {
    try { const raw = localStorage.getItem('mcp_enabled_tools'); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  }); // serverId -> { toolName: true }
  const [loadingServers, setLoadingServers] = useState(false);
  const [loadingTools, setLoadingTools] = useState(false);
  const [error, setError] = useState(null);

  // Persist active server selection locally for convenience
  useEffect(() => {
    try { const saved = localStorage.getItem('mcp_active_server'); if (saved) setActiveServerId(saved); } catch {}
  }, []);
  useEffect(() => {
    try { if (activeServerId) localStorage.setItem('mcp_active_server', activeServerId); } catch {}
  }, [activeServerId]);

  const API_BASE = import.meta.env.VITE_API_BASE || '';
  const buildUrl = (path) => {
    if (API_BASE) {
      return API_BASE.replace(/\/?$/, '') + path; // absolute to Worker
    }
    // fallback to same origin (dev)
    return path;
  };

  const refreshServers = useCallback(async () => {
    setLoadingServers(true); setError(null);
    try {
      const resp = await fetch(buildUrl('/api/mcp/servers'));
      if (!resp.ok) throw new Error(`List servers failed ${resp.status}`);
      const data = await resp.json();
      // Sanitize server list: ensure each entry is an object with an id
      const raw = data.servers || [];
      const cleaned = Array.isArray(raw) ? raw.filter(s => s && typeof s.id === 'string') : [];
      setServers(cleaned);
      if (!activeServerId && cleaned.length) setActiveServerId(cleaned[0].id);
    } catch (e) { setError(String(e.message || e)); }
    finally { setLoadingServers(false); }
  }, [activeServerId]);

  useEffect(() => { refreshServers(); }, [refreshServers]);

  const addServer = useCallback(async (name, baseUrl) => {
    setError(null);
    const resp = await fetch(buildUrl('/api/mcp/servers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseUrl }) });
    if (!resp.ok) throw new Error(`Add server failed ${resp.status}`);
    const data = await resp.json();
    // Validate returned server shape before mutating state
    if (!data || !data.server || typeof data.server.id !== 'string') {
      throw new Error('Invalid server returned from registry');
    }
    setServers(s => [...s, data.server]);
    setActiveServerId(data.server.id);
    return data.server;
  }, []);

  const removeServer = useCallback(async (id) => {
    const resp = await fetch(buildUrl(`/api/mcp/servers/${id}`), { method: 'DELETE' });
    if (!resp.ok) throw new Error(`Remove server failed ${resp.status}`);
    setServers(s => s.filter(x => x.id !== id));
    setToolsByServer(m => { const clone = { ...m }; delete clone[id]; return clone; });
    if (activeServerId === id) setActiveServerId(null);
  }, [activeServerId]);

  const fetchTools = useCallback(async (id) => {
    if (!id) return;
    setLoadingTools(true); setError(null);
    try {
      const resp = await fetch(buildUrl(`/api/mcp/servers/${id}/tools`));
      if (!resp.ok) throw new Error(`List tools failed ${resp.status}`);
      const data = await resp.json();
      const tools = data.tools || [];
      setToolsByServer(m => ({ ...m, [id]: tools }));
      // Persist enabled flags returned by backend into our enabledTools map
      try {
        const map = {};
        (tools || []).forEach(t => { if (t && t.name && t.enabled) map[t.name] = true; });
        setEnabledForServer(id, map);
      } catch {}
      return tools;
    } catch (e) { setError(String(e.message || e)); }
    finally { setLoadingTools(false); }
  }, []);

  // Enable/disable tools per-server. Persist in localStorage for convenience.
  const setEnabledForServer = useCallback((serverId, newMap) => {
    setEnabledToolsByServer(prev => {
      const next = { ...prev, [serverId]: newMap };
      try { localStorage.setItem('mcp_enabled_tools', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);
  const enableTool = useCallback(async (serverId, toolName) => {
    // Persist enablement to backend so Anthropic/Worker can honor it
    try {
      await fetch(buildUrl(`/api/mcp/servers/${serverId}/enabled`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolName, enabled: true }) });
      setEnabledForServer(serverId, { ...(enabledToolsByServer[serverId] || {}), [toolName]: true });
    } catch (e) { console.warn('Failed to persist enabled tool', e); setEnabledForServer(serverId, { ...(enabledToolsByServer[serverId] || {}), [toolName]: true }); }
  }, [enabledToolsByServer, setEnabledForServer]);
  const disableTool = useCallback(async (serverId, toolName) => {
    try {
      await fetch(buildUrl(`/api/mcp/servers/${serverId}/enabled`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolName, enabled: false }) });
      const cur = { ...(enabledToolsByServer[serverId] || {}) };
      delete cur[toolName]; setEnabledForServer(serverId, cur);
    } catch (e) { console.warn('Failed to persist disabled tool', e); const cur = { ...(enabledToolsByServer[serverId] || {}) }; delete cur[toolName]; setEnabledForServer(serverId, cur); }
  }, [enabledToolsByServer, setEnabledForServer]);
  const isToolEnabled = useCallback((serverId, toolName) => {
    return Boolean(enabledToolsByServer?.[serverId]?.[toolName]);
  }, [enabledToolsByServer]);

  useEffect(() => { if (activeServerId) fetchTools(activeServerId); }, [activeServerId, fetchTools]);

  const callTool = useCallback(async (serverId, toolName, args) => {
    // Backwards-compatible: if options is not supplied, behave as before.
    // If options.integrateWithAnthropic is true, perform the tool call, then send
    // the tool output + user's original prompt to the Worker's Anthropic endpoint
    // so the model can compose a human-friendly summary.
    let options = {};
    if (arguments.length >= 4 && typeof arguments[3] === 'object' && arguments[3] !== null) {
      options = arguments[3];
    }

    const resp = await fetch(buildUrl(`/api/mcp/servers/${serverId}/tool-call`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolName, arguments: args }) });
    if (!resp.ok) throw new Error(`Tool call failed ${resp.status}`);
    const json = await resp.json();

    if (!options.integrateWithAnthropic) {
      return json;
    }

    // Integration requested: compose prompt and call the Anthropic-aware endpoint
    try {
      const toolResult = json.result || json;
      const toolText = (typeof toolResult === 'object') ? JSON.stringify(toolResult) : String(toolResult);
      const userPrompt = String(options.userPrompt || '').trim();
      const composedPrompt = userPrompt
        ? `The following tool was executed to help answer the user's request. Tool: ${toolName}\n\nTool output:\n${toolText}\n\nUser's original request:\n${userPrompt}\n\nPlease incorporate the tool output into a concise, helpful answer.`
        : `The following tool was executed: ${toolName}\n\nTool output:\n${toolText}\n\nPlease summarize the result in plain language for the user.`;

      const anthHeaders = { 'Content-Type': 'application/json' };
      // When integrating tool results with Anthropic, ask the Worker to force-enable
      // discovered MCP tools so the model can call them if needed. This mirrors the
      // streaming path's use of the x-force-enable-tools header.
      anthHeaders['x-force-enable-tools'] = '1';
      const ar = await fetch(buildUrl('/anthropic/ai/chat'), {
        method: 'POST', headers: anthHeaders,
        body: JSON.stringify({ prompt: composedPrompt, model: options.model })
      });
      if (!ar.ok) {
        let t = '';
        try { t = await ar.text(); } catch {}
        return { result: json.result, anthropicError: `Anthropic proxy error ${ar.status} ${t.slice(0,160)}` };
      }
  const ajson = await ar.json();
  // Debug: show raw Anthropic response for troubleshooting in browser console
  try { console.debug('[Anthropic integration] raw response:', ajson); } catch {}
  return { result: json.result, anthropic: ajson };
    } catch (e) {
      return { result: json.result, anthropicError: String(e?.message || e) };
    }
  }, []);

  // Persist per-server allowlist (allowedDomains: array or comma-separated string)
  const setServerAllowlist = useCallback(async (serverId, allowedDomains) => {
    try {
      const body = { allowedDomains };
      const resp = await fetch(buildUrl(`/api/mcp/servers/${serverId}/allowlist`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!resp.ok) throw new Error(`Set allowlist failed ${resp.status}`);
      const data = await resp.json();
      // update local server entry
      setServers(prev => prev.map(s => s.id === serverId ? { ...s, allowedDomains: data.allowedDomains || [] } : s));
      return data;
    } catch (e) { console.warn('Failed to set allowlist', e); throw e; }
  }, []);

  const value = {
    servers,
    activeServerId,
    setActiveServerId,
    refreshServers,
    addServer,
    removeServer,
    fetchTools,
    tools: toolsByServer[activeServerId] || [],
    callTool,
    loadingServers,
    loadingTools,
    error,
    // tool enablement API
    enableTool,
    disableTool,
    isToolEnabled,
    enabledToolsByServer,
    // allowlist API
    setServerAllowlist
  };

  return <McpServersContext.Provider value={value}>{children}</McpServersContext.Provider>;
}

export function useMcpServers() {
  return useContext(McpServersContext);
}
