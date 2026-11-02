import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most suites exercise pricing and delivery with a fresh payee each time; they use the laxer new-payee
    // rule. test/payouts.test.ts and test/new-payee.test.ts check the production default (agents held).
    env: { SAYSO_NEW_PAYEE_HOLD: "large" },
  },
});
