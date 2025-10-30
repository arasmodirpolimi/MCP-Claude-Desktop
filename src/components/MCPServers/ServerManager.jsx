import React, { useState, useCallback, useEffect } from "react";
import { useMcpServers } from "../../context/McpServersContext";

// Simplified ServerManager: lists servers loaded via backend (mcpServers.json) and allows selection/removal.
// All former config mapping / add UI removed.
export default function ServerManager() {
  const { servers, activeServerId, setActiveServerId, loadingServers, error, refreshServers } = useMcpServers();
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState(null);
  const [reloadOk, setReloadOk] = useState(false);

  const doReload = useCallback(async () => {
    setReloading(true); setReloadError(null); setReloadOk(false);
    try {
      // Fetch current config for safety then post reload
      const cfgResp = await fetch('/admin/mcp/config');
      if (!cfgResp.ok) throw new Error(`Config fetch failed ${cfgResp.status}`);
      const cfgJson = await cfgResp.json();
      const config = cfgJson?.config || { mcpServers: {} };
      const r = await fetch('/admin/mcp/reload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, replace: true })
      });
      if (!r.ok) {
        let txt = await r.text().catch(()=> '');
        throw new Error(`Reload failed ${r.status} ${txt.slice(0,120)}`);
      }
      setReloadOk(true);
      await refreshServers();
      // Auto-sync after reload to bridge any new tools and update tool counts
      try {
        // Use replace:true on sync after reload so removed servers prune bridged tools
        const syncResp = await fetch('/admin/mcp/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ reload: false, replace: true, timeoutMs: 9000 }) });
        if (syncResp.ok) {
          // Optionally parse and surface tool additions count
          const syncJson = await syncResp.json().catch(()=>null);
          console.debug('[ServerManager] sync summary', syncJson);
          await refreshServers(); // refresh again so updated toolCount shows
          // After pruning, ensure active server's tools re-fetched
          if (activeServerId) {
            try { await fetch(`/api/mcp/servers/${activeServerId}/tools`); } catch {}
          }
        }
      } catch (syncErr) {
        console.warn('[ServerManager] sync after reload failed', syncErr);
      }
      // Clear success after short delay
      setTimeout(()=> setReloadOk(false), 2500);
    } catch (e) {
      setReloadError(String(e.message || e));
    } finally { setReloading(false); }
  }, [refreshServers]);

  // Initial sync when panel opens (component mounts) to ensure any externally added servers are bridged.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const syncResp = await fetch('/admin/mcp/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ reload: false, replace: true, timeoutMs: 6000 }) });
        if (syncResp.ok && !cancelled) {
          const syncJson = await syncResp.json().catch(()=>null);
          console.debug('[ServerManager] initial sync summary', syncJson);
          await refreshServers();
          if (activeServerId) {
            try { await fetch(`/api/mcp/servers/${activeServerId}/tools`); } catch {}
          }
        }
      } catch (e) {
        if (!cancelled) console.warn('[ServerManager] initial sync failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshServers]);

  return (
    <div
      style={{
        border: "1px solid #333",
        padding: "0.9rem",
        borderRadius: 8,
        background: "#1a1a1a",
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>MCP Servers</h3>
        <button
          onClick={doReload}
          disabled={reloading}
          style={{
            padding: '4px 10px',
            fontSize: '0.65rem',
            background: reloading ? '#444' : '#2c2c2c',
            color: '#eee',
            border: '1px solid #555',
            borderRadius: 5,
            cursor: reloading ? 'wait' : 'pointer'
          }}
          title='Reload mcpServers.json and respawn external servers'
        >{reloading ? 'Reloading...' : 'Reload Config'}</button>
      </div>
      {reloadError && <div style={{ color:'#ff6b6b', fontSize:'0.6rem', marginTop:4 }}>Reload error: {reloadError}</div>}
      {reloadOk && !reloadError && <div style={{ color:'#5dff9e', fontSize:'0.6rem', marginTop:4 }}>Reloaded.</div>}
      {loadingServers && <div style={{ fontSize: "0.75rem", opacity: 0.7 }}>Loading servers...</div>}
      {error && <div style={errorStyle}>{error}</div>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {servers.map((s) => (
          <li
            key={s.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "0.35rem 0",
              borderBottom: "1px solid #222",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <div
                style={{
                  flex: "1 1 0",
                  minWidth: 0,
                  cursor: "pointer",
                  fontWeight: activeServerId === s.id ? "600" : "500",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
                onClick={() => setActiveServerId(s.id)}
                title={s.baseUrl}
              >
                {s.name}
                {typeof s.toolCount === 'number' && (
                  <span style={{ marginLeft: 4, fontSize: '0.55rem', opacity: 0.65 }} title={`Tool count: ${s.toolCount}`}>
                    ({s.toolCount} tool{s.toolCount === 1 ? '' : 's'})
                  </span>
                )}
                {s.type && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: "0.55rem",
                      padding: "2px 5px",
                      borderRadius: 4,
                      background:
                        s.type === "filesystem-degraded"
                          ? "#663b00"
                          : s.type === "filesystem-inproc"
                            ? "#004c66"
                            : "#2d2d2d",
                      color: "#ccc",
                      border: "1px solid #444",
                    }}
                  >
                    {s.type === "filesystem-degraded"
                      ? "filesystem (degraded)"
                      : s.type === "filesystem-inproc"
                        ? "filesystem (inproc)"
                        : s.type}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <small
                  style={{
                    opacity: 0.6,
                    fontSize: "0.55rem",
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.baseUrl}
                </small>
              </div>
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "#bfbfbf",
                wordBreak: "break-all",
              }}
            >
              {s.baseUrl || (s.type === "filesystem" ? "(spawned local process)" : "")}
            </div>
            {s.type === "filesystem-degraded" && (
              <div
                style={{
                  fontSize: "0.6rem",
                  color: "#ffb347",
                  background: "#352400",
                  padding: "4px 6px",
                  borderRadius: 4,
                }}
              >
                Spawn failed; using in-process static filesystem tools. Attempts: {(s.attempts || []).length}.
              </div>
            )}
            {s.type === "filesystem-inproc" && (
              <div
                style={{
                  fontSize: "0.6rem",
                  color: "#9dd7ff",
                  background: "#062635",
                  padding: "4px 6px",
                  borderRadius: 4,
                }}
              >
                Using in-process imported filesystem server. Attempts: {(s.attempts || []).length}.
              </div>
            )}
          </li>
        ))}
        {!servers.length && !loadingServers && (
          <li style={{ opacity: 0.7 }}>No servers added yet.</li>
        )}
      </ul>
    </div>
  );
}

const errorStyle = { color: "#ff6b6b", fontSize: "0.75rem" };
