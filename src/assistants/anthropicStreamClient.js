// Unified Anthropic streaming helper producing normalized events
// Events emitted:
//   { type: 'assistant_text', text }
//   { type: 'tool_use', tool, args }
//   { type: 'tool_result', tool, output }
//   { type: 'tool_error', tool, error }
//   { type: 'done', text }
//   { type: 'error', error }
// Falls back to non-stream chat if streaming yields no assistant text.

import { Assistant } from './anthropic.js';

export async function runAnthropicStream({ prompt, model = 'claude-3-5-sonnet-latest', forceEnableTools = true, onEvent, signal, sessionId }) {
  const assistant = new Assistant(model, { sessionId });
  let sawAssistantText = false;
  try {
    for await (const evt of assistant.chatStreamToolAware(prompt, { forceEnableTools, signal })) {
      if (signal?.aborted) {
        onEvent?.({ type: 'error', error: 'Cancelled' });
        return;
      }
      if (!evt || typeof evt !== 'object') continue;
      if (evt.type === 'assistant_text') {
        sawAssistantText = true;
        onEvent?.({ type: 'assistant_text', text: evt.text || '' });
      } else if (evt.type === 'model_used') {
        onEvent?.({ type: 'model_used', model: evt.model });
      } else if (evt.type === 'tool_use') {
        // Forward unique id so client can approve/cancel using exact server-side key.
        // Anthropic may use id or tool_use_id; if absent we rely on server provided synthetic id.
        onEvent?.({ type: 'tool_use', tool: evt.tool || evt.name, args: evt.args || evt.input || {}, id: evt.id || evt.tool_use_id });
      } else if (evt.type === 'tool_result') {
        onEvent?.({ type: 'tool_result', tool: evt.tool, output: evt.output });
      } else if (evt.type === 'tool_error') {
        onEvent?.({ type: 'tool_error', tool: evt.tool, error: evt.error });
      } else if (evt.type === 'done') {
        onEvent?.({ type: 'done', text: evt.text || '' });
      } else if (evt.type === 'error') {
        onEvent?.({ type: 'error', error: evt.error || 'Unknown error' });
      }
    }
  } catch (e) {
    onEvent?.({ type: 'error', error: String(e?.message || e) });
  }
  // Fallback request if none streamed
  if (!sawAssistantText && !signal?.aborted) {
    try {
  const text = await assistant.chat(prompt, { forceEnableTools, sessionId });
      if (text) onEvent?.({ type: 'assistant_text', text });
      onEvent?.({ type: 'done', text });
    } catch (e) {
      onEvent?.({ type: 'error', error: String(e?.message || e) });
    }
  }
}

// Convenience promise wrapper returning accumulated assistant text and step log
export async function runAnthropicStreamCollect(opts) {
  const steps = [];
  let assistant = '';
  await runAnthropicStream({
    ...opts,
    onEvent: (e) => {
      if (e.type === 'assistant_text') assistant += e.text;
      if (e.type === 'tool_use' || e.type === 'tool_result' || e.type === 'tool_error') steps.push(e);
      opts.onEvent?.(e);
    }
  });
  return { text: assistant, steps };
}
