// Pushover notifications — pings the owner's iPhone.
// Configure with env: PUSHOVER_TOKEN (application API token) and PUSHOVER_USER (your user key).
// Both come from https://pushover.net (see GO-LIVE.md). If unset, notify() is a no-op
// so the app still runs locally without credentials.

const TOKEN = process.env.PUSHOVER_TOKEN ?? '';
const USER = process.env.PUSHOVER_USER ?? '';

export type NotifyOpts = {
  title?: string;
  /** -2 quiet … 2 emergency. 1 = high priority (bypasses quiet hours). */
  priority?: -2 | -1 | 0 | 1 | 2;
  /** Optional deep link the notification opens (e.g. the order in the admin panel). */
  url?: string;
  urlTitle?: string;
};

/** Fire-and-forget push to the owner's phone. Never throws — logs on failure. */
export async function notify(message: string, opts: NotifyOpts = {}): Promise<boolean> {
  if (!TOKEN || !USER) {
    console.log(`[notify:skipped — Pushover not configured] ${opts.title ?? ''} ${message}`);
    return false;
  }
  try {
    const body = new URLSearchParams({
      token: TOKEN,
      user: USER,
      message,
      title: opts.title ?? 'NAYO',
      priority: String(opts.priority ?? 0),
      ...(opts.url ? { url: opts.url, url_title: opts.urlTitle ?? 'Open' } : {}),
    });
    const res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body });
    if (!res.ok) {
      console.error('[notify] Pushover error', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[notify] Pushover request failed', e);
    return false;
  }
}

export const notifyConfigured = () => Boolean(TOKEN && USER);
