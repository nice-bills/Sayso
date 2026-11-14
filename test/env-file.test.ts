import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockMetalDir, setEnv } from "../scripts/env-file.js";

describe("env-file", () => {
  it("setEnv replaces the line and keeps the file owner-only", () => {
    const f = join(mkdtempSync(join(tmpdir(), "envf-")), ".env");
    setEnv("K", "one", f);
    setEnv("K", "two$&", f);
    expect(readFileSync(f, "utf8")).toBe("K=two$&\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it("lockMetalDir makes the dir 0700 and files 0600", () => {
    const d = join(mkdtempSync(join(tmpdir(), "metal-")), ".metal");
    lockMetalDir(d);
    writeFileSync(join(d, "k.json"), "{}", { mode: 0o644 });
    lockMetalDir(d);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(join(d, "k.json")).mode & 0o777).toBe(0o600);
  });
});
