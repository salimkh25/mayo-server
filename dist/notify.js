"use strict";
// Pushover notifications — pings the owner's iPhone.
// Configure with env: PUSHOVER_TOKEN (application API token) and PUSHOVER_USER (your user key).
// Both come from https://pushover.net (see GO-LIVE.md). If unset, notify() is a no-op
// so the app still runs locally without credentials.
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyConfigured = void 0;
exports.notify = notify;
const TOKEN = process.env.PUSHOVER_TOKEN ?? '';
const USER = process.env.PUSHOVER_USER ?? '';
/** Fire-and-forget push to the owner's phone. Never throws — logs on failure. */
async function notify(message, opts = {}) {
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
    }
    catch (e) {
        console.error('[notify] Pushover request failed', e);
        return false;
    }
}
const notifyConfigured = () => Boolean(TOKEN && USER);
exports.notifyConfigured = notifyConfigured;
