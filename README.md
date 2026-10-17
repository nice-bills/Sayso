# Coin Slot

An AI agent that sells its service a tenth of a cent at a time on **Metal**, banks the earnings with **Airwallex**, and pays its own bills in any currency, while the rails, not the prompt, decide what it is allowed to pay.

Built for the Airwallex Agentic Banking Hackathon (2026).

## How it fits together

```
buyer agents --x402 (exact / clearing-debit)--> seller API on Metal testnet
                                                   |
                                   epoch settles on chain (*USDZ)
                                                   |
             verify receipt + Transfer event + finality (Metal PSP guide)
                                                   |
                    ramp ledger: one credit per finalized event (UNIQUE event key)
                                                   |
                              Airwallex global account (USD)
                                                   |
     treasury policy (code): hold / convert minimum / pay LOCAL / defer / escalate
                                                   |
            FX conversion -> beneficiary payouts -> reconcile; agent card for compute
```

- `src/treasury/policy.ts`: every amount, limit and reserve is decided here, in pure code. The model can only lower forecast confidence or flag evidence.
- `src/treasury/approval.ts`: approvals bound to the exact amount, currency, beneficiary and evidence. Single use, with an expiry.
- `src/bridge/`: the Metal-to-Airwallex off-ramp. Until a sandbox link exists, the credit side is Airwallex's deposit simulation behind one interface.
- `src/metal/`: the x402 seller, the buyer swarm, and server-side transfer verification.
- `src/airwallex/client.ts`: a typed REST client with the sandbox conventions built in.

## Run

```
npm install
cp .env.example .env   # fill in sandbox keys and a Metal testnet RPC endpoint
npm test               # policy, approval and ramp tests
npm run seller         # x402 seller on :4021
npm run swarm          # buyer agents paying per call
```

Note: `@x402/*` is pinned to 2.21.0. `@metalntwx/metal-pay` 0.2.0's `ClearingDebitServerScheme` has no `paymentFlows`, which `@x402/core` 2.22+ requires at runtime.
