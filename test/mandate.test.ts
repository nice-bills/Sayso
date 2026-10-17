import { describe, expect, it } from "vitest";
import { centsToUsdz, centsToUsdzUnits, parseCliOutput, parsePull } from "../src/metal/mandate.js";

// Line formats follow @metalntwx/metal-agent 0.2.0 (dist/commands/mandate.js printPull / printUnsent); the values are made up.
const PAID = `transaction 0xabc0000000000000000000000000000000000000000000000000000000000001
outcome paid
spent 12.34 of 1000.00
payer 0x1111111111111111111111111111111111111111
payee 0xE09B648c3B386b5062b2Eef953865C05b63f03B6
amount 12.34
explorer https://testnet.metalntwx.com/tx/0xabc0000000000000000000000000000000000000000000000000000000000001
gas 51234`;

const REFUSED_RECORDED = `transaction 0xdef0000000000000000000000000000000000000000000000000000000000002
outcome refused
reason PayeeNotAllowed: the mandate does not allow this payee
payer 0x1111111111111111111111111111111111111111
payee 0x9999999999999999999999999999999999999999
amount 4800.00
gas 40000`;

const REFUSED_UNSENT = `outcome refused, not sent
reason ExceedsCap: more than the per-payment cap
recorded no`;

describe("metal-agent output", () => {
  it("parses a paid pull with its explorer proof", () => {
    expect(parsePull(PAID)).toMatchObject({ outcome: "paid", tx: "0xabc0000000000000000000000000000000000000000000000000000000000001", spent: "12.34 of 1000.00" });
  });

  it("parses a refusal recorded on chain and one that was never sent", () => {
    expect(parsePull(REFUSED_RECORDED)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("PayeeNotAllowed") });
    expect(parsePull(REFUSED_UNSENT)).toEqual({ outcome: "refused_unsent", reason: "ExceedsCap: more than the per-payment cap" });
  });

  it("keeps the first of repeated keys and converts cents exactly", () => {
    expect(parseCliOutput("payee 0xA ramp\npayee 0xB other").payee).toBe("0xA ramp");
    expect(centsToUsdz(4210)).toBe("42.10");
    expect(centsToUsdzUnits(1)).toBe(10n ** 16n);
  });
});
