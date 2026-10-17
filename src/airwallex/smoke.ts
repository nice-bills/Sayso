// Read-only check that the sandbox keys work: login, balances, global accounts, one FX rate.
import { Airwallex } from "./client.js";

const awx = Airwallex.fromEnv();
console.log("balances", await awx.currentBalances());
console.log("global accounts", (await awx.globalAccounts()).items.map((a) => `${a.id} ${a.currency ?? ""} ${a.country_code ?? ""}`));
console.log("USD->EUR rate", await awx.fxRate("USD", "EUR"));
console.log("Airwallex sandbox OK");
