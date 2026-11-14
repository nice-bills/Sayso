import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs scripts/start.sh in an empty dir with a fake npx that just echoes its arguments.
function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sayso-start-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "bin", "npx"), '#!/bin/sh\necho "npx $@"\n');
  chmodSync(join(dir, "bin", "npx"), 0o755);
  copyFileSync("scripts/start.sh", join(dir, "scripts", "start.sh"));
  return spawnSync("sh", ["scripts/start.sh"], { cwd: dir, encoding: "utf8", env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, ...env } });
}

describe("scripts/start.sh", () => {
  it("runs the offline demo with no keys", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tsx src/serve.ts --offline");
  });

  it("refuses to start when only some live keys are set", () => {
    const r = run({ AWX_CLIENT_ID: "x" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Refusing to start");
    expect(r.stderr).toContain("METAL_PRINCIPAL");
  });

  it("runs offline when SAYSO_OFFLINE=on even with some keys", () => {
    const r = run({ AWX_CLIENT_ID: "x", SAYSO_OFFLINE: "on" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tsx src/serve.ts --offline");
  });
});
