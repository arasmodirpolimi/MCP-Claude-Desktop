// src/lib/summarizeWithAnthropic.js
// NOTE: This file lives in src/assistants/, so import the Anthropic assistant with a relative path in the same folder.
// Previous path went up one level and back down (../assistants/anthropic) causing ERR_MODULE_NOT_FOUND in Node tests.
import { Assistant } from "./anthropic.js";

// Heuristic HTML -> plain text extractor (client side, lightweight)
function stripHtml(html) {
  if (typeof html !== "string") return "";
  // Remove scripts/styles
  let txt = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Keep alt text of images
  txt = txt.replace(/<img [^>]*alt="([^"]*)"[^>]*>/gi, "$1 ");
  // Replace block tags with newlines
  txt = txt.replace(/<\/(p|div|h[1-6]|li|section|article|br|tr)>/gi, "\n");
  // Strip the rest of tags
  txt = txt.replace(/<[^>]+>/g, " ");
  // Decode a few common entities
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  txt = txt.replace(/&(amp|lt|gt|quot|#39);/g, m => entities[m] || m);
  // Collapse whitespace
  txt = txt.replace(/\s+/g, ' ').trim();
  return txt;
}

function extractReadable(toolOutput) {
  if (!toolOutput) return "";
  // If it's already a string
  if (typeof toolOutput === 'string') {
    // Detect if looks like HTML
    if (/<html[\s>]/i.test(toolOutput) || /<p[\s>]/i.test(toolOutput)) {
      return stripHtml(toolOutput);
    }
    return toolOutput;
  }
  // If toolOutput has a typical MCP shape: { content: [ { type:'text', text: '...' } ] }
  if (Array.isArray(toolOutput.content)) {
    const joined = toolOutput.content
      .map(c => (c && typeof c === 'object' && 'text' in c ? c.text : ''))
      .join('\n');
    return extractReadable(joined);
  }
  // If it has body field (like a custom fetch tool)
  if (typeof toolOutput === 'object' && toolOutput.body) {
    return extractReadable(toolOutput.body);
  }
  // Fallback to JSON string
  try { return JSON.stringify(toolOutput); } catch { return String(toolOutput); }
}

const buildPrompt = (toolName, cleanedExcerpt, userPrompt, truncated) => `You are an expert assistant.
The following tool was executed to help answer the user's request.
Tool: ${toolName}

Relevant extracted content (plain text${truncated ? ', truncated' : ''}):
"""
${cleanedExcerpt}
"""

User request:
${userPrompt || '(no user prompt captured)'}

Instructions:
1. Provide a concise, faithful answer.
2. Do NOT hallucinate details not present in the content unless they are universally known basics.
3. If the content seems truncated, note that politely then answer using what is available.
4. Return the answer in one well-structured paragraph unless the user asked otherwise.
`;

export async function summarizeWithAnthropic({ toolName, toolOutput, userPrompt, model = "claude-3-5-sonnet-latest" }) {
  const assistant = new Assistant(model);
  const rawClean = extractReadable(toolOutput);
  // Limit size to keep token usage reasonable
  const MAX_CHARS = 12000; // ~ a few thousand tokens
  const truncated = rawClean.length > MAX_CHARS;
  const excerpt = truncated ? rawClean.slice(0, MAX_CHARS) : rawClean;
  const prompt = buildPrompt(toolName, excerpt, userPrompt, truncated);
  try {
    const text = await assistant.chat(prompt);
    if (typeof text === 'string' && text.trim()) return text.trim();
  } catch (e) {
    // fall through to local summarization
  }
  // Local fallback summarization (no Anthropic key / network failure)
  const sentences = excerpt
    .replace(/\s+/g, ' ') // normalize whitespace
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 30);
  // Prioritize sentences mentioning the main subject (heuristic for page-based summaries)
  const subject = (userPrompt || '').match(/\b([A-Z][A-Za-z0-9_-]{2,})\b/)?.[1] || toolName;
  const ranked = sentences.sort((a,b) => {
    const as = a.toLowerCase().includes(subject.toLowerCase()) ? 0 : 1;
    const bs = b.toLowerCase().includes(subject.toLowerCase()) ? 0 : 1;
    return as - bs;
  });
  const selected = ranked.slice(0, 5);
  const localSummary = selected.join(' ').trim();
  return localSummary || excerpt.slice(0, 600).trim();
}

// Export internal helpers for testing
export const _internalSummarizeHelpers = { stripHtml, extractReadable };
