// Who let this agent spend? An agent can pay Sayso from its owner's Metal account under a mandate
// the owner bound: Sayso as the only payee, a cap per payment, a total budget, an expiry. Metal
// enforces those limits on chain, so a compromised agent can't overspend whatever its prompt says.
//
// Sayso checks every such payment from the chain alone (Metal's four verification steps) and keeps
// the result on the payout: the mandate, its limits, what is left of the budget, and whether the
// agent signed this exact order. With SAYSO_AGENT_MANDATES=required, a payment that is not under a
// mandate is refused before it settles, so no money moves.

import { createPublicClient, http, type Hash, type Hex } from "viem";
import { readMandateState, verifyMandatePayment, type VerifyStep } from "@metalntwx/metal-pay/mandates";
import { centsToUsdz, METAL_TESTNET_CHAIN_ID } from "./mandate.js";

export type MandatePolicy = "off" | "verify" | "required";

export function mandatePolicy(raw = process.env.SAYSO_AGENT_MANDATES): MandatePolicy {
  return raw === "off" || raw === "required" ? raw : "verify";
}

export interface MandateProof {
  ref: string;
  principal: string;
  /** Every step Metal's verifier ran passed. */
  ok: boolean;
  steps: Array<{ step: number; title: string; outcome: "pass" | "fail" | "skipped"; detail: string }>;
  limits: { cap_usdz: string; budget_usdz: string; payees: string[]; expires_at: string | null; max_payments: string | null };
  spent_usdz: string;
  left_usdz: string;
  /** The agent's key signed this exact offer (amount, payee), not just "a payment". */
  signed_order: boolean;
  problems: string[];
}

export interface MandateChecker {
  check(a: { tx: string; requirements: unknown; ref: string; checkoutMandate?: string }): Promise<MandateProof>;
}

const UNITS_PER_CENT = 10n ** 16n;
const usdz = (units: bigint) => centsToUsdz(Number(units / UNITS_PER_CENT));
const UNCAPPED = 2n ** 64n - 1n;

/** Reads the mandate and the payment from Metal through any RPC endpoint. */
export class ChainMandateChecker implements MandateChecker {
  private readonly client;
  constructor(rpcUrl: string, chainId = METAL_TESTNET_CHAIN_ID) {
    this.client = createPublicClient({ transport: http(rpcUrl), chain: { id: chainId, name: "Metal", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } });
  }

  async check(a: { tx: string; requirements: unknown; ref: string; checkoutMandate?: string }): Promise<MandateProof> {
    const v = await verifyMandatePayment(this.client, {
      tx: a.tx as Hash, ref: a.ref as Hex, requirements: a.requirements as never, ...(a.checkoutMandate ? { checkoutMandate: a.checkoutMandate } : {}),
    });
    const m = v.mandate;
    if (!m) return { ...empty(a.ref), steps: v.steps.map(step), problems: ["no mandate is bound for this payment"] };
    const state = await readMandateState(this.client, m.principal, m.ref);
    const c = m.constraints;
    return {
      ref: m.ref, principal: m.principal, ok: v.ok && !state.revoked, steps: v.steps.map(step),
      limits: {
        cap_usdz: usdz(c.perPaymentCap), budget_usdz: usdz(c.budget),
        payees: m.terms.payees.map((p) => p.account), expires_at: c.expiry ? new Date(Number(c.expiry) * 1000).toISOString() : null,
        max_payments: c.maxOccurrences && c.maxOccurrences < UNCAPPED ? String(c.maxOccurrences) : null,
      },
      spent_usdz: usdz(state.spent), left_usdz: usdz(c.budget > state.spent ? c.budget - state.spent : 0n),
      signed_order: Boolean(a.checkoutMandate) && v.ok,
      problems: [...(state.revoked ? ["the owner has revoked this mandate"] : []), ...v.payments.flatMap((p) => p.problems)],
    };
  }
}

const step = (s: VerifyStep) => ({ step: s.step, title: s.title, outcome: s.outcome, detail: s.detail });
const empty = (ref: string): MandateProof => ({
  ref, principal: "", ok: false, steps: [], limits: { cap_usdz: "0.00", budget_usdz: "0.00", payees: [], expires_at: null, max_payments: null },
  spent_usdz: "0.00", left_usdz: "0.00", signed_order: false, problems: [],
});

/**
 * Offline: mandates an owner "bound" in the simulator, with the same rules Metal enforces on chain.
 * The payment names its mandate in x-sim-mandate; a payment outside the mandate is refused before
 * anything settles, as Metal would refuse it.
 */
export class SimMandates implements MandateChecker {
  private readonly bound = new Map<string, { principal: string; capCents: number; budgetCents: number; payee: string; spentCents: number; expiresAt: Date }>();

  constructor(readonly payee: string) {}

  /** What `metal-agent mandate credential create` + `bind` would do, offline. */
  bind(ref: string, o: { principal: string; capCents: number; budgetCents: number; payee?: string; expiresAt?: Date }) {
    this.bound.set(ref, { principal: o.principal, capCents: o.capCents, budgetCents: o.budgetCents, payee: o.payee ?? this.payee, spentCents: 0, expiresAt: o.expiresAt ?? new Date(Date.now() + 30 * 86_400_000) });
  }

  /** Metal's settlement-time refusal, or undefined when the payment fits. Spends on success. */
  spend(ref: string, cents: number, now = new Date()): string | undefined {
    const m = this.bound.get(ref);
    if (!m) return "mandate_not_bound";
    if (m.payee.toLowerCase() !== this.payee.toLowerCase()) return "mandate_payee_not_allowed";
    if (now > m.expiresAt) return "mandate_expired";
    if (cents > m.capCents) return "mandate_cap_exceeded";
    if (m.spentCents + cents > m.budgetCents) return "mandate_budget_exceeded";
    m.spentCents += cents;
    return undefined;
  }

  principalOf(ref: string): string | undefined {
    return this.bound.get(ref)?.principal;
  }

  async check(a: { tx: string; ref: string; checkoutMandate?: string }): Promise<MandateProof> {
    const m = this.bound.get(a.ref);
    if (!m) return { ...empty(a.ref), problems: ["no mandate is bound for this payment"] };
    const pass = (n: 1 | 2 | 3 | 4, title: string) => ({ step: n, title, outcome: "pass" as const, detail: "sim" });
    return {
      ref: a.ref, principal: m.principal, ok: true,
      steps: [
        pass(1, "The mandate is bound on the principal's account"),
        { step: 2, title: "The credential matches the binding", outcome: "skipped", detail: "Sayso holds no credential" },
        { step: 3, title: "The credential's signatures", outcome: "skipped", detail: "Sayso holds no credential" },
        pass(4, "The payment is the agent key's per-payment mandate, inside the mandate"),
      ],
      limits: { cap_usdz: centsToUsdz(m.capCents), budget_usdz: centsToUsdz(m.budgetCents), payees: [m.payee], expires_at: m.expiresAt.toISOString(), max_payments: null },
      spent_usdz: centsToUsdz(m.spentCents), left_usdz: centsToUsdz(m.budgetCents - m.spentCents),
      signed_order: Boolean(a.checkoutMandate), problems: [],
    };
  }
}

/** One line for the trail: what the owner allowed, and what is left. */
export function describeMandate(p: MandateProof): string {
  if (!p.ok) return `Metal could not verify the agent's mandate: ${[...p.problems, ...p.steps.filter((s) => s.outcome === "fail").map((s) => s.title)].join("; ") || "unknown"}`;
  const payees = p.limits.payees.length ? "Sayso only" : "any payee";
  return `Paid under the owner's Metal mandate (${payees}, up to ${p.limits.cap_usdz} USDZ a payment, ${p.left_usdz} of ${p.limits.budget_usdz} USDZ left)${p.signed_order ? "; the agent signed this exact order" : ""}`;
}

