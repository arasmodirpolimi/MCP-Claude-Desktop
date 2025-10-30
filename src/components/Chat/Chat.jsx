import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import Markdown from "react-markdown";
import styles from "./Chat.module.css";
import { useMcpServers } from "../../context/McpServersContext";
import { summarizeWithAnthropic } from "../../assistants/summarizeWithAnthropic";

/** ----------------------- ToolRunButton ----------------------- */
function ToolRunButton({ suggestion, activeServerId, onResult }) {
  const [busy, setBusy] = useState(false);
  const { isToolEnabled } = useMcpServers();

  const handleRun = async () => {
    let serverId = activeServerId || null;
    let toolName = suggestion?.tool;

    if (typeof suggestion?.tool === "string" && suggestion.tool.includes("__")) {
      const parts = suggestion.tool.split("__");
      const possibleServerId = parts.shift();
      toolName = parts.join("__") || suggestion.tool;
      if (possibleServerId) serverId = possibleServerId;
    }

    if (!serverId) {
      onResult?.({ error: "No server selected or specified for tool run." });
      return;
    }

    const enabled = typeof isToolEnabled === "function" ? isToolEnabled(serverId, toolName) : true;
    if (!enabled) {
      onResult?.({ error: `Tool ${toolName} is not enabled on server ${serverId}. Enable it in the Tools panel first.` });
      return;
    }

    setBusy(true);
    try {
      let lastUser = "";
      try { if (typeof window !== "undefined" && window.__lastUserPrompt__) lastUser = String(window.__lastUserPrompt__ || ""); } catch {}

      const res = await fetch(`${import.meta.env.VITE_API_BASE || ""}/api/mcp/servers/${serverId}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName, arguments: suggestion.args || {} })
      });
      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        throw new Error(`Tool call failed (${res.status}) ${errTxt.slice(0,160)}`);
      }
      const data = await res.json();
      const toolResult = data?.result;

      const refined = await summarizeWithAnthropic({
        toolName,
        toolOutput: toolResult,
        userPrompt: lastUser,
        model: "claude-3-5-sonnet-latest"
      });

      onResult?.(typeof refined === 'string' && refined.trim() ? refined.trim() : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)));
    } catch (e) {
      onResult?.({ error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const isNamespaced = typeof suggestion?.tool === "string" && suggestion.tool.includes("__");
  return (
    <button onClick={handleRun} disabled={(!activeServerId && !isNamespaced) || busy} style={{ marginRight: 8, padding: "0.25rem 0.5rem", fontSize: "0.75rem" }} title={isNamespaced ? "Run on the server specified in the suggestion" : ""}> {busy ? "Running…" : `Run ${suggestion?.tool ?? "tool"}`} </button>
  );
}

/** ----------------------------- Chat ----------------------------- */

const WELCOME_MESSAGE_GROUP = [
  { role: "assistant", content: "Hello! How can I assist you right now?" },
];

export function Chat({ messages, activeServerId, activeServerName = '', onToolResult, autoRunTools = true, sessionId: externalSessionId, isLoading = false, isStreaming = false, activeToolExecs = [], onClearMemory }) {
  const messagesEndRef = useRef(null);
  const scrollRef = useRef(null);
  const [userNearBottom, setUserNearBottom] = useState(true);
  const [expandedTools, setExpandedTools] = useState({}); // tool -> bool
  const [, forceTick] = useState(0); // for elapsed time re-render
  // Use externally provided sessionId (source of truth) or fall back once
  const [sessionId] = useState(() => {
    if (typeof externalSessionId === 'string' && externalSessionId.length > 10) return externalSessionId;
    try {
      const existing = typeof window !== 'undefined' ? window.localStorage.getItem('chat_session_id') : null;
      if (existing && existing.length > 10) return existing;
      const id = crypto.randomUUID();
      if (typeof window !== 'undefined') window.localStorage.setItem('chat_session_id', id);
      return id;
    } catch { return Math.random().toString(36).slice(2); }
  });
  const [memoryStats, setMemoryStats] = useState({ messages: 0, summaries: 0, chars: 0 });
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [memoryViewLimit, setMemoryViewLimit] = useState(12); // last N entries
  const [memoryEntries, setMemoryEntries] = useState([]); // cached memory messages
  const [memorySummaries, setMemorySummaries] = useState([]);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState(null);

  // Robust grouping: start with one empty group, open a new group when we hit a user message
  const messagesGroups = useMemo(() => {
    const groups = [[]];
    for (const m of messages || []) {
      if (m?.role === "user") {
        if (groups[groups.length - 1].length > 0) {
          groups.push([m]);
        } else {
          groups[groups.length - 1].push(m);
        }
      } else {
        groups[groups.length - 1].push(m);
      }
    }
    return groups;
  }, [messages]);

  // Expose the most recent user prompt globally so ToolRunButton can pass it for LLM integration.
  const lastUserMessage = (messages || [])
    .slice()
    .reverse()
    .find((m) => m.role === "user");
  const lastUserContent = lastUserMessage
    ? String(lastUserMessage.content || "")
    : "";
  try {
    if (typeof window !== "undefined") {
      window.__lastUserPrompt__ = lastUserContent;
    }
  } catch {}

  // Smart autoscroll: only scroll if user is already near bottom
  const updateUserNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 140; // px from bottom
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setUserNearBottom(distance < threshold);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateUserNearBottom();
    el.addEventListener('scroll', onScroll, { passive: true });
    updateUserNearBottom();
    // Elapsed timer interval
    const iv = setInterval(() => {
      const running = activeToolExecs.some(e => e.status === 'running');
      if (running) forceTick(t => t + 1); // trigger re-render
    }, 500);
    return () => el.removeEventListener('scroll', onScroll);
    // cleanup interval
    return () => { clearInterval(iv); el.removeEventListener('scroll', onScroll); };
  }, [updateUserNearBottom, activeToolExecs]);
  function formatElapsed(exec) {
    const end = exec.finishedAt || Date.now();
    const ms = end - exec.startedAt;
    if (ms < 1000) return (ms/1000).toFixed(2)+'s';
    if (ms < 60000) return (ms/1000).toFixed(1)+'s';
    const s = Math.floor(ms/1000);
    const m = Math.floor(s/60); const rem = s%60;
    return m + 'm ' + rem + 's';
  }

  function toggleExpand(tool) { setExpandedTools(prev => ({ ...prev, [tool]: !prev[tool] })); }

  // Memory clear now handled externally; ensure no duplicate greeting since we inject welcome group separately.

  useEffect(() => {
    if (!userNearBottom) return; // respect user's manual scroll position
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, userNearBottom]);

  // Fetch memory stats periodically (lightweight)
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const base = import.meta.env.VITE_API_BASE || '';
        const r = await fetch(`${base}/memory/${sessionId}`);
        if (r.ok) {
          const text = await r.text();
          if (/^\s*</.test(text)) {
            // HTML response indicates proxy misconfiguration (likely index.html)
            if (active) setMemoryError('Memory endpoint returned HTML (proxy misconfigured)');
            return;
          }
          let data; try { data = JSON.parse(text); } catch { setMemoryError('Invalid JSON from memory endpoint'); return; }
          if (active) setMemoryStats({ messages: data.messages.length, summaries: data.summaries.length, chars: data.chars });
          // Opportunistically refresh cached memory if panel is open (lightweight incremental UX)
          if (active && showMemoryPanel) {
            setMemoryEntries(data.messages || []);
            setMemorySummaries(data.summaries || []);
          }
        }
      } catch {}
    }
    load();
    const id = setInterval(load, 8000);
    return () => { active = false; clearInterval(id); };
  }, [sessionId, showMemoryPanel]);

  // Auto tool execution for structured tool_use events inserted into messages array
  useEffect(() => {
    if (!autoRunTools) return;
    const pending = [];
    for (const m of messages || []) {
      if (m && m.role === 'assistant' && typeof m.content === 'object' && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block?.type === 'tool_use' && block?.name) {
            pending.push({ name: block.name, args: block.input || {}, tool_use_id: block.id || block.tool_use_id });
          }
        }
      }
    }
    if (!pending.length) return;
    let cancelled = false;
    (async () => {
      for (const p of pending) {
        if (cancelled) break;
        try {
          const serverId = activeServerId;
          if (!serverId) continue;
          const base = import.meta.env.VITE_API_BASE || '';
          const res = await fetch(`${base}/api/mcp/servers/${serverId}/tool-call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ toolName: p.name, arguments: p.args })
          });
          if (!res.ok) {
            const txt = await res.text().catch(()=> '');
            onToolResult?.({ error: `Auto tool ${p.name} failed: ${txt.slice(0,160)}` });
            continue;
          }
          const data = await res.json();
          const toolResult = data?.result;
          const refined = await summarizeWithAnthropic({
            toolName: p.name,
            toolOutput: toolResult,
            userPrompt: lastUserContent,
            model: 'claude-3-5-sonnet-latest'
          });
          onToolResult?.(typeof refined === 'string' && refined.trim() ? refined.trim() : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2)));
        } catch (e) {
          onToolResult?.({ error: `Auto tool ${p.name} error: ${String(e?.message || e)}` });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [messages, autoRunTools, activeServerId, lastUserContent, onToolResult]);

  async function handleClearMemory() {
    try {
      const base = import.meta.env.VITE_API_BASE || '';
      await fetch(`${base}/memory/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
      setMemoryStats({ messages: 0, summaries: 0, chars: 0 });
      setMemoryEntries([]);
      setMemorySummaries([]);
      // Also clear chat history via parent (keeps welcome)
      onClearMemory?.();
    } catch {}
  }

  async function loadMemorySnapshot() {
    setLoadingMemory(true); setMemoryError(null);
    try {
      const base = import.meta.env.VITE_API_BASE || '';
      const r = await fetch(`${base}/memory/${sessionId}`);
      if (!r.ok) throw new Error(`Fetch memory failed ${r.status}`);
      const data = await r.json();
      setMemoryEntries(data.messages || []);
      setMemorySummaries(data.summaries || []);
    } catch (e) { setMemoryError(String(e.message || e)); }
    finally { setLoadingMemory(false); }
  }

  function renderMemoryPanel() {
    const combined = [...(memoryEntries || [])];
    // Include summaries as synthetic entries at end (tagged)
    (memorySummaries || []).forEach((s, i) => {
      combined.push({ role: 'summary', content: s?.content || s?.text || s?.summary || '[summary]', createdAt: s?.createdAt || s?.timestamp || Date.now(), _isSummary: true });
    });
    const last = combined.slice(-memoryViewLimit);
    return (
      <div className={styles.MemoryPanel}>
        <div className={styles.MemoryPanelHeader}>
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <strong style={{ fontSize:'0.75rem' }}>Memory Viewer</strong>
            <label style={{ fontSize:'0.65rem', display:'flex', alignItems:'center', gap:4 }}>
              Show last
              <select value={memoryViewLimit} onChange={e=> setMemoryViewLimit(Number(e.target.value))} style={{ fontSize:'0.65rem' }}>
                {[6,12,20,40].map(n=> <option key={n} value={n}>{n}</option>)}
              </select>
              entries
            </label>
            <button onClick={loadMemorySnapshot} disabled={loadingMemory} style={{ fontSize:'0.65rem', padding:'2px 6px' }}>{loadingMemory ? 'Loading…' : 'Refresh'}</button>
            <button onClick={handleClearMemory} style={{ fontSize:'0.65rem', padding:'2px 6px' }}>Clear</button>
          </div>
          <button onClick={()=> setShowMemoryPanel(false)} style={{ fontSize:'0.65rem', padding:'2px 6px' }}>Close</button>
        </div>
        {memoryError && <div className={styles.MemoryError}>⚠ {memoryError}</div>}
        <div className={styles.MemoryList}>
          {last.length === 0 && <div className={styles.MemoryEmpty}>No memory entries yet.</div>}
          {last.map((m,i) => {
            const role = m.role || 'unknown';
            const isSummary = m._isSummary || role === 'summary';
            let text = '';
            if (typeof m.content === 'string') text = m.content;
            else if (Array.isArray(m.content)) text = m.content.map(b => (typeof b.text === 'string' ? b.text : '')).join('\n');
            else if (m.content && typeof m.content === 'object' && typeof m.content.text === 'string') text = m.content.text;
            else text = JSON.stringify(m.content || '');
            const display = text.length > 260 ? text.slice(0,260) + '…' : text;
            return (
              <div key={i} className={styles.MemoryItem} data-role={role} data-summary={isSummary ? '1':'0'}>
                <div className={styles.MemoryMeta}>
                  <span className={styles.MemoryRole}>{isSummary ? 'summary' : role}</span>
                  {m.createdAt && <span className={styles.MemoryTime}>{new Date(m.createdAt).toLocaleTimeString()}</span>}
                </div>
                <div className={styles.MemoryText}><Markdown>{display}</Markdown></div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.Chat} ref={scrollRef}>
      <div className={styles.TopFade} />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <div style={{ fontSize:'0.7rem', opacity:0.8 }}>
          Session: {sessionId}
          {' '}• Mem msgs {memoryStats.messages}
          {' '}• summaries {memoryStats.summaries}
          {' '}• chars {memoryStats.chars}
          {activeServerId && (
            <span style={{ marginLeft:8, padding:'2px 6px', background:'#222', border:'1px solid #333', borderRadius:4 }} title={`Active MCP server for tool calls: ${activeServerName || activeServerId}`}>Server: {activeServerName || activeServerId.slice(0,8)}</span>
          )}
        </div>
        <div style={{ display:'flex', gap:6 }}>
          <button onClick={()=> { if (!showMemoryPanel) loadMemorySnapshot(); setShowMemoryPanel(s=> !s); }} style={{ fontSize:'0.65rem', padding:'2px 6px' }}>{showMemoryPanel ? 'Hide Memory' : 'View Memory'}</button>
          <button onClick={handleClearMemory} style={{ fontSize:'0.65rem', padding:'2px 6px' }}>Clear Memory</button>
        </div>
      </div>
      {showMemoryPanel && renderMemoryPanel()}
      {[WELCOME_MESSAGE_GROUP, ...messagesGroups].map((group, groupIndex) => (
        <div key={groupIndex} className={styles.Group}>
          {group.map(({ role, content }, index) => {
            const key = `${groupIndex}-${index}`;

            // Detect assistant-suggested tool lines like:
            // "→ Using toolName {"arg": 123}"
            const suggestions = [];
            if (role === "assistant" && typeof content === "string") {
              for (const line of content.split("\n")) {
                const m = line
                  .trim()
                  .match(/^→\s+Using\s+(\S+)(?:\s+(\{.*\}))?$/);
                if (m) {
                  let args = {};
                  if (m[2]) {
                    try {
                      args = JSON.parse(m[2]);
                    } catch {
                      args = {};
                    }
                  }
                  suggestions.push({ tool: m[1], args });
                }
              }
            }

            return (
              <div key={key} className={styles.Message} data-role={role}>
                <Markdown>{String(content ?? "")}</Markdown>
                {isStreaming && groupIndex === messagesGroups.length - 1 && index === group.length - 1 && role === 'assistant' && (
                  <span className={styles.StreamingCursor} />
                )}
                {autoRunTools && suggestions.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {suggestions.map((s, idx) => (
                      <ToolRunButton
                        key={idx}
                        suggestion={s}
                        activeServerId={activeServerId}
                        onResult={onToolResult}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {isLoading && (
        <div style={{ marginTop:4, marginBottom:8 }}>
          <div className={styles.Message} data-role='assistant' style={{ background:'transparent', boxShadow:'none', padding:'4px 8px' }}>
            <div className={styles.LoadingBubble}></div>
            <div className={styles.LoadingBubble} style={{ width:'240px' }}></div>
            <div className={styles.LoadingBubble} style={{ width:'120px' }}></div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
      <div className={styles.BottomFade} />
      {autoRunTools && activeToolExecs.length > 0 && (
        <div className={styles.ToolExecContainer}>
          {activeToolExecs.map(exec => {
            const cls = [styles.ToolExecItem];
            if (exec.status === 'done') cls.push('ToolExecDone');
            if (exec.status === 'error') cls.push('ToolExecError');
            const expanded = expandedTools[exec.tool];
            const preview = (() => {
              if (exec.output == null) return '';
              const raw = typeof exec.output === 'string' ? exec.output : JSON.stringify(exec.output, null, 2);
              return raw.length > 400 ? raw.slice(0,400) + '…' : raw;
            })();
            return (
              <div key={exec.tool} className={cls.join(' ')}>
                <div style={{ display:'flex', flexDirection:'column', width:'100%', gap:4 }}>
                  <div className={styles.ToolExecMetaRow}>
                    <span className={styles.ToolExecName}>{exec.tool}</span>
                    <span className={styles.ToolExecElapsed}>{formatElapsed(exec)}</span>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span className={styles.ToolExecStatus}>{exec.status === 'running' ? 'executing…' : exec.status}</span>
                    <div style={{ flex:1 }} className={styles.ToolExecProgress} />
                    {(exec.output || exec.error || exec.args) && (
                      <button className={styles.ToolExecToggle} onClick={() => toggleExpand(exec.tool)}>{expanded ? 'Hide' : 'Details'}</button>
                    )}
                  </div>
                  {expanded && (
                    <div className={styles.ToolExecDetails}>
                      {exec.args && Object.keys(exec.args).length > 0 && (
                        <div style={{ marginBottom:4 }}><strong>Args:</strong> <code>{JSON.stringify(exec.args)}</code></div>
                      )}
                      {exec.error && (
                        <div style={{ color:'#f87171', marginBottom:4 }}><strong>Error:</strong> {String(exec.error)}</div>
                      )}
                      {exec.output && (
                        <div><strong>Output:</strong>
                          <pre style={{ margin:0 }}>{preview}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!userNearBottom && (
        <button
          onClick={()=> messagesEndRef.current?.scrollIntoView({ behavior:'smooth' })}
          style={{ position:'sticky', bottom:12, marginLeft:'auto', padding:'6px 10px', fontSize:'0.65rem', background:'#2563eb', color:'#fff', border:'none', borderRadius:16, boxShadow:'0 2px 6px rgba(0,0,0,0.4)', cursor:'pointer' }}
        >Jump to latest ↓</button>
      )}
      {/* Removed Clear Chat View button per updated requirements */}
    </div>
  );
}
