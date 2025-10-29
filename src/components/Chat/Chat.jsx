import { useRef, useEffect, useMemo, useState } from "react";
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

export function Chat({ messages, activeServerId, onToolResult }) {
  const messagesEndRef = useRef(null);

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

  useEffect(() => {
    const lastMessage = (messages || [])[messages.length - 1];
    if (lastMessage) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  return (
    <div className={styles.Chat}>
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
                {suggestions.length > 0 && (
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
      <div ref={messagesEndRef} />
    </div>
  );
}
