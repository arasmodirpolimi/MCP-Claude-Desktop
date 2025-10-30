// Lightweight Anthropic client (browser) using fetch instead of SDK to avoid bundle bloat.
// NOTE: Do NOT expose your Anthropic key to the browser in production.
// Use the Worker proxy endpoints instead.

/* eslint no-useless-catch: 0 */
// Streaming parser deferred loader to avoid top-level await (not supported in some build targets)
let parseSSEReadable, extractAnthropicDelta, _sseInitPromise;
function ensureSSEParser() {
  if (parseSSEReadable && extractAnthropicDelta) return _sseInitPromise;
  _sseInitPromise = (async () => {
    try {
      const mod = await import('./sseParser.js');
      parseSSEReadable = mod.parseSSEReadable;
      extractAnthropicDelta = mod.extractAnthropicDelta;
    } catch {
      // Minimal no-op fallbacks (non-streaming environments / tests)
      parseSSEReadable = async function* (_r) { /* no streaming in test */ };
      extractAnthropicDelta = () => '';
    }
  })();
  return _sseInitPromise;
}

// Resolve API base (for production static hosting where relative paths break)
// Guard for Node test context where import.meta.env is undefined.
let rawBase = "";
try {
  rawBase = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE) ? import.meta.env.VITE_API_BASE : "";
} catch { rawBase = ""; }
function join(base, path) {
  if (!base) return path; // fallback to relative (dev proxy)
  return base.replace(/\/?$/, "") + "/" + path.replace(/^\//, "");
}

export class Assistant {
  #model;
  constructor(model = "claude-3-5-sonnet-latest") {
    this.#model = model;
  }

  /**
   * Non-streaming call to the Worker tool-aware endpoint.
   * Accepts { forceEnableTools?: boolean } to pass through the enabling header.
   */
  async chat(content, options = {}) {
    const url = join(rawBase, "/anthropic/ai/chat");
    const headers = { "content-type": "application/json" };
    if (options?.forceEnableTools) headers["x-force-enable-tools"] = "1";

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: content, model: this.#model }),
    });
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {}
      throw new Error(
        `Anthropic tool proxy error ${res.status} ${text.slice(0, 160)}`
      );
    }
    const data = await res.json();
    return data.text || JSON.stringify(data);
  }

  /**
   * Basic streaming (no tool calling on this path). Yields text deltas (strings).
   * Accepts { forceEnableTools?: boolean } for parity, forwarded to the proxy.
   */
  async *chatStream(content, options = {}) {
    const url = join(rawBase, "/anthropic/chat");
    const headers = { "content-type": "application/json" };
    if (options?.forceEnableTools) headers["x-force-enable-tools"] = "1";

    const controller = options.signal instanceof AbortSignal ? null : (options.signal ? null : null);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: content,
        model: this.#model,
        max_tokens: 1024,
      }),
      signal: options.signal
    });
    if (!res.ok || !res.body) {
      let text = "";
      try {
        text = await res.text();
      } catch {}
      throw new Error(
        `Anthropic proxy error ${res.status} ${text.slice(0, 160)}`
      );
    }

    await ensureSSEParser();
    for await (const payload of parseSSEReadable(res.body)) {
      const delta = extractAnthropicDelta(payload);
      if (delta) yield delta;
    }
  }

  /**
   * Streaming with tool awareness. The Worker emits structured events:
   *   { type: "assistant_text" | "tool_use" | "tool_result" | "tool_error" | "done" | "error", ... }
   * Accepts { forceEnableTools?: boolean } — forwarded as x-force-enable-tools.
   */
  async *chatStreamToolAware(content, options = {}) {
    const url = join(rawBase, "/anthropic/ai/chat-stream");
    let res;
    try {
      const headers = { "content-type": "application/json" };
      if (options?.forceEnableTools) headers["x-force-enable-tools"] = "1";

      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: content, model: this.#model }),
        signal: options.signal
      });
    } catch {
      // Immediate network fallback
      yield* this.#fallbackNonStream(content, options);
      return;
    }

    if (res.status === 404 || res.status === 405) {
      // Endpoint missing on the server — fall back
      yield* this.#fallbackNonStream(content, options);
      return;
    }
    if (!res.ok || !res.body) {
      // Non-OK: fall back to non-stream path
      yield* this.#fallbackNonStream(content, options);
      return;
    }

    try {
      await ensureSSEParser();
      for await (const evt of parseSSEReadable(res.body)) {
        if (options.signal?.aborted) {
          yield { type: 'error', error: 'Stream cancelled' };
          return;
        }
        // Pass through structured event objects to the UI
        yield evt;
      }
    } catch {
      // If parsing fails, fall back
      yield* this.#fallbackNonStream(content, options);
    }
  }

  /**
   * Fallback strategy when the tool-aware SSE endpoint isn't available:
   *  1) Try the non-stream tool-aware endpoint and yield a single assistant_text + done.
   *  2) Otherwise, use the basic streaming proxy, aggregate text, and yield it.
   */
  async *#fallbackNonStream(content, options = {}) {
    // 1) Non-stream tool-aware endpoint
    try {
      const fbUrl = join(rawBase, "/anthropic/ai/chat");
      const headers = { "content-type": "application/json" };
      if (options?.forceEnableTools) headers["x-force-enable-tools"] = "1";

      const r = await fetch(fbUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: content, model: this.#model }),
      });
      if (r.ok) {
        const data = await r.json();
        const text = data.text || data.error || "[No text]";
        yield { type: "assistant_text", text };
        yield { type: "done", text };
        return;
      }
    } catch {
      // continue to step 2
    }

    // 2) Basic streaming proxy (aggregate to a single message)
    try {
      const basicUrl = join(rawBase, "/anthropic/chat");
      const headers2 = { "content-type": "application/json" };
      if (options?.forceEnableTools) headers2["x-force-enable-tools"] = "1";

      const r2 = await fetch(basicUrl, {
        method: "POST",
        headers: headers2,
        body: JSON.stringify({
          prompt: content,
          model: this.#model,
          max_tokens: 512,
        }),
      });
      if (r2.ok && r2.body) {
        let agg = "";
        await ensureSSEParser();
        for await (const payload of parseSSEReadable(r2.body)) {
          const delta = extractAnthropicDelta(payload);
          if (delta) agg += delta;
        }
        if (!agg) agg = "[No text streamed]";
        yield { type: "assistant_text", text: agg };
        yield { type: "done", text: agg };
        return;
      } else {
        let errTxt = "";
        try {
          errTxt = await r2.text();
        } catch {}
        const finalText = errTxt.slice(0, 160) || "[No text returned]";
        yield { type: "assistant_text", text: finalText };
        yield { type: "done", text: finalText };
        return;
      }
    } catch (e) {
      const msg = String(e?.message || e);
      yield { type: "assistant_text", text: `[Fallback error] ${msg}` };
      yield { type: "done", text: `[Fallback error] ${msg}` };
    }
  }
}

// WARNING: For production do NOT expose your Anthropic key to the browser. Route through your Worker instead.
