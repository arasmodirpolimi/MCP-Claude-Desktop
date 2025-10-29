#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// ---- STATIC MODE FLAG -------------------------------------------------------
const STATIC_MODE = process.argv.includes("--static");
// Small helper for consistent dividers
const SEP = "---";
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: "weather",
    version: "1.0.0",
    capabilities: { resources: {}, tools: {} },
});

// No tools registered (dynamic weather handled elsewhere via HTTP endpoints)
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Weather MCP Server running on stdio${STATIC_MODE ? " (STATIC MODE)" : ""}`);
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
