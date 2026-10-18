// Tells the owner on their phone when something needs their tap. Uses ntfy (free, no account):
// install the ntfy app, subscribe to a long random topic, and set NTFY_TOPIC. PUBLIC_URL makes the
// notification open the approval page. Without NTFY_TOPIC this only logs.

import { emit } from "./events.js";

export type Notifier = (title: string, message: string, path: string) => Promise<void>;

export function notifierFromEnv(): Notifier {
  const topic = process.env.NTFY_TOPIC;
  const server = process.env.NTFY_SERVER ?? "https://ntfy.sh";
  const publicUrl = process.env.PUBLIC_URL;
  return async (title, message, path) => {
    if (!topic) return;
    const headers: Record<string, string> = { title, tags: "coin" };
    if (publicUrl) headers.click = new URL(path, publicUrl).toString();
    try {
      const res = await fetch(`${server}/${encodeURIComponent(topic)}`, { method: "POST", headers, body: message });
      if (!res.ok) emit("escalate", `Phone notification failed: HTTP ${res.status}`);
    } catch (err) {
      emit("escalate", `Phone notification failed: ${String(err).slice(0, 120)}`);
    }
  };
}
