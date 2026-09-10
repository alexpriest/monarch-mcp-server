/**
 * Streamable HTTP transport — Express app with:
 *   - claude.ai-compatible Helmet config (CSP, COOP, CORP overrides)
 *   - MCP OAuth 2.1 layer (passcode-gated approval) via mountMcpOAuth
 *   - Stateless StreamableHTTPServerTransport at /mcp (per-request server+transport)
 *   - Hybrid auth on /mcp: static AUTH_TOKEN OR OAuth bearer
 *
 * Ported from strava-mcp-server. Differences: no provider-side OAuth flow
 * (Monarch authenticates with stored credentials + generated TOTP, not a
 * consent redirect), and `trust proxy` is set — see the comment below.
 */
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer as createHttpServer } from 'http';
import { secureCompare, sanitizeErrorMessage } from '../utils/security.js';
import { logger } from '../utils/logger.js';
import { mountMcpOAuth } from '../oauth/mcpOAuth.js';

export interface StreamableTransportConfig {
  port: number;
  host: string;
  mcpPath: string;
  authToken?: string;
  publicUrl?: string;
  oauthPasscode?: string;
}

/**
 * @param serverFactory function returning a fresh Server instance — called per
 *   incoming MCP request, since the stateless Streamable HTTP transport pattern
 *   requires a fresh server+transport pair per request (the Server class binds
 *   to a single transport at a time).
 */
export async function createStreamableApp(
  serverFactory: () => Server,
  config: StreamableTransportConfig
): Promise<express.Application> {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  // Railway terminates TLS at its edge proxy and forwards X-Forwarded-For.
  // Without this, req.ip is the proxy's address for every request, so the rate
  // limiter buckets the whole internet together — one noisy client would lock
  // everyone out — and `secure`/protocol detection is wrong. One hop = 1.
  app.set('trust proxy', 1);

  // Helmet — CSP/COOP defaults break the claude.ai OAuth popup flow.
  //  - form-action 'self' blocks /approve's 302 redirect to https://claude.ai/api/mcp/auth_callback.
  //  - COOP: same-origin sandboxes the popup away from its claude.ai opener,
  //    breaking the postMessage handshake.
  // Permit form actions to claude.ai and disable COOP/CORP.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
      // A CSP source with no port matches only the scheme's default port (80),
      // so bare 'http://localhost' never matches Claude Code's OAuth callback on a
      // random high port. Without :* the browser silently refuses the 302 from
      // /approve and the approval page appears to reload.
          formAction: ["'self'", 'https://claude.ai', 'https://*.claude.ai', 'http://localhost:*', 'http://127.0.0.1:*'],
        },
      },
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Generous timeouts for long-running MCP tool calls (5 min).
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);
    next();
  });

  // Request logging.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    res.on('finish', () => {
      logger.apiRequest(req.method, req.path, res.statusCode, Date.now() - startTime);
    });
    next();
  });

  // Permissive CORS — the MCP spec lets connectors call from any origin.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Rate limiting — generous for AI agents, exempts /health.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: 'Too many requests from this IP, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    handler: (req, res) => {
      logger.rateLimitExceeded(req.ip, req.path);
      res.status(429).json({ error: 'Too many requests', message: 'Please try again later' });
    },
  });
  app.use(limiter);

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    skipSuccessfulRequests: true,
  });

  // MCP OAuth 2.1 — for claude.ai custom connector compatibility.
  // Mounts /.well-known/*, /authorize, /token, /register, /approve at the app root.
  let requireOAuthBearer: RequestHandler | null = null;
  if (config.oauthPasscode && config.publicUrl) {
    const { requireBearer } = mountMcpOAuth(app, {
      publicUrl: new URL(config.publicUrl),
      resourcePath: config.mcpPath,
      passcode: config.oauthPasscode,
      resourceName: 'Monarch MCP',
      scopesSupported: ['mcp'],
    });
    requireOAuthBearer = requireBearer;
    logger.info('MCP OAuth 2.1 enabled', { resourcePath: config.mcpPath });
  } else {
    logger.warn('MCP OAuth 2.1 NOT enabled — set MCP_OAUTH_PASSCODE and PUBLIC_URL to enable claude.ai compatibility');
  }

  // Hybrid resource auth: static AUTH_TOKEN OR OAuth bearer.
  //
  // FAILS CLOSED. This previously fell through to `next()` when neither was
  // configured, which served the full tool list — and, once credentials were
  // set, Alex's entire financial history — to any unauthenticated caller on the
  // public internet. Observed live on the first Railway deploy of this service.
  // A misconfigured deploy must be inert, never open.
  const authConfigured = !!config.authToken || !!requireOAuthBearer;
  if (!authConfigured) {
    logger.warn(
      'No auth configured (AUTH_TOKEN and MCP_OAUTH_PASSCODE both unset) — ' +
        `${config.mcpPath} will refuse every request until one is set`,
    );
  }
  const authResource: RequestHandler = (req, res, next) => {
    if (!authConfigured) {
      logger.authFailure('no_auth_configured', req.ip);
      res.status(503).json({
        error: 'server_misconfigured',
        error_description:
          'No authentication is configured on this deployment. Set AUTH_TOKEN or MCP_OAUTH_PASSCODE.',
      });
      return;
    }
    authLimiter(req, res, () => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace(/^Bearer\s+/i, '');

      if (token && config.authToken && secureCompare(token, config.authToken)) {
        logger.authAttempt(true, req.ip, req.headers['mcp-session-id'] as string);
        return next();
      }
      if (requireOAuthBearer) {
        return requireOAuthBearer(req, res, next);
      }
      logger.authFailure('invalid_token', req.ip);
      res.status(401).json({ error: 'Unauthorized' });
    });
  };

  // Health check — unauthenticated for Railway's healthcheck. Deliberately says
  // nothing about credentials, tokens, or account state.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      transport: 'streamable',
    });
  });

  // /mcp — Streamable HTTP, stateless. Per SDK example simpleStatelessStreamableHttp.js,
  // each request gets its own fresh Server + Transport pair.
  const handleMcp = async (req: Request, res: Response) => {
    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
    } catch (err) {
      logger.error('MCP request failed', { path: req.path, method: req.method }, err as Error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  app.get(config.mcpPath, authResource, handleMcp);
  app.post(config.mcpPath, authResource, handleMcp);
  app.delete(config.mcpPath, authResource, handleMcp);

  // Friendly root page so visiting the bare URL doesn't 404.
  app.get('/', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html><html><head><title>Monarch MCP Server</title>
      <style>body{font-family:system-ui;max-width:560px;margin:60px auto;padding:24px;line-height:1.5}
      code{background:rgba(0,0,0,.06);padding:2px 6px;border-radius:4px}</style></head><body>
      <h1>Monarch MCP Server</h1>
      <p>This is an MCP server for Monarch Money, deployed for use with claude.ai custom connectors.</p>
      <ul>
        <li><a href="/health">/health</a> — health check</li>
        <li><code>/mcp</code> — MCP Streamable HTTP endpoint (requires auth)</li>
      </ul>
      </body></html>`);
  });

  // Global error handler.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', { path: req.path, method: req.method }, err);
    res.status(500).json({
      error: 'Internal server error',
      message: sanitizeErrorMessage(err, isProduction),
    });
  });

  return app;
}

export async function initializeStreamableTransport(
  serverFactory: () => Server,
  config: StreamableTransportConfig
): Promise<void> {
  const app = await createStreamableApp(serverFactory, config);

  return new Promise((resolve, reject) => {
    try {
      const httpServer = createHttpServer(app);
      logger.info('Starting HTTP server', { host: config.host, port: config.port });

      if (process.env.NODE_ENV === 'production' && !process.env.RAILWAY_ENVIRONMENT) {
        logger.warn('Running without HTTPS in production — Railway provides HTTPS at the edge');
      }

      httpServer.listen(config.port, config.host, () => {
        logger.info('Monarch MCP Server started', {
          host: config.host,
          port: config.port,
          mcpPath: config.mcpPath,
        });
        console.error(`Monarch MCP Server running on http://${config.host}:${config.port}`);
        console.error(`MCP endpoint: http://${config.host}:${config.port}${config.mcpPath}`);
        console.error(`Health: http://${config.host}:${config.port}/health`);
        resolve();
      });

      httpServer.on('error', (error) => {
        logger.error('Server error', {}, error);
        reject(error);
      });
    } catch (error) {
      logger.error('Failed to start server', {}, error as Error);
      reject(error);
    }
  });
}
