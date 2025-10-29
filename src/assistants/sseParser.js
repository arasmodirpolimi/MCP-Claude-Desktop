// Generic SSE stream parser for LLM providers.
// Yields parsed JSON objects from lines starting with 'data:' until [DONE].
export async function* parseSSEReadable(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\n/);
    buffer = lines.pop() || ""; // keep last incomplete line
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith("data:")) continue;
      if (line === "data: [DONE]") return;
      const jsonPart = line.slice(5).trim();
      if (!jsonPart) continue;
      try {
        const obj = JSON.parse(jsonPart);
        yield obj;
      } catch {
        // ignore malformed JSON chunks
      }
    }
  }
}

export function extractAnthropicDelta(payload) {
  // Try various shapes emitted by Anthropic SSE events
  if (typeof payload?.delta === 'string') return payload.delta; // proxy simplified shape
  if (payload?.delta?.text) return payload.delta.text;
  if (payload?.content_block?.text) return payload.content_block.text;
  if (payload?.text) return payload.text;
  if (payload?.type === "content_block_delta" && payload?.delta?.type === "text_delta") {
    return payload.delta.text || "";
  }
  return "";
}