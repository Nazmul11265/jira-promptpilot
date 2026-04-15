import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { runAgent } from './agent.js';

const server = new Server(
  { name: 'jira-promptpilot', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ─── Tool Registry ────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'fix_jira_ticket',
      description:
        'Agentic ReAct workflow powered by Groq/Llama. ' +
        'Fetches the Jira ticket, searches the codebase, reads relevant files, ' +
        'reasons about the root cause, then returns a ready-to-use VS Code Copilot prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket_id: {
            type: 'string',
            description: 'Jira ticket ID (e.g. PROJ-123)',
          },
          workspace_root: {
            type: 'string',
            description:
              'Absolute path to the workspace root to analyse. ' +
              'Defaults to the folder this MCP server was launched from (DEFAULT_WORKSPACE_ROOT). ' +
              'Pass this explicitly when the target codebase is in a different location.',
          },
        },
        required: ['ticket_id'],
      },
    },
  ],
}));

// ─── Tool Dispatch ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'fix_jira_ticket') {
    throw new Error(`Unknown tool: ${name}`);
  }

  const ticketId = args?.ticket_id;
  const workspaceRoot =
    args?.workspace_root ??
    process.env.DEFAULT_WORKSPACE_ROOT ??
    process.cwd();

  if (!ticketId || typeof ticketId !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: ticket_id is required.' }],
      isError: true,
    };
  }

  try {
    const prompt = await runAgent(ticketId.trim(), workspaceRoot);
    return { content: [{ type: 'text', text: prompt }] };
  } catch (err) {
    console.error('[PromptPilot] Fatal error:', err);
    return {
      content: [{ type: 'text', text: `Agent error: ${err.message}` }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[PromptPilot] MCP server ready (Groq/Llama ReAct agent)');
