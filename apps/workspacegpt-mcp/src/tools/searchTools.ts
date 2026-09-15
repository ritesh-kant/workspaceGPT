import { z } from 'zod';
import { SearchEngine } from '../search/searchEngine.js';
import type { SearchResult } from '../search/reranker.js';

/**
 * Formats search results into human-readable text for the MCP response.
 */
export function formatResults(results: SearchResult[], source: string): string {
  if (results.length === 0) {
    return `No relevant results found in ${source}.`;
  }

  const lines: string[] = [`Found ${results.length} relevant result(s) from ${source}:\n`];

  results.forEach((result, index) => {
    lines.push(`---`);
    lines.push(`### Result ${index + 1} — ${result.data.fileName}`);
    lines.push(`**Source**: ${result.data.sourceName}`);
    if (result.data.source) {
      lines.push(`**URL**: ${result.data.source}`);
    }
    lines.push(`**Relevance**: ${(result.score * 100).toFixed(1)}%`);
    lines.push('');
    lines.push(result.text);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Tool handler for search_confluence
 */
export function createSearchConfluenceTool(engine: SearchEngine) {
  return {
    name: 'search_confluence',
    description:
      'Search the Confluence knowledge base for documentation, guides, runbooks, architecture docs, and other wiki content. ' +
      'Use this when the user asks about processes, documentation, how-to guides, or general company knowledge.',
    inputSchema: z.object({
      query: z.string().describe('The search query — a natural language question or keywords'),
      topK: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
    handler: async (args: { query: string; topK?: number }) => {
      const results = await engine.search(args.query, 'confluence', args.topK ?? 10);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatResults(results, 'Confluence'),
          },
        ],
      };
    },
  };
}

/**
 * Tool handler for search_ado
 */
export function createSearchAdoTool(engine: SearchEngine) {
  return {
    name: 'search_ado',
    description:
      'Search Azure DevOps (ADO) work items including bugs, user stories, tasks, epics, and other tickets. ' +
      'Use this when the user asks about specific tickets, sprints, bugs, tasks, work items, or project tracking.',
    inputSchema: z.object({
      query: z.string().describe('The search query — ticket ID, keywords, or natural language question'),
      topK: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
    handler: async (args: { query: string; topK?: number }) => {
      const results = await engine.search(args.query, 'ado', args.topK ?? 10);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatResults(results, 'Azure DevOps'),
          },
        ],
      };
    },
  };
}

/**
 * Tool handler for search_jira
 */
export function createSearchJiraTool(engine: SearchEngine) {
  return {
    name: 'search_jira',
    description:
      'Search Jira issues including bugs, stories, tasks, epics, and other tickets. ' +
      'Use this when the user asks about specific issues, sprints, bugs, tasks, or project tracking in Jira.',
    inputSchema: z.object({
      query: z.string().describe('The search query — issue key, keywords, or natural language question'),
      topK: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
    handler: async (args: { query: string; topK?: number }) => {
      const results = await engine.search(args.query, 'jira', args.topK ?? 10);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatResults(results, 'Jira'),
          },
        ],
      };
    },
  };
}

/**
 * Tool handler for search_workspace
 */
export function createSearchWorkspaceTool(engine: SearchEngine) {
  return {
    name: 'search_workspace',
    description:
      'Search across all connected workspace sources (Confluence, Azure DevOps, Jira). ' +
      'Use this for general questions where the best data source is unclear, or when the answer may span multiple sources.',
    inputSchema: z.object({
      query: z.string().describe('The search query — natural language question or keywords'),
      topK: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
    handler: async (args: { query: string; topK?: number }) => {
      const results = await engine.search(args.query, 'all', args.topK ?? 10);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatResults(results, 'all sources'),
          },
        ],
      };
    },
  };
}
