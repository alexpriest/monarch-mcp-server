import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * stdio transport — what Claude Code / Claude Desktop register locally.
 * Logs go to stderr so they don't corrupt the JSON-RPC stream on stdout.
 */
export async function initializeStdioTransport(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Monarch MCP Server running on stdio transport');
}
