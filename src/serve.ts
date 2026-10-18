// Runs Sayso: `npm run serve` (live sandboxes) or `npm run serve:offline` (simulators).
// Offline, the app opens with a few sample invoices and agent payouts so there is something to tap
// (SEED=0 starts empty).
import { buildSayso } from "./app.js";
import { emit } from "./events.js";
import { designerInvoice, fakeLandlord, studioInvoice, vagueEmail } from "../samples/invoices.js";

const offline = process.argv.includes("--offline");
const port = Number(process.env.PORT ?? 4021);
const cs = await buildSayso({ offline });
const base = `http://127.0.0.1:${port}`;
cs.app.listen(port, async () => {
  emit("observe", `Sayso on ${base}${offline ? ` OFFLINE; sign in with ${cs.ownerToken}` : ""}`);
  if (offline && process.env.SEED !== "0") await seed().catch((e) => emit("escalate", `Seeding failed: ${String(e)}`));
});
const every = Number(process.env.TICK_MS ?? (offline ? 3000 : 30_000));
setInterval(() => void cs.tick(), every);

async function seed() {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  for (const [i, e] of [vagueEmail, fakeLandlord, designerInvoice, studioInvoice].entries()) await cs.inbox.receive({ ...e, receivedAt: minutesAgo(40 - i * 10) });
  const json = { "content-type": "application/json" };
  const jobs = [
    { amount: "180.00", currency: "EUR", reference: "Translation Oct", payee: { name: "Lingua Freelance", address: { country_code: "FR", city: "Paris", street_address: "1 Rue de Rivoli", postcode: "75001" }, bank: { iban: "FR1420041010050500013M02606" }, bank_country_code: "FR" } },
    { amount: "95.50", currency: "EUR", reference: "GPU rental 44", payee: { name: "Rechenzentrum Nord GmbH", address: { country_code: "DE", city: "Hamburg", street_address: "Hafenstr. 2", postcode: "20359" }, bank: { iban: "DE75512108001245126199" }, bank_country_code: "DE" } },
  ];
  for (const [i, job] of jobs.entries()) {
    const q = (await (await fetch(`${base}/v1/quotes`, { method: "POST", headers: json, body: JSON.stringify(job) })).json()) as { pay_url?: string };
    if (q.pay_url) await fetch(base + q.pay_url, { method: "POST", headers: { "x-sim-payer": `0xA9e000000000000000000000000000000000000${i + 1}` } });
  }
  emit("observe", "Seeded sample invoices and two agent payouts (offline)");
}
