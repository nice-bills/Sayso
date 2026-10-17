// Runs Coin Slot: `npm run serve` (live sandboxes) or `npm run serve:offline` (simulators).
import { buildCoinSlot } from "./app.js";
import { emit } from "./events.js";

const offline = process.argv.includes("--offline");
const port = Number(process.env.PORT ?? 4021);
const cs = await buildCoinSlot({ offline });
cs.app.listen(port, () => emit("observe", `Coin Slot on http://127.0.0.1:${port} (API /v1, back office /ops/)${offline ? " OFFLINE" : ""}`));
const every = Number(process.env.TICK_MS ?? (offline ? 3000 : 30_000));
setInterval(() => void cs.tick(), every);
