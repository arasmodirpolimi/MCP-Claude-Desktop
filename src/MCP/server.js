// server.js
// Make sure your package.json has: { "type": "module" }

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  registerTools,
  TOOL_DEFS,
  addTool,
  removeTool,
  buildAnthropicTools,
  getToolUsageLog,
  mapAnthropicToolNameBack,
  removeToolsByOrigin,
} from "./registerTools.js";
import { StdioMcpClient, waitForReady } from "./stdioClient.js";
import { z } from "zod";
import cors from "cors";

const SEP = "---";
function createServer() {
  const server = new McpServer({
    name: "weather-server",
    version: "1.0.0",
    capabilities: { tools: {}, resources: {} },
  });
  registerTools(server);
  return server;
}

const app = express();
// Helper to spawn servers from config file; re-loadable
async function spawnServersFromConfig({ replace = false } = {}) {
  const cfgPath = path.join(process.cwd(), "mcpServers.json");
  const raw = await fs.readFile(cfgPath, "utf8").catch(() => null);
  if (!raw) {
    console.log("[MCP] No mcpServers.json found; skipping auto-spawn");
    return { ok: true, loaded: 0 };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    console.warn("[MCP] Invalid JSON in mcpServers.json", e);
    return { ok: false, error: "Invalid JSON", details: String(e?.message || e) };
  }
  const entries = cfg?.mcpServers ? Object.entries(cfg.mcpServers) : [];
  if (!entries.length) {
    console.log("[MCP] mcpServers.json has empty mcpServers map");
    return { ok: true, loaded: 0 };
  }
  // If replace is true, remove existing external servers not present in config
  if (replace) {
    const keepNames = new Set(entries.map(([k]) => k));
    for (const [id, entry] of [...sessionServers.entries()]) {
      if ((entry.type === "external" || entry.type === 'filesystem' || entry.type === 'filesystem-inproc' || entry.type === 'filesystem-degraded') && !keepNames.has(entry.name)) {
        try { entry.transport.close?.(); } catch {}
        sessionServers.delete(id);
        // Prune bridged tools originating from this server
        const removed = removeToolsByOrigin(entry.name);
        console.log("[MCP] removed external server not in config", entry.name, id, "pruned tools:", removed);
      }
    }
  }
  let loaded = 0;
  // Helper to attach degraded filesystem tools when falling back
  function registerDegradedFsTools(targetServer) {
    const names = [];
    try {
      const readSchema = z.object({ path: z.string().describe('File path to read (relative or absolute)') });
      const readHandler = async ({ path: filePath }) => {
        try {
          const full = path.resolve(process.cwd(), filePath);
          const data = await fs.readFile(full, 'utf8');
          return { content: [{ type: 'text', text: data.slice(0, 8000) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: 'Error reading file: ' + String(e?.message || e) }] };
        }
      };
      targetServer.tool('fs_read_file', 'Read a text file (degraded local)', readSchema, readHandler);
      if (!TOOL_DEFS['fs_read_file']) {
        try { addTool({ name: 'fs_read_file', description: 'Read a UTF-8 text file from the local workspace (degraded mode)', inputSchema: readSchema, handler: readHandler }); } catch {}
      }
      names.push('fs_read_file');

      const listSchema = z.object({ dir: z.string().describe('Directory path to list (non-recursive)') });
      const listHandler = async ({ dir }) => {
        try {
          const full = path.resolve(process.cwd(), dir);
          const entries = await fs.readdir(full).catch(() => []);
          return { content: [{ type: 'text', text: entries.slice(0, 200).join('\n') }] };
        } catch (e) {
          return { content: [{ type: 'text', text: 'Error listing directory: ' + String(e?.message || e) }] };
        }
      };
      targetServer.tool('fs_list_directory', 'List files in directory (degraded local)', listSchema, listHandler);
      if (!TOOL_DEFS['fs_list_directory']) {
        try { addTool({ name: 'fs_list_directory', description: 'List files in a directory (non-recursive, degraded mode)', inputSchema: listSchema, handler: listHandler }); } catch {}
      }
      names.push('fs_list_directory');
    } catch (err) {
      console.warn('[MCP] failed registering degraded fs tools', err);
    }
    return names;
  }
  for (const [key, def] of entries) {
    let { command, args = [], type = "external", name = key } = def || {};
    if (!command) { console.warn("[MCP] skip", key, "missing command"); continue; }
    // Consolidated duplicate detection: Treat any existing server whose name matches (or filesystem variants) as duplicate
    const existingVariant = [...sessionServers.values()].find(s => s.name === name || (
      name === 'filesystem' && ['filesystem','filesystem-inproc','filesystem-degraded'].includes(s.type)
    ));
    if (existingVariant) {
      // If we previously had a degraded/inproc filesystem and config still asks for filesystem, attempt upgrade by spawning external ONLY once
      const wantsFilesystem = args.includes("@modelcontextprotocol/server-filesystem");
      if (wantsFilesystem && ['filesystem-inproc','filesystem-degraded'].includes(existingVariant.type)) {
        // Attempt upgrade: remove old entry then allow loop to spawn fresh external
        const toRemoveId = [...sessionServers.entries()].find(([id, v]) => v === existingVariant)?.[0];
        if (toRemoveId) {
          try { existingVariant.transport.close?.(); } catch {}
          sessionServers.delete(toRemoveId);
          console.log('[MCP] upgrading', existingVariant.type, 'to external filesystem via fresh spawn');
        }
      } else {
        continue; // duplicate; skip spawning another
      }
    }
    try {
      const id = randomUUID();
      if (type === "external") {
        // Build potential spawn variants for Windows npx ENOENT and filesystem server fallbacks
        const spawnAttempts = [];
        const variants = [];
        const isFilesystem = args.includes("@modelcontextprotocol/server-filesystem");
        // If config implies filesystem server, upgrade type so downstream UI can distinguish
  if (isFilesystem) type = 'filesystem';
        // Optional override: force in-process import (HTTP transport) instead of stdio process when MCP_FORCE_INPROC=1
        if (isFilesystem && process.env.MCP_FORCE_INPROC === '1') {
          try {
            const require = createRequire(import.meta.url);
            const mod = require("@modelcontextprotocol/server-filesystem");
            if (mod && typeof mod.createServer === 'function') {
              const fsServerInproc = new McpServer({ name: `${name}-filesystem-inproc`, version: '1.0.0', capabilities: { tools: {}, resources: {} } });
              // Register degraded tools so at minimum read/list available; actual module tools may self-register internally
              registerDegradedFsTools(fsServerInproc);
              const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
              await fsServerInproc.connect(transport);
              const degradedNames = Object.keys(TOOL_DEFS).filter(n => ['fs_read_file','fs_list_directory'].includes(n));
              sessionServers.set(id, { server: fsServerInproc, transport, name, type: 'filesystem-inproc', baseUrl: null, spawnAttempts: [{ label: 'inproc-forced', ok: true }], note: 'MCP_FORCE_INPROC active; stdio disabled.', toolCount: degradedNames.length, degradedTools: degradedNames });
              console.log('[MCP] forced in-process filesystem server created (MCP_FORCE_INPROC=1)', key, 'id', id);
              loaded++;
              continue; // skip external spawning entirely
            } else {
              console.warn('[MCP] filesystem module createServer not found; falling back to external spawn');
            }
          } catch (e) {
            console.warn('[MCP] forced inproc import failed; falling back to external spawn', e?.message || e);
          }
        }
        // Normalize config: treat npx exec pattern as npm exec for reliability on Windows
        if (process.platform === 'win32' && command === 'npx' && args[0] === 'exec') {
          command = 'npm';
          console.log('[MCP] normalized npx exec to npm exec for filesystem server');
        }
        if (process.platform === 'win32' && command.toLowerCase() === 'npx') {
          // Prefer npx.cmd first on Windows to avoid ENOENT
          variants.push({ cmd: 'npx.cmd', argv: args, label: 'npx-cmd-primary' });
          variants.push({ cmd: 'npx', argv: args, label: 'npx-alt' });
        } else {
          variants.push({ cmd: command, argv: args, label: 'primary' });
          if (process.platform === 'win32' && command.toLowerCase() === 'npx.cmd') {
            variants.push({ cmd: 'npx', argv: args, label: 'npx-alt' });
          }
        }
        if (isFilesystem) {
          const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
          variants.push({ cmd: npmCmd, argv: ['exec','@modelcontextprotocol/server-filesystem','.'], label: 'npm-exec-filesystem' });
          // Attempt to locate npm if ENOENT likely (common on some Windows setups without PATH propagation)
          const candidateNpmPaths = [
            process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'npm.cmd') : null,
            'C://Program Files//nodejs//npm.cmd',
            'C://Program Files (x86)//nodejs//npm.cmd'
          ].filter(Boolean);
          for (const cand of candidateNpmPaths) {
            try { await fs.access(cand); variants.push({ cmd: cand, argv: ['exec','@modelcontextprotocol/server-filesystem','.'], label: 'npm-candidate' }); break; } catch {}
          }
            // NEW: Explicit direct node execution of the package's dist/index.js when npm/npx unavailable.
            try {
              const distPath = path.join(process.cwd(), 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js');
              await fs.access(distPath);
              // Provide '.' as workspace root arg (same as npm exec behavior)
              variants.push({ cmd: process.execPath, argv: [distPath, '.'], label: 'node-direct-dist' });
            } catch {}
          // Direct bin script resolution (pre-fallback) using process.execPath
          try {
            const require = createRequire(import.meta.url);
            const pkgPath = require.resolve('@modelcontextprotocol/server-filesystem/package.json');
            const pkgDir = path.dirname(pkgPath);
            const pkgJson = JSON.parse(await fs.readFile(pkgPath,'utf8'));
            const binEntries = [];
            if (typeof pkgJson.bin === 'string') binEntries.push(path.join(pkgDir, pkgJson.bin));
            else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
              for (const v of Object.values(pkgJson.bin)) binEntries.push(path.join(pkgDir, v));
            }
            binEntries.push(path.join(pkgDir,'dist','index.js'));
            for (const be of binEntries) {
              try { await fs.access(be); variants.push({ cmd: process.execPath, argv: [be,'.'], label: 'node-bin-script' }); break; } catch {}
            }
          } catch (e) {
            spawnAttempts.push({ label: 'node-bin-script-prepare', ok: false, error: String(e?.message || e) });
          }
        }
        let proc = null;
        for (const v of variants) {
          if (proc) break;
          try {
            proc = spawn(v.cmd, v.argv, { cwd: process.cwd(), stdio: ["pipe","pipe","pipe"] });
            proc._spawnLabel = v.label;
            spawnAttempts.push({ label: v.label, command: v.cmd, args: v.argv, ok: true });
          } catch (e) {
            spawnAttempts.push({ label: v.label, command: v.cmd, args: v.argv, ok: false, error: String(e?.message || e) });
          }
        }
        if (!proc) {
          console.warn('[auto-external-mcp] all spawn variants failed for', key);
          // Filesystem specific fallback: attempt in-process import or degraded
          if (isFilesystem) {
            let inprocOk = false;
            try {
              const require = createRequire(import.meta.url);
              const mod = require("@modelcontextprotocol/server-filesystem");
              if (mod && typeof mod.createServer === 'function') {
                const fsServerInproc = new McpServer({ name: `${name}-filesystem-inproc`, version: '1.0.0', capabilities: { tools: {}, resources: {} } });
                // Register degraded tools BEFORE connecting (SDK disallows tool registration after connect)
                const degradedNames = registerDegradedFsTools(fsServerInproc);
                const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
                await fsServerInproc.connect(transport);
                sessionServers.set(id, { server: fsServerInproc, transport, name, type: 'filesystem-inproc', baseUrl: null, spawnAttempts, note: 'In-process import fallback active.', toolCount: degradedNames.length, degradedTools: degradedNames });
                console.log('[MCP] filesystem in-process fallback created', key, 'id', id);
                inprocOk = true;
              }
            } catch (e) {
              spawnAttempts.push({ label: 'inproc-import', ok: false, error: String(e?.message || e) });
            }
            if (!inprocOk) {
              const fsServerDegraded = new McpServer({ name: `${name}-filesystem-degraded`, version: '1.0.0', capabilities: { tools: {}, resources: {} } });
              // Register degraded tools before connect
              const degradedNames = registerDegradedFsTools(fsServerDegraded);
              const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
              await fsServerDegraded.connect(transport);
              sessionServers.set(id, { server: fsServerDegraded, transport, name, type: 'filesystem-degraded', baseUrl: null, warning: 'All spawn attempts failed; degraded static tools active.', spawnAttempts, toolCount: degradedNames.length, degradedTools: degradedNames });
              console.log('[MCP] filesystem degraded fallback created', key, 'id', id);
            }
          }
          continue; // move on to next configured server
        }
        let stdoutBuf = ""; let stderrBuf = ""; let started = false; const birth = Date.now();
        proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
        proc.stdout.on("data", c => { const t = c.toString(); stdoutBuf += t; if (!started && stdoutBuf.length) started = true; });
        proc.stderr.on("data", c => { const t = c.toString(); stderrBuf += t; if (/Error|ENOENT|EACCES|ECONNREFUSED/i.test(t)) console.warn("[auto-external-mcp][stderr]", t.trim()); });
        proc.on("exit", code => { console.log("[auto-external-mcp] process exited", code, key); const life = Date.now()-birth; if (life < 2000 && !started) { const entry = sessionServers.get(id); if (entry) entry.warning = "Exited immediately; no tools."; }});
        proc.on('error', err => {
          console.error('[auto-external-mcp] spawn error', err);
          // Windows-specific ENOENT guidance for npm/npx issues
          if (err?.code === 'ENOENT' && process.platform === 'win32') {
            console.warn('[auto-external-mcp] npm ENOENT on Windows. Troubleshooting steps:');
            console.warn('  1) Ensure Node.js installation added npm.cmd to PATH (re-open terminal).');
            console.warn('  2) Try setting command to "npm.cmd" in mcpServers.json for filesystem server.');
            console.warn('  3) Run: npm install @modelcontextprotocol/server-filesystem (module appears missing).');
            console.warn('  4) As fallback set MCP_FORCE_INPROC=1 (if package installed) to avoid spawning.');
          }
          if (/Cannot find module '@modelcontextprotocol\/server-filesystem'/.test(String(err))) {
            console.warn('[auto-external-mcp] Module not found. Install with: npm install @modelcontextprotocol/server-filesystem');
          }
          const entry = sessionServers.get(id);
          if (entry) entry.warning = 'Spawn error: ' + (err?.code || String(err?.message || err));
        });
        const server = new McpServer({ name: `${name}-external-mcp`, version: "1.0.0", capabilities: { tools: {}, resources: {} } });
        const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
        await server.connect(transport);
        let stdioClient = null; try { stdioClient = new StdioMcpClient(proc, { timeoutMs: 8000 }); } catch (e) { console.warn("[auto-external-mcp] failed StdioMcpClient", e); }
        const serverEntry = { server, transport, name, type: isFilesystem ? 'filesystem' : 'external', proc, stdioClient, external: { command, args, attempts: spawnAttempts }, baseUrl: null, stdout: () => stdoutBuf.slice(-4000), stderr: () => stderrBuf.slice(-4000), toolCount: 0, spawnAttempts };
        sessionServers.set(id, serverEntry);
        (async () => {
          if (!stdioClient) return;
          const ready = await waitForReady(stdioClient).catch(()=>false);
          if (!ready) {
            console.warn("[auto-external-mcp] readiness probe timed out for", key);
            if (isFilesystem) {
              // Mutate existing entry instead of delete to avoid stale id 404
              try { proc?.kill?.(); } catch {}
              let swapped = false;
              // Try in-process import replacement
              try {
                const require = createRequire(import.meta.url);
                const mod = require("@modelcontextprotocol/server-filesystem");
                if (mod && typeof mod.createServer === 'function') {
                  const fsServerInproc = new McpServer({ name: `${name}-filesystem-inproc`, version: '1.0.0', capabilities: { tools: {}, resources: {} } });
                  const degradedNames = registerDegradedFsTools(fsServerInproc);
                  // Reuse transport path
                  const transport2 = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
                  await fsServerInproc.connect(transport2);
                  Object.assign(serverEntry, { server: fsServerInproc, transport: transport2, type: 'filesystem-inproc', warning: null, note: 'Timeout: swapped to inproc', toolCount: degradedNames.length, degradedTools: degradedNames });
                  sessionServers.set(id, serverEntry);
                  console.log('[MCP] Swapped external filesystem to inproc after timeout');
                  swapped = true;
                }
              } catch (e) {
                console.warn('[MCP] inproc import after timeout failed', e?.message || e);
              }
              if (!swapped) {
                const fsServerDegraded = new McpServer({ name: `${name}-filesystem-degraded`, version: '1.0.0', capabilities: { tools: {}, resources: {} } });
                const degradedNames = registerDegradedFsTools(fsServerDegraded);
                const transport3 = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
                await fsServerDegraded.connect(transport3);
                Object.assign(serverEntry, { server: fsServerDegraded, transport: transport3, type: 'filesystem-degraded', warning: 'External readiness timeout; degraded tools active.', toolCount: degradedNames.length, degradedTools: degradedNames });
                sessionServers.set(id, serverEntry);
                console.log('[MCP] Swapped external filesystem to degraded after timeout');
              }
            }
            return;
          }
          console.log("[auto-external-mcp] ready tools for", key);
          try {
            const tools = await stdioClient.listTools({ forceRefresh: true });
            serverEntry.toolCount = Array.isArray(tools) ? tools.length : 0;
          } catch {}
        })();
        // Bridge external server tools into internal registry (non-blocking)
        (async () => {
          if (!stdioClient) return;
            try {
              const tools = await stdioClient.listTools({ forceRefresh: true });
              if (Array.isArray(tools)) {
                for (const t of tools) {
                  if (!t?.name) continue;
                  const baseName = t.name;
                  let finalName = baseName;
                  // Avoid name collision: if already exists, namespace with server name
                  if (TOOL_DEFS[finalName]) finalName = `${name}:${baseName}`;
                  if (TOOL_DEFS[finalName]) continue; // still collision, skip
                  const rawSchema = t.input_schema || t.inputSchema || { type: 'object', properties: {} };
                  const props = rawSchema.properties || {};
                  const required = Array.isArray(rawSchema.required) ? rawSchema.required : [];
                  const shape = {};
                  for (const [pk, pv] of Object.entries(props)) {
                    const pType = pv?.type || 'string';
                    let zType;
                    switch (pType) {
                      case 'number': zType = z.number(); break;
                      case 'boolean': zType = z.boolean(); break;
                      default: zType = z.string(); break;
                    }
                    if (!required.includes(pk)) zType = zType.optional();
                    shape[pk] = zType;
                  }
                  const inputSchema = z.object(shape);
                  const handler = async (args = {}) => {
                    try {
                      const result = await stdioClient.callTool(baseName, args);
                      if (result && result.content) return result;
                      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
                    } catch (err) {
                      return { content: [{ type: 'text', text: 'External tool error: ' + String(err?.message || err) }] };
                    }
                  };
                  try {
                    addTool({ name: finalName, description: t.description || '', inputSchema, handler, origin: name });
                    // Attach bridged tool to server instance so listTools via HTTP includes it
                    try { server.tool(finalName, t.description || '', inputSchema, handler); } catch {}
                    console.log('[MCP] bridged external tool', finalName, 'from auto-spawn server', name);
                  } catch (e) {
                    console.warn('[MCP] failed bridging tool', finalName, e);
                  }
                }
              }
            } catch (e) {
              console.warn('[MCP] bridge external tools failed for', name, e?.message || e);
            }
        })();
        console.log("[MCP] auto-spawned external server", key, "id", id, "command", command, "args", args);
        loaded++;
      } else {
        console.warn("[MCP] auto-spawn unsupported type", type, "for", key);
      }
    } catch (e) {
      console.warn("[MCP] failed auto-spawning", key, e);
    }
  }
  // Post-spawn duplicate cleanup: ensure only one filesystem server instance remains
  try {
    const fsEntries = [...sessionServers.entries()].filter(([, v]) => v.name === 'filesystem');
    if (fsEntries.length > 1) {
      // Precedence order
      const precedence = {
        'filesystem': 4,
        'filesystem-inproc': 3,
        'filesystem-degraded': 2,
        'external': 1
      };
      // Pick winner with highest precedence type
      let winner = fsEntries[0];
      for (const e of fsEntries) {
        const [, v] = e;
        if (precedence[v.type] > precedence[winner[1].type]) winner = e;
      }
      for (const e of fsEntries) {
        if (e[0] === winner[0]) continue;
        try { e[1].transport.close?.(); } catch {}
        sessionServers.delete(e[0]);
        console.log('[MCP] duplicate filesystem server removed', e[0], e[1].type);
      }
    }
  } catch (cleanupErr) {
    console.warn('[MCP] duplicate cleanup error', cleanupErr);
  }
  return { ok: true, loaded };
}

// Unified external tool bridging helper (extracts logic used during spawn) so we can re-run on demand.
async function bridgeExternalTools(stdioClient, serverEntry, name) {
  if (!stdioClient) return { ok: false, error: 'No stdioClient' };
  try {
    const tools = await stdioClient.listTools({ forceRefresh: true });
    if (!Array.isArray(tools)) return { ok: false, error: 'No tools array returned' };
    let added = 0;
    for (const t of tools) {
      if (!t?.name) continue;
      const baseName = t.name;
      let finalName = baseName;
      if (TOOL_DEFS[finalName]) finalName = `${name}:${baseName}`; // namespace to avoid collision
      if (TOOL_DEFS[finalName]) continue; // still collision
      const rawSchema = t.input_schema || t.inputSchema || { type: 'object', properties: {} };
      const props = rawSchema.properties || {};
      const required = Array.isArray(rawSchema.required) ? rawSchema.required : [];
      const shape = {};
      for (const [pk, pv] of Object.entries(props)) {
        const pType = pv?.type || 'string';
        let zType;
        switch (pType) {
          case 'number': zType = z.number(); break;
          case 'boolean': zType = z.boolean(); break;
          default: zType = z.string(); break;
        }
        if (!required.includes(pk)) zType = zType.optional();
        shape[pk] = zType;
      }
      const inputSchema = z.object(shape);
      const handler = async (args = {}) => {
        try {
          const result = await stdioClient.callTool(baseName, args);
          if (result && result.content) return result;
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: 'External tool error: ' + String(err?.message || err) }] };
        }
      };
      try {
        addTool({ name: finalName, description: t.description || '', inputSchema, handler, origin: name });
        try { serverEntry.server?.tool(finalName, t.description || '', inputSchema, handler); } catch {}
        added++;
      } catch (e) {
        console.warn('[MCP] bridge tool failed (sync)', finalName, e?.message || e);
      }
    }
    serverEntry.toolCount = typeof serverEntry.toolCount === 'number' ? serverEntry.toolCount + added : added;
    return { ok: true, added, total: serverEntry.toolCount };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Sync operation: reload config (optional) then attempt readiness + tool bridging for all servers.
async function syncMcpConfig({ reload = true, replace = false, readinessTimeoutMs = 8000 } = {}) {
  const status = { reloaded: false, servers: [] };
  if (reload) {
    try {
      const res = await spawnServersFromConfig({ replace });
      status.reloaded = true;
      status.reloadResult = res;
    } catch (e) {
      status.reloaded = false;
      status.reloadError = String(e?.message || e);
    }
  }
  // For each external / filesystem server, attempt tools/list & bridging if not already.
  const entries = [...sessionServers.entries()];
  for (const [id, entry] of entries) {
    const serverInfo = { id, name: entry.name, type: entry.type, toolCount: entry.toolCount || 0 };
    if (entry.stdioClient) {
      // Wait for readiness by polling tools/list until timeout
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < readinessTimeoutMs) {
        try {
          const tools = await entry.stdioClient.listTools({ forceRefresh: true });
          if (Array.isArray(tools) && tools.length) { ready = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 350));
      }
      serverInfo.ready = ready;
      // Bridge (idempotent): will skip already added names
      const bridgeResult = await bridgeExternalTools(entry.stdioClient, entry, entry.name);
      serverInfo.bridge = bridgeResult;
    } else {
      serverInfo.ready = entry.type === 'embedded' || entry.type?.includes('inproc');
      serverInfo.bridge = { ok: false, error: 'No stdioClient (non-external or spawn failure)' };
    }
    status.servers.push(serverInfo);
  }
  return status;
}

// Initial spawn
(async () => { await spawnServersFromConfig(); })();
// Watch mcpServers.json for changes and auto-spawn new servers (non-destructive; does not remove missing ones)
try {
  const cfgPath = path.join(process.cwd(), 'mcpServers.json');
  await fs.access(cfgPath).then(() => {
    fs.watch(cfgPath, { persistent: false }, async (eventType) => {
      if (eventType !== 'change') return;
      console.log('[MCP] Detected mcpServers.json change; checking for new servers...');
      try {
        const raw = await fs.readFile(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
        const entries = parsed?.mcpServers ? Object.entries(parsed.mcpServers) : [];
        for (const [key, def] of entries) {
          const name = (def && def.name) || key;
          const exists = [...sessionServers.values()].some(s => s.name === name);
          if (exists) continue; // already present
          console.log('[MCP] Auto-spawn new server from updated config:', key);
          // Spawn only new ones; reuse spawnServersFromConfig logic by passing replace=false
          await spawnServersFromConfig({ replace: false });
          break; // spawnServersFromConfig will handle all missing; exit loop
        }
      } catch (e) {
        console.warn('[MCP] Failed processing updated mcpServers.json', e);
      }
    });
  }).catch(() => {});
} catch (e) {
  console.warn('[MCP] watch setup failed', e);
}
// Custom tolerant JSON parser (replaces express.json()) so we can repair common escaping mistakes
app.use((req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("application/json")) return next();
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    req.rawBody = raw;
    if (!raw.trim()) return next();
    const tryParse = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    let parsed = tryParse(raw);
    if (!parsed && raw.startsWith("\\{")) {
      // User likely sent escaped JSON like \{"jsonrpc"...} from PowerShell quoting mistakes.
      const repaired = raw.replace(/^\\+/, "").replace(/\\"/g, '"');
      parsed = tryParse(repaired);
      if (parsed)
        console.warn("[JSON parser] repaired leading backslash-escaped JSON");
    }
    if (!parsed && /\\"jsonrpc\\"/.test(raw)) {
      // Attempt broad unescape of backslash-escaped quotes (but keep escaped backslashes first)
      const repaired2 = raw.replace(/\\"/g, '"');
      parsed = tryParse(repaired2);
      if (parsed) console.warn("[JSON parser] repaired quote escaping in JSON");
    }
    if (!parsed) {
      return res.status(400).json({
        error: "Invalid JSON",
        details: "Could not parse request body as JSON",
        hint: 'Remove unnecessary backslashes. Example: {"jsonrpc":"2.0",...} (not \\{"jsonrpc"...})',
        rawPreview: raw.slice(0, 120),
      });
    }
    req.body = parsed;
    return next();
  });
});

// With the Vite proxy, CORS is not required; leaving it enabled is harmless.
// If you access the server directly from the browser (no proxy), this will help.
// Allow overriding allowed origins via env. Support comma-separated list or '*'.
// Example: ALLOWED_ORIGIN="https://arasmodirpolimi.github.io,http://localhost:5173"
const ALLOWED_ORIGIN_RAW =
  process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const ALLOWED_ORIGINS = ALLOWED_ORIGIN_RAW.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin))
        return cb(null, true);
      return cb(new Error("Origin not allowed"));
    },
    credentials: true,
  })
);

// ---------------- MCP session management endpoints -----------------
// Maintain per-session MCP servers so tools registered dynamically are isolated per browser tab.
// Persist sessions across potential hot-reload / dev restarts by stashing on globalThis.
const globalKey = "__mcp_session_servers__";
const sessionServers =
  globalThis[globalKey] instanceof Map ? globalThis[globalKey] : new Map();
globalThis[globalKey] = sessionServers; // ensure future reloads reuse
console.log(
  "[MCP] sessionServers init. Existing entries:",
  sessionServers.size
);

// ---------------- Chat Memory Store ----------------------------------------
// Per-session conversational memory. In-memory Map (can swap to Redis or DB later).
// Shape: memoryMap[sessionId] = { messages: [ { role, content, ts } ], summaries: [ { content, ts } ], chars }
const memoryKey = "__chat_memory_store__";
const memoryMap =
  globalThis[memoryKey] instanceof Map ? globalThis[memoryKey] : new Map();
globalThis[memoryKey] = memoryMap;
const MAX_MEMORY_CHARS = 12000; // rough cap before summarization
const SUMMARY_TARGET = 6000; // after summarizing prune to this size

function estimateChars(arr) {
  return arr.reduce((n, m) => n + (m.content?.length || 0), 0);
}
function buildMemoryContext(sessionId) {
  const entry = memoryMap.get(sessionId);
  if (!entry) return [];
  // Convert stored messages + summaries to Anthropic style earlier context.
  const ctx = [];
  for (const s of entry.summaries)
    ctx.push({
      role: "assistant",
      content: [{ type: "text", text: "(summary) " + s.content }],
    });
  for (const m of entry.messages)
    ctx.push({ role: m.role, content: [{ type: "text", text: m.content }] });
  return ctx;
}

function summarizeOldMessages(entry) {
  if (!entry || entry.messages.length < 6) return; // require some depth
  const half = Math.floor(entry.messages.length / 2);
  const toSummarize = entry.messages.slice(0, half);
  const summaryText = toSummarize
    .map((m) =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`.slice(0, 300)
    )
    .join("\n");
  entry.summaries.push({ content: summaryText, ts: Date.now() });
  entry.messages = entry.messages.slice(half); // keep recent half
}

// Shared helper to store memory messages internally or via HTTP endpoint.
function storeMemoryMessage(sessionId, role, content) {
  if (!sessionId || typeof sessionId !== "string")
    return { error: "Missing sessionId" };
  if (!["user", "assistant", "system"].includes(role))
    return { error: "Invalid role" };
  if (typeof content !== "string" || !content.trim())
    return { error: "Invalid content" };
  const entry = memoryMap.get(sessionId) || {
    messages: [],
    summaries: [],
    chars: 0,
  };
  const now = Date.now();
  const last = entry.messages[entry.messages.length - 1];
  // Deduplicate identical consecutive messages of same role within short window (5s)
  if (
    last &&
    last.role === role &&
    last.content === content &&
    now - last.ts < 5000
  ) {
    return {
      ok: true,
      sessionId,
      deduped: true,
      counts: {
        messages: entry.messages.length,
        summaries: entry.summaries.length,
      },
      chars: entry.chars,
    };
  }
  entry.messages.push({ role, content, ts: now });
  entry.chars = estimateChars(entry.messages) + estimateChars(entry.summaries);
  if (entry.chars > MAX_MEMORY_CHARS) {
    summarizeOldMessages(entry);
    entry.chars =
      estimateChars(entry.messages) + estimateChars(entry.summaries);
    if (entry.chars > MAX_MEMORY_CHARS) {
      entry.messages.shift();
      entry.chars =
        estimateChars(entry.messages) + estimateChars(entry.summaries);
    }
  }
  memoryMap.set(sessionId, entry);
  return {
    ok: true,
    sessionId,
    counts: {
      messages: entry.messages.length,
      summaries: entry.summaries.length,
    },
    chars: entry.chars,
  };
}

app.post("/memory/append", async (req, res) => {
  const { sessionId, role, content } = req.body || {};
  const result = storeMemoryMessage(sessionId, role, content);
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

app.get("/memory/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  const entry = memoryMap.get(sessionId) || {
    messages: [],
    summaries: [],
    chars: 0,
  };
  return res.json({
    sessionId,
    messages: entry.messages,
    summaries: entry.summaries,
    chars: entry.chars,
  });
});

app.post("/memory/clear", (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  memoryMap.delete(sessionId);
  return res.json({ ok: true, sessionId });
});

// Removed static filesystem tool definitions; rely solely on dynamic registry (registerTools.js)

app.post("/api/mcp/servers", async (req, res) => {
  const {
    name = "default",
    type = "embedded",
    args = [],
    command = "",
    cwd = process.cwd(),
  } = req.body || {};
  const id = randomUUID();
  if (type === "embedded") {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
    await server.connect(transport);
    sessionServers.set(id, { server, transport, name, type, baseUrl: null });
    console.log("[MCP] created embedded server", id, name);
    return res.json({
      server: { id, name, type, path: `/mcp/${id}`, baseUrl: null },
    });
  }
  // Guard: disallow manual creation of filesystem/external servers; they must come from mcpServers.json config
  if (type === 'filesystem' || type === 'external') {
    return res.status(400).json({ error: 'Manual creation of external/filesystem servers is disabled; edit mcpServers.json and POST /admin/mcp/reload instead.' });
  }
  if (type === "filesystem") {
    // Launch external filesystem MCP server via npx @modelcontextprotocol/server-filesystem .
    // Windows requires npx.cmd; attempt cross-platform resolution
    let cmd = command || "npx";
    if (process.platform === "win32") {
      // If user passed just 'npx', use npx.cmd to avoid ENOENT
      if (cmd.toLowerCase() === "npx") cmd = "npx.cmd";
    }
    const fullArgs = args.length
      ? args
      : ["-y", "@modelcontextprotocol/server-filesystem", "."];
    let proc;
    const spawnAttempts = [];
    const trySpawn = (label, c, a) => {
      try {
        const p = spawn(c, a, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        p._spawnLabel = label;
        spawnAttempts.push({ label, command: c, args: a, ok: true });
        return p;
      } catch (err) {
        spawnAttempts.push({
          label,
          command: c,
          args: a,
          ok: false,
          error: String(err?.message || err),
        });
        return null;
      }
    };
    // Attempt sequence: primary cmd, if win32 also try alternative npx/npx.cmd, then npm exec
    proc = trySpawn("primary", cmd, fullArgs);
    if (!proc && process.platform === "win32" && cmd !== "npx.cmd") {
      proc = trySpawn("win-npx-cmd", "npx.cmd", fullArgs);
    }
    if (!proc) {
      const altCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      proc = trySpawn("npm-exec", altCmd, [
        "exec",
        "@modelcontextprotocol/server-filesystem",
        ".",
      ]);
    }
    // Final fallback: attempt direct node module resolution of package bin
    if (!proc) {
      try {
        const require = createRequire(import.meta.url);
        const pkgPath = require.resolve(
          "@modelcontextprotocol/server-filesystem/package.json"
        );
        const pkgDir = path.dirname(pkgPath);
        const raw = await fs.readFile(pkgPath, "utf8");
        const pkgJson = JSON.parse(raw);
        const candidates = [];
        if (typeof pkgJson.bin === "string")
          candidates.push(path.join(pkgDir, pkgJson.bin));
        if (pkgJson.bin && typeof pkgJson.bin === "object") {
          for (const v of Object.values(pkgJson.bin)) {
            candidates.push(path.join(pkgDir, v));
          }
        }
        // heuristic extra paths
        candidates.push(path.join(pkgDir, "index.js"));
        candidates.push(path.join(pkgDir, "dist", "index.js"));
        let script = null;
        for (const c of candidates) {
          try {
            await fs.access(c);
            script = c;
            break;
          } catch {}
        }
        if (script) {
          proc = trySpawn("direct-node", process.execPath, [script, "."]);
        } else {
          spawnAttempts.push({
            label: "direct-node",
            ok: false,
            error: "No viable bin script found",
            candidates,
          });
        }
      } catch (e) {
        spawnAttempts.push({
          label: "direct-node",
          ok: false,
          error: "Resolution failed: " + String(e?.message || e),
        });
      }
    }
    if (!proc) {
      // Try in-process import fallback if module is installed
      let inprocOk = false;
      try {
        const require = createRequire(import.meta.url);
        const mod = require("@modelcontextprotocol/server-filesystem");
        if (mod && typeof mod.createServer === "function") {
          const server = new McpServer({
            name: "filesystem-server-inproc",
            version: "1.0.0",
            capabilities: { tools: {}, resources: {} },
          });
          const transport = new StreamableHTTPServerTransport({
            path: `/mcp/${id}`,
          });
          await server.connect(transport);
          sessionServers.set(id, {
            server,
            transport,
            name,
            type: "filesystem-inproc",
            spawnAttempts,
            baseUrl: null,
            note: "Using in-process imported filesystem server; tools proxied locally.",
          });
          console.log("[MCP] created filesystem-inproc server", id, name);
          inprocOk = true;
          return res
            .status(200)
            .json({
              server: {
                id,
                name,
                type: "filesystem-inproc",
                path: `/mcp/${id}`,
                baseUrl: null,
                attempts: spawnAttempts,
                note: "In-process import fallback active.",
              },
            });
        }
      } catch {}
      if (!inprocOk) {
        // Degraded mode
        const server = new McpServer({
          name: "filesystem-server-degraded",
          version: "1.0.0",
          capabilities: { tools: {}, resources: {} },
        });
        const transport = new StreamableHTTPServerTransport({
          path: `/mcp/${id}`,
        });
        await server.connect(transport);
        sessionServers.set(id, {
          server,
          transport,
          name,
          type: "filesystem-degraded",
          spawnAttempts,
          baseUrl: null,
          warning:
            "All spawn attempts failed; static in-process file tools active.",
        });
        console.log("[MCP] created filesystem-degraded server", id, name);
        return res
          .status(200)
          .json({
            server: {
              id,
              name,
              type: "filesystem-degraded",
              path: `/mcp/${id}`,
              baseUrl: null,
              warning:
                "All spawn attempts failed; static in-process file tools active.",
              attempts: spawnAttempts,
            },
          });
      }
    }
    let started = false;
    let stderrBuf = "";
    let stdoutBuf = "";
    const birth = Date.now();
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      if (!started && /"root"|read_file|list_directory/.test(stdoutBuf))
        started = true;
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (/Error|ENOENT|EACCES|ECONNREFUSED/i.test(text))
        console.warn("[filesystem-mcp][stderr]", text.trim());
    });
    proc.on("exit", (code) => {
      console.log(
        "[filesystem-mcp] process exited",
        code,
        "label",
        proc._spawnLabel
      );
      const lifespan = Date.now() - birth;
      if (lifespan < 2000 && !started) {
        // Convert to degraded if process died immediately
        for (const [sid, entry] of sessionServers.entries()) {
          if (entry.proc === proc && entry.type === "filesystem") {
            console.warn(
              "[filesystem-mcp] external process exited too quickly; switching to degraded for server",
              sid
            );
            entry.type = "filesystem-degraded";
            entry.warning =
              "External process exited immediately; degraded static tools active.";
            entry.spawnAttempts = spawnAttempts;
            entry.stderr = stderrBuf.slice(-4000);
            entry.stdout = stdoutBuf.slice(-4000);
          }
        }
      }
    });
    proc.on("error", (err) => {
      console.error("[filesystem-mcp] spawn error", err);
      if (err?.code === 'ENOENT' && process.platform === 'win32') {
        console.warn('[filesystem-mcp] npm ENOENT on Windows. Suggestions:');
        console.warn('  - Update mcpServers.json: use "npm.cmd" instead of "npm" for command.');
        console.warn('  - Verify npm is on PATH. Run "where npm" in PowerShell.');
        console.warn('  - Ensure dependency installed: npm install @modelcontextprotocol/server-filesystem');
      }
    });
    // Create a local MCP client server wrapper to expose tools list via our HTTP transport
    const server = new McpServer({
      name: "filesystem-server",
      version: "1.0.0",
      capabilities: { tools: {}, resources: {} },
    });
    const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
    await server.connect(transport);
    // We do NOT register our own tools; external server is separate. We'll proxy its list.
    // Wrap external process with stdio JSON-RPC client (lazy init)
    let stdioClient = null;
    try {
      stdioClient = new StdioMcpClient(proc, { timeoutMs: 8000 });
    } catch (e) {
      console.warn("[filesystem-mcp] failed creating StdioMcpClient:", e);
    }
    sessionServers.set(id, {
      server,
      transport,
      name,
      type,
      proc,
      stdioClient,
      external: { command: cmd, args: fullArgs, cwd },
      baseUrl: null,
      stdout: () => stdoutBuf.slice(-4000),
      stderr: () => stderrBuf.slice(-4000),
    });
    // Attempt readiness probe (non-blocking)
    (async () => {
      if (!stdioClient) return;
      const ready = await waitForReady(stdioClient).catch(() => false);
      if (!ready) {
        console.warn(
          "[filesystem-mcp] readiness probe timed out; tools may be unavailable yet"
        );
      } else {
        console.log("[filesystem-mcp] external server reported tools list");
      }
    })();
    console.log("[MCP] created filesystem external server", id, name);
    return res.json({
      server: {
        id,
        name,
        type,
        path: `/mcp/${id}`,
        baseUrl: null,
        external: { command: cmd, args: fullArgs, cwd },
      },
    });
  }
  if (type === "external") {
    // Generic external MCP server (e.g. fetch server) using provided command & args.
    if (!command) {
      return res.status(400).json({ error: "Missing command for external server" });
    }
    let proc;
    const spawnAttempts = [];
    const trySpawn = (label, c, a) => {
      try {
        const p = spawn(c, a, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        p._spawnLabel = label;
        spawnAttempts.push({ label, command: c, args: a, ok: true });
        return p;
      } catch (err) {
        spawnAttempts.push({ label, command: c, args: a, ok: false, error: String(err?.message || err) });
        return null;
      }
    };
    proc = trySpawn("primary", command, args);
    if (!proc) {
      return res.status(500).json({ error: "Failed to spawn external MCP server", attempts: spawnAttempts });
    }
    let started = false;
    let stderrBuf = "";
    let stdoutBuf = "";
    const birth = Date.now();
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      if (!started && stdoutBuf.length > 0) started = true; // any output implies start
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (/Error|ENOENT|EACCES|ECONNREFUSED/i.test(text)) console.warn("[external-mcp][stderr]", text.trim());
    });
    proc.on("exit", (code) => {
      const lifespan = Date.now() - birth;
      console.log("[external-mcp] process exited", code, "label", proc._spawnLabel);
      if (lifespan < 2000 && !started) {
        for (const [sid, entry] of sessionServers.entries()) {
          if (entry.proc === proc && entry.type === "external") {
            entry.warning = "External MCP process exited immediately; no tools available.";
            entry.spawnAttempts = spawnAttempts;
            entry.stderr = stderrBuf.slice(-4000);
            entry.stdout = stdoutBuf.slice(-4000);
          }
        }
      }
    });
    proc.on("error", (err) => console.error("[external-mcp] spawn error", err));

    const server = new McpServer({ name: `${name}-external-mcp`, version: "1.0.0", capabilities: { tools: {}, resources: {} } });
    const transport = new StreamableHTTPServerTransport({ path: `/mcp/${id}` });
    await server.connect(transport);
    let stdioClient = null;
    try { stdioClient = new StdioMcpClient(proc, { timeoutMs: 8000 }); } catch (e) { console.warn("[external-mcp] failed creating StdioMcpClient:", e); }
    sessionServers.set(id, {
      server,
      transport,
      name,
      type: "external",
      proc,
      stdioClient,
      external: { command, args, cwd },
      baseUrl: null,
      stdout: () => stdoutBuf.slice(-4000),
      stderr: () => stderrBuf.slice(-4000),
      spawnAttempts,
    });
    (async () => {
      if (!stdioClient) return;
      const ready = await waitForReady(stdioClient).catch(() => false);
      if (!ready) console.warn("[external-mcp] readiness probe timed out; tools may be unavailable yet");
      else console.log("[external-mcp] external server reported tools list readiness");
    })();
    // Bridge generic external server tools into internal registry (non-blocking)
    (async () => {
      if (!stdioClient) return;
      try {
        const tools = await stdioClient.listTools({ forceRefresh: true });
        if (Array.isArray(tools)) {
          for (const t of tools) {
            if (!t?.name) continue;
            const baseName = t.name;
            let finalName = baseName;
            if (TOOL_DEFS[finalName]) finalName = `${name}:${baseName}`;
            if (TOOL_DEFS[finalName]) continue; // still collision
            const rawSchema = t.input_schema || t.inputSchema || { type: 'object', properties: {} };
            const props = rawSchema.properties || {};
            const required = Array.isArray(rawSchema.required) ? rawSchema.required : [];
            const shape = {};
            for (const [pk, pv] of Object.entries(props)) {
              const pType = pv?.type || 'string';
              let zType;
              switch (pType) {
                case 'number': zType = z.number(); break;
                case 'boolean': zType = z.boolean(); break;
                default: zType = z.string(); break;
              }
              if (!required.includes(pk)) zType = zType.optional();
              shape[pk] = zType;
            }
            const inputSchema = z.object(shape);
            const handler = async (args = {}) => {
              try {
                const result = await stdioClient.callTool(baseName, args);
                if (result && result.content) return result;
                return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
              } catch (err) {
                return { content: [{ type: 'text', text: 'External tool error: ' + String(err?.message || err) }] };
              }
            };
            try {
              addTool({ name: finalName, description: t.description || '', inputSchema, handler, origin: name });
              try { server.tool(finalName, t.description || '', inputSchema, handler); } catch {}
              console.log('[MCP] bridged external tool', finalName, 'from manual external server', name);
            } catch (e) {
              console.warn('[MCP] failed bridging external generic tool', finalName, e);
            }
          }
        }
      } catch (e) {
        console.warn('[MCP] bridge external generic tools failed', name, e?.message || e);
      }
    })();
    console.log("[MCP] created generic external server", id, name);
    return res.json({ server: { id, name, type: "external", path: `/mcp/${id}`, baseUrl: null, attempts: spawnAttempts } });
  }
  return res.status(400).json({ error: "Unsupported server type" });
});

app.get("/api/mcp/servers", (req, res) => {
  const servers = [...sessionServers.entries()].map(([id, v]) => ({
    id,
    name: v.name,
    type: v.type,
    path: `/mcp/${id}`,
    baseUrl: v.baseUrl || null,
    warning: v.warning || null,
    attempts: v.spawnAttempts ? v.spawnAttempts.slice(-10) : undefined,
    toolCount: typeof v.toolCount === 'number' ? v.toolCount : undefined,
  }));
  return res.json({ servers });
});

// Diagnostics for a single server (spawn attempts, stderr/stdout buffers if captured later)
app.get("/api/mcp/servers/:id/diagnostics", (req, res) => {
  const { id } = req.params;
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: "Server not found" });
  return res.json({
    id,
    name: entry.name,
    type: entry.type,
    warning: entry.warning || null,
    attempts: entry.spawnAttempts || [],
    external: entry.external || null,
    stdout:
      typeof entry.stdout === "function"
        ? entry.stdout()
        : entry.stdout || null,
    stderr:
      typeof entry.stderr === "function"
        ? entry.stderr()
        : entry.stderr || null,
  });
});

app.delete("/api/mcp/servers/:id", (req, res) => {
  const { id } = req.params || {};
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  try {
    entry.transport.close?.();
  } catch {}
  sessionServers.delete(id);
  return res.json({ ok: true });
});

app.get("/api/mcp/servers/:id/tools", async (req, res) => {
  const { id } = req.params || {};
  const entry = sessionServers.get(id);
  if (!entry) {
    console.warn(
      "[MCP] tools request for missing server id",
      id,
      "current size",
      sessionServers.size
    );
    return res.status(404).json({ error: "Server not found" });
  }
  if (entry.type === "embedded") {
    const tools = Object.values(TOOL_DEFS).map((def) => ({
      name: def.name,
      description: def.description,
    }));
    return res.json({ tools });
  }
  if (entry.type === "filesystem") {
    // Use JSON-RPC tools/list via StdioMcpClient
    const client = entry.stdioClient;
    if (!client) {
      return res
        .status(500)
        .json({ error: "MCP stdio client not available (spawn failure?)" });
    }
    try {
      const tools = await client.listTools({ forceRefresh: true });
      return res.json({ tools });
    } catch (e) {
      console.warn("[MCP] tools/list error via stdio client:", e);
      return res.json({
        tools: [],
        warning:
          "Failed JSON-RPC tools/list; no fallback static list (removed).",
      });
    }
  }
  if (entry.type === "external") {
    const client = entry.stdioClient;
    if (!client) {
      return res.status(500).json({ error: "MCP stdio client not available (spawn failure?)" });
    }
    try {
      const tools = await client.listTools({ forceRefresh: true });
      entry.toolCount = Array.isArray(tools) ? tools.length : 0;
      return res.json({ tools });
    } catch (e) {
      console.warn("[MCP] tools/list error via external stdio client:", e);
      return res.json({ tools: [], warning: "Failed JSON-RPC tools/list from external server." });
    }
  }
  if (entry.type === "filesystem-degraded") {
    return res.json({
      tools: [],
      warning: "Process spawn failed; degraded mode without static tool list.",
    });
  }
  if (entry.type === "filesystem-inproc") {
    return res.json({
      tools: Object.values(TOOL_DEFS).map((def) => ({
        name: def.name,
        description: def.description,
      })),
      note: "In-process fallback exposing dynamic registry tools only.",
    });
  }
  return res.status(400).json({ error: "Unsupported server type" });
});

app.post("/api/mcp/servers/:id/tool-call", async (req, res) => {
  const { id } = req.params || {};
  const { toolName, tool, arguments: args = {} } = req.body || {};
  const name = toolName || tool;
  const entry = sessionServers.get(id);
  if (!entry) return res.status(404).json({ error: "Server not found" });
  // If external filesystem server, prefer JSON-RPC call
  if (entry.type === "filesystem") {
    const client = entry.stdioClient;
    if (!client)
      return res
        .status(500)
        .json({ error: "Missing stdio client for external server" });
    try {
      const result = await client.callTool(name, args || {});
      return res.json({ result, tool: name, transport: "json-rpc" });
    } catch (e) {
      console.warn(
        "[MCP] tools/call JSON-RPC failed; attempting local fallback:",
        e
      );
      // Fallback to local TOOL_DEFS if available
      const def = TOOL_DEFS[name];
      if (!def)
        return res
          .status(500)
          .json({
            error: "JSON-RPC call failed and no local fallback tool",
            details: String(e?.message || e),
          });
      try {
        const r = await def.handler(args || {});
        return res.json({ result: r, tool: name, transport: "fallback-local" });
      } catch (e2) {
        return res
          .status(500)
          .json({
            error: "Both JSON-RPC and fallback local handler failed",
            details: String(e2?.message || e2),
          });
      }
    }
  } else {
    // Local embedded or degraded/inproc: use TOOL_DEFS directly
    const def = TOOL_DEFS[name];
    if (!def) return res.status(404).json({ error: "Tool not found" });
    try {
      const r = await def.handler(args || {});
      return res.json({ result: r, tool: name, transport: "local" });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }
  if (entry.type === "external") {
    const client = entry.stdioClient;
    if (!client) return res.status(500).json({ error: "Missing stdio client for external server" });
    try {
      const result = await client.callTool(name, args || {});
      // bump tool usage count introspectively if needed; optional logic
      return res.json({ result, tool: name, transport: "json-rpc" });
    } catch (e) {
      console.warn("[MCP] external tools/call JSON-RPC failed", e);
      return res.status(500).json({ error: "External JSON-RPC call failed", details: String(e?.message || e) });
    }
  }
});

// ---------------- mcpServers.json admin endpoints -----------------
// GET current config file content
app.get('/admin/mcp/config', async (req, res) => {
  try {
    const cfgPath = path.join(process.cwd(), 'mcpServers.json');
    const raw = await fs.readFile(cfgPath, 'utf8').catch(() => null);
    if (!raw) return res.json({ ok: true, config: null, missing: true });
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return res.status(400).json({ error: 'Invalid JSON in mcpServers.json', details: String(e?.message || e) }); }
    return res.json({ ok: true, config: parsed });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
// POST to write new config and reload (replace existing external servers)
app.post('/admin/mcp/reload', async (req, res) => {
  const { config, replace = true } = req.body || {};
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Missing config object' });
  if (!config.mcpServers || typeof config.mcpServers !== 'object') return res.status(400).json({ error: 'config.mcpServers missing or not object' });
  try {
    const cfgPath = path.join(process.cwd(), 'mcpServers.json');
    await fs.writeFile(cfgPath, JSON.stringify(config, null, 4), 'utf8');
    const result = await spawnServersFromConfig({ replace });
    return res.json({ ok: true, reload: result });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /admin/mcp/sync -> { reload?: boolean, replace?: boolean }
// Reloads config optionally, then attempts readiness & tool bridging for all servers.
app.post('/admin/mcp/sync', async (req, res) => {
  const { reload = false, replace = false, timeoutMs = 8000 } = req.body || {};
  try {
    const summary = await syncMcpConfig({ reload, replace, readinessTimeoutMs: timeoutMs });
    return res.json({ ok: true, summary });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------- Anthropic basic streaming proxy ------------------
// SSE endpoint: /anthropic/chat { prompt, model?, max_tokens? }
app.post("/anthropic/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const {
    prompt,
    model: requestedModel,
    max_tokens = 512,
    sessionId,
  } = req.body || {};
  const defaultModel =
    process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  let model = requestedModel || defaultModel;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Invalid prompt" });
  }
  // Prepend memory context if provided
  const memoryMessages = sessionId ? buildMemoryContext(sessionId) : [];
  // Build dynamic tool schema only if header present (tool usage toggle)
  const forceEnable = req.headers['x-force-enable-tools'] === '1';
  const tools = forceEnable ? buildAnthropicTools() : [];
  const toolListForSystem = Object.values(TOOL_DEFS)
    .map((def) => `- ${def.name}: ${def.description}`)
    .join("\n");
  const system = `You are a helpful assistant.\nRuntime tools available (list ONLY when the user explicitly asks about tools/capabilities):\n${forceEnable ? (toolListForSystem || '- (no tools registered)') : '- (tools disabled for this request)'}\nGuidelines:\n- Do NOT invent tools.\n- When tools are disabled, answer using existing knowledge and clarify limitations if fresh data required.`;
  if (sessionId) {
    // Store user message before model call
    storeMemoryMessage(sessionId, "user", prompt);
  }
  let aggregatedAssistant = "";
  if (!apiKey) {
    // Mock stream fallback for local dev without key
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const fake = [
      "Mock response: no ANTHROPIC_API_KEY set.",
      "Set the key to receive real Claude streaming tokens.",
    ];
    for (const chunk of fake) {
      res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      await new Promise((r) => setTimeout(r, 300));
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  try {
    // Helper: produce ordered list of candidate models for fallback
    function getModelCandidates(primary) {
      const envRaw = process.env.ANTHROPIC_MODEL_CANDIDATES;
      const base = envRaw ? envRaw.split(/[,\s]+/).filter(Boolean) : [
        "claude-3-5-sonnet",
        "claude-3-5-sonnet-latest",
        "claude-3-5-haiku",
        "claude-3-5-haiku-latest",
        "claude-3-opus",
        "claude-3-opus-latest"
      ];
      const dedup = [];
      const seen = new Set();
      if (primary && !seen.has(primary)) { dedup.push(primary); seen.add(primary); }
      for (const m of base) { if (!seen.has(m)) { dedup.push(m); seen.add(m); } }
      return dedup;
    }
    // Optional cached model list from Anthropic
    let cachedModelList = globalThis.__anthropic_model_list_cache__ || null;
    const nowTs = Date.now();
    if (!cachedModelList || (nowTs - cachedModelList.ts) > 5 * 60 * 1000) {
      try {
        if (apiKey) {
          const listResp = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
          if (listResp.ok) {
            const data = await listResp.json().catch(()=>null);
            const names = Array.isArray(data?.data) ? data.data.map(d => d.id).filter(Boolean) : [];
            cachedModelList = { ts: nowTs, names };
            globalThis.__anthropic_model_list_cache__ = cachedModelList;
          }
        }
      } catch {}
    }
    const availableNames = cachedModelList?.names || [];
    function pickFallback(tried) {
      const candidates = getModelCandidates(model);
      for (const cand of candidates) {
        if (tried.includes(cand)) continue;
        // If we have a list of available names, prefer ones present
        if (availableNames.length && !availableNames.includes(cand)) continue;
        return cand;
      }
      return null;
    }
    async function callAnthropic(modelName) {
      const body = {
        model: modelName,
        max_tokens,
        messages: memoryMessages.concat([{ role: "user", content: prompt }]),
        system,
        tools, // allow Claude to enumerate / potentially call tools (multi-turn orchestration not yet implemented here)
        stream: true,
      };
      return await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }
    let upstream = await callAnthropic(model);
    if (!upstream.ok && upstream.status === 404) {
      const tried = [model];
      let fb;
      while ((fb = pickFallback(tried))) {
        tried.push(fb);
        const attempt = await callAnthropic(fb);
        if (attempt.ok) { upstream = attempt; model = fb; break; }
      }
    }
    if (!upstream.ok || !upstream.body) {
      let details = "";
      try {
        details = await upstream.text();
      } catch {}
      return res
        .status(upstream.status)
        .json({
          error: `Anthropic upstream error ${upstream.status}`,
          modelTried: model,
          fallbackAttempted: upstream.status === 404,
          details: details.slice(0, 400),
        });
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const reader = upstream.body.getReader();
    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
      try {
        reader.cancel();
      } catch {}
    });
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (cancelled) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\n/);
      buffer = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line === "data: [DONE]") {
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        if (!line.startsWith("data:")) continue;
        try {
          const payload = JSON.parse(line.slice(5));
          // Pass through tool_use events as discrete SSE messages for client awareness
          if (payload?.type === 'tool_use') {
            res.write(`data: ${JSON.stringify({ tool_use: payload })}\n\n`);
          }
          const delta =
            payload?.delta?.text ||
            payload?.content_block?.text ||
            payload?.text ||
            (payload?.type === "content_block_delta" &&
            payload?.delta?.type === "text_delta"
              ? payload?.delta?.text
              : "");
          if (delta) {
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            if (sessionId) {
              // Accumulate assistant text for memory after stream completes
              aggregatedAssistant += delta;
            }
          }
        } catch {}
      }
    }
    if (sessionId && aggregatedAssistant.trim()) {
      storeMemoryMessage(sessionId, "assistant", aggregatedAssistant.trim());
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Proxy failure", details: String(e?.message || e) });
  }
});

// ---------------- Anthropic tool-aware streaming (multi-turn) -------------
// Emits structured events: model_used, tool_use, tool_result, tool_error, assistant_text, done
// Strategy: iterative non-stream Anthropic calls to capture tool_use blocks; final answer streamed in chunks.
app.post("/anthropic/ai/chat-stream", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const {
    prompt,
    model: requestedModel,
    sessionId,
    max_iterations = 5,
  } = req.body || {};
  const defaultModel =
    process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  let model = requestedModel || defaultModel;
  if (typeof prompt !== "string" || !prompt.trim())
    return res.status(400).json({ error: "Invalid prompt" });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!apiKey) {
    send({ type: "model_used", model: "mock-anthropic" });
    send({
      type: "assistant_text",
      text: "Mock (no key). " + prompt.slice(0, 160),
    });
    send({ type: "done" });
    return res.end();
  }

  if (sessionId) storeMemoryMessage(sessionId, "user", prompt);
  const forceEnable2 = req.headers['x-force-enable-tools'] === '1';
  const tools = forceEnable2 ? buildAnthropicTools() : [];
  const toolListForSystem = Object.values(TOOL_DEFS)
    .map((def) => `- ${def.name}: ${def.description}`)
    .join("\n");
  const system = `You are a helpful assistant.
${forceEnable2 ? 'You currently have access to the following runtime tools (enumerate ONLY when asked):\n' + (toolListForSystem || '- (no tools registered)') : 'Tools are disabled for this request. Do not claim tool usage.'}\nInstructions:\n- If tools are enabled and external data is needed, invoke a tool with correct arguments.\n- If tools are disabled and the user asks you to use one, politely state they are disabled and how to enable them.`;
  let messages = (sessionId ? buildMemoryContext(sessionId) : []).concat([
    { role: "user", content: prompt },
  ]);

  async function anthropicOnce(currentModel) {
    const body = {
      model: currentModel,
      max_tokens: 512,
      system,
      messages,
      tools,
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let txt = await r.text().catch(() => "");
      if (r.status === 404) {
        // Fallback logic via candidate list
        const envRaw = process.env.ANTHROPIC_MODEL_CANDIDATES;
        const base = envRaw ? envRaw.split(/[,\s]+/).filter(Boolean) : [
          "claude-3-5-sonnet",
          "claude-3-5-sonnet-latest",
          "claude-3-5-haiku",
          "claude-3-5-haiku-latest",
          "claude-3-opus",
          "claude-3-opus-latest"
        ];
        const tried = new Set([currentModel]);
        for (const cand of base) {
          if (tried.has(cand)) continue;
          tried.add(cand);
          const r2 = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...body, model: cand }),
          });
          if (r2.ok) {
            model = cand;
            return await r2.json();
          }
        }
      }
      throw new Error(`Anthropic upstream error ${r.status}: ${txt.slice(0,180)}`);
    }
    return await r.json();
  }

  send({ type: "model_used", model });
  let finalText = "";
  for (let iter = 0; iter < max_iterations; iter++) {
    let response;
    try {
      response = await anthropicOnce(model);
    } catch (e) {
      send({ type: "error", error: String(e?.message || e) });
      break;
    }
    const contentBlocks = response.content || [];
    const toolUses = contentBlocks.filter((b) => b.type === "tool_use");
    const textBlocks = contentBlocks.filter((b) => b.type === "text");
    // If there are tool uses, execute them then append results and loop
    if (toolUses.length) {
      // Append tool_use blocks (assistant role)
      messages.push({ role: "assistant", content: contentBlocks });
      const collectedResults = [];
      for (const t of toolUses) {
        const toolName = t.name;
        const toolArgs = t.input || {};
        const toolId = t.id || t.tool_use_id || `${toolName}-${Date.now()}`;
        send({
          type: "tool_use",
          tool: toolName,
          args: toolArgs,
          id: toolId,
          iteration: iter,
        });
  const originalName = mapAnthropicToolNameBack(toolName);
  const def = TOOL_DEFS[originalName];
        if (!def) {
          send({
            type: "tool_error",
            tool: toolName,
            error: "Tool not registered",
          });
          continue;
        }
        try {
          const result = await def.handler(toolArgs);
          // result.content is an array of blocks; convert to string snippet
          const textOut = Array.isArray(result?.content)
            ? result.content.map((c) => c.text || "").join("\n")
            : JSON.stringify(result);
          send({
            type: "tool_result",
            tool: toolName,
            id: toolId,
            output: textOut.slice(0, 4000),
          });
          collectedResults.push({
            type: "tool_result",
            tool_use_id: toolId,
            content: [{ type: "text", text: textOut.slice(0, 8000) }],
          });
        } catch (err) {
          send({
            type: "tool_error",
            tool: toolName,
            id: toolId,
            error: String(err?.message || err),
          });
        }
      }
      if (collectedResults.length) {
        // Anthropic requires tool_result blocks inside a user role message
        messages.push({ role: "user", content: collectedResults });
      }
      // Continue loop to let model observe tool results
      continue;
    }
    // No tool uses: finalize with text
    if (textBlocks.length) {
      finalText = textBlocks.map((tb) => tb.text).join("\n");
      // Stream in pseudo-chunks for client consistency
      const chunkSize = 200;
      let i = 0;
      while (i < finalText.length) {
        send({
          type: "assistant_text",
          text: finalText.slice(i, i + chunkSize),
        });
        i += chunkSize;
      }
      break;
    } else {
      // If no text and no tools, we are done
      break;
    }
  }
  if (sessionId && finalText.trim())
    storeMemoryMessage(sessionId, "assistant", finalText.trim());
  send({ type: "done", final: finalText.slice(0, 8000) });
  return res.end();
});

// Debug endpoint for local Node server: show Anthropic tool schema that would be sent
app.get("/anthropic/debug/tools", (req, res) => {
  try {
    // buildAnthropicTools maps registered TOOL_DEFS to Anthropic schema
    const tools = buildAnthropicTools();
    // Also return current runtime TOOL_DEFS keys for inspection
    const runtimeToolNames = Object.keys(TOOL_DEFS || {});
    return res.json({ ok: true, tools, runtimeToolNames });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Anthropic Models listing -> /anthropic/models (diagnostic helper)
app.get("/anthropic/models", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({
      error: "Failed to list models",
      details: String(e?.message || e),
    });
  }
});

// Allow port override for cloud platforms (Render, Railway, etc.)
const PORT = process.env.PORT || 3100;

// ---------------------- Anthropic tool-calling endpoint -------------------
// Accepts { prompt, model?, max_iterations? } and invokes Claude with tools.
// Requires ANTHROPIC_API_KEY. Uses the static forecast tool when appropriate.
app.post("/anthropic/ai/chat", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mockMode = process.env.ANTHROPIC_MOCK === "1" || !apiKey;
  if (!apiKey && !mockMode)
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
  const {
    prompt,
    model: requestedModel = process.env.ANTHROPIC_MODEL ||
      "claude-3-5-sonnet-latest",
    max_iterations = 3,
    sessionId,
  } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim())
    return res.status(400).json({ error: "Invalid prompt" });

  // Build Anthropic tool schema
  const forceEnable3 = req.headers['x-force-enable-tools'] === '1';
  const tools = forceEnable3 ? buildAnthropicTools() : [];
  let currentModel = requestedModel;
  const steps = [];
  // Represent user prompt as content block array for consistency
  const messages = (sessionId ? buildMemoryContext(sessionId) : []).concat([
    { role: "user", content: [{ type: "text", text: prompt }] },
  ]);
  if (sessionId) storeMemoryMessage(sessionId, "user", prompt);
  // Dynamic system prompt: enumerate runtime tools for capability questions
  const toolListForSystem = Object.values(TOOL_DEFS)
    .map((def) => `- ${def.name}: ${def.description}`)
    .join("\n");
  const system = `You are a helpful assistant.
${forceEnable3 ? 'You currently have access to the following runtime tools (enumerate them ONLY when the user asks what tools/capabilities you have):\n' + (toolListForSystem || '- (no tools registered)') : 'Tools are disabled for this request. Do not list or claim capabilities.'}\nIf the user asks about capabilities: ${forceEnable3 ? 'List ONLY the tools above with brief descriptions.' : 'Explain that runtime tools are currently disabled.'} For all other queries, reply normally. Keep answers concise and relevant.`;
  let finalText = "";

  async function anthropicCall(toolResults = []) {
    // Anthropic expects messages with role user/assistant only. Tool results are passed via content blocks of type 'tool_result'.
    const body = {
      model: currentModel,
      max_tokens: 512,
      system,
      messages: messages.concat(toolResults),
      tools,
      // Use "auto" tool choice implicitly; Anthropic will decide
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let details = await r.text().catch(()=>"");
      if (r.status === 404) {
        const envRaw = process.env.ANTHROPIC_MODEL_CANDIDATES;
        const base = envRaw ? envRaw.split(/[,\s]+/).filter(Boolean) : [
          "claude-3-5-sonnet",
          "claude-3-5-sonnet-latest",
          "claude-3-5-haiku",
          "claude-3-5-haiku-latest",
          "claude-3-opus",
          "claude-3-opus-latest"
        ];
        const tried = new Set([currentModel]);
        for (const cand of base) {
          if (tried.has(cand)) continue;
          tried.add(cand);
          const r2 = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...body, model: cand }),
          });
          if (r2.ok) { currentModel = cand; return await r2.json(); }
        }
      }
      throw new Error(`Anthropic upstream error ${r.status}: ${details.slice(0,200)}`);
    }
    return await r.json();
  }

  // Mock path: directly decide whether to call tool
  if (mockMode) {
    const steps = [];
    let finalText = "";
    return res.json({
      text: "Anthropic API key missing (mock mode). Set ANTHROPIC_API_KEY on the server to receive real Claude responses.",
      steps,
      model: "mock-anthropic",
      mode: "anthropic-mock",
    });
  }

  try {
    for (let i = 0; i < max_iterations; i++) {
      const response = await anthropicCall();
      const contentBlocks = response.content || [];
      if (contentBlocks.length) {
        messages.push({ role: "assistant", content: contentBlocks });
        const textParts = contentBlocks
          .filter((c) => c.type === "text")
          .map((t) => t.text)
          .join("\n")
          .trim();
        if (textParts) finalText = textParts;
      }
      break; // tools removed; single iteration
    }
    return res.json({
      text: finalText,
      steps,
      model: currentModel,
      mode: "anthropic-tool-assisted",
      memory: sessionId ? { sessionId } : undefined,
    });
  } catch (e) {
    console.error("[anthropic/ai/chat] failure:", e);
    return res
      .status(500)
      .json({
        error: "Anthropic tool orchestration failed",
        details: String(e?.message || e),
      });
  }
});

app.listen(PORT, () => {
  const originDisplay = ALLOWED_ORIGINS.includes("*")
    ? "*"
    : ALLOWED_ORIGINS.join(", ");
  console.log(
    `MCP Streamable HTTP Server listening at http://localhost:${PORT} (allowed origins: ${originDisplay})`
  );
});

// ---------------------- Runtime tool registration endpoints ------------------
// Simple admin endpoints to register proxy tools at runtime.
// POST /admin/tools/register
//   body: { name, description, inputs: { key: 'string'|'number'|'boolean' }, invokeUrl }
// GET /admin/tools -> list currently registered tool names
// DELETE /admin/tools/:name -> remove from registry (affects new sessions)

app.post("/admin/tools/register", express.json(), async (req, res) => {
  const { name, description, inputs = {}, invokeUrl } = req.body || {};
  if (!name || !invokeUrl)
    return res.status(400).json({ error: "Missing name or invokeUrl" });
  try {
    // Build a zod object schema from inputs map
    const shape = {};
    for (const [k, t] of Object.entries(inputs || {})) {
      if (t === "string") shape[k] = z.string();
      else if (t === "number") shape[k] = z.number();
      else if (t === "boolean") shape[k] = z.boolean();
      else shape[k] = z.any();
    }
    const inputSchema = z.object(shape);

    // Create a proxy handler that forwards args to the provided invokeUrl
    const handler = async (args = {}) => {
      try {
        const r = await fetch(invokeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        const text = await r.text();
        // Try parse JSON to make nicer output
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const out = parsed
          ? typeof parsed === "string"
            ? parsed
            : JSON.stringify(parsed)
          : text;
        return { content: [{ type: "text", text: String(out) }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Invocation error: ${String(e?.message || e)}`,
            },
          ],
        };
      }
    };

    const def = { name, description: description || "", inputSchema, handler };
    addTool(def);

    // Register on active session servers (attach to underlying MCP server instance)
    for (const [, entry] of sessionServers.entries()) {
      try {
        entry.server?.tool?.(def.name, def.description, def.inputSchema, def.handler);
      } catch (err) {
        // Non-fatal; continue
        console.warn('[admin/tools/register] failed attaching tool to server', entry.name, err?.message || err);
      }
    }

    return res.json({ ok: true, tool: name });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/admin/tools", (req, res) => {
  try {
    return res.json({ tools: Object.keys(TOOL_DEFS) });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Simple health endpoint for tool invocation tests
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), status: 'healthy' });
});

app.delete("/admin/tools/:name", (req, res) => {
  const { name } = req.params || {};
  if (!name) return res.status(400).json({ error: "Missing name" });
  const ok = removeTool(name);
  return res.json({ ok, removed: name });
});

// Tool usage log endpoint (in-memory; resets on server restart)
app.get("/admin/tools/usage", (req, res) => {
  try {
    const log = getToolUsageLog();
    return res.json({ entries: log.slice(-200) }); // cap size
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Optional export for serverless adapters or test harnesses
export { app };
