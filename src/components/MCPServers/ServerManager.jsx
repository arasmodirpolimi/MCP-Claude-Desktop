import React, { useState } from "react";
import { useMcpServers } from "../../context/McpServersContext";

export default function ServerManager() {
  const {
    servers,
    addServer,
    removeServer,
    activeServerId,
    setActiveServerId,
    loadingServers,
    error,
    fetchTools,
  } = useMcpServers();
  // Removed manual add form (name/baseUrl) per request; retain adding + error state for config-based registration
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [configText, setConfigText] = useState("");
  const [mappingInfo, setMappingInfo] = useState(null);
  const [toolPreview, setToolPreview] = useState({}); // name -> tool names
  const [previewLoading, setPreviewLoading] = useState(false);

  // Auto-map a Claude-style process config to a virtual Worker MCP baseUrl
  // Recognizes known commands/args and rewrites baseUrl accordingly.
  function detectVirtualMapping(parsed) {
    // Expect shape: { "filesystem": { command:"npx", args:["-y","@modelcontextprotocol/server-filesystem","."] }, ... }
    const mappings = [];
    const workerBase = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
    const servers = parsed.mcpServers || parsed; // allow root or nested key
    for (const [srvName, cfgRaw] of Object.entries(servers)) {
      // Normalise different config shapes: string, array, object
      let cfg = cfgRaw;
      // If the entry is a string that is a url, treat as baseUrl
      if (typeof cfg === "string") {
        const s = cfg.trim();
        try {
          const u = new URL(s);
          mappings.push({
            name: srvName,
            baseUrl: s.replace(/\/$/, ""),
            source: "external",
            editable: true,
          });
          continue;
        } catch {}
        // if it's a single word command, wrap into object
        cfg = { command: s };
      }
      const cmd = (cfg && (cfg.command || cfg.cmd || "")) || "";
      const args = Array.isArray(cfg.args)
        ? cfg.args
        : Array.isArray(cfg.commandArgs)
          ? cfg.commandArgs
          : [];
      const argStr = Array.isArray(args) ? args.join(" ") : String(args || "");
      // Respect explicit baseUrl/url fields in config
      const explicitUrl = cfg && (cfg.baseUrl || cfg.url || cfg.endpoint);
      if (explicitUrl && typeof explicitUrl === "string") {
        try {
          const uu = new URL(explicitUrl);
          mappings.push({
            name: srvName,
            baseUrl: explicitUrl.replace(/\/$/, ""),
            source: "explicit",
            editable: true,
          });
          continue;
        } catch {}
      }
      // Heuristics for known virtual server implementations
      if (
        cmd === "npx" &&
        args.includes("@modelcontextprotocol/server-filesystem")
      ) {
        if (workerBase) {
          mappings.push({
            name: srvName,
            baseUrl: `${workerBase}/local/filesystem`,
            source: "filesystem",
            editable: true,
            type: "embedded-virtual",
          });
        } else {
          mappings.push({
            name: srvName,
            baseUrl: null,
            source: "filesystem",
            editable: false,
            type: "filesystem",
          });
        }
      } else if (
        (cmd === "uvx" && args.includes("mcp-server-fetch")) ||
        (cmd === "npx" && argStr.includes("fetch")) ||
        argStr.includes("mcp-server-fetch")
      ) {
        if (workerBase)
          mappings.push({
            name: srvName,
            baseUrl: `${workerBase}/local/fetch`,
            source: "fetch",
            editable: true,
            type: "embedded-virtual",
          });
      } else if (
        argStr.includes("weather_server.py") ||
        srvName.toLowerCase().includes("weather")
      ) {
        mappings.push({
          name: srvName,
          baseUrl: null,
          source: "unmapped",
          editable: true,
          type: "external",
        });
      }
    }
    return { mappings };
  }

  async function handleConfigAnalyze() {
    setAddError(null);
    setMappingInfo(null);
    setToolPreview({});
    try {
      const parsed = JSON.parse(configText);
      const info = detectVirtualMapping(parsed);
      setMappingInfo(info);
      // Preview tools for mapped entries
      setPreviewLoading(true);
      const previews = {};
      const previewErrors = {};
      for (const m of info.mappings) {
        if (!m.baseUrl) continue;
        try {
          const initResp = await fetch(m.baseUrl.replace(/\/$/, "") + "/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "init-" + Date.now(),
              method: "initialize",
              params: {
                clientInfo: { name: "preview", version: "0.0.1" },
                capabilities: { tools: {} },
              },
            }),
          });
          if (!initResp.ok) {
            previewErrors[m.name] = `initialize failed ${initResp.status}`;
            continue;
          }
          const sid = initResp.headers.get("mcp-session-id");
          const toolsResp = await fetch(m.baseUrl.replace(/\/$/, "") + "/mcp", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(sid ? { "mcp-session-id": sid } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "tools-" + Date.now(),
              method: "tools/list",
            }),
          });
          if (!toolsResp.ok) {
            previewErrors[m.name] = `tools/list failed ${toolsResp.status}`;
            continue;
          }
          const data = await toolsResp.json();
          const list = data?.result?.tools || [];
          previews[m.name] = list.map((t) => t.name);
        } catch {
          /* ignore preview failures */
        }
      }
      setToolPreview(previews);
      // If we had preview failures, surface an aggregate error to the user
      const errEntries = Object.entries(previewErrors);
      if (errEntries.length) {
        setAddError(
          "Preview issue: " +
            errEntries.map(([k, v]) => `${k}: ${v}`).join("; ")
        );
      }
    } catch (e) {
      setAddError("Invalid JSON: " + String(e.message || e));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleConfigRegister() {
    if (!mappingInfo?.mappings?.length) return;
    setAdding(true);
    setAddError(null);
    let anyToolsLoaded = false;
    try {
      for (const m of mappingInfo.mappings) {
        if (!m.baseUrl && m.type !== "filesystem") continue; // skip unmapped external unless filesystem
        let added = null;
        try {
          added = await addServer(
            m.name,
            m.baseUrl,
            m.type === "filesystem" ? "filesystem" : "embedded"
          );
        } catch (e) {
          setAddError(
            "Registration failed for " + m.name + ": " + String(e?.message || e)
          );
          continue;
        }
        if (!added || !added.id) {
          setAddError("Registration returned no server id for " + m.name);
          continue;
        }
        try {
          // Ask the registry (Worker) to list tools for the registered server.
          // fetchTools now returns the tool array, which avoids extra fetches
          // and ensures we use the same API base as the context.
          const tools = await fetchTools(added.id);
          if (Array.isArray(tools) && tools.length) anyToolsLoaded = true;
        } catch (err) {
          setAddError(
            "Failed to fetch tools for " +
              m.name +
              ": " +
              String(err?.message || err)
          );
        }
      }
      setConfigText("");
      setMappingInfo(null);
      setToolPreview({});
      if (!anyToolsLoaded) {
        setAddError(
          "Registration succeeded, but no tools detected. Ensure the MCP endpoint is reachable and implements tools/list."
        );
      }
    } catch (e) {
      setAddError("Registration failed: " + String(e.message || e));
    } finally {
      setAdding(false);
    }
  }

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
      <h3 style={{ marginTop: 0 }}>MCP Servers</h3>
      {addError && <div style={errorStyle}>{addError}</div>}
      <details style={{ marginBottom: "0.75rem" }}>
        <summary
          style={{ cursor: "pointer", fontSize: "0.8rem", opacity: 0.85 }}
        >
          Add via Process Config (auto-map to virtual servers)
        </summary>
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
          <textarea
            placeholder='Paste JSON (claude_desktop_config fragment or {"mcpServers":{...}})'
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={6}
            style={{
              ...inputStyle,
              fontFamily: "monospace",
              resize: "vertical",
              width: "100%",
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={adding}
              onClick={handleConfigAnalyze}
              style={buttonStyle}
            >
              Analyze
            </button>
            <button
              type="button"
              disabled={adding || !mappingInfo}
              onClick={handleConfigRegister}
              style={buttonStyle}
            >
              Register Mapped
            </button>
          </div>
          {mappingInfo && (
            <div
              style={{
                fontSize: "0.65rem",
                lineHeight: 1.4,
                display: "grid",
                gap: "0.4rem",
              }}
            >
              {mappingInfo.mappings.map((m, i) => (
                <div
                  key={i}
                  style={{
                    opacity: m.baseUrl ? 1 : 0.6,
                    border: "1px solid #333",
                    padding: "0.35rem",
                    borderRadius: 4,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.25rem",
                    }}
                  >
                    <div>
                      <strong>{m.name}</strong>{" "}
                      <span style={{ opacity: 0.6 }}>
                        ({m.source}
                        {m.type ? `, ${m.type}` : ""})
                      </span>
                    </div>
                    {m.baseUrl ? (
                      <input
                        value={m.baseUrl}
                        disabled={!m.editable}
                        onChange={(e) => {
                          const val = e.target.value;
                          setMappingInfo((mi) => ({
                            ...mi,
                            mappings: mi.mappings.map((x, idx) =>
                              idx === i ? { ...x, baseUrl: val } : x
                            ),
                          }));
                        }}
                        style={{ ...inputStyle, fontSize: "0.6rem" }}
                      />
                    ) : (
                      <div style={{ fontSize: "0.6rem" }}>
                        {m.type === "filesystem"
                          ? "Will spawn local filesystem MCP (no baseUrl needed)."
                          : "No virtual mapping; provide a baseUrl before registering."}
                      </div>
                    )}
                    {previewLoading && (
                      <div style={{ fontSize: "0.55rem", opacity: 0.6 }}>
                        Loading tools preview…
                      </div>
                    )}
                    {!previewLoading &&
                      toolPreview[m.name] &&
                      toolPreview[m.name].length > 0 && (
                        <div style={{ fontSize: "0.55rem" }}>
                          Tools:{" "}
                          {toolPreview[m.name]
                            .map((t) => `\`${t}\``)
                            .join(", ")}
                        </div>
                      )}
                    {!previewLoading &&
                      m.baseUrl &&
                      (!toolPreview[m.name] ||
                        toolPreview[m.name].length === 0) && (
                        <div style={{ fontSize: "0.55rem", opacity: 0.6 }}>
                          No tools detected (may load after registration).
                        </div>
                      )}
                  </div>
                </div>
              ))}
              {!mappingInfo.mappings.length && <div>No entries detected.</div>}
            </div>
          )}
        </div>
      </details>
      {loadingServers && <div>Loading servers...</div>}
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
                <button
                  onClick={() => {
                    const ok = window.confirm(
                      `Remove MCP server '${s.name}' and its session? This cannot be undone.`
                    );
                    if (!ok) return;
                    removeServer(s.id);
                  }}
                  title={`Remove ${s.name}`}
                  aria-label={`Remove ${s.name}`}
                  style={{
                    ...smallBtnStyle,
                    background: "#7a1f1f",
                    color: "#fff",
                    borderRadius: 6,
                  }}
                >
                  🗑️
                </button>
              </div>
            </div>
            <div
              style={{
                fontSize: "0.72rem",
                color: "#bfbfbf",
                wordBreak: "break-all",
              }}
            >
              {s.baseUrl ||
                (s.type === "filesystem" ? "(spawned local process)" : "")}
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
                Spawn failed; using in-process static filesystem tools.
                Attempts: {(s.attempts || []).length}. Some advanced features
                may be unavailable.
                {Array.isArray(s.attempts) && s.attempts.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.55rem" }}>
                      Details
                    </summary>
                    <div
                      style={{
                        fontSize: "0.55rem",
                        maxHeight: 150,
                        overflowY: "auto",
                        marginTop: 4,
                      }}
                    >
                      {(s.attempts || []).map((a, i) => (
                        <div
                          key={i}
                          style={{
                            borderBottom: "1px solid #444",
                            padding: "2px 0",
                          }}
                        >
                          <div>
                            <strong>{a.label}</strong> {a.ok ? "OK" : "FAIL"}
                          </div>
                          <div style={{ opacity: 0.7 }}>
                            cmd: {a.command}{" "}
                            {Array.isArray(a.args) ? a.args.join(" ") : ""}
                          </div>
                          {!a.ok && a.error && (
                            <div style={{ color: "#ff8c8c" }}>
                              {a.error.slice(0, 160)}
                            </div>
                          )}
                          {a.candidates && (
                            <div style={{ opacity: 0.6 }}>
                              candidates:{" "}
                              {Array.isArray(a.candidates)
                                ? a.candidates.slice(0, 4).join(", ")
                                : ""}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
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
                Using in-process imported filesystem server. Attempts:{" "}
                {(s.attempts || []).length}. This avoids external spawn and may
                be more stable.
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

const inputStyle = {
  padding: "0.4rem 0.55rem",
  background: "#222",
  color: "#eee",
  border: "1px solid #444",
  borderRadius: 4,
  fontSize: "0.85rem",
};
const buttonStyle = {
  padding: "0.45rem 0.7rem",
  background: "#444",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.85rem",
};
const smallBtnStyle = {
  padding: "0.3rem 0.5rem",
  background: "#333",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.7rem",
};
const errorStyle = { color: "#ff6b6b", fontSize: "0.75rem" };
