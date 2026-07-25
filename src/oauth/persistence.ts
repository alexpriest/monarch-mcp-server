/**
 * Disk persistence for the OAuth layer.
 *
 * Why this exists: OAuth clients and access tokens used to live only in memory,
 * so every Railway redeploy silently invalidated them and forced a manual
 * re-authorization from claude.ai. (See the 2026-07-13 incident: a routine
 * redeploy to ship a schema fix knocked the connector offline mid-session.)
 *
 * Storage is a single JSON file on the Railway volume. If no volume is mounted
 * (local dev, or the volume was detached), every call degrades to a no-op and
 * the server behaves exactly as it did before — in-memory only. It never throws:
 * a broken disk must not take auth down with it.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PersistedClient {
  client_id: string;
  [key: string]: unknown;
}

export interface PersistedToken {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  /** Serialized as a string; rehydrated into a URL by the caller. */
  resource?: string;
}

export interface PersistedState {
  clients: Record<string, PersistedClient>;
  tokens: Record<string, PersistedToken>;
}

const EMPTY: PersistedState = { clients: {}, tokens: {} };

/**
 * Resolves to a path on the mounted volume, or null when there's no volume —
 * in which case persistence is disabled and we stay purely in-memory.
 */
function statePath(): string | null {
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!mount) return null;
  return join(mount, 'oauth-state.json');
}

export function loadState(): PersistedState {
  const path = statePath();
  if (!path) return { clients: {}, tokens: {} };

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const state: PersistedState = {
      clients: parsed.clients ?? {},
      tokens: parsed.tokens ?? {},
    };

    // Drop anything already expired rather than resurrecting dead tokens on boot.
    const now = Date.now();
    let dropped = 0;
    for (const [token, record] of Object.entries(state.tokens)) {
      if (!record || typeof record.expiresAt !== 'number' || record.expiresAt < now) {
        delete state.tokens[token];
        dropped++;
      }
    }

    const clientCount = Object.keys(state.clients).length;
    const tokenCount = Object.keys(state.tokens).length;
    console.error(
      `[oauth] restored ${clientCount} client(s) and ${tokenCount} token(s) from ${path}` +
        (dropped ? ` (dropped ${dropped} expired)` : ''),
    );
    return state;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== 'ENOENT') {
      // Corrupt or unreadable state is not fatal — start clean and force a re-auth,
      // which is exactly the old behavior.
      console.error(`[oauth] could not read ${path}, starting with empty state:`, e?.message ?? err);
    }
    return { clients: {}, tokens: {} };
  }
}

/**
 * Atomic write (tmp file + rename) so a crash mid-write can't leave truncated
 * JSON behind and lock the user out on the next boot.
 */
export function saveState(state: PersistedState): void {
  const path = statePath();
  if (!path) return;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, path);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    console.error(`[oauth] failed to persist state to ${path}:`, e?.message ?? err);
    // Deliberately swallowed. Losing persistence degrades us to the old
    // in-memory behavior; throwing here would break a live auth flow.
  }
}

export { EMPTY };
