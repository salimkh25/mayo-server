"use strict";
// Payment provider abstraction.
//
// Today: Stripe (hosted Checkout — card details never touch our server).
// The rest of the app only calls createCheckout() / verifyWebhook(), so swapping in an
// Israeli gateway later (PayPlus / Grow / Cardcom — for Bit + local VAT invoices) means
// rewriting only this file, not the routes.
//
// Configure with env: STRIPE_SECRET_KEY (sk_...) and STRIPE_WEBHOOK_SECRET (whsec_...).
// If STRIPE_SECRET_KEY is unset the app falls back to "dev mode": orders are committed
// immediately with no payment, so it still runs locally exactly like the original demo.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentsConfigured = exports.CURRENCY = void 0;
exports.createCheckout = createCheckout;
exports.isSessionPaid = isSessionPaid;
exports.verifyWebhook = verifyWebhook;
const stripe_1 = __importDefault(require("stripe"));
const SECRET = process.env.STRIPE_SECRET_KEY ?? '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
exports.CURRENCY = (process.env.CURRENCY ?? 'ils').toLowerCase();
let stripe = null;
if (SECRET)
    stripe = new stripe_1.default(SECRET);
const paymentsConfigured = () => Boolean(stripe);
exports.paymentsConfigured = paymentsConfigured;
/** Create a hosted Stripe Checkout Session. Returns the URL to redirect the shopper to. */
async function createCheckout(args) {
    if (!stripe)
        throw new Error('Stripe is not configured');
    const line_items = args.lines.map((l) => ({
        quantity: l.qty,
        price_data: {
            currency: exports.CURRENCY,
            unit_amount: l.amountCents,
            product_data: { name: l.name },
        },
    }));
    if (args.shippingCents && args.shippingCents > 0) {
        line_items.push({
            quantity: 1,
            price_data: {
                currency: exports.CURRENCY,
                unit_amount: args.shippingCents,
                product_data: { name: 'Shipping' },
            },
        });
    }
    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: args.email,
        line_items,
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        metadata: args.metadata,
        // Stripe truncates metadata values at 500 chars; the cart is also stored under
        // payment_intent metadata via the session, but we keep our own copy small.
    });
    if (!session.url)
        throw new Error('Stripe did not return a checkout URL');
    return { url: session.url, id: session.id };
}
/** Confirm a session was actually paid — used as a fallback on the success page in case
 *  the webhook is delayed or unavailable (e.g. local testing without Stripe CLI). */
async function isSessionPaid(sessionId) {
    if (!stripe)
        return false;
    try {
        const s = await stripe.checkout.sessions.retrieve(sessionId);
        return s.payment_status === 'paid';
    }
    catch {
        return false;
    }
}
/** Verify a Stripe webhook signature and pull out the fields we care about. */
function verifyWebhook(rawBody, signature) {
    if (!stripe)
        return { ok: false, error: 'Stripe not configured' };
    if (!WEBHOOK_SECRET)
        return { ok: false, error: 'STRIPE_WEBHOOK_SECRET not set' };
    if (!signature)
        return { ok: false, error: 'Missing stripe-signature header' };
    try {
        const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
        if (event.type === 'checkout.session.completed') {
            const s = event.data.object;
            return {
                ok: true,
                type: event.type,
                sessionId: s.id,
                metadata: (s.metadata ?? {}),
                email: s.customer_email ?? s.customer_details?.email ?? '',
            };
        }
        return { ok: true, type: event.type, sessionId: '', metadata: {}, email: '' };
    }
    catch (e) {
        return { ok: false, error: e?.message ?? 'signature verification failed' };
    }
}
