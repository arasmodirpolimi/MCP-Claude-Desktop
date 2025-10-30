<div align="center">
<h1>AI Chatbot</h1>
<p><strong>React + Vite + Supabase Auth + Multi‑LLM Streaming (OpenAI, Anthropic, Google Gemini, DeepSeek)</strong></p>
<p>Modern, secure, streaming AI chat interface with an animated glassmorphic login and pluggable assistant architecture.</p>
</div>

## 1. Overview
This project is a front‑end focused multi‑provider AI chat client. It authenticates users via Supabase email/password and streams model responses token‑by‑token (Server‑Sent Events, SSE) for responsive UX. Providers are encapsulated behind lightweight Assistant classes (`src/assistants/*`) so you can swap or extend models with minimal effort.

### Why This Stack?
* React + Vite: Fast dev server, modern build, easy environment variable handling.
* Supabase Auth: Drop‑in managed Postgres + auth with JWT session persistence.
* SSE Streaming: Per‑token UI updates for perceived latency reduction.
* Modular Assistants: Each provider isolated; add new ones without touching core chat UI.

## 2. Features
* Email/Password authentication (session persistence & auto refresh)
* Animated, accessible login form with basic validation
* Multi‑LLM provider support: OpenAI, Anthropic Claude, Google Gemini, DeepSeek
* Incremental streaming of responses (async generator pattern)
* Simple provider switching (instantiate different Assistant class)
* Environment variable configuration via `import.meta.env`
* Secure server / proxy endpoints for sensitive keys (recommended production pattern)

## 3. Project Structure (Essentials)
```
src/
	App.jsx                # High-level composition & chat orchestration
	supabaseClient.js      # Supabase initialization using env vars
	context/AuthContext.jsx# Auth state provider
	components/            # UI modules (Login, Chat, Controls, Loader)
	assistants/            # Provider adapters (openai, anthropic, googleai, deepseekai, sseParser)
	MCP/                   # Worker / server integration (tool registration, streaming endpoints)
```

## 4. Prerequisites
| Requirement | Notes |
|-------------|-------|
| Node.js >= 18 | For native fetch & streams |
| Supabase Account | Create project at supabase.com |
| API Keys (optional dev) | OpenAI / Anthropic / Google / DeepSeek |
| Wrangler (if using Cloudflare Worker) | For secrets + deployment |

## 5. Environment Variables
Create a local file `./.env.local` (Vite auto loads) with at minimum:
```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_PUBLIC_KEY
```
Optional (dev/testing only – avoid exposing in production bundle):
```bash
VITE_OPENAI_API_KEY=sk-...            # If you bypass proxy (not recommended)
VITE_ANTHROPIC_API_KEY=sk-ant-...     # Dev only, prefer server proxy
VITE_GOGGLE_AI_API_KEY=AIza...        # Google Generative AI key (typo kept for compatibility if present)
VITE_DEEPSEEK_AI_API_KEY=sk-...       # DeepSeek key if direct calling
```
Production best practice: keep provider keys on the server / Cloudflare Worker (see secrets section) and expose only your own proxy endpoints to the browser.

## 6. Installation & Run
```powershell
git clone https://github.com/arasmodirpolimi/AI-CHATBOT.git
cd AI-CHATBOT
npm install
npm run dev
```
Open http://localhost:5173 and log in with a Supabase test user.

## 7. Supabase Auth Setup
1. In Supabase Dashboard: Authentication → Providers → enable Email.
2. (Optional) Disable email confirmation for faster local iteration.
3. Create a user manually under Authentication → Users (or use sign‑up flow once implemented).
4. Add the project URL & anon key to `.env.local` as shown above.

### Auth Flow Internals
* `AuthContext` calls `supabase.auth.getSession()` on mount.
* Adds a listener to keep React state consistent when tokens refresh or logout occurs.
* `signInWithEmail` wraps `supabase.auth.signInWithPassword`.
* `signOut` calls `supabase.auth.signOut` and clears remembered email.
* "Remember me" only stores the email string in `localStorage` (no tokens).

## 8. Switching Model Providers
Each provider exports `Assistant` with a consistent interface:
```js
const assistant = new OpenAI.Assistant("gpt-4o-mini");
const response = await assistant.chat("Hello");
for await (const chunk of assistant.chatStream("Explain SSE")) {
	// append chunk to UI
}
```
To switch:
```js
import { Assistant as AnthropicAssistant } from './assistants/anthropic';
const assistant = new AnthropicAssistant();
```

### Provider Notes
| Provider | File | Key Handling | Streaming Method |
|----------|------|--------------|------------------|
| OpenAI | `assistants/openai.js` | Uses server proxy `/openai/chat` | SSE via `parseSSEReadable` |
| Anthropic | `assistants/anthropic.js` | Proxy endpoints `/anthropic/chat` & `/anthropic/ai/*` | SSE events mapped to deltas |
| Google Gemini | `assistants/googleai.js` | Direct SDK (key in env) | SDK stream iterator |
| DeepSeek | `assistants/deepseekai.js` | OpenAI-compatible baseURL & key | Inherits OpenAI streaming |

## 9. Streaming Architecture
1. User submits a prompt in Chat UI.
2. `assistant.chatStream(prompt)` returns an async generator.
3. UI consumes generator and appends tokens/chunks to the active message.
4. SSE parsing (`sseParser.js`) converts raw `data:` lines to JSON objects until `[DONE]`.

### Benefits of Streaming
* Faster perceived response time.
* Possibility of real‑time cancellation or injection of tool events.
* Foundation for advanced features (partial reasoning traces, tool call progress).

## 10. Anthropic vs OpenAI (Quick Comparison)
| Criterion | Claude 3.5 Sonnet | GPT‑4o / Mini |
|-----------|-------------------|---------------|
| Context Length | ~200K tokens | Smaller (but multimodal) |
| Strengths | Long document analysis, safety | Ecosystem, multimodal & tooling |
| Cost | Competitive for long contexts | Mini inexpensive for short prompts |
| Streaming Delta Type | `content_block_delta` | `choices[0].delta.content` |
| Pick When | Need long, careful reasoning | Need breadth & integrations |

## 11. Cloudflare Worker / Secrets (Optional)
If deploying SSE proxies via Cloudflare Worker:
```powershell
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```
Then map Worker routes to `/openai/chat`, `/anthropic/chat` etc. so browser never sees raw keys.

## 12. Security Guidelines
* Never commit service role or admin keys.
* Prefer server/Worker proxy for provider calls; avoid exposing secret keys client side.
* Enable Row Level Security (RLS) before storing user chat history.
* Consider rate limiting & logging on proxy endpoints.
* Use HTTPS in production; watch for mixed content with streaming.

## 13. Extending with a New Provider
1. Create `src/assistants/myprovider.js`.
2. Implement `chat(prompt, history?)` and `async *chatStream(...)`.
3. Parse SSE or streaming SDK output into plain text deltas (`yield string`).
4. Plug into UI by instantiating `new Assistant()` in the component or context.

Minimal template:
```js
import { parseSSEReadable } from './sseParser';
export class Assistant {
	constructor(model = 'my-model') { this.model = model; }
	async chat(content) { /* fetch -> return full text */ }
	async *chatStream(content) {
		const res = await fetch('/myprovider/chat', { /* ... */ });
		for await (const evt of parseSSEReadable(res.body)) {
			const delta = evt.delta || evt.text; if (delta) yield delta;
		}
	}
}
```

## 14. Testing & Debugging
| Test | What to Look For |
|------|------------------|
| Invalid login | Error banner with message from Supabase |
| Network offline | Graceful error instead of crash |
| SSE termination | Stream stops at `[DONE]` without hanging |
| Provider switch | Response still streams after swapping assistant |

Debug Tips:
* Add `console.log(payload)` inside `parseSSEReadable` to inspect provider event shapes.
* Log `session` within `AuthContext` for token refresh issues.
* Use browser DevTools → Network to watch `/openai/chat` (should remain pending while streaming).

## 15. Common Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| Warning: Missing Supabase vars | `.env.local` not loaded | Restart dev server; ensure prefix `VITE_` |
| 401 Unauthorized on provider | Key absent server-side | Add secret to Worker / server environment |
| Streaming stops early | Provider sends finish event | Verify loop handles `[DONE]` correctly |
| CORS error | Direct fetch to provider domain | Use server proxy endpoint |

## 16. Roadmap / Future Enhancements
* Sign‑up & password reset flows
* OAuth (Google / GitHub) via `supabase.auth.signInWithOAuth`
* Persist per‑user chat history (Postgres table + RLS policy)
* Tool call visualization (function execution traces in UI)
* Prompt templates & system message editing
* Rate limiting & usage metering dashboard
* Theme toggle & accessibility contrast improvements
* Streaming cancel button
* External filesystem MCP server (spawn via npx) for rich file operations

### Filesystem MCP Server Support
Add an external MCP server providing filesystem tools (read/write/list/search/etc.). Create it by POSTing to `/api/mcp/servers` with type `filesystem`:

```json
{
	"name": "fs",
	"type": "filesystem",
	"command": "npx",
	"args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
}
```

The server responds with an id; fetch tools via `/api/mcp/servers/<id>/tools`.

Tool discovery is now fully dynamic via MCP JSON-RPC (`initialize` + `tools/list`). No static fallback list is bundled.

Security cautions:
- Do NOT expose a filesystem MCP server publicly without sandboxing.
- Run it in a restricted working directory or container.
- Prefer read‑only or audited tools where possible; add allow/deny path filters upstream.

## 17. Contributing
1. Fork & branch: `git checkout -b feat/your-feature`.
2. Keep changes minimal & focused; update documentation if behavior changes.
3. Run `npm run build` (optional) to ensure no production errors.
4. Submit PR describing motivation + screenshots (if UI changes).

## 18. License
MIT (see `LICENSE` if added). Replace or augment for proprietary deployments.

## 19. Quick Start Snippet
```js
// Inside a React component after auth:
import { Assistant as OpenAIAssistant } from './assistants/openai';
const assistant = new OpenAIAssistant();
async function ask(q) {
	let text = '';
	for await (const delta of assistant.chatStream(q)) {
		text += delta;
		// setState(text) to update UI progressively
	}
	return text;
}
```

## 20. Acknowledgements
Built using Vite React template; adapted for multi‑provider AI experimentation. Thanks to open model providers for streaming APIs.

---
Enjoy building on top of this AI + auth starter. Contributions welcome!



## 21. Deployment Guide

### GitHub Pages (Frontend Only)
### Supabase Environment Variables on Static Hosts
GitHub Pages (and other static hosts) bake environment variables at build time. You must provide:
```
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
```
These are public (anon key) but still protect data via RLS policies. If they are missing the build workflow now injects placeholders and the app should show a warning (login actions will fail). Set real secrets under Settings > Secrets > Actions to enable authentication.

GitHub Pages serves static files only. You can deploy the built Vite app but NOT the Express/MCP server. The provided workflow `.github/workflows/deploy-pages.yml` automatically:
1. Installs dependencies
2. Runs `npm run build`
3. Publishes the `dist/` folder to Pages

After first successful run, check the Actions log or Settings > Pages for the URL. If assets 404 under a sub-path, set `base` in `vite.config.js`:
```js
import { defineConfig } from 'vite';
export default defineConfig({ base: '/REPO_NAME/' });
```

### Backend Hosting (Required for MCP & Proxies)
Choose any free Node/edge platform to run `src/MCP/server.js`:
| Platform | Pros | Notes |
|----------|------|-------|
| Render | Persistent process (Map sessions OK) | Use `PORT` env; add secrets |
| Railway | Similar ease to Render | Free tier limits runtime |
| Cloudflare Workers | Global edge, cheap/free | Must refactor Express → Worker; externalize sessions |
| Fly.io | VM-like; good control | Requires Dockerfile |
| Vercel Functions | Unified with frontend | Stateless; need external session store (Redis) |

Set secrets (OPENAI_API_KEY, ANTHROPIC_API_KEY, ALLOWED_ORIGIN). Never expose provider keys to the browser.

### Environment Variables Added
`PORT` and `ALLOWED_ORIGIN` now supported in `server.js`. Adjust origin on deploy to prevent CORS issues.

### Linking Frontend to Backend
Use an environment variable (e.g. `VITE_API_BASE`) to point fetch calls to the deployed backend origin:
```js
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3100';
fetch(`${API_BASE}/openai/chat`, { /* ... */ });
```
Add `VITE_API_BASE` in GitHub Pages build environment if needed (Pages build only injects static values—no secrets).

### Codespaces
Run everything inside a GitHub Codespace for a cloud dev environment:
```bash
export OPENAI_MOCK=1
export ANTHROPIC_MOCK=1
npm ci
npm run dev
```
Forward ports (3100 backend, 5173 frontend) and test streaming endpoints.

### Troubleshooting Deployment
| Symptom | Cause | Fix |
|---------|-------|-----|
| CORS error | Frontend origin mismatch | Set `ALLOWED_ORIGIN` env on backend |
| SSE disconnects | Host buffering / idle | Choose platform supporting long-lived responses (Render/Workers) |
| 404 on `/mcp` | Backend not deployed / wrong base | Verify backend URL; session header optional |
| Assets 404 on Pages | Missing `base` | Set `base` to repo path |
| 405 Not Allowed on `/anthropic/ai/chat-stream` | Static host (Pages) sees POST to nonexistent path | Set `VITE_API_BASE` to backend origin; fallback will use non-stream endpoint |

### Cloudflare Worker Integration (Backend Proxy)
Deploying a Cloudflare Worker lets you host the minimal proxy endpoints at the edge. Steps:
1. Add secrets (never commit provider keys):
	```powershell
	wrangler secret put OPENAI_API_KEY
	wrangler secret put ANTHROPIC_API_KEY
	wrangler secret put ALLOWED_ORIGIN # e.g. https://<user>.github.io/AI-CHATBOT
	```
2. Deploy: `wrangler deploy`
3. Set Pages build env `VITE_API_BASE` to your Worker URL, e.g.:
	```powershell
	VITE_API_BASE=https://ai-chatbot-mcp-alt.<your-subdomain>.workers.dev  # Use latest Worker hostname (avoid old Access-protected domain)
	```

Ensure each endpoint returns CORS headers:
```
Access-Control-Allow-Origin: <frontend origin>
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```
Missing preflight or mismatched origin commonly produces a generic browser `TypeError: Failed to fetch`.

### Key Rotation & Leak Response
If a provider key was exposed:
1. Generate a new key immediately (provider dashboard).
2. Update Worker/server secret and redeploy.
3. Invalidate old key (delete/revoke).
4. Scrub repository history if the key was committed (use `git filter-repo`).
5. Add lightweight rate limiting + logging to detect abusive spikes.

For local development convenience you can still use `VITE_OPENAI_API_KEY` or `VITE_ANTHROPIC_API_KEY`; keep them in `.env.local` (already gitignored). Production builds should omit these and rely solely on proxy endpoints secured by server-side secrets.

### Security Checklist
* Keep all provider API keys out of the public build.
* Add basic rate limiting if public.
* Log tool usage (`/logs/tools`) and rotate logs.
* Consider moving session state to Redis / Durable Object for horizontal scaling.

## 22. MCP Server Deployment (Current Approach)
The project now targets a Worker or external MCP servers using JSON-RPC. The previous Express-specific deployment instructions and static tool fallbacks have been removed. Use the Worker deployment guide below or plug in external MCP servers via the UI.


## 23. Cloudflare Worker Backend & Dynamic External MCP Servers (Current Implementation)
The project has been migrated so the backend now runs on a Cloudflare Worker (`src/MCP/worker.ts`) instead of an Express server. The Worker provides:

| Capability | Endpoint | Notes |
|------------|----------|-------|
| OpenAI proxy | (removed) | Endpoint deprecated in favor of Anthropic + MCP tooling |
| Anthropic proxy | `/anthropic/chat` | Basic non-stream messages endpoint proxy |
| Anthropic weather demo | `/anthropic/ai/chat` | Single-iteration tool call using internal weather helper |
| Dynamic MCP server CRUD | `/api/mcp/servers` | Add/list/remove external MCP servers |
| List tools for server | `/api/mcp/servers/:id/tools` | Performs MCP initialize + `tools/list` handshake |
| Invoke tool | `/api/mcp/servers/:id/tool-call` | Performs MCP `tools/call` with auto session refresh |

### Why This Change?
The original requirement was: "users must have the ability to connect MCP servers". Instead of hard-coding a single weather tool, the UI now lets any user add arbitrary external MCP servers (that expose the Streamable HTTP transport at `<baseUrl>/mcp`). The Worker acts as a light proxy/handshake facilitator so the browser doesn't need to manage multiple session headers directly (and avoids CORS issues if remote servers lack permissive origins).

### Adding a Server (UI Flow)
1. Open the app (local or deployed) – the left sidebar shows the MCP Server Manager.
2. Enter a name (label) and the base URL of the external MCP server (e.g. `https://example-tools.workers.dev`). Do NOT include `/mcp` (the Worker appends it automatically).
3. The Worker stores the server (KV if configured; in-memory fallback otherwise) and attempts an MCP `initialize` handshake to cache a `sessionId`.
4. The Tool Invoker panel auto-fetches `tools/list` and renders buttons for each tool.

### Invoking a Tool
1. Click a tool name – a dynamic form is generated from the tool's input schema or parameter object.
2. Fill arguments and click "Invoke Tool".
3. The Worker calls `tools/call` on the external server, auto-reinitializing the session if it expired, and returns the result.
4. The result is appended into the main chat as a `tool` message.

### Persistence
If a KV namespace binding `MCP_SERVERS` is configured in `wrangler.toml`, server definitions persist across deployments. Without KV, servers are stored only in memory (lost on Worker cold restart). Add to `wrangler.toml`:
```toml
kv_namespaces = [
	{ binding = "MCP_SERVERS", id = "<production_namespace_id>", preview_id = "<preview_namespace_id>" }
]
```
Create via:
```powershell
wrangler kv namespace create MCP_SERVERS
wrangler kv namespace create MCP_SERVERS --preview
```
Then copy the returned IDs into the config.

### Security & CORS
Set `ALLOWED_ORIGIN` secret to your frontend origin (comma-separated list for multiples). Hardened CORS now rejects disallowed origins with 403 instead of falling back:
```powershell
wrangler secret put ALLOWED_ORIGIN
```
Requests from other origins will be rejected unless `*` is explicitly included.

### Worker Development & Deployment
Scripts added:
```powershell
npm run worker:dev     # local dev (wrangler dev)
npm run worker:deploy  # deploy to Cloudflare
```
Add secrets before deploying:
```powershell
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ALLOWED_ORIGIN
```

### External MCP Server Requirements
Your external server must implement the Streamable HTTP transport at `/mcp` supporting the JSON-RPC methods:
* `initialize`
* `tools/list`
* `tools/call`

The Worker automatically sends:
```json
{
	"jsonrpc": "2.0",
	"id": "init-<timestamp>",
	"method": "initialize",
	"params": {
		"clientInfo": { "name": "dynamic-client", "version": "1.0.0" },
		"capabilities": { "tools": {} }
	}
}
```
It caches the `mcp-session-id` header; on failure it re-runs `initialize`.

### Limitations & Future Work
| Area | Current | Planned Improvement |
|------|---------|---------------------|
| Streaming tool responses | Not implemented (single JSON-RPC round trips) | SSE pass-through for streaming MCP servers |
| Auth to external servers | Assumes public endpoints | Allow per-server auth headers / tokens |
| Schema rendering | Simple text inputs | Rich form (types, enums, validation) |
| Session persistence | KV optional | Durable Objects for more robust session management |
| Chat integration | Tool outputs appended as separate messages | Inline tool call reasoning chain & multi-tool orchestration |

### Migrating From Express
The previous Express server has been superseded by the Worker. You can remove any deployment referencing `src/MCP/server.js` once satisfied with Worker behaviour:
```powershell
npm run worker:deploy
# Update any VITE_API_BASE to Worker URL
```

### Troubleshooting
| Symptom | Possible Cause | Fix |
|---------|----------------|-----|
| "Failed to initialize" when adding server | Wrong base URL (should not include /mcp) | Provide base without trailing slash; Worker appends /mcp internally |
| Tool list empty | Server returned no tools or handshake failed | Check server logs; confirm it implements `tools/list` |
| 502 on tool-call | Session expired & re-init also failed | Re-add server; inspect remote MCP server health |
| CORS error | Missing ALLOWED_ORIGIN secret or mismatch | Set correct origin and redeploy Worker |

---
This dynamic MCP architecture enables users to plug in any compatible tool server (similar to Claude Desktop custom MCP servers) without modifying the application code. The old Worker hostname still protected by Cloudflare Access must be replaced everywhere with the new `ai-chatbot-mcp-alt` hostname (GitHub Pages workflow updated).




## 24. Worker‑Only Mode (Express Deprecated)

You asked to run the project **without Node.js / Express — using only the Cloudflare Worker**. The repository is now aligned with that goal:

### Current State
* `src/MCP/worker.ts` implements ALL required backend capabilities.
* Added OpenAI streaming proxy endpoint: `POST /openai/chat` (SSE)
* Anthropic endpoints already present: `/anthropic/chat`, `/anthropic/ai/chat`, `/anthropic/ai/chat-stream`
* Dynamic MCP server CRUD + tool invocation: `/api/mcp/servers`, `/api/mcp/servers/:id/tools`, `/api/mcp/servers/:id/tool-call`, plus enable/allowlist endpoints.
* Global tool registration: `/admin/tools` (POST/GET/DELETE)
* CORS hardened via `ALLOWED_ORIGIN` secret.
* `npm start` now runs the Worker (`wrangler dev`). The old Express script is deprecated.

### Required Secrets (set before deploy)
```powershell
wrangler secret put ALLOWED_ORIGIN            # e.g. https://<your-gh-username>.github.io/AI-CHATBOT
wrangler secret put ANTHROPIC_API_KEY         # if you need Anthropic
wrangler secret put OPENAI_API_KEY            # if you use OpenAI assistant
```
Optional:
```powershell
wrangler secret put ALLOWED_FETCH_DOMAINS     # comma list for http_get (e.g. en.wikipedia.org,api.example.com)
wrangler secret put MAX_FETCH_BYTES           # e.g. 30000
```

### Local Development (Worker Only)
```powershell
npm install
npm run worker:dev
# In another terminal
npm run dev   # Vite frontend, ensure VITE_API_BASE points to worker (see below)
```

Add to `.env.local` (or Pages build env):
```
VITE_API_BASE=http://127.0.0.1:8787
```
When deployed, set `VITE_API_BASE` to the `*.workers.dev` URL.

### Capability Matrix (Worker)
| Feature | Endpoint | Notes |
|---------|----------|-------|
| OpenAI streaming | `/openai/chat` | SSE emits `{ assistant_text }` + `done` |
| Anthropic non-stream | `/anthropic/chat` | Basic message proxy |
| Anthropic tool (single) | `/anthropic/ai/chat` | One tool cycle + follow-up |
| Anthropic tool streaming | `/anthropic/ai/chat-stream` | Events: model_used, tool_use, tool_result, assistant_text, done |
| MCP servers CRUD | `/api/mcp/servers` | KV persistence if bound |
| List tools | `/api/mcp/servers/:id/tools` | Auto (re)initialize session |
| Invoke tool | `/api/mcp/servers/:id/tool-call` | Retries once on session failure |
| Toggle tool | `/api/mcp/servers/:id/enabled` | Persist enablement filter |
| Per-server allowlist | `/api/mcp/servers/:id/allowlist` | Domain filtering merge with global env |
| Register global tool | `/admin/tools` (POST) | Provide invokeUrl; appears as tool for Anthropic orchestration |
| Debug dynamic tools | `/anthropic/debug/tools` | Inspect assembled tool schema |

### Remove Express (Optional Cleanup)
You can delete `src/MCP/server.js` and any unused dependencies (express, cors, dotenv) — they are already not listed in `package.json`. If you previously deployed a Node backend, you can shut it down; just ensure `VITE_API_BASE` points to the Worker.

### Frontend Update Checklist
1. Set `VITE_API_BASE=<worker_url>`.
2. Make sure browser requests go to `https://<worker>.workers.dev/...`.
3. Confirm network panel shows 200 + SSE for `/anthropic/ai/chat-stream` and `/openai/chat`.
4. For URL summarization, ensure `ALLOWED_FETCH_DOMAINS` includes the target domain (e.g. `en.wikipedia.org`).

### Verifying Worker Only Mode
| Test | Expected |
|------|----------|
| Prompt "Hello" | Streaming assistant_text events from `/anthropic/ai/chat-stream` |
| Prompt referencing weather | Tool_use + tool_result events then summary |
| Prompt with Wikipedia URL | http_get tool call then summarized paragraph (no raw HTML) |
| OpenAI assistant (if used) | Streaming via `/openai/chat` |
| Add MCP server | Appears in list; tools show enabled status |

### Common Worker-Only Pitfalls
| Symptom | Fix |
|---------|-----|
| 501 from `/openai/chat` | Add `OPENAI_API_KEY` secret |
| 501 from Anthropic endpoints | Add `ANTHROPIC_API_KEY` secret |
| CORS error | Set `ALLOWED_ORIGIN` correctly (no trailing slash) |
| Tool call 502 | Remote MCP server down / invalid base URL |
| Raw HTML returned | Add domain to `ALLOWED_FETCH_DOMAINS`; ensure prompt explicitly asks to summarize |

### Next Hardening Steps
* Add rate limiting (per IP) via Durable Object or KV counters.
* Add logging sample counts (avoid full prompt retention) for observability.
* Implement streaming pass-through for long-running remote MCP tool calls.
* Introduce cancellation (close SSE stream on client abort).

You are now fully decoupled from Node; the Worker is the single backend surface.




