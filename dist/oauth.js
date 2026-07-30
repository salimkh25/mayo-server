"use strict";
// Social sign-in: Google, Facebook, Apple (OAuth 2.0 / OIDC authorization-code flow).
//
// Each provider needs credentials in env (see GO-LIVE.md). A provider whose env is missing
// is simply reported as "not configured" and its button returns a friendly message instead
// of a broken redirect — so you can turn them on one at a time.
//
// State is a stateless HMAC token (signed with SESSION_SECRET) to defend against login CSRF
// without needing a session store.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVIDERS = void 0;
exports.providerConfigured = providerConfigured;
exports.makeState = makeState;
exports.verifyState = verifyState;
exports.authUrl = authUrl;
exports.exchangeCodeForProfile = exchangeCodeForProfile;
const node_crypto_1 = __importDefault(require("node:crypto"));
exports.PROVIDERS = ['google', 'facebook'];
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-session-secret-change-me';
const env = {
    google: { id: process.env.GOOGLE_CLIENT_ID ?? '', secret: process.env.GOOGLE_CLIENT_SECRET ?? '' },
    facebook: { id: process.env.FACEBOOK_CLIENT_ID ?? '', secret: process.env.FACEBOOK_CLIENT_SECRET ?? '' },
};
function providerConfigured(p) {
    if (p === 'google')
        return Boolean(env.google.id && env.google.secret);
    return Boolean(env.facebook.id && env.facebook.secret);
}
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// ---- signed state ----------------------------------------------------------
function makeState() {
    const payload = b64url(JSON.stringify({ n: node_crypto_1.default.randomBytes(8).toString('hex'), t: Date.now() }));
    const mac = node_crypto_1.default.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return `${payload}.${mac}`;
}
function verifyState(state) {
    if (!state)
        return false;
    const [payload, mac] = state.split('.');
    if (!payload || !mac)
        return false;
    const expect = node_crypto_1.default.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(mac);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !node_crypto_1.default.timingSafeEqual(a, b))
        return false;
    try {
        const { t } = JSON.parse(Buffer.from(payload, 'base64').toString());
        return Date.now() - t < 10 * 60 * 1000; // 10 min window
    }
    catch {
        return false;
    }
}
// ---- authorize URLs --------------------------------------------------------
function authUrl(p, state, redirectUri) {
    if (p === 'google') {
        const q = new URLSearchParams({
            client_id: env.google.id,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            access_type: 'online',
            prompt: 'select_account',
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    }
    if (p === 'facebook') {
        const q = new URLSearchParams({
            client_id: env.facebook.id,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'email public_profile',
            state,
        });
        return `https://www.facebook.com/v19.0/dialog/oauth?${q}`;
    }
    return '';
}
async function exchangeCodeForProfile(p, code, redirectUri) {
    if (p === 'google') {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: env.google.id,
                client_secret: env.google.secret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        const tok = await tokenRes.json();
        if (!tok.access_token)
            throw new Error('Google token exchange failed');
        const uRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { Authorization: `Bearer ${tok.access_token}` },
        });
        const u = await uRes.json();
        if (!u.email)
            throw new Error('Google did not return an email');
        return { email: String(u.email).toLowerCase(), name: u.name ?? '' };
    }
    if (p === 'facebook') {
        const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' +
            new URLSearchParams({
                code,
                client_id: env.facebook.id,
                client_secret: env.facebook.secret,
                redirect_uri: redirectUri,
            }));
        const tok = await tokenRes.json();
        if (!tok.access_token)
            throw new Error('Facebook token exchange failed');
        const uRes = await fetch('https://graph.facebook.com/me?' +
            new URLSearchParams({ fields: 'id,name,email', access_token: tok.access_token }));
        const u = await uRes.json();
        if (!u.email)
            throw new Error('Facebook account has no shared email');
        return { email: String(u.email).toLowerCase(), name: u.name ?? '' };
    }
    throw new Error('Unsupported provider');
}
