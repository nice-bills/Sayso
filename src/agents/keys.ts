// Keys for agents the owner connects (Claude, ChatGPT, OpenClaw, a phone assistant...). A key lets an
// agent quote, forward invoices and check status. It can never approve a payment: that takes the
// owner's own sign-in, so a poisoned email that hijacks the agent still can't pay anyone.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "../store.js";

export interface AgentKey {
  id: string;
  name: string;
  /** The most this agent may ask Sayso to pay in one payout, in USD cents (null: no cap beyond the risk rules). */
  capMinor: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export class AgentKeys {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, cap_minor INTEGER,
      created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_tokens (token_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  }

  /** Returns the secret once; only its hash is stored. */
  create(name: string, capMinor: number | null, now = new Date()): { key: string; agent: AgentKey } {
    const id = randomUUID();
    const key = `cs_agent_${randomBytes(24).toString("base64url")}`;
    this.store.db.prepare("INSERT INTO agent_keys (id, name, key_hash, cap_minor, created_at) VALUES (?,?,?,?,?)").run(id, name.slice(0, 60), hash(key), capMinor, now.toISOString());
    return { key, agent: this.get(id)! };
  }

  /** A short-lived access token for an agent that signed up through auth.md (see agents/authmd.ts). */
  issueToken(agentId: string, ttlSeconds: number, now = new Date()): string {
    const token = `cs_at_${randomBytes(24).toString("base64url")}`;
    this.store.db.prepare("DELETE FROM agent_tokens WHERE expires_at < ?").run(now.getTime());
    this.store.db.prepare("INSERT INTO agent_tokens (token_hash, agent_id, expires_at) VALUES (?,?,?)").run(hash(token), agentId, now.getTime() + ttlSeconds * 1000);
    return token;
  }

  revokeToken(token: string): void {
    this.store.db.prepare("DELETE FROM agent_tokens WHERE token_hash = ?").run(hash(token));
  }

  /** The live agent behind a key or an unexpired access token, marking it used. */
  verify(key: string, now = new Date()): AgentKey | undefined {
    const row = (this.store.db.prepare("SELECT id FROM agent_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hash(key))
      ?? this.store.db.prepare("SELECT k.id FROM agent_tokens t JOIN agent_keys k ON k.id = t.agent_id WHERE t.token_hash = ? AND t.expires_at > ? AND k.revoked_at IS NULL").get(hash(key), now.getTime())) as { id: string } | undefined;
    if (!row) return undefined;
    this.store.db.prepare("UPDATE agent_keys SET last_used_at = ? WHERE id = ?").run(now.toISOString(), row.id);
    return this.get(row.id);
  }

  revoke(id: string, now = new Date()): boolean {
    return Number(this.store.db.prepare("UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), id).changes) === 1;
  }

  get(id: string): AgentKey | undefined {
    const r = this.store.db.prepare("SELECT * FROM agent_keys WHERE id = ?").get(id) as Record<string, string | number | null> | undefined;
    return r ? { id: r.id as string, name: r.name as string, capMinor: r.cap_minor as number | null, createdAt: r.created_at as string, lastUsedAt: r.last_used_at as string | null, revokedAt: r.revoked_at as string | null } : undefined;
  }

  list(): AgentKey[] {
    return (this.store.db.prepare("SELECT id FROM agent_keys ORDER BY created_at DESC").all() as Array<{ id: string }>).map((r) => this.get(r.id)!);
  }
}
