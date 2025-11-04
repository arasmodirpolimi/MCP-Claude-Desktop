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

export function Chat({ messages, activeServerId, activeServerName = '', onToolResult, autoRunTools = true, sessionId: externalSessionId, isLoading = false, isStreaming = false, activeToolExecs = [], toolEvents = [], userTurn = 0, onClearMemory }) {
  const messagesEndRef = useRef(null);
  const scrollRef = useRef(null);
  const [userNearBottom, setUserNearBottom] = useState(true);
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
      {[WELCOME_MESSAGE_GROUP, ...messagesGroups].map((group, groupIndex, all) => {
        const isLatestGroup = groupIndex === all.length - 1;
        return (
        <div key={groupIndex} className={styles.Group}>
          {group.map(({ role, content, turn }, index) => {
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
                {/* Per-turn tool windows: show finished executions for this message's turn; running only for current turn */}
                {role === 'user' && (
                  <div style={{ marginTop:12 }}>
                    {isLatestGroup && turn === userTurn && (
                      <ToolActivityPanel toolEvents={toolEvents.filter(e => e.turn === userTurn)} activeToolExecs={activeToolExecs.filter(e => e.turn === userTurn)} />
                    )}
                    <ToolExecutionWindows execs={activeToolExecs.filter(e => e.turn === (turn || 0) && e.status !== 'running')} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ); })}
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

/** ToolActivityPanel: shows sequential tool events and current executions; collapsible/minimizable */
function ToolActivityPanel({ toolEvents = [], activeToolExecs = [] }) {
  const [open, setOpen] = useState(true);
  const [showFinishedOutput, setShowFinishedOutput] = useState(false);
  const recent = toolEvents.slice(-40); // cap entries for performance
  const [expandedMap, setExpandedMap] = useState({}); // tool -> bool for details
  function toggleTool(t){ setExpandedMap(prev => ({ ...prev, [t]: !prev[t] })); }
  // Show only currently running executions here (finished results shown separately)
  const runningExecs = activeToolExecs.filter(e => e.status === 'running');
  return (
    <div style={{ marginBottom:12, border:'1px solid #2a2a2a', borderRadius:8, background:'#141414', overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 10px', background:'#1d1d1d', borderBottom: open ? '1px solid #222':'none' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <strong style={{ fontSize:'0.7rem' }}>Tool Activity</strong>
          <span style={{ fontSize:'0.6rem', opacity:0.6 }}>({toolEvents.length} events)</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <label style={{ fontSize:'0.55rem', display:'flex', alignItems:'center', gap:4 }}>
            <input type='checkbox' checked={showFinishedOutput} onChange={e=> setShowFinishedOutput(e.target.checked)} /> show output
          </label>
          <button onClick={()=> setOpen(o=> !o)} style={{ fontSize:'0.6rem', padding:'2px 8px', background:'#262626', color:'#ddd', border:'1px solid #333', borderRadius:4 }}>{open ? '−' : '+'}</button>
        </div>
      </div>
      {open && (
        <div style={{ maxHeight:180, overflowY:'auto', padding:'6px 10px', fontSize:'0.6rem', lineHeight:1.4 }}>
          {recent.length === 0 && <div style={{ opacity:0.5 }}>No tool events yet.</div>}
          {recent.map((e,i) => {
            let line;
            if (e.type === 'use') line = `I should call the following tool: ${e.tool}`;
            else if (e.type === 'result') line = `Tool ${e.tool} finished.`;
            else if (e.type === 'error') line = `Tool ${e.tool} error: ${String(e.error).slice(0,140)}`;
            return (
              <div key={i} style={{ padding:'2px 0', borderBottom:'1px solid #1a1a1a' }}>
                <div>{line}</div>
                {showFinishedOutput && e.type === 'result' && e.output != null && (
                  <pre style={{ margin:'2px 0 4px', whiteSpace:'pre-wrap', background:'#101010', padding:'4px', borderRadius:4, maxHeight:120, overflowY:'auto' }}>{
                    typeof e.output === 'string' ? e.output.slice(0,1000) : JSON.stringify(e.output, null, 2).slice(0,1000)
                  }{(typeof e.output === 'string' ? e.output.length : JSON.stringify(e.output).length) > 1000 ? '…':''}</pre>
                )}
              </div>
            );
          })}
          {/* Running executions only (no finished to avoid duplication) */}
          {runningExecs.length > 0 && (
            <div style={{ marginTop:8 }}>
              <div style={{ fontWeight:600, marginBottom:4 }}>Execution Details</div>
              <ul style={{ listStyle:'none', margin:0, padding:0 }}>
                {runningExecs.map((exec, i) => {
                  const expanded = expandedMap[exec.tool];
                  const elapsed = (() => {
                    const end = exec.finishedAt || Date.now();
                    const ms = end - exec.startedAt;
                    if (ms < 1000) return (ms/1000).toFixed(2)+'s';
                    if (ms < 60000) return (ms/1000).toFixed(2)+'s';
                    const s = Math.floor(ms/1000); const m = Math.floor(s/60); const r = s%60; return m+'m '+r+'s';
                  })();
                  const outputStr = exec.output == null ? '' : (typeof exec.output === 'string' ? exec.output : Array.isArray(exec.output) ? exec.output.map(o=> typeof o === 'string'? o: JSON.stringify(o)).join('\n') : JSON.stringify(exec.output, null, 2));
                  return (
                    <li key={i} style={{ border:'1px solid #1f1f1f', borderRadius:6, padding:'6px 8px', marginBottom:6, background:'#161616' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <strong style={{ fontSize:'0.65rem' }}>{exec.tool}</strong>
                        <span style={{ fontSize:'0.55rem', opacity:0.7 }}>{elapsed}</span>
                        <span style={{ fontSize:'0.55rem', padding:'2px 6px', borderRadius:4, background: exec.status==='error'? '#7f1d1d':'#1e293b', color:'#ddd', textTransform:'uppercase' }}>{exec.status}</span>
                        {(exec.args || exec.output || exec.error) && (
                          <button onClick={()=> toggleTool(exec.tool)} style={{ fontSize:'0.55rem', padding:'2px 6px', background:'#272727', color:'#ddd', border:'1px solid #333', borderRadius:4 }}>
                            {expanded? 'Hide' : 'Details'}
                          </button>
                        )}
                      </div>
                      {expanded && (
                        <div style={{ marginTop:6 }}>
                          {exec.args && Object.keys(exec.args).length > 0 && (
                            <div style={{ marginBottom:4 }}><strong style={{ fontSize:'0.6rem' }}>Args:</strong> <code style={{ fontSize:'0.6rem' }}>{JSON.stringify(exec.args)}</code></div>
                          )}
                          {exec.error && (
                            <div style={{ marginBottom:4, color:'#f87171', fontSize:'0.6rem' }}><strong>Error:</strong> {String(exec.error)}</div>
                          )}
                          {outputStr && (
                            <div style={{ fontSize:'0.6rem' }}><strong>Output:</strong>
                              <pre style={{ margin:'4px 0 0', maxHeight:160, overflowY:'auto', background:'#101010', padding:'6px', borderRadius:4, whiteSpace:'pre-wrap' }}>{outputStr}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// New component: render EACH finished tool execution in an independent window panel
function ToolExecutionWindows({ activeToolExecs = [], execs }) {
  // Collapsible container: default collapsed per user request so tool output windows don't dominate the chat view.
  // Header shows count of visible windows and allows restoring all closed windows.
  const source = Array.isArray(execs) ? execs : activeToolExecs.filter(e => e.status === 'done' || e.status === 'error');
  const finished = source;
  const [hidden, setHidden] = useState({}); // tool -> true if user closed
  const [expanded, setExpanded] = useState({}); // tool -> bool for full output
  const [allCollapsed, setAllCollapsed] = useState(true); // default collapsed per user request
  if (finished.length === 0) return null;
  const visibleCount = finished.filter(f => !hidden[f.tool]).length;
  return (
    <div style={{ border:'1px solid #262626', borderRadius:8, background:'#151515', overflow:'hidden' }}>
      {/* Header / Toggle */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 10px', background:'#1e1e1e', borderBottom: allCollapsed ? 'none':'1px solid #222' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <strong style={{ fontSize:'0.65rem' }}>Tool Results</strong>
          <span style={{ fontSize:'0.55rem', opacity:0.6 }}>({visibleCount} window{visibleCount===1?'':'s'})</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          {visibleCount < finished.length && (
            <button onClick={()=> setHidden({})} title='Restore closed windows' style={{ fontSize:'0.55rem', padding:'2px 6px', background:'#272727', color:'#ddd', border:'1px solid #333', borderRadius:4 }}>Restore</button>
          )}
          <button onClick={()=> setAllCollapsed(c => !c)} style={{ fontSize:'0.55rem', padding:'2px 8px', background:'#272727', color:'#ddd', border:'1px solid #333', borderRadius:4 }}>{allCollapsed ? 'Expand +' : 'Collapse −'}</button>
        </div>
      </div>
      {!allCollapsed && (
        <div style={{ padding:'10px 12px', display:'flex', flexDirection:'column', gap:10 }}>
          {finished.map((e,i) => {
            if (hidden[e.tool]) return null;
            const isExpanded = expanded[e.tool];
            const outputStr = e.output == null ? '' : (typeof e.output === 'string' ? e.output : JSON.stringify(e.output, null, 2));
            const preview = outputStr.slice(0, 260) + (outputStr.length > 260 ? '…' : '');
            return (
              <div key={i} style={{ border:'1px solid #2d2d2d', borderRadius:8, background:'#121212', padding:'8px 10px', position:'relative' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap' }}>
                  <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                    <strong style={{ fontSize:'0.65rem', wordBreak:'break-all' }}>{e.tool}</strong>
                    <span style={{ fontSize:'0.55rem', opacity:0.65 }}>Status: {e.status}</span>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    {outputStr && (
                      <button onClick={()=> setExpanded(prev => ({ ...prev, [e.tool]: !prev[e.tool] }))} style={{ fontSize:'0.55rem', padding:'2px 6px', background:'#242424', color:'#ddd', border:'1px solid #333', borderRadius:4 }}>{isExpanded? 'Collapse' : 'Expand'}</button>
                    )}
                    <button onClick={()=> setHidden(prev => ({ ...prev, [e.tool]: true }))} style={{ fontSize:'0.55rem', padding:'2px 6px', background:'#3b3b3b', color:'#bbb', border:'1px solid #444', borderRadius:4 }}>Close</button>
                  </div>
                </div>
                {outputStr && !isExpanded && (
                  <pre style={{ margin:'6px 0 0', fontSize:'0.55rem', background:'#0d0d0d', padding:'6px', borderRadius:4, maxHeight:120, overflow:'auto', whiteSpace:'pre-wrap' }}>{preview}</pre>
                )}
                {isExpanded && (
                  <pre style={{ margin:'6px 0 0', fontSize:'0.55rem', background:'#0d0d0d', padding:'6px', borderRadius:4, maxHeight:300, overflow:'auto', whiteSpace:'pre-wrap' }}>{outputStr}</pre>
                )}
                {e.error && (
                  <div style={{ marginTop:6, fontSize:'0.55rem', color:'#f87171' }}>Error: {String(e.error)}</div>
                )}
                {e.args && Object.keys(e.args).length > 0 && (
                  <div style={{ marginTop:6, fontSize:'0.5rem', opacity:0.6 }}>Args: <code>{JSON.stringify(e.args)}</code></div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
