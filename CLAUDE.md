# Sayso

Agents pay invoices in USDZ on Metal; Sayso decides pay, wait, split or hold, and pays the payee in their currency through Airwallex.

## Commands

Needs Node 24.8+ (`node:sqlite`, `--env-file-if-exists`).

- `npm ci`: install.
- `npm run typecheck`: `tsc --noEmit`.
- `npm test`: vitest, offline.
- `npm run serve:offline`: run the app with simulated rails.
- `npm run test:e2e`: e2e suite; needs a running app.

## Layout

- `src/payouts`: quote to paid state machine.
- `src/inbox`: invoice inbox (mailbox intake, extraction, approval).
- `src/airwallex`: Airwallex client.
- `src/metal`: Metal (USDZ) client.
- `src/platform`: platform API (router, rules, OpenAPI).
- `src/mcp`: MCP server for agents.
- `src/web`: static web UI served by the app.
- `src/sim`: offline fakes; every sim proof starts with `sim:`.
- `src/machine.ts`: state tables for every status.

## Conventions

- Every status change is a compare-and-set (`transition` in `src/payouts/book.ts`, `setStatus` in the inbox and batch code) checked against the tables in `src/machine.ts`.
- Money is integer minor units.
- Comments are short "why" lines.
- No em dashes.
- Tests are vitest under `test/`, offline through `buildSayso({ offline: true })`.

## Safety

- Never commit `.env` or `.metal/`.
- Never print private keys.
