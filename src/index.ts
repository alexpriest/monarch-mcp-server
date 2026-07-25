#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MonarchMoneyAPI } from './monarch/api.js';
import { MonarchTools } from './tools/index.js';
import { createMonarchMCPServer } from './server.js';
import { initializeStdioTransport } from './transports/stdio.js';
import { initializeStreamableTransport } from './transports/streamable.js';
import { ConfigurationError } from './utils/errors.js';
import { tokenCachePath } from './monarch/tokenStore.js';

// Load .env from the package root, not the cwd — a stdio client can launch this
// from anywhere. Missing file is a silent no-op, which is the Railway case.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(packageRoot, '.env') });

async function main() {
  try {
    // On Railway a stdio-only server would start, serve nothing, and fail the
    // healthcheck — so default to http there and stdio everywhere else, which
    // keeps `node dist/index.js` behaving like the original local server.
    const transport =
      process.env.TRANSPORT || (process.env.RAILWAY_ENVIRONMENT ? 'http' : 'stdio');
    const port = parseInt(process.env.PORT || '3000', 10);
    // 0.0.0.0 for Railway/production, 127.0.0.1 for local development.
    const host = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
    const mcpPath = process.env.MCP_PATH || '/mcp';
    const authToken = process.env.AUTH_TOKEN;
    const oauthPasscode = process.env.MCP_OAUTH_PASSCODE;

    // PUBLIC_URL is the externally-reachable origin used for OAuth metadata.
    // On Railway, derive from RAILWAY_PUBLIC_DOMAIN if not set explicitly.
    const publicUrl = process.env.PUBLIC_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);

    if (transport !== 'stdio' && transport !== 'http' && transport !== 'both') {
      throw new ConfigurationError(
        `Invalid TRANSPORT value: ${transport}. Must be 'stdio', 'http', or 'both'.`
      );
    }

    console.error('Initializing Monarch MCP Server...');
    console.error(`Transport mode: ${transport}`);

    // One API client for the whole process. It holds the Monarch session token
    // in memory and refreshes it in place, so every request — including the
    // per-request Server instances the HTTP transport builds — shares one login.
    const api = new MonarchMoneyAPI();
    const tools = new MonarchTools(api);

    if (!api.isConfigured()) {
      console.error(
        'WARNING: no Monarch session token and no MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
      );
      console.error('  The server will start, but every tool call will fail until credentials are set.');
    }
    console.error(`Token cache: ${tokenCachePath()}`);

    const serverFactory = () => createMonarchMCPServer(tools);

    if (transport === 'stdio' || transport === 'both') {
      console.error('Starting stdio transport...');
      await initializeStdioTransport(serverFactory());
    }

    if (transport === 'http' || transport === 'both') {
      console.error('Starting HTTP transport...');
      await initializeStreamableTransport(serverFactory, {
        port,
        host,
        mcpPath,
        authToken,
        publicUrl,
        oauthPasscode,
      });
    }

    console.error('Monarch MCP Server initialized successfully!');
  } catch (error) {
    console.error('Failed to start Monarch MCP Server:');
    if (error instanceof ConfigurationError) {
      console.error(`Configuration Error: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(error.message);
      console.error(error.stack);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.error('\nShutting down Monarch MCP Server...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.error('\nShutting down Monarch MCP Server...');
  process.exit(0);
});

main();
