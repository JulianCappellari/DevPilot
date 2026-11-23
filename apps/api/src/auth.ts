import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { get, newId, nowIso, run, type DB } from "@devpilot/storage";

const N = 16384;
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N });
  return `scrypt$${N}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, saltHex, hashHex] = stored.split("$");
  if (alg !== "scrypt" || !n || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: Number(n) });
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type AuthContext = { userId: string; username: string; sessionId: string; csrfToken: string };

export function createSession(db: DB, userId: string, ttlMs: number, ip: string, ua: string): { token: string; csrfToken: string; sessionId: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const id = newId("ses");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  run(db, "INSERT INTO session(id,user_id,token_hash,csrf_token,created_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)",
    id, userId, sha256(token), csrfToken, nowIso(), expiresAt, ip.slice(0, 64), ua.slice(0, 200));
  return { token, csrfToken, sessionId: id, expiresAt };
}

export function authenticate(db: DB, token: string | undefined): AuthContext | null {
  if (!token) return null;
  const s = get<{ id: string; user_id: string; csrf_token: string; expires_at: string; revoked_at: string | null; username: string }>(db,
    "SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.revoked_at, u.username FROM session s JOIN user u ON u.id = s.user_id WHERE s.token_hash = ?", sha256(token));
  if (!s || s.revoked_at || new Date(s.expires_at).getTime() <= Date.now()) return null;
  return { userId: s.user_id, username: s.username, sessionId: s.id, csrfToken: s.csrf_token };
}

/** Limitador de fuerza bruta en memoria: 5 fallos / 15 min por IP+usuario (RF-001, abuso). */
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly windowMs = 15 * 60_000) {}
  private recent(key: string): number[] {
    const cutoff = Date.now() - this.windowMs;
    const arr = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    this.fails.set(key, arr);
    return arr;
  }
  blocked(key: string): boolean { return this.recent(key).length >= this.max; }
  fail(key: string): void { this.recent(key).push(Date.now()); }
  reset(key: string): void { this.fails.delete(key); }
}
