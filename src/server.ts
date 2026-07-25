import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MonarchTools } from './tools/index.js';

/**
 * Create a fresh MCP Server instance wired to a shared MonarchTools.
 *
 * The Server is per-request (the stateless Streamable HTTP transport requires
 * it — a Server binds to one transport at a time), but the tools object is not:
 * it holds the Monarch session token in memory, so sharing it means one login
 * serves every request instead of one login per request.
 */
export function createMonarchMCPServer(tools: MonarchTools): Server {
  const server = new Server(
    {
      name: 'monarch-mcp-server',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.getToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await tools.executeTool(name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
