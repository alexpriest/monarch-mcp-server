/**
 * Self-contained OAuth 2.1 layer for the MCP server, compatible with
 * claude.ai custom connectors. Implements:
 *   - /.well-known/oauth-authorization-server (RFC 8414)
 *   - /.well-known/oauth-protected-resource (RFC 9728)
 *   - POST /register (RFC 7591 dynamic client registration)
 *   - GET /authorize (PKCE-required code flow with passcode-gated approval page)
 *   - POST /token (auth code + refresh)
 *   - requireBearer middleware for the resource (MCP) endpoints
 *
 * Single-tenant: anyone who knows the passcode can grant claude.ai access.
 *
 * Registered clients and issued access tokens are persisted to the Railway
 * volume (see ./persistence.ts), so a redeploy no longer forces a manual
 * re-authorization. Short-lived `pending` approvals and auth `codes` stay
 * in memory on purpose — they expire in 10min / 1min respectively, so a
 * redeploy mid-handshake just means retrying the click, not losing a session.
 * With no volume mounted, everything degrades to the old in-memory behavior.
 */
import express, { Express, Request, Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadState, saveState, type PersistedState } from './persistence.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const ACCESS_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year — personal-use server
const APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 min to enter the passcode
const CODE_TTL_MS = 60 * 1000; // 1 min between authorize and token exchange

class PersistentClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  /**
   * @param defaultScope Space-separated scopes auto-granted at registration when the
   *   client doesn't include `scope` in its metadata. claude.ai's DCR omits the
   *   scope field, but the SDK's authorization handler validates requested
   *   scopes against `client.scope`. Without this default, every authorize
   *   request from claude.ai redirects with `invalid_scope`.
   * @param onChange Called after any mutation so the provider can snapshot to disk.
   */
  constructor(
    private readonly defaultScope: string | undefined,
    restored: Record<string, unknown>,
    private readonly onChange: () => void,
  ) {
    for (const [clientId, client] of Object.entries(restored)) {
      this.clients.set(clientId, client as OAuthClientInformationFull);
    }
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (this.defaultScope && !client.scope) {
      client.scope = this.defaultScope;
    }
    this.clients.set(client.client_id, client);
    this.onChange();
    return client;
  }

  snapshot(): Record<string, OAuthClientInformationFull> {
    return Object.fromEntries(this.clients);
  }
}

interface PendingApproval {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface CodeRecord {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

class PasscodeOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore;
  private pending = new Map<string, PendingApproval>();
  private codes = new Map<string, CodeRecord>();
  private tokens = new Map<string, TokenRecord>();

  constructor(
    private readonly passcode: string,
    private readonly resourceName: string,
    defaultScope?: string,
  ) {
    const restored: PersistedState = loadState();

    for (const [token, record] of Object.entries(restored.tokens)) {
      this.tokens.set(token, {
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
        resource: record.resource ? new URL(record.resource) : undefined,
      });
    }

    this.clientsStore = new PersistentClientsStore(defaultScope, restored.clients, () => this.persist());
    setInterval(() => this.gc(), 60_000).unref?.();
  }

  /** Snapshot clients + tokens to the volume. Cheap: this is a handful of records. */
  private persist() {
    saveState({
      clients: this.clientsStore.snapshot() as PersistedState['clients'],
      tokens: Object.fromEntries(
        [...this.tokens].map(([token, record]) => [
          token,
          {
            clientId: record.clientId,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            resource: record.resource?.toString(),
          },
        ]),
      ),
    });
  }

  private gc() {
    const now = Date.now();
    let expiredTokens = 0;
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.tokens) {
      if (v.expiresAt < now) {
        this.tokens.delete(k);
        expiredTokens++;
      }
    }
    // Only rewrite the file when a persisted record actually changed.
    if (expiredTokens > 0) this.persist();
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new Error('Unregistered redirect_uri');
    }
    const approvalId = randomUUID();
    this.pending.set(approvalId, {
      client,
      params,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    });
    res.set('Cache-Control', 'no-store');
    res.send(approvalPage({
      approvalId,
      resourceName: this.resourceName,
      clientName: client.client_name || client.client_id,
      scopes: params.scopes,
    }));
  }

  /**
   * Called by POST /approve once the user enters the right passcode.
   * Issues an auth code and returns the redirect URL back to the client.
   *
   * Approval entries are NOT deleted on first use — claude.ai (and some
   * browsers) occasionally re-POST the form, and a single-use approvalId
   * caused a "Not approved — Unknown or expired approval" page on the
   * second hit. The auth code itself is single-use (consumed at /token),
   * which is the actual security boundary.
   */
  approve(approvalId: string, passcode: string): string {
    if (passcode !== this.passcode) {
      throw new Error('Wrong passcode');
    }
    const pending = this.pending.get(approvalId);
    if (!pending) throw new Error('Unknown or expired approval');
    if (pending.expiresAt < Date.now()) {
      this.pending.delete(approvalId);
      throw new Error('Approval expired — please retry from claude.ai');
    }

    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      client: pending.client,
      params: pending.params,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set('code', code);
    if (pending.params.state) target.searchParams.set('state', pending.params.state);
    return target.toString();
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = this.codes.get(code);
    if (!record) throw new Error('Invalid authorization code');
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.codes.get(code);
    if (!record) throw new Error('Invalid authorization code');
    if (record.expiresAt < Date.now()) {
      this.codes.delete(code);
      throw new Error('Authorization code expired');
    }
    if (record.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }
    this.codes.delete(code);

    const accessToken = randomBytes(32).toString('base64url');
    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes: record.params.scopes ?? [],
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
      resource: record.params.resource,
    });
    // The load-bearing line: without this the token dies with the container.
    this.persist();

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: (record.params.scopes ?? []).join(' '),
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error('Refresh tokens not supported — access tokens are long-lived');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.tokens.get(token);
    if (!record) throw new InvalidTokenError('Invalid token');
    if (record.expiresAt < Date.now()) {
      this.tokens.delete(token);
      this.persist();
      throw new InvalidTokenError('Token expired');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource,
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function approvalPage(opts: {
  approvalId: string;
  resourceName: string;
  clientName: string;
  scopes?: string[];
}): string {
  const scopesList = opts.scopes && opts.scopes.length > 0
    ? `<ul>${opts.scopes.map(s => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>`
    : '<p><em>No scopes requested.</em></p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize ${escapeHtml(opts.resourceName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 480px; margin: 60px auto; padding: 24px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .sub { color: #6b7280; margin-bottom: 24px; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; background: rgba(0,0,0,0.02); }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; font-size: 16px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box; }
  button { margin-top: 20px; width: 100%; padding: 12px; font-size: 16px; font-weight: 600;
           border: none; border-radius: 8px; background: #111827; color: white; cursor: pointer; }
  button:hover { background: #000; }
  ul { padding-left: 20px; margin: 8px 0 0; }
  code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    .card { border-color: #374151; background: rgba(255,255,255,0.03); }
    input[type=password] { background: #1f2937; color: #f9fafb; border-color: #374151; }
    code { background: rgba(255,255,255,0.1); }
  }
</style>
</head>
<body>
  <h1>Authorize <strong>${escapeHtml(opts.resourceName)}</strong></h1>
  <p class="sub"><strong>${escapeHtml(opts.clientName)}</strong> wants to connect.</p>
  <div class="card">
    <p>Scopes requested:</p>
    ${scopesList}
    <form method="POST" action="/approve">
      <input type="hidden" name="approvalId" value="${escapeHtml(opts.approvalId)}">
      <label for="passcode">Passcode</label>
      <input id="passcode" name="passcode" type="password" autocomplete="off" autofocus required>
      <button type="submit">Approve &amp; connect</button>
    </form>
  </div>
</body>
</html>`;
}

export interface MountOptions {
  /** Public origin of the deployed server, e.g. https://monarch-mcp-production-xxxx.up.railway.app */
  publicUrl: URL;
  /** Path of the resource (MCP) endpoint, e.g. "/mcp" or "/sse". Used for protected-resource metadata. */
  resourcePath: string;
  /** Passcode that gates the approval page. Required — server fails to start without it. */
  passcode: string;
  /** Human-readable name shown on the approval page (e.g. "Strava MCP"). */
  resourceName: string;
  /** Scopes advertised on the metadata endpoints. */
  scopesSupported?: string[];
}

export interface MountResult {
  /** Express middleware that requires a valid OAuth Bearer token. Apply to MCP endpoints. */
  requireBearer: express.RequestHandler;
  /** Underlying provider — exposed for tests/debugging. */
  provider: PasscodeOAuthProvider;
}

/**
 * Mounts OAuth endpoints on the given Express app and returns middleware
 * to gate the MCP resource endpoints.
 *
 * IMPORTANT: call this BEFORE any catch-all middleware or the resource
 * endpoint route handlers, but AFTER body parsers if the app uses them.
 */
export function mountMcpOAuth(app: Express, opts: MountOptions): MountResult {
  if (!opts.passcode) {
    throw new Error('mountMcpOAuth: passcode is required');
  }
  const provider = new PasscodeOAuthProvider(
    opts.passcode,
    opts.resourceName,
    opts.scopesSupported?.join(' '),
  );

  // mcpAuthRouter mounts: /authorize, /token, /register, plus both well-known docs.
  // resourceServerUrl includes the resource path so the protected-resource
  // metadata is served at /.well-known/oauth-protected-resource{path}.
  const resourceServerUrl = new URL(opts.resourcePath, opts.publicUrl);
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: opts.publicUrl,
    baseUrl: opts.publicUrl,
    resourceServerUrl,
    resourceName: opts.resourceName,
    scopesSupported: opts.scopesSupported,
  }));

  // /approve is our own endpoint, completing the authorization flow after the user enters the passcode.
  app.post('/approve', express.urlencoded({ extended: true }), (req: Request, res: Response) => {
    const approvalId = String(req.body?.approvalId ?? '');
    const passcode = String(req.body?.passcode ?? '');
    try {
      const redirectUrl = provider.approve(approvalId, passcode);
      res.redirect(302, redirectUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Authorization failed';
      res.status(403).send(`<!DOCTYPE html><html><body style="font-family:system-ui;max-width:480px;margin:60px auto;padding:24px;">
        <h1>Not approved</h1>
        <p>${escapeHtml(msg)}</p>
        <p><a href="javascript:history.back()">Try again</a></p>
        </body></html>`);
    }
  });

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const requireBearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl,
  });

  return { requireBearer, provider };
}
