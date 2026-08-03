# Monarch MCP Server

MCP server for Monarch Money — exposes accounts, transactions, budgets, categories, net worth, and portfolio to claude.ai (as a custom connector over Streamable HTTP + OAuth 2.1) or to any local MCP client over stdio.

Ported from the local stdio server at `~/Code/tools/monarch-mcp/` (a fork of `whitebirchio/monarch-mcp`), following the pattern proven in [`strava-mcp-server`](../strava-mcp-server). The 11 tools carried over unchanged; one GraphQL query has since been rewritten (see [Gotchas](#gotchas-already-handled)).

## Tools

All read-only.

| Tool | What it returns |
| --- | --- |
| `get_accounts` | Every linked account with balances, type, institution |
| `get_account_balance` | Current balance for one account id |
| `get_transactions` | Recent transactions, filterable by account and date range |
| `get_spending_by_category` | Spend totals grouped by category over a date range |
| `get_budget_summary` | Planned vs actual for the current month |
| `search_transactions` | Client-side search over merchant / description / amount |
| `get_net_worth` | Assets, liabilities, and the net figure |
| `get_monthly_summary` | Income, expenses, savings for one month |
| `get_categories` | All Monarch categories and their groups |
| `get_account_snapshots` | Balance history for one account (`date` + `signedBalance`; date range filtered client-side) |
| `get_portfolio` | Holdings, basis, performance, benchmarks |

## How auth works

Two layers, don't confuse them:

1. **Monarch-side** — the server logs into Monarch itself with `MONARCH_EMAIL` / `MONARCH_PASSWORD` / `MONARCH_TOTP_SECRET`, generating its own TOTP with node crypto (no authenticator app in the loop). The session token is cached on disk and refreshed automatically on a 401. There's no consent redirect to click.
2. **MCP-side** (`src/oauth/mcpOAuth.ts`) — what claude.ai authenticates against. Dynamic client registration plus a passcode-gated approval page issues the bearer tokens that gate `/mcp`.

`/mcp` accepts either:

- a static `AUTH_TOKEN` (constant-time compared) — the simple path for local Claude Code or curl, or
- an OAuth bearer issued by the MCP-side flow — the claude.ai path.

Whichever arrives first wins; a bad static token falls through to the OAuth verifier rather than short-circuiting.

## Transports

`TRANSPORT` selects which one(s) start:

| Value | Behavior |
| --- | --- |
| `stdio` | Long-lived Server on stdin/stdout — what a local MCP client registers |
| `http` | Express + stateless Streamable HTTP at `/mcp` |
| `both` | Starts stdio, then HTTP |

Default: `http` when `RAILWAY_ENVIRONMENT` is set, `stdio` otherwise. So `node dist/index.js` with no env behaves exactly like the old local server, and the Railway deploy works even if the variable is never set.

## Environment variables

Full annotated list in `.env.example`. What Railway needs:

**Required**

```
MONARCH_EMAIL              Monarch login email
MONARCH_PASSWORD           Monarch password
MONARCH_TOTP_SECRET        Base32 2FA secret (not a 6-digit code)
MCP_OAUTH_PASSCODE         What you type on the approval page during the claude.ai handshake
PUBLIC_URL                 https://<your-railway-domain>   (auto-derived from RAILWAY_PUBLIC_DOMAIN, but set it)
TRANSPORT                  http
```

**Recommended**

```
AUTH_TOKEN                 Static bearer for local/curl clients — openssl rand -hex 32
NODE_ENV                   production
```

**Optional**

```
MONARCH_TOKEN              Seed an existing session token instead of logging in on first use
MONARCH_TOKEN_CACHE_PATH   Override the token cache location
PORT                       Railway sets this
HOST                       Defaults to 0.0.0.0 on Railway
MCP_PATH                   Defaults to /mcp
```

Never set `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` on Railway. It exists only so the OAuth layer can run against `http://127.0.0.1` locally — the SDK otherwise refuses a non-HTTPS issuer.

## Persistence

Both pieces of durable state live on the Railway volume, keyed off `RAILWAY_VOLUME_MOUNT_PATH`:

- `oauth-state.json` — registered OAuth clients and issued access tokens. Without it, every redeploy silently invalidates the claude.ai connector and forces a manual re-authorization.
- `monarch-token.json` — the Monarch session token. Without it, every restart triggers a fresh login.

With no volume mounted both degrade to in-memory / home-directory behavior and never throw. **Mount a volume** — the deploy works without one, it just re-authorizes more than it should.

## Deploy (Alex runs these)

```bash
cd /Users/alex/Code/projects/monarch-mcp-server
railway link                        # pick or create the project/service
railway volume add -m /data         # sets RAILWAY_VOLUME_MOUNT_PATH=/data on the service
railway variables --set "TRANSPORT=http" --set "NODE_ENV=production" \
  --set "MONARCH_EMAIL=..." --set "MONARCH_PASSWORD=..." --set "MONARCH_TOTP_SECRET=..." \
  --set "MCP_OAUTH_PASSCODE=..." --set "AUTH_TOKEN=$(openssl rand -hex 32)"
railway up
```

Then generate a public domain for the service (dashboard → Settings → Networking, or `railway domain`), set `PUBLIC_URL` to it, and redeploy so the OAuth metadata advertises the right origin:

```bash
railway variables --set "PUBLIC_URL=https://<your-railway-domain>"
```

Verify:

```bash
curl https://<domain>/health
curl https://<domain>/.well-known/oauth-authorization-server
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/mcp   # expect 401
```

## Add to claude.ai

1. claude.ai → Settings → Connectors → **Add custom connector**.
2. URL: `https://<your-railway-domain>/mcp`
3. claude.ai discovers the OAuth metadata, self-registers via DCR, and opens the approval page in a popup.
4. Enter `MCP_OAUTH_PASSCODE`, click **Approve & connect**. The popup redirects back to claude.ai and the connector goes live.
5. The 11 tools appear under the connector. Access tokens last a year and survive redeploys as long as the volume is mounted.

## Local use

```bash
npm install
npm run build

# stdio (default) — register this with Claude Code
node dist/index.js

# HTTP, with the OAuth layer, against localhost
TRANSPORT=http PORT=3111 PUBLIC_URL=http://127.0.0.1:3111 \
  MCP_OAUTH_PASSCODE=... AUTH_TOKEN=... \
  MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true node dist/index.js
```

Local stdio registration (Claude Code):

```bash
claude mcp add monarch -- node /Users/alex/Code/projects/monarch-mcp-server/dist/index.js
```

Credentials come from `.env` in the package root (loaded relative to the binary, not the cwd) or from the MCP registration's `env` block.

## Layout

```
src/
  index.ts              entrypoint, TRANSPORT switch, shared API/tools singleton
  server.ts             per-request MCP Server factory
  monarch/
    api.ts              GraphQL client, TOTP login, auto-refresh on 401
    tokenStore.ts       session-token cache (volume → home dir fallback)
  tools/index.ts        the 11 tool definitions and handlers
  transports/
    stdio.ts
    streamable.ts       Express app, Helmet/CORS/rate limit, hybrid auth, /mcp
  oauth/
    mcpOAuth.ts         OAuth 2.1 + DCR + passcode approval (verbatim from strava)
    persistence.ts      volume-backed client/token storage (verbatim from strava)
  utils/                logger, security (secureCompare), errors
```

## Gotchas already handled

Four things silently break the claude.ai connector; all four are solved in `streamable.ts` / `mcpOAuth.ts`, don't "clean them up":

- Helmet's default CSP `form-action: 'self'` blocks the `/approve` → `https://claude.ai/api/mcp/auth_callback` redirect. The config explicitly allows claude.ai.
- COOP sandboxes the OAuth popup from its opener, breaking the postMessage handshake. `crossOriginOpenerPolicy` and `crossOriginResourcePolicy` are disabled.
- claude.ai's DCR omits `scope`, and the SDK validates requested scopes against `client.scope` — every authorize would fail `invalid_scope`. `PersistentClientsStore` applies a default scope at registration.
- The approval form is deliberately **not** single-use; claude.ai re-POSTs it. The auth *code* is the single-use boundary.

Plus one this server fixes that strava and hevy don't: `app.set('trust proxy', 1)`. Behind Railway's proxy, `req.ip` is the proxy's address for every request, so the rate limiter buckets all clients together and the 1000-request window becomes global instead of per-client.

### Monarch's API hides why a query failed

Every GraphQL error comes back as the same generic 400 — `Something went wrong while processing: None on request_id: None.` A field name that doesn't exist returns a byte-identical response to a genuine server fault, and introspection is refused for non-admin users. `get_account_snapshots` looked like a Monarch outage for exactly this reason; it was querying `accountSnapshots(filters:)`, a field that no longer exists.

The live field is `snapshotsForAccount(accountId: $id)` — a direct `UUID!` argument rather than a filter object, exposing only `date` and `signedBalance`, and accepting **no** date arguments (hence the client-side range filter in `api.ts`).

When a query 400s here, calibrate before believing the message: send a deliberately bogus field name and compare. Identical response means your query is wrong, not the server. Since you only learn from successes, probe candidate shapes in batches — and check the [`monarchmoney`](https://github.com/hammem/monarchmoney) Python library for current query shapes, which is how this one was found.
