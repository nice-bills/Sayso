// The agent's storefront: an HTTP API that charges per call over x402 on Metal testnet.
// `exact` works for any seller; `clearing-debit` (sub-cent, netted per epoch) is offered
// only when Metal has issued us a seller token.

import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ClearingDebitServerScheme, METAL_NETWORKS, registerMetalScheme, sellerToken } from "@metalntwx/metal-pay";

const NETWORK = METAL_NETWORKS.testnet.network; // eip155:63825
const PRICE_EXACT = "0.01";
const PRICE_CLEARING = "0.001";

const payTo = process.env.METAL_SELLER_ADDRESS;
if (!payTo) throw new Error("Set METAL_SELLER_ADDRESS to the agent's Metal address");
const token = process.env.METAL_SELLER_TOKEN;

const facilitator = new HTTPFacilitatorClient({
  url: METAL_NETWORKS.testnet.facilitatorUrl,
  ...(token ? { createAuthHeaders: sellerToken(token) } : {}),
});
const server = registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] });

// Live meter for the demo screen. The ledger of record is the chain, not this.
export const meter = { paidCalls: 0, clearingReceipts: 0 };

if (token) {
  server.register(NETWORK, new ClearingDebitServerScheme(undefined, {
    onReceipt: async () => { meter.clearingReceipts += 1; },
  }));
}

const accepts = [
  ...(token ? [{ scheme: "clearing-debit", network: NETWORK, payTo, price: PRICE_CLEARING }] : []),
  { scheme: "exact", network: NETWORK, payTo, price: PRICE_EXACT },
];

const app = express();
app.use(express.json());
app.use(paymentMiddleware({ "GET /v1/answer": { accepts } } as Parameters<typeof paymentMiddleware>[0], server));

app.get("/v1/answer", (req, res) => {
  meter.paidCalls += 1;
  // The paid service itself is wired up next (it is what generates the compute bill the agent pays).
  res.json({ ok: true, q: req.query.q ?? null, served: meter.paidCalls });
});

app.get("/meter", (_req, res) => res.json(meter));

const port = Number(process.env.PORT ?? 4021);
app.listen(port, () => console.log(`Coin Slot seller on :${port}, paying to ${payTo} on ${NETWORK}${token ? " (clearing enabled)" : " (exact only)"}`));
