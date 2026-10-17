// The agent loop: observe -> decide -> act, every tick. Reconciliation runs separately over a
// balance snapshot (see reconcile.ts) so it can never be skipped by a failing step here.
//
// observe: sweep settled Metal earnings into Airwallex; read balances and rates; read inbound messages.
// decide:  the treasury policy plans every obligation in the horizon (code, not the model).
// act:     the executor converts and pays, approval-gated and duplicate-safe.

import type { Airwallex } from "../airwallex/client.js";
import type { RampLedger } from "../bridge/ledger.js";
import { sweepEpoch, type AirwallexCredit, type MetalSettlementVerifier } from "../bridge/ramp.js";
import { emit } from "../events.js";
import type { EarningsSource } from "../metal/earnings.js";
import { fmt, toMinor } from "../treasury/money.js";
import { plan, type Action, type Forecast, type Obligation, type PolicyConfig, type TreasuryState } from "../treasury/policy.js";
import { executeConvert, executePay, onTransferState, type AirwallexPort, type ExecutorDeps } from "./executor.js";
import { applyFindings, readAuto } from "./reader.js";

export type LoopAirwallex = AirwallexPort & Pick<Airwallex, "currentBalances" | "fxRate">;

export interface InboundMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
}

export interface AgentDeps extends ExecutorDeps {
  awx: LoopAirwallex;
  ledger: RampLedger;
  verifier: MetalSettlementVerifier;
  credit: AirwallexCredit;
  earnings: EarningsSource;
  cfg: PolicyConfig;
  obligations: Obligation[];
  allowlist: Set<string>;
  forecast: Forecast;
}

export class Agent {
  readonly inbox: InboundMessage[] = [];
  lastPlan?: { actions: Action[]; autonomousLimitMinor: number };
  balancesMinor: Record<string, number> = {};
  /** Messages that asked to move money somewhere new; a person must verify them out of band. */
  readonly flagged: Array<{ message: InboundMessage; citations: string[]; addresses: string[] }> = [];

  constructor(readonly d: AgentDeps) {}

  async sweep(): Promise<void> {
    const e = await this.d.earnings.pending();
    if (!e) return;
    emit("observe", `Earnings ready to sweep: ${fmt(e.amountMinor, "USD")} (${e.epoch})`, { epoch: e.epoch });
    const r = await sweepEpoch({ ...e, currency: "USD" }, this.d.ledger, this.d.verifier, this.d.credit);
    if (r.outcome === "credited") emit("act", `Credited ${fmt(e.amountMinor, "USD")} to Airwallex, exactly once`, { epoch: e.epoch, eventKey: r.sweep.eventKey }, r.sweep.airwallexDepositId ?? undefined);
    else if (r.outcome === "rejected") emit("refuse", `Sweep ${e.epoch} not credited: ${r.sweep.reason}`);
  }

  async observe(): Promise<TreasuryState> {
    const balances = await this.d.awx.currentBalances();
    this.balancesMinor = Object.fromEntries(balances.map((b) => [b.currency, toMinor(b.available_amount)]));
    const rates: Record<string, number> = {};
    for (const ccy of new Set(this.d.obligations.map((o) => o.currency))) {
      if (ccy !== this.d.cfg.baseCurrency) rates[ccy] = (await this.d.awx.fxRate(this.d.cfg.baseCurrency, ccy)).rate;
    }
    emit("observe", `Balances: ${Object.entries(this.balancesMinor).map(([c, m]) => fmt(m, c)).join(", ") || "none"}`, { rates });
    return { balancesMinor: this.balancesMinor, rates, obligations: this.open(), allowlistedBeneficiaries: this.d.allowlist, forecast: this.d.forecast };
  }

  /** Obligations with no live payout: never paid, or the last attempt failed and may be replaced. */
  open(): Obligation[] {
    return this.d.obligations.filter((o) => {
      const op = this.d.store.latestOp(o.id, "pay");
      return !op || op.status === "failed";
    });
  }

  /** The model reads; code decides what the reading changes. */
  async readInbox(): Promise<void> {
    while (this.inbox.length) {
      const m = this.inbox.shift()!;
      const f = await readAuto(`From: ${m.from}\nSubject: ${m.subject}\n\n${m.body}`);
      const effect = applyFindings(f, this.d.forecast);
      if (effect.forecast.confidence !== this.d.forecast.confidence) {
        emit("decide", `"${m.subject}" contradicts the earnings forecast: confidence ${this.d.forecast.confidence} -> ${effect.forecast.confidence}, so autonomous limits tighten`, { citations: f.citations, reader: f.reader });
      }
      this.d.forecast = effect.forecast;
      if (effect.escalate) {
        const addresses = [...m.body.matchAll(/0x[0-9a-fA-F]{40}/g)].map((x) => x[0]);
        this.flagged.push({ message: m, citations: f.citations, addresses });
        // The verified beneficiary on file is unchanged: an email can never edit where money goes.
        emit("escalate", `"${m.subject}" asks to change bank details. Not acted on; payments keep going to the verified account until a person confirms by phone`, { from: m.from, citations: f.citations, pressure: f.pressureTactics, reader: f.reader });
      } else {
        emit("observe", `Read "${m.subject}": ${f.kind}`, { reader: f.reader });
      }
    }
  }

  decide(state: TreasuryState, now: Date): Action[] {
    const p = plan(state, this.d.cfg, now);
    this.lastPlan = p;
    emit("decide", `Plan: ${p.actions.length} actions, autonomous limit ${fmt(p.autonomousLimitMinor, this.d.cfg.baseCurrency)}`, { actions: p.actions });
    for (const a of p.actions) {
      if (a.kind === "hold") emit("decide", `Hold ${fmt(a.amountMinor, a.currency)}: ${a.reason.replaceAll("_", " ")}`);
      if (a.kind === "defer") emit("decide", `Defer ${a.obligationId}: ${a.reason.replaceAll("_", " ")}`);
      if (a.kind === "escalate") emit("escalate", `${a.obligationId}: ${a.reason.replaceAll("_", " ")}`);
    }
    return p.actions;
  }

  async act(actions: Action[]): Promise<void> {
    for (const a of actions) {
      if (a.kind === "convert") await executeConvert(this.d, a);
      if (a.kind === "pay") await executePay(this.d, a);
    }
  }

  /** Poll payouts we started (webhooks do this in production) and settle or replace them. */
  async followPayouts(): Promise<void> {
    for (const op of this.d.store.ops()) {
      if (op.kind !== "pay" || op.status !== "submitted") continue;
      const t = await this.d.awx.transferByRequestId(op.requestId);
      if (!t) continue;
      const beneficiary = this.d.obligations.find((o) => o.id === op.obligationId)?.beneficiaryId;
      onTransferState(this.d, t, beneficiary !== undefined && this.d.allowlist.has(beneficiary));
    }
  }

  async tick(now = new Date()): Promise<void> {
    await this.sweep();
    await this.readInbox();
    const state = await this.observe();
    await this.act(this.decide(state, now));
    await this.followPayouts();
  }
}
