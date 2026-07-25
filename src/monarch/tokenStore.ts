/**
 * Where the Monarch session token gets cached.
 *
 * The stdio original hardcoded `~/.monarch-mcp-token.json`. That path is wrong
 * on Railway: the container filesystem is ephemeral, so every redeploy (and
 * every crash-restart) would drop the token and force a fresh login. When a
 * volume is mounted we write there instead, alongside the OAuth state.
 *
 * Resolution order:
 *   1. MONARCH_TOKEN_CACHE_PATH — explicit override, wins everywhere
 *   2. $RAILWAY_VOLUME_MOUNT_PATH/monarch-token.json — the deployed case
 *   3. ~/.monarch-mcp-token.json — local stdio, unchanged from the original
 *
 * Every operation degrades gracefully: an unreadable or unwritable cache means
 * the caller falls back to an in-process token and re-logs in on restart. It
 * never throws — a read-only disk must not take the server down.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function tokenCachePath(): string {
  const explicit = process.env.MONARCH_TOKEN_CACHE_PATH;
  if (explicit) return explicit;

  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (mount) return join(mount, 'monarch-token.json');

  return join(homedir(), '.monarch-mcp-token.json');
}

export function loadCachedToken(): string | undefined {
  try {
    const data = JSON.parse(readFileSync(tokenCachePath(), 'utf8'));
    return data.token || undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write (tmp + rename) so a crash mid-write can't leave truncated JSON. */
export function saveCachedToken(token: string): void {
  const path = tokenCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ token, updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 }
    );
    renameSync(tmp, path);
  } catch (e) {
    // Swallowed on purpose: no cache just means we log in again next boot.
    console.error(
      `[monarch] failed to cache token to ${path}:`,
      e instanceof Error ? e.message : e
    );
  }
}
