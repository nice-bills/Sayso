import { expect, it } from "vitest";
import { buildSayso } from "../src/app.js";

it("a tick that is running is joined, not started again", async () => {
  const cs = await buildSayso({ offline: true });
  const [a, b] = [cs.tick(), cs.tick()];
  expect(a).toBe(b);
  await a;
  const c = cs.tick();
  expect(c).not.toBe(a);
  await c;
});
