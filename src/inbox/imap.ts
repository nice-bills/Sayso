// Reads forwarded invoices from any IMAP mailbox (a free Gmail with an app password works):
// unseen messages in INBOX are parsed, handed to the inbox, and marked seen.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { emit } from "../events.js";
import type { Inbox } from "./inbox.js";

export interface ImapConfig { host: string; port: number; user: string; pass: string }

export function imapFromEnv(): ImapConfig | undefined {
  const { INBOX_IMAP_HOST, INBOX_IMAP_PORT, INBOX_IMAP_USER, INBOX_IMAP_PASS } = process.env;
  if (!INBOX_IMAP_HOST || !INBOX_IMAP_USER || !INBOX_IMAP_PASS) return undefined;
  return { host: INBOX_IMAP_HOST, port: Number(INBOX_IMAP_PORT ?? 993), user: INBOX_IMAP_USER, pass: INBOX_IMAP_PASS };
}

export async function pollImap(cfg: ImapConfig, inbox: Inbox): Promise<number> {
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  await client.connect();
  let n = 0;
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const mail = await simpleParser(msg.source);
      await inbox.receive({
        messageId: mail.messageId ?? `imap-${uid}`,
        from: mail.from?.text ?? "unknown",
        subject: mail.subject ?? "(no subject)",
        body: mail.text ?? "",
        receivedAt: mail.date ?? new Date(),
      });
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      n++;
    }
  } catch (err) {
    emit("escalate", `Inbox read failed: ${String(err).slice(0, 200)}`);
  } finally {
    lock.release();
    await client.logout();
  }
  return n;
}
