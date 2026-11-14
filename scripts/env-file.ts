// Setup scripts write secrets into .env (owner-only) instead of printing them, and keep .metal/ owner-only.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Sets NAME=value in .env, replacing an existing line, and makes .env readable only by its owner. */
export function setEnv(name: string, value: string, file = ".env") {
  const env = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(file, re.test(env) ? env.replace(re, () => line) : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Creates .metal/ as 0700 and makes every file in it 0600. */
export function lockMetalDir(dir = ".metal") {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
}
