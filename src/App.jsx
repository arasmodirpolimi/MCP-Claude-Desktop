import { useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { McpServersProvider, useMcpServers } from "./context/McpServersContext";
import ServerManager from "./components/MCPServers/ServerManager";
import ToolInvoker from "./components/MCPServers/ToolInvoker";
import ToolLog from "./components/ToolLog/ToolLog";
import { Assistant as AnthropicAssistant } from "./assistants/anthropic"; // kept for direct calls if needed
import { runAnthropicStream } from "./assistants/anthropicStreamClient.js";
import { Loader } from "./components/Loader/Loader";
import { Chat } from "./components/Chat/Chat";
import { Controls } from "./components/Controls/Controls";
import Login from "./components/Login/Login";
import styles from "./App.module.css";

function AppInner() {
  // Single provider: Anthropic (with server-side tool calling)
  const assistant = new AnthropicAssistant();
  const [messages, setMessages] = useState([]);
  const [pendingSteps, setPendingSteps] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const { user, signOut, loading } = useAuth();

  function addMessage(message) {
    setMessages((prevMessages) => [...prevMessages, message]);
  }

  const [currentModel, setCurrentModel] = useState('');

  async function handleContentSend(content, opts = {}) {
    const SHOW_TOOL_STEPS = false; // toggle to surface tool step summary as a single message
    addMessage({ content, role: "user" });
    setIsLoading(true);
    setIsStreaming(true);
    setPendingSteps([]);
    let assistantIdxRef = -1;
    const stepsLocal = [];
    try {
      await runAnthropicStream({
        prompt: content,
        model: opts.model,
        forceEnableTools: opts.enableTools,
        onEvent: (evt) => {
          if (evt.type === 'assistant_text') {
            if (assistantIdxRef === -1) {
              setMessages(prev => {
                assistantIdxRef = prev.length; // index of new assistant message
                return [...prev, { role: 'assistant', content: evt.text }];
              });
            } else {
              setMessages(prev => prev.map((m,i)=> i===assistantIdxRef ? { ...m, content: m.content + evt.text } : m));
            }
          } else if (evt.type === 'model_used') {
            setCurrentModel(evt.model || opts.model || '');
          } else if (evt.type === 'tool_use' || evt.type === 'tool_result' || evt.type === 'tool_error') {
            stepsLocal.push(evt);
            setPendingSteps(prev => [...prev, evt]);
          } else if (evt.type === 'error') {
            addMessage({ role: 'system', content: 'Error: ' + evt.error });
          } else if (evt.type === 'done') {
            if (SHOW_TOOL_STEPS && stepsLocal.length) {
              const stepSummary = stepsLocal.map(s => {
                if (s.type === 'tool_use') return `→ Using ${s.tool} ${JSON.stringify(s.args)}`;
                if (s.type === 'tool_result') return `✔ ${s.tool} finished`;
                if (s.type === 'tool_error') return `✖ Error in ${s.tool}: ${s.error}`;
                return '';
              }).join('\n');
              addMessage({ role: 'tool', content: stepSummary });
            }
          }
        }
      });
    } catch (e) {
      addMessage({ role: 'system', content: 'Sorry, I could not process your request. ' + String(e?.message || e) });
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  }
  const { activeServerId } = useMcpServers();

  async function handleLogout() {
    await signOut();
    try {
      localStorage.removeItem("auth_email");
    } catch {}
  }

  /**
   * ✅ Fixed: prefer refined text; keep raw data in console only.
   * Accepts either:
   *  - string (already refined)
   *  - { text, toolRaw, ... } from ToolRunButton
   *  - legacy { toolResult, anthropic } / { anthropicError }
   */
  function handleToolResult(result) {
    if (result == null) {
      addMessage({ role: "assistant", content: "[No result returned]" });
      return;
    }

    // Auto-summarize raw HTML bodies if Anthropic text missing
    const maybeAutoSummarizeHtml = async (raw) => {
      try {
        if (!raw) return null;
        const str = typeof raw === 'string' ? raw : (raw.body || '');
        if (typeof str !== 'string') return null;
        if (!/<html[\s>]/i.test(str) && !/<head[\s>]/i.test(str)) return null;
        const { summarizeWithAnthropic } = await import('./assistants/summarizeWithAnthropic.js');
        const summarized = await summarizeWithAnthropic({
          toolName: 'http_get',
          toolOutput: raw,
          userPrompt: lastUserContent,
        });
        return summarized;
      } catch { return null; }
    };

    // New ToolRunButton shape
    if (
      typeof result === "object" &&
      ("text" in result || "toolRaw" in result)
    ) {
      const refined =
        typeof result.text === "string" && result.text.trim()
          ? result.text.trim()
          : null;
      if (refined) {
        addMessage({ role: "assistant", content: refined });
      } else {
        // Fallback if refined text is missing
        const fallback =
          (result.toolRaw && typeof result.toolRaw === "object"
            ? result.toolRaw.extract || result.toolRaw.body
            : null) || JSON.stringify(result.toolRaw ?? result);
        maybeAutoSummarizeHtml(result.toolRaw).then((summ) => {
          addMessage({ role: "assistant", content: summ || fallback });
        });
      }
      try {
        // eslint-disable-next-line no-console
        console.debug("[Tool raw]", result.toolRaw);
      } catch {}
      return;
    }

    // Legacy worker-integrated shape
    if (
      typeof result === "object" &&
      ("anthropic" in result || "anthropicError" in result)
    ) {
      try {
        if (result.anthropic)
          console.debug("[Anthropic payload]", result.anthropic);
      } catch {}

      if (result.anthropic) {
        const anth = result.anthropic;
        const composed =
          typeof anth.text === "string" && anth.text.trim()
            ? anth.text.trim()
            : Array.isArray(anth.content)
              ? anth.content
                  .filter(
                    (c) => c && c.type === "text" && typeof c.text === "string"
                  )
                  .map((c) => c.text)
                  .join("\n")
              : null;

        if (composed && composed.trim()) {
          addMessage({ role: "assistant", content: composed.trim() });
        } else {
          const fallback =
            (result.toolResult && typeof result.toolResult === "object"
              ? result.toolResult.extract || result.toolResult.body
              : null) || JSON.stringify(result.toolResult ?? result);
          maybeAutoSummarizeHtml(result.toolResult).then((summ) => {
            addMessage({ role: "assistant", content: summ || fallback });
          });
        }
      } else if (result.anthropicError) {
        addMessage({
          role: "assistant",
          content: `Anthropic integration failed: ${result.anthropicError}`,
        });
      }
      try {
        console.debug("[Tool result]", result.toolResult);
      } catch {}
      return;
    }

    // Other shapes / strings
    if (typeof result === "string") {
      // Attempt auto summarization if raw HTML
      if (/<html[\s>]/i.test(result)) {
        maybeAutoSummarizeHtml(result).then((summ) => {
          addMessage({ role: "assistant", content: summ || result });
        });
        return;
      }
      addMessage({ role: "assistant", content: result });
      return;
    }
    if (result?.result?.content && Array.isArray(result.result.content)) {
      const textParts = result.result.content.map((c) =>
        c && typeof c === "object" && "text" in c ? c.text : JSON.stringify(c)
      );
      addMessage({ role: "assistant", content: textParts.join("\n") });
      return;
    }
    if (result?.result) {
      addMessage({ role: "assistant", content: JSON.stringify(result.result) });
      return;
    }

    addMessage({ role: "assistant", content: JSON.stringify(result) });
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
      {isLoading && <Loader />}
      <header className={styles.HeaderRow}>
        <div className={styles.Header}>
          <img
            className={styles.Logo}
            src="./chat-bot.png"
            alt="Chatbot Logo"
          />
          <h2 className={styles.Title}>AI Chatbot</h2>
          {currentModel && (
            <span style={{ marginLeft:'0.75rem', fontSize:'0.65rem', padding:'2px 6px', background:'#222', border:'1px solid #333', borderRadius:6, color:'#aaa' }}>
              Model: {currentModel}
            </span>
          )}
        </div>
        <button onClick={handleLogout} className={styles.LogoutButton}>
          Logout
        </button>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "380px 1fr",
          gap: "1rem",
          width: "100%",
          height: "100%",
        }}
      >
        <div style={{ overflowY: "auto", maxHeight: "85vh" }}>
          <ServerManager />
          <ToolInvoker onResult={handleToolResult} />
          <ToolLog />
        </div>

        <div className={styles.ChatContainer}>
          {/* No need to pass callTool; Chat runs its own tool calls and returns only refined text */}
          <Chat
            messages={messages}
            activeServerId={activeServerId}
            onToolResult={handleToolResult}
          />
        </div>
      </div>

      <Controls
        isDisabled={isLoading || isStreaming}
        onSend={handleContentSend}
      />
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
