import { useRef, useState, useEffect } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { McpServersProvider, useMcpServers } from "./context/McpServersContext";
import ServerManager from "./components/MCPServers/ServerManager";
import ToolInvoker from "./components/MCPServers/ToolInvoker";
// Removed ToolLog, Chat, Controls per simplified UI requirement
import { Loader } from "./components/Loader/Loader";
import Login from "./components/Login/Login";
import styles from "./App.module.css";
import { Chat } from "./components/Chat/Chat";
import { Controls } from "./components/Controls/Controls";
import { runAnthropicStream } from "./assistants/anthropicStreamClient.js";
function AppInner() {
  const { user, signOut, loading } = useAuth();
  const { activeServerId, servers } = useMcpServers();
  const [showManager, setShowManager] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null);
  const [currentModel, setCurrentModel] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [activeToolExecs, setActiveToolExecs] = useState([]); // [{tool, startedAt, args, status, output, turn}]
  const [toolEvents, setToolEvents] = useState([]); // sequential log of tool actions for in-chat panel (with turn)
  const [userTurn, setUserTurn] = useState(0); // increments per user message
  // Tools always enabled now (toggle removed)
  function clearMessages() {
    // Set to empty; Chat component injects the welcome group automatically so no duplicates
    setMessages([]);
  }

  // Ensure sessionId exists (memory continuity)
  useEffect(() => {
    try {
      const existing = window.localStorage.getItem('chat_session_id');
      if (existing) setSessionId(existing); else {
        const id = crypto.randomUUID();
        window.localStorage.setItem('chat_session_id', id);
        setSessionId(id);
      }
    } catch {}
  }, []);

  function addMessage(m){ setMessages(prev => [...prev, m]); }

  function handleToolResult(result){
    if (result == null) return;
    if (typeof result === 'string') { addMessage({ role:'assistant', content: result }); return; }
    if (result && typeof result === 'object') {
      if (result.error) { addMessage({ role:'system', content: 'Tool error: '+ result.error }); return; }
      const txt = result.text || result.summary || JSON.stringify(result).slice(0,400);
      addMessage({ role:'assistant', content: txt });
    }
  }

  async function handleContentSend(content, opts = {}) {
    // Increment turn and tag user message
    const nextTurn = userTurn + 1;
    setUserTurn(nextTurn);
    addMessage({ role:'user', content, turn: nextTurn });
    setIsLoading(true); setIsStreaming(true); abortRef.current = new AbortController();
    let assistantIndex = -1;
    try {
      await runAnthropicStream({
        prompt: content,
        model: opts.model,
        forceEnableTools: true,
        sessionId,
        signal: abortRef.current.signal,
        onEvent: (evt) => {
          if (evt.type === 'assistant_text') {
            if (assistantIndex === -1) {
              setMessages(prev => { assistantIndex = prev.length; return [...prev, { role:'assistant', content: evt.text, turn: nextTurn }]; });
            } else {
              setMessages(prev => prev.map((m,i)=> i===assistantIndex ? { ...m, content: m.content + evt.text } : m));
            }
          } else if (evt.type === 'model_used') {
            setCurrentModel(evt.model || '');
          } else if (evt.type === 'tool_use') {
            // Tool requires user approval before execution now: mark as pending
            setToolEvents(prev => [...prev, { type:'use', tool: evt.tool, args: evt.args || {}, id: evt.id, at: Date.now(), turn: nextTurn }]);
            setActiveToolExecs(prev => [...prev.filter(e => e.tool !== evt.tool), { tool: evt.tool, id: evt.id, startedAt: Date.now(), args: evt.args || {}, status: 'pending', turn: nextTurn }]);
          } else if (evt.type === 'tool_result') {
            setToolEvents(prev => [...prev, { type:'result', tool: evt.tool, output: evt.output, at: Date.now(), turn: nextTurn }]);
            setActiveToolExecs(prev => prev.map(e => e.tool === evt.tool ? { ...e, status: 'done', output: evt.output, finishedAt: Date.now() } : e));
          } else if (evt.type === 'tool_error') {
            addMessage({ role:'system', content: `Tool ${evt.tool} error: ${evt.error}` });
            setToolEvents(prev => [...prev, { type:'error', tool: evt.tool, error: evt.error, at: Date.now(), turn: nextTurn }]);
            setActiveToolExecs(prev => prev.map(e => e.tool === evt.tool ? { ...e, status: 'error', error: evt.error, finishedAt: Date.now() } : e));
          } else if (evt.type === 'error') {
            addMessage({ role:'system', content: 'Stream error: '+ evt.error });
          }
        }
      });
    } catch (e) {
      addMessage({ role:'system', content: 'Request failed: '+ String(e?.message || e) });
    } finally {
      setIsLoading(false); setIsStreaming(false); abortRef.current = null;
    }
  }

  async function handleToolDecision(toolId, decision){
    if (!toolId || !decision) return;
    const primary = decision === 'allow' ? '/anthropic/ai/approve-tool' : '/anthropic/ai/cancel-tool';
    const secondary = decision === 'allow' ? '/api/anthropic/ai/approve-tool' : '/api/anthropic/ai/cancel-tool';
    let ok = false; let toolNameRef = toolId; let respJson = null;
    try {
      const r1 = await fetch((import.meta.env.VITE_API_BASE || '') + primary, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ toolId }) });
      if (r1.ok) { ok = true; respJson = await r1.json().catch(()=>null); }
      else {
        const r2 = await fetch((import.meta.env.VITE_API_BASE || '') + secondary, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ toolId }) });
        if (r2.ok) { ok = true; respJson = await r2.json().catch(()=>null); }
        else {
          // Capture body for diagnostics
          let txt=''; try { txt = await r2.text(); } catch {}
          setToolEvents(prev => [...prev, { type:'error', tool: toolNameRef, error:`Decision failed (${r1.status}/${r2.status}) ${txt.slice(0,140)}`, at: Date.now(), turn: userTurn }]);
        }
      }
      if (ok) {
        setActiveToolExecs(prev => prev.map(e => e.id === toolId ? { ...e, status: decision === 'allow' ? 'running' : 'canceled' } : e));
        if (decision === 'cancel') {
          setToolEvents(prev => [...prev, { type:'error', tool: prev.find(p => p.id === toolId)?.tool || toolNameRef, error:'User canceled tool', at: Date.now(), turn: userTurn }]);
        }
      }
    } catch (e) {
      setToolEvents(prev => [...prev, { type:'error', tool: toolId, error:'Decision endpoint failed: '+ String(e?.message || e), at: Date.now(), turn: userTurn }]);
    }
  }

  function handleCancelStream(){ if (abortRef.current) abortRef.current.abort(); }

  async function handleLogout() {
    await signOut();
    try { localStorage.removeItem("auth_email"); } catch {}
  }

  if (loading) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          color: "#fff",
          fontFamily: "system-ui",
        }}
      >
        Loading session...
      </div>
    );
  }
  if (!user) {
    return <Login onLogin={() => {}} />;
  }

  return (
    <div className={styles.App}>
      <header className={styles.HeaderRow}>
        <div className={styles.Header}>
          <img className={styles.Logo} src="./chat-bot.png" alt="Chatbot Logo" />
          <h2 className={styles.Title}>MCP Manager</h2>
        </div>
        <button onClick={handleLogout} className={styles.LogoutButton}>Logout</button>
      </header>
      <div style={{ padding: '1rem', display:'grid', gap:'1rem', gridTemplateColumns: showManager ? '380px 1fr' : '1fr' }}>
        {!showManager && (
          <button
            style={{ padding:'0.7rem 1.1rem', fontSize:'0.9rem', background:'#333', color:'#fff', border:'1px solid #444', borderRadius:8, cursor:'pointer' }}
            onClick={()=> setShowManager(true)}
          >
            Open MCP Servers & Tools
          </button>
        )}
        {showManager && (
          <div style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
            <div style={{ overflowY:'auto', maxHeight:'60vh' }}>
              <ServerManager />
              <ToolInvoker />
            </div>
            <div style={{ alignSelf:'start' }}>
              <button
                style={{ padding:'0.45rem 0.75rem', fontSize:'0.7rem', background:'#222', color:'#ddd', border:'1px solid #333', borderRadius:6, cursor:'pointer', marginBottom:'0.6rem' }}
                onClick={()=> setShowManager(false)}
              >Close Panel</button>
              <div style={{ fontSize:'0.65rem', opacity:0.75 }}>
                Edit <code>mcpServers.json</code> in your workspace to modify auto-spawn servers. Restart backend after changes.
              </div>
            </div>
          </div>
        )}
        <div style={{ minHeight:'60vh', border:'1px solid #2a2a2a', borderRadius:8, padding:'0.75rem', background:'#181818' }}>
          <Chat
            messages={messages}
            activeServerId={activeServerId}
            activeServerName={servers.find(s=> s.id===activeServerId)?.name || ''}
            onToolResult={handleToolResult}
            sessionId={sessionId}
            isLoading={isLoading}
            isStreaming={isStreaming}
            activeToolExecs={activeToolExecs}
            toolEvents={toolEvents}
            userTurn={userTurn}
            autoRunTools={true}
            onClearMemory={clearMessages}
            onToolDecision={handleToolDecision}
          />
        </div>
      </div>
      <Controls
        isDisabled={isLoading}
        isStreaming={isStreaming}
        onSend={handleContentSend}
        onCancel={handleCancelStream}
      />
    {/* DebugPanel removed per request. Tool activity now shown inline inside chat. */}
  {/* Memory clear button triggers local chat clear by calling Chat's clear memory or App's helper (already wired via Chat) */}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <McpServersProvider>
        <AppInner />
      </McpServersProvider>
    </AuthProvider>
  );
}
