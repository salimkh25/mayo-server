import 'dotenv/config'; // load .env locally (no-op if the file is absent; hosts inject env directly)
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';

import { db, moveStock, outfitAvailability, itemAvailability, variantSizeFor } from './db.js';
import { backfillThemeImages, backfillItemPrices, backfillPriceFloors, seedIfEmpty } from './seed.js';
import { notify } from './notify.js';
import { createCheckout, verifyWebhook, paymentsConfigured, isSessionPaid } from './payments.js';
import * as oauth from './oauth.js';

// Production launches with an EMPTY catalog — add real products via the admin panel.
// Set SEED_DEMO=true to load the sample catalog (useful for local development).
if (process.env.SEED_DEMO === 'true') {
  seedIfEmpty();
  backfillThemeImages();
  backfillItemPrices();
  backfillPriceFloors();
}

const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.use(cors());
// The Stripe webhook needs the raw, unparsed body to verify its signature, so JSON
// parsing is skipped for that one path (it gets express.raw where it's defined).
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  return express.json({ limit: '16mb' })(req, res, next); // room for base64 product photos
});
// Public base URL of the site (used to build OAuth + Stripe redirect URLs). In dev the
// Vite server proxies /api, so a relative fallback works; set PUBLIC_URL in production.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const publicUrl = (req: express.Request) =>
  PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
// Served under /api so the Vite dev proxy forwards it; also works in prod behind one host.
app.use('/api/uploads', express.static(uploadsDir, { maxAge: '365d', immutable: true }));

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
};

const ADMIN_KEY = process.env.ADMIN_KEY ?? 'admin-dev-key';
const SCARCITY_THRESHOLD = Number(process.env.SCARCITY_THRESHOLD ?? 5);

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (emailFromToken(req) === '__admin__') return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---- helpers -------------------------------------------------------------

/** Full gallery for an item: the extra photos if any, else the single legacy image_url. */
function itemImages(itemId: number): { url: string; color: string }[] {
  const rows = db
    .prepare(`SELECT url, color FROM item_images WHERE item_id = ? ORDER BY sort, id`)
    .all(itemId) as { url: string; color: string }[];
  if (rows.length) return rows;
  const i = db.prepare(`SELECT image_url FROM items WHERE id = ?`).get(itemId) as any;
  return i?.image_url ? [{ url: i.image_url, color: '' }] : [];
}

/** An item's selectable colors (empty = the item has no colors). */
function itemColors(itemId: number): { name: string; swatch: string; imageUrl: string }[] {
  return (
    db.prepare(`SELECT name, swatch, image_url FROM item_colors WHERE item_id = ? ORDER BY sort, id`).all(itemId) as any[]
  ).map((c) => ({ name: c.name, swatch: c.swatch, imageUrl: c.image_url }));
}

/** Full gallery for an outfit: the extra photos if any, else the single legacy hero_image. */
function outfitImages(outfitId: number): string[] {
  const rows = db
    .prepare(`SELECT url FROM outfit_images WHERE outfit_id = ? ORDER BY sort, id`)
    .all(outfitId) as { url: string }[];
  if (rows.length) return rows.map((r) => r.url);
  const o = db.prepare(`SELECT hero_image FROM outfits WHERE id = ?`).get(outfitId) as any;
  return o?.hero_image ? [o.hero_image] : [];
}

/** Photos to display for an outfit. If the set has none of its own, borrow its component
 *  items' photos so shoppers still see real imagery instead of a placeholder. */
function outfitPhotos(outfitId: number): string[] {
  const own = outfitImages(outfitId);
  if (own.length) return own;
  const parts = db
    .prepare(`SELECT i.id FROM outfit_items oi JOIN items i ON i.id = oi.item_id WHERE oi.outfit_id = ? ORDER BY i.id`)
    .all(outfitId) as { id: number }[];
  const photos: string[] = [];
  for (const p of parts) for (const im of itemImages(p.id)) if (im.url) photos.push(im.url);
  return photos;
}

/** Replace an item's gallery and keep image_url (the card thumbnail) as the first photo. */
function replaceItemImages(itemId: number, gallery: { url: string; color?: string }[]) {
  db.prepare(`DELETE FROM item_images WHERE item_id = ?`).run(itemId);
  gallery.forEach((g, idx) => {
    if (!g?.url) return;
    db.prepare(`INSERT INTO item_images (item_id, url, color, sort) VALUES (?, ?, ?, ?)`).run(itemId, g.url, g.color ?? '', idx);
  });
  db.prepare(`UPDATE items SET image_url = ? WHERE id = ?`).run(gallery.find((g) => g?.url)?.url ?? '', itemId);
}

/** Replace an outfit's gallery and keep hero_image as the first photo. */
function replaceOutfitImages(outfitId: number, gallery: string[]) {
  db.prepare(`DELETE FROM outfit_images WHERE outfit_id = ?`).run(outfitId);
  gallery.forEach((url, idx) => {
    if (!url) return;
    db.prepare(`INSERT INTO outfit_images (outfit_id, url, sort) VALUES (?, ?, ?)`).run(outfitId, url, idx);
  });
  db.prepare(`UPDATE outfits SET hero_image = ? WHERE id = ?`).run(gallery.find(Boolean) ?? '', outfitId);
}

/** Upsert an item's color list (by name) and make sure a variant row exists for every
 *  (size × color). Surviving variants keep their stock; colors dropped from the list are
 *  removed along with their (zero-usage) variant rows. The stock ledger is never touched. */
function syncItemColors(itemId: number, colors: { name: string; swatch?: string; imageUrl?: string }[]) {
  const clean = colors.filter((c) => c && c.name && c.name.trim());
  const sizes = (
    db.prepare(`SELECT DISTINCT size FROM item_variants WHERE item_id = ?`).all(itemId) as any[]
  ).map((r) => r.size);
  const keep = new Set(clean.map((c) => c.name));

  // drop colors no longer listed (and their variants)
  for (const existing of db.prepare(`SELECT name FROM item_colors WHERE item_id = ?`).all(itemId) as any[]) {
    if (!keep.has(existing.name)) {
      db.prepare(`DELETE FROM item_colors WHERE item_id = ? AND name = ?`).run(itemId, existing.name);
      db.prepare(`DELETE FROM item_variants WHERE item_id = ? AND color = ?`).run(itemId, existing.name);
    }
  }
  // upsert listed colors + ensure a variant exists for each size
  clean.forEach((c, idx) => {
    db.prepare(
      `INSERT INTO item_colors (item_id, name, swatch, image_url, sort) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id, name) DO UPDATE SET swatch = excluded.swatch, image_url = excluded.image_url, sort = excluded.sort`
    ).run(itemId, c.name, c.swatch ?? '', c.imageUrl ?? '', idx);
    for (const size of sizes)
      db.prepare(`INSERT OR IGNORE INTO item_variants (item_id, size, color, on_hand) VALUES (?, ?, ?, 0)`).run(itemId, size, c.name);
  });
}

function outfitPublic(o: any, ctx: PriceCtx = null) {
  const availability = outfitAvailability(o.id);
  const maxAvailable = availability.reduce((m, a) => Math.max(m, a.available), 0);
  const items = db
    .prepare(
      `SELECT i.id, i.sku, i.name, i.type, i.sizing, i.detail, i.icon, i.list_price_cents
       FROM outfit_items oi JOIN items i ON i.id = oi.item_id WHERE oi.outfit_id = ?`
    )
    .all(o.id) as any[];
  const componentsSum = items.reduce((n, it) => n + (it.list_price_cents || 0), 0);
  const themes = db
    .prepare(
      `SELECT t.slug, t.name FROM outfit_themes ot JOIN themes t ON t.id = ot.theme_id WHERE ot.outfit_id = ?`
    )
    .all(o.id);
  const yourPrice = effectiveUnitPrice(o.price_cents, o.price_floor_cents, o.sale_price_cents, ctx);
  // struck reference: a sale strikes the regular list price; otherwise the pieces-sum
  // anchor (bundles save vs buying separately — everyone sees it). Loyalty rides on top.
  const onSale = o.sale_price_cents > 0 && o.sale_price_cents < o.price_cents;
  const compareAt = onSale ? o.price_cents : Math.max(componentsSum > o.price_cents ? componentsSum : 0, o.price_cents);
  return {
    id: o.id,
    slug: o.slug,
    name: o.name,
    story: o.story,
    priceCents: o.price_cents, // public list price (ceiling)
    floorCents: o.price_floor_cents,
    saleCents: o.sale_price_cents,
    componentsSumCents: componentsSum,
    yourPriceCents: yourPrice, // effective price this viewer pays
    compareAtCents: compareAt > yourPrice ? compareAt : 0, // 0 = nothing to strike
    onSale,
    onLoyaltyBand: o.price_floor_cents > 0 && o.price_floor_cents < o.price_cents,
    yourTier: ctx?.tierName ?? null,
    sizeRun: JSON.parse(o.size_run),
    heroImage: o.hero_image || outfitPhotos(o.id)[0] || '',
    images: outfitPhotos(o.id),
    paletteFrom: o.palette_from,
    paletteTo: o.palette_to,
    icon: o.icon,
    rating: o.rating,
    items,
    themes,
    availability: availability.map(({ size, available }) => ({
      size,
      soldOut: available <= 0,
      // Truthful scarcity: exact count only exposed when at/below threshold (CF-08)
      lowStock: available > 0 && available <= SCARCITY_THRESHOLD,
      left: available > 0 && available <= SCARCITY_THRESHOLD ? available : null,
    })),
    soldOut: maxAvailable <= 0,
    scarcity:
      maxAvailable > 0 && maxAvailable <= SCARCITY_THRESHOLD ? maxAvailable : null,
  };
}

function itemPublic(i: any, ctx: PriceCtx = null) {
  const availability = itemAvailability(i.id);
  const maxAvailable = availability.reduce((m, a) => Math.max(m, a.available), 0);
  // outfits this item is part of (reverse cross-sell — FEATURES §1.4)
  const partOfOutfits = db
    .prepare(
      `SELECT o.slug, o.name, o.price_cents FROM outfit_items oi
       JOIN outfits o ON o.id = oi.outfit_id
       WHERE oi.item_id = ? AND o.status = 'live'`
    )
    .all(i.id) as any[];
  return {
    id: i.id,
    sku: i.sku,
    name: i.name,
    type: i.type,
    sizing: i.sizing,
    detail: i.detail,
    icon: i.icon,
    priceCents: i.list_price_cents, // public list price (ceiling)
    floorCents: i.price_floor_cents,
    saleCents: i.sale_price_cents,
    yourPriceCents: effectiveUnitPrice(i.list_price_cents, i.price_floor_cents, i.sale_price_cents, ctx),
    compareAtCents:
      effectiveUnitPrice(i.list_price_cents, i.price_floor_cents, i.sale_price_cents, ctx) < i.list_price_cents
        ? i.list_price_cents
        : 0,
    onSale: i.sale_price_cents > 0 && i.sale_price_cents < i.list_price_cents,
    onLoyaltyBand: i.price_floor_cents > 0 && i.price_floor_cents < i.list_price_cents,
    yourTier: ctx?.tierName ?? null,
    imageUrl: i.image_url,
    images: itemImages(i.id),
    colors: itemColors(i.id),
    soldStandalone: !!i.is_sold_standalone,
    availability: availability.map(({ size, color, available }) => ({
      size,
      color: color ?? '',
      soldOut: available <= 0,
      lowStock: available > 0 && available <= SCARCITY_THRESHOLD,
      left: available > 0 && available <= SCARCITY_THRESHOLD ? available : null,
    })),
    soldOut: maxAvailable <= 0,
    scarcity: maxAvailable > 0 && maxAvailable <= SCARCITY_THRESHOLD ? maxAvailable : null,
    partOfOutfits: partOfOutfits.map((o) => ({
      slug: o.slug,
      name: o.name,
      priceCents: o.price_cents,
    })),
  };
}

const TIERS = [
  { name: 'Insider', minOrders: 0, perk: 'Early access to new themes', bundleDiscountPct: 0 },
  { name: 'Gold', minOrders: 3, perk: 'Free shipping + 5% member pricing', bundleDiscountPct: 5 },
  { name: 'Platinum', minOrders: 6, perk: 'Express shipping + exclusive capsules', bundleDiscountPct: 8 },
];

function tierFor(email: string) {
  const n = (
    db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE email = ? AND status != 'cancelled'`).get(email) as {
      n: number;
    }
  ).n;
  let tier = TIERS[0];
  for (const t of TIERS) if (n >= t.minOrders) tier = t;
  const next = TIERS.find((t) => t.minOrders > n);
  return { orders: n, tier, next: next ? { name: next.name, ordersAway: next.minOrders - n } : null };
}

// ---- loyalty pricing band -------------------------------------------------------
// Personalized price lives in [floor, list]. It only ever moves DOWN from the public
// list price (the ceiling), scaled by tier + order history. Disclosed as a member price.
type PriceCtx = { email: string; tierName: string; orders: number } | null;

const TIER_BASE: Record<string, number> = { Insider: 0, Gold: 0.5, Platinum: 0.85 };

function loyaltyUnitPrice(listCents: number, floorCents: number, ctx: PriceCtx): number {
  if (!ctx || !floorCents || floorCents >= listCents) return listCents; // no band, or not signed in
  const base = TIER_BASE[ctx.tierName] ?? 0;
  const factor = Math.min(1, base + ctx.orders * 0.03); // each past order nudges toward the floor
  return Math.round(listCents - factor * (listCents - floorCents));
}

/** What this viewer actually pays: the lowest of list, a manager sale, and their loyalty price. */
function effectiveUnitPrice(listCents: number, floorCents: number, saleCents: number, ctx: PriceCtx): number {
  const candidates = [listCents, loyaltyUnitPrice(listCents, floorCents, ctx)];
  if (saleCents > 0 && saleCents < listCents) candidates.push(saleCents);
  return Math.min(...candidates);
}

/** Optional customer context from a bearer token — enables personalized display pricing. */
function customerCtx(req: express.Request): PriceCtx {
  const email = emailFromToken(req);
  if (!email) return null;
  const { tier, orders } = tierFor(email);
  return { email, tierName: tier.name, orders };
}

// ---- public: catalog -------------------------------------------------------

app.get('/api/themes', (_req, res) => {
  const themes = db.prepare(`SELECT * FROM themes WHERE published = 1 ORDER BY sort`).all();
  res.json(
    themes.map((t: any) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      tagline: t.tagline,
      description: t.description,
      icon: t.icon,
      paletteFrom: t.palette_from,
      paletteTo: t.palette_to,
      heroImage: t.hero_image,
    }))
  );
});

app.get('/api/themes/:slug', (req, res) => {
  const t = db.prepare(`SELECT * FROM themes WHERE slug = ? AND published = 1`).get(req.params.slug) as any;
  if (!t) return void res.status(404).json({ error: 'not found' });
  const outfits = db
    .prepare(
      `SELECT o.* FROM outfits o JOIN outfit_themes ot ON ot.outfit_id = o.id
       WHERE ot.theme_id = ? AND o.status = 'live' ORDER BY o.id`
    )
    .all(t.id);
  const ctx = customerCtx(req);
  res.json({
    slug: t.slug, name: t.name, tagline: t.tagline, description: t.description,
    icon: t.icon, paletteFrom: t.palette_from, paletteTo: t.palette_to,
    heroImage: t.hero_image,
    outfits: outfits.map((o) => outfitPublic(o, ctx)),
  });
});

app.get('/api/outfits', (req, res) => {
  const ctx = customerCtx(req);
  const outfits = db.prepare(`SELECT * FROM outfits WHERE status = 'live' ORDER BY id`).all();
  res.json(outfits.map((o) => outfitPublic(o, ctx)));
});

app.get('/api/outfits/:slug', (req, res) => {
  const o = db.prepare(`SELECT * FROM outfits WHERE slug = ?`).get(req.params.slug) as any;
  if (!o || o.status !== 'live') return void res.status(404).json({ error: 'not found' });
  res.json(outfitPublic(o, customerCtx(req)));
});

// ---- public: loyalty / offers ----------------------------------------------

app.get('/api/loyalty', (req, res) => {
  const email = String(req.query.email ?? '').toLowerCase().trim();
  if (!email) return void res.json({ orders: 0, tier: TIERS[0], next: { name: 'Gold', ordersAway: 3 } });
  res.json(tierFor(email));
});

// ---- public: auth -----------------------------------------------------------

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-session-secret-change-me';

function makeToken(email: string) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(email).digest('hex');
  return `${Buffer.from(email).toString('base64url')}.${mac}`;
}

function emailFromToken(req: express.Request): string | null {
  const auth = req.header('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const [b64, mac] = auth.slice(7).split('.');
  if (!b64 || !mac) return null;
  const email = Buffer.from(b64, 'base64url').toString();
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(email).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return email;
}

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

app.post('/api/auth/register', (req, res) => {
  const { email, name, password } = req.body ?? {};
  const em = String(email ?? '').toLowerCase().trim();
  if (!em.includes('@') || !password || String(password).length < 8)
    return void res.status(400).json({ error: 'Valid email and a password of 8+ characters required' });
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    db.prepare(`INSERT INTO users (email, name, password_hash, salt) VALUES (?, ?, ?, ?)`).run(
      em, String(name ?? ''), hashPassword(String(password), salt), salt
    );
  } catch {
    return void res.status(409).json({ error: 'An account with this email already exists' });
  }
  res.json({ token: makeToken(em), email: em, name: String(name ?? '') });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const em = String(email ?? '').toLowerCase().trim();
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(em) as any;
  if (!user) return void res.status(401).json({ error: 'Invalid email or password' });
  const hash = hashPassword(String(password ?? ''), user.salt);
  const a = Buffer.from(hash);
  const b = Buffer.from(user.password_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return void res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: makeToken(em), email: em, name: user.name });
});

app.get('/api/me', (req, res) => {
  const email = emailFromToken(req);
  if (!email) return void res.status(401).json({ error: 'unauthorized' });
  const user = db.prepare(`SELECT email, name FROM users WHERE email = ?`).get(email) as any;
  if (!user) return void res.status(401).json({ error: 'unauthorized' });
  res.json({ ...user, loyalty: tierFor(email) });
});

// ---- public: personalized recommendations (consented, first-party data only) ----

app.get('/api/recommendations', (req, res) => {
  const email = emailFromToken(req);
  if (!email) return void res.status(401).json({ error: 'sign in to see your recommendations' });
  const user = db.prepare(`SELECT name FROM users WHERE email = ?`).get(email) as any;
  const loyalty = tierFor(email);
  const ctx: PriceCtx = { email, tierName: loyalty.tier.name, orders: loyalty.orders };

  const purchased = db
    .prepare(
      `SELECT l.outfit_id, l.size, l.qty, o.created_at, ou.name, ou.slug
       FROM order_lines l
       JOIN orders o ON o.id = l.order_id
       JOIN outfits ou ON ou.id = l.outfit_id
       WHERE o.email = ? AND o.status != 'cancelled'
       ORDER BY o.id DESC`
    )
    .all(email) as any[];

  const spend = (
    db.prepare(`SELECT COALESCE(SUM(total_cents),0) AS v FROM orders WHERE email = ? AND status != 'cancelled'`).get(email) as any
  ).v;
  const points = Math.floor(spend / 100); // 1 point per ₪1
  const creditCents = points * 10; // 1% back as store credit

  // style profile: themes + item types actually purchased
  const purchasedIds = [...new Set(purchased.map((p) => p.outfit_id))];
  const styleTags = new Set<string>();
  for (const oid of purchasedIds) {
    const ts = db
      .prepare(`SELECT t.name FROM outfit_themes ot JOIN themes t ON t.id = ot.theme_id WHERE ot.outfit_id = ?`)
      .all(oid) as any[];
    ts.forEach((t) => styleTags.add(t.name));
  }

  // size watch: most frequent purchased size + next size up
  const sizeCounts: Record<string, number> = {};
  purchased.forEach((p) => (sizeCounts[p.size] = (sizeCounts[p.size] ?? 0) + p.qty));
  const currentSize = Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const SIZE_LADDER = ['3-4Y', '5-6Y', '7-8Y'];
  const nextSize = currentSize ? SIZE_LADDER[SIZE_LADDER.indexOf(currentSize) + 1] ?? null : null;

  // "because you loved X": live outfits sharing a theme with the last purchase, not yet bought
  const allLive = db.prepare(`SELECT * FROM outfits WHERE status = 'live'`).all() as any[];
  const lastLoved = purchased[0] ?? null;
  let because: any[] = [];
  if (lastLoved) {
    const themeIds = (
      db.prepare(`SELECT theme_id FROM outfit_themes WHERE outfit_id = ?`).all(lastLoved.outfit_id) as any[]
    ).map((r) => r.theme_id);
    because = allLive.filter(
      (o) =>
        !purchasedIds.includes(o.id) &&
        (db.prepare(`SELECT COUNT(*) AS n FROM outfit_themes WHERE outfit_id = ? AND theme_id IN (${themeIds.map(() => '?').join(',')})`).get(o.id, ...themeIds) as any).n > 0
    );
  }
  const fresh = allLive.filter((o) => !purchasedIds.includes(o.id) && !because.some((b) => b.id === o.id));

  res.json({
    name: user?.name || email.split('@')[0],
    loyalty,
    points,
    creditCents,
    styleTags: [...styleTags],
    sizeWatch: currentSize ? { currentSize, nextSize } : null,
    becauseYouLoved: lastLoved
      ? { outfitName: lastLoved.name, outfits: because.map((o) => outfitPublic(o, ctx)) }
      : null,
    fresh: fresh.map((o) => outfitPublic(o, ctx)),
  });
});

// ---- public: items (standalone catalog — FEATURES §1) -----------------------

app.get('/api/items', (req, res) => {
  const ctx = customerCtx(req);
  const type = req.query.type ? String(req.query.type) : null;
  const rows = type
    ? db.prepare(`SELECT * FROM items WHERE is_sold_standalone = 1 AND type = ? ORDER BY name`).all(type)
    : db.prepare(`SELECT * FROM items WHERE is_sold_standalone = 1 ORDER BY name`).all();
  res.json((rows as any[]).map((i) => itemPublic(i, ctx)));
});

app.get('/api/items/:sku', (req, res) => {
  const i = db.prepare(`SELECT * FROM items WHERE sku = ?`).get(req.params.sku) as any;
  if (!i || !i.is_sold_standalone) return void res.status(404).json({ error: 'not found' });
  res.json(itemPublic(i, customerCtx(req)));
});

// ---- public: search across items + outfits ----------------------------------

app.get('/api/search', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (!q) return void res.json({ query: '', outfits: [], items: [] });
  const like = `%${q}%`;
  const outfits = db
    .prepare(
      `SELECT DISTINCT o.* FROM outfits o
       LEFT JOIN outfit_themes ot ON ot.outfit_id = o.id
       LEFT JOIN themes t ON t.id = ot.theme_id
       WHERE o.status = 'live' AND (LOWER(o.name) LIKE ? OR LOWER(o.story) LIKE ? OR LOWER(t.name) LIKE ?)
       LIMIT 24`
    )
    .all(like, like, like) as any[];
  const items = db
    .prepare(
      `SELECT * FROM items WHERE is_sold_standalone = 1
       AND (LOWER(name) LIKE ? OR LOWER(detail) LIKE ? OR LOWER(type) LIKE ?) LIMIT 24`
    )
    .all(like, like, like) as any[];
  const ctx = customerCtx(req);
  res.json({ query: q, outfits: outfits.map((o) => outfitPublic(o, ctx)), items: items.map((i) => itemPublic(i, ctx)) });
});

// ---- public: back-in-stock capture ------------------------------------------

app.post('/api/back-in-stock', (req, res) => {
  const { email, kind, refId, size } = req.body ?? {};
  const em = String(email ?? '').toLowerCase().trim();
  if (!em.includes('@') || (kind !== 'outfit' && kind !== 'item') || !refId)
    return void res.status(400).json({ error: 'valid email, kind and refId required' });
  try {
    db.prepare(
      `INSERT OR IGNORE INTO back_in_stock (email, kind, ref_id, size) VALUES (?, ?, ?, ?)`
    ).run(em, kind, Number(refId), String(size ?? ''));
  } catch {
    /* ignore dup */
  }
  res.json({ ok: true });
});

// ---- public: orders ----------------------------------------------------------

const SHIPPING = {
  standard: { labelFreeFrom: 'Gold', baseCents: 2500 }, // free from Gold tier
  express: { baseCents: 4500 },
} as const;

/** Authoritative cart pricing — shared by /api/quote (preview) and /api/orders (commit).
 *  Validates availability and applies: loyalty band per unit → multi-buy 10% on outfits →
 *  shipping. Personalization is independent of any promo the customer enters. Throws on
 *  a stock problem. Read-only. */
function computeOrder(email: string, outfitLines: any[], itLines: any[], shipMethod: 'standard' | 'express') {
  const em = String(email).toLowerCase().trim();
  const { tier, orders: pastOrders } = tierFor(em);
  const ctx: PriceCtx = { email: em, tierName: tier.name, orders: pastOrders };

  const outLines = outfitLines.map((line) => {
    const o = db.prepare(`SELECT * FROM outfits WHERE id = ? AND status = 'live'`).get(line.outfitId) as any;
    if (!o) throw new Error(`Outfit ${line.outfitId} unavailable`);
    const avail = outfitAvailability(o.id).find((a) => a.size === line.size);
    if (!avail || avail.available < line.qty)
      throw new Error(`"${o.name}" (${line.size}) has only ${avail?.available ?? 0} left`);
    const listUnit = o.price_cents;
    const unit = effectiveUnitPrice(listUnit, o.price_floor_cents, o.sale_price_cents, ctx);
    return { outfit: o, size: line.size, qty: line.qty, listUnit, unit };
  });
  const iLines = itLines.map((line) => {
    const it = db.prepare(`SELECT * FROM items WHERE id = ? AND is_sold_standalone = 1`).get(line.itemId) as any;
    if (!it) throw new Error(`Item ${line.itemId} unavailable`);
    const color = line.color ?? '';
    const avail = itemAvailability(it.id).find((a) => a.size === line.size && (a.color ?? '') === color);
    if (!avail || avail.available < line.qty)
      throw new Error(`"${it.name}" (${[color, line.size].filter(Boolean).join(' · ')}) has only ${avail?.available ?? 0} left`);
    const listUnit = it.list_price_cents;
    const unit = effectiveUnitPrice(listUnit, it.price_floor_cents, it.sale_price_cents, ctx);
    return { item: it, size: line.size, color, qty: line.qty, listUnit, unit };
  });

  const listSubtotal = [...outLines, ...iLines].reduce((n, l) => n + l.listUnit * l.qty, 0);
  const loyaltySubtotal = [...outLines, ...iLines].reduce((n, l) => n + l.unit * l.qty, 0);
  const loyaltySavings = listSubtotal - loyaltySubtotal;

  const outfitQty = outLines.reduce((n, l) => n + l.qty, 0);
  const outfitLoyalty = outLines.reduce((n, l) => n + l.unit * l.qty, 0);
  const multibuyDiscount = outfitQty >= 3 ? Math.round(outfitLoyalty * 0.1) : 0;

  const tierRank = ['Insider', 'Gold', 'Platinum'].indexOf(tier.name);
  const shippingCents = shipMethod === 'express' ? SHIPPING.express.baseCents : tierRank >= 1 ? 0 : SHIPPING.standard.baseCents;

  const discount = loyaltySavings + multibuyDiscount; // total off the list-price ceiling
  const totalCents = loyaltySubtotal - multibuyDiscount + shippingCents;

  return {
    tier: tier.name, outLines, iLines,
    listSubtotalCents: listSubtotal, loyaltySavingsCents: loyaltySavings,
    multibuyDiscountCents: multibuyDiscount, discountCents: discount,
    shippingCents, totalCents,
  };
}

// Price preview — never writes. Lets the checkout show the real loyalty-adjusted total.
app.post('/api/quote', (req, res) => {
  const { email, lines, itemLines, shipping } = req.body ?? {};
  const shipMethod = shipping?.method === 'express' ? 'express' : 'standard';
  try {
    const q = computeOrder(email ?? 'guest@guest', Array.isArray(lines) ? lines : [], Array.isArray(itemLines) ? itemLines : [], shipMethod);
    res.json({
      tier: q.tier,
      subtotalCents: q.listSubtotalCents,
      loyaltySavingsCents: q.loyaltySavingsCents,
      multibuyDiscountCents: q.multibuyDiscountCents,
      discountCents: q.discountCents,
      shippingCents: q.shippingCents,
      totalCents: q.totalCents,
      lines: [
        ...q.outLines.map((l) => ({ kind: 'outfit', name: l.outfit.name, size: l.size, color: '', qty: l.qty, listUnitCents: l.listUnit, unitCents: l.unit })),
        ...q.iLines.map((l) => ({ kind: 'item', name: l.item.name, size: l.size, color: l.color ?? '', qty: l.qty, listUnitCents: l.listUnit, unitCents: l.unit })),
      ],
    });
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

type ShipInput = { method?: string; address?: string; city?: string; zip?: string };
type OrderResult = {
  orderId: number; subtotalCents: number; discountCents: number;
  loyaltySavingsCents: number; shippingCents: number; totalCents: number; tier: string;
};

/** Create the order + decrement stock atomically. Shared by the dev checkout and the
 *  Stripe webhook. Only ever called AFTER payment is confirmed (or in no-payment dev mode). */
function commitOrder(
  email: string, customerName: string,
  outfitLines: any[], itLines: any[], ship: ShipInput, stripeSessionId = ''
): OrderResult {
  const shipMethod = ship?.method === 'express' ? 'express' : 'standard';
  const em = String(email).toLowerCase().trim();

  db.exec('BEGIN');
  try {
    const q = computeOrder(em, outfitLines, itLines, shipMethod);

    db.prepare(
      `INSERT INTO orders (email, customer_name, subtotal_cents, discount_cents, total_cents, tier_at_purchase,
                           shipping_cents, ship_method, ship_address, ship_city, ship_zip, stripe_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      em, customerName ?? '', q.listSubtotalCents, q.discountCents, q.totalCents, q.tier,
      q.shippingCents, shipMethod, String(ship?.address ?? ''), String(ship?.city ?? ''), String(ship?.zip ?? ''),
      stripeSessionId
    );
    const orderId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as any).id);

    for (const l of q.outLines) {
      db.prepare(
        `INSERT INTO order_lines (order_id, outfit_id, size, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?)`
      ).run(orderId, l.outfit.id, l.size, l.qty, l.unit);
      const parts = db
        .prepare(`SELECT i.id, i.sizing, oi.color FROM outfit_items oi JOIN items i ON i.id = oi.item_id WHERE oi.outfit_id = ?`)
        .all(l.outfit.id) as any[];
      for (const p of parts) {
        const vsize = p.sizing === 'one-size' ? 'ONE' : l.size;
        moveStock(p.id, vsize, p.color ?? '', -l.qty, 'sale', `Order #${orderId} — ${l.outfit.name}`, 'storefront', orderId);
      }
    }
    for (const l of q.iLines) {
      db.prepare(
        `INSERT INTO order_item_lines (order_id, item_id, size, color, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(orderId, l.item.id, l.size, l.color ?? '', l.qty, l.unit);
      moveStock(l.item.id, variantSizeFor(l.item.id, l.size), l.color ?? '', -l.qty, 'sale', `Order #${orderId} — ${l.item.name}`, 'storefront', orderId);
    }

    db.exec('COMMIT');
    return {
      orderId, subtotalCents: q.listSubtotalCents, discountCents: q.discountCents,
      loyaltySavingsCents: q.loyaltySavingsCents, shippingCents: q.shippingCents,
      totalCents: q.totalCents, tier: q.tier,
    };
  } catch (e: any) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Ping the owner's iPhone (Pushover) that a paid order came in. */
function notifyNewOrder(result: OrderResult, req: express.Request) {
  const total = (result.totalCents / 100).toFixed(2);
  notify(`New order #${result.orderId} — ₪${total} (${result.tier} tier)`, {
    title: '🛍️ NAYO — New order',
    priority: 1,
    url: `${publicUrl(req)}/admin/orders`,
    urlTitle: 'Open orders',
  });
}

// Legacy / dev fallback: commit with no payment (used when Stripe isn't configured,
// and kept so the original local demo flow keeps working).
app.post('/api/orders', (req, res) => {
  const { email, customerName, lines, itemLines, shipping } = req.body ?? {};
  const outfitLines: any[] = Array.isArray(lines) ? lines : [];
  const itLines: any[] = Array.isArray(itemLines) ? itemLines : [];
  if (!email || outfitLines.length + itLines.length === 0)
    return void res.status(400).json({ error: 'email and at least one line are required' });
  try {
    const result = commitOrder(email, customerName ?? '', outfitLines, itLines, shipping ?? {});
    notifyNewOrder(result, req);
    res.json(result);
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

// Begin checkout. With Stripe configured → returns a hosted payment URL to redirect to.
// Without Stripe → commits immediately (dev/demo), returns { dev: true, orderId }.
app.post('/api/checkout', async (req, res) => {
  const { email, customerName, lines, itemLines, shipping } = req.body ?? {};
  const outfitLines: any[] = Array.isArray(lines) ? lines : [];
  const itLines: any[] = Array.isArray(itemLines) ? itemLines : [];
  const em = String(email ?? '').toLowerCase().trim();
  if (!em.includes('@') || outfitLines.length + itLines.length === 0)
    return void res.status(400).json({ error: 'A valid email and at least one item are required' });
  const shipMethod = shipping?.method === 'express' ? 'express' : 'standard';

  // Price + validate the cart authoritatively before taking any money.
  let q: ReturnType<typeof computeOrder>;
  try {
    q = computeOrder(em, outfitLines, itLines, shipMethod);
  } catch (e: any) {
    return void res.status(409).json({ error: e.message });
  }

  if (!paymentsConfigured()) {
    try {
      const result = commitOrder(em, customerName ?? '', outfitLines, itLines, shipping ?? {});
      notifyNewOrder(result, req);
      return void res.json({ dev: true, orderId: result.orderId });
    } catch (e: any) {
      return void res.status(409).json({ error: e.message });
    }
  }

  try {
    const base = publicUrl(req);
    const itemCount = q.outLines.reduce((n, l) => n + l.qty, 0) + q.iLines.reduce((n, l) => n + l.qty, 0);
    const names = [...q.outLines.map((l) => l.outfit.name), ...q.iLines.map((l) => l.item.name)]
      .slice(0, 4).join(', ');
    // Charge one merchandise line at the exact loyalty/bundle-adjusted total (minus shipping,
    // which Stripe shows separately). This guarantees the charge equals the displayed total.
    const merchandiseCents = q.totalCents - q.shippingCents;
    const session = await createCheckout({
      lines: [{ name: `NAYO order — ${itemCount} item${itemCount > 1 ? 's' : ''}${names ? ` (${names})` : ''}`, amountCents: merchandiseCents, qty: 1 }],
      shippingCents: q.shippingCents,
      email: em,
      successUrl: `${base}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/checkout?canceled=1`,
      metadata: { email: em },
    });
    db.prepare(`INSERT OR REPLACE INTO pending_checkouts (session_id, payload) VALUES (?, ?)`).run(
      session.id,
      JSON.stringify({ email: em, customerName: customerName ?? '', lines: outfitLines, itemLines: itLines, shipping: shipping ?? {} })
    );
    res.json({ url: session.url });
  } catch (e: any) {
    console.error('checkout error', e);
    res.status(502).json({ error: 'Could not start payment. Please try again.' });
  }
});

// Turn a paid Stripe session into a real order (idempotent).
function fulfillSession(sessionId: string, req: express.Request): OrderResult | null {
  const row = db.prepare(`SELECT payload, order_id FROM pending_checkouts WHERE session_id = ?`).get(sessionId) as any;
  if (!row) return null;
  if (row.order_id) {
    const existing = db.prepare(`SELECT id AS orderId, subtotal_cents AS subtotalCents, discount_cents AS discountCents, shipping_cents AS shippingCents, total_cents AS totalCents, tier_at_purchase AS tier FROM orders WHERE id = ?`).get(row.order_id) as any;
    return existing ? { ...existing, loyaltySavingsCents: 0 } : null;
  }
  try {
    const p = JSON.parse(row.payload);
    const result = commitOrder(p.email, p.customerName ?? '', p.lines ?? [], p.itemLines ?? [], p.shipping ?? {}, sessionId);
    db.prepare(`UPDATE pending_checkouts SET order_id = ? WHERE session_id = ?`).run(result.orderId, sessionId);
    notifyNewOrder(result, req);
    return result;
  } catch (e) {
    console.error('fulfillSession failed', e);
    return null;
  }
}

// Stripe webhook — the source of truth that a payment succeeded. Needs the raw body.
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const result = verifyWebhook(req.body as Buffer, req.header('stripe-signature'));
  if (!result.ok) return void res.status(400).send(`Webhook error: ${result.error}`);
  if (result.type === 'checkout.session.completed' && result.sessionId) fulfillSession(result.sessionId, req);
  res.json({ received: true });
});

// Success page fetches the confirmed order for a session (fulfills on-read as a fallback
// if the webhook is delayed, after verifying with Stripe that the session was actually paid).
app.get('/api/orders/by-session/:sid', async (req, res) => {
  const sid = req.params.sid;
  const pending = db.prepare(`SELECT order_id FROM pending_checkouts WHERE session_id = ?`).get(sid) as any;
  if (pending && !pending.order_id && (await isSessionPaid(sid))) fulfillSession(sid, req);
  const order = db.prepare(
    `SELECT id AS orderId, subtotal_cents AS subtotalCents, discount_cents AS discountCents,
            shipping_cents AS shippingCents, total_cents AS totalCents, tier_at_purchase AS tier
     FROM orders WHERE stripe_session_id = ?`
  ).get(sid) as any;
  if (!order) return void res.status(404).json({ error: 'Payment is still processing — refresh in a moment.' });
  res.json(order);
});

// ---- social sign-in (Google / Facebook / Apple) ----------------------------

function upsertOAuthUser(email: string, name: string): string {
  const em = email.toLowerCase().trim();
  const existing = db.prepare(`SELECT email, name FROM users WHERE email = ?`).get(em) as any;
  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    const randomPw = crypto.randomBytes(32).toString('hex'); // OAuth users have no usable password
    db.prepare(`INSERT INTO users (email, name, password_hash, salt) VALUES (?, ?, ?, ?)`).run(
      em, name ?? '', hashPassword(randomPw, salt), salt
    );
  } else if (name && !existing.name) {
    db.prepare(`UPDATE users SET name = ? WHERE email = ?`).run(name, em);
  }
  return makeToken(em);
}

app.get('/api/auth/:provider/start', (req, res) => {
  const p = req.params.provider as oauth.Provider;
  if (!oauth.PROVIDERS.includes(p)) return void res.status(404).json({ error: 'unknown provider' });
  if (!oauth.providerConfigured(p))
    return void res.redirect('/login?error=' + encodeURIComponent(`${p} sign-in is not set up yet`));
  const redirectUri = `${publicUrl(req)}/api/auth/${p}/callback`;
  res.redirect(oauth.authUrl(p, oauth.makeState(), redirectUri));
});

async function handleOAuthCallback(
  p: oauth.Provider, req: express.Request, res: express.Response,
  code: string, state: string | undefined, appleUser: string | undefined
) {
  if (!oauth.PROVIDERS.includes(p)) return void res.status(404).send('unknown provider');
  if (!oauth.verifyState(state) || !code)
    return void res.redirect('/login?error=' + encodeURIComponent('Sign-in expired — please try again'));
  try {
    const redirectUri = `${publicUrl(req)}/api/auth/${p}/callback`;
    const profile = await oauth.exchangeCodeForProfile(p, code, redirectUri, appleUser);
    const token = upsertOAuthUser(profile.email, profile.name);
    const frag = new URLSearchParams({ token, email: profile.email, name: profile.name || '' }).toString();
    res.redirect(`/auth/callback#${frag}`);
  } catch (e: any) {
    console.error('oauth callback error', e?.message ?? e);
    res.redirect('/login?error=' + encodeURIComponent('Sign-in failed — please try again'));
  }
}

app.get('/api/auth/:provider/callback', (req, res) => {
  void handleOAuthCallback(
    req.params.provider as oauth.Provider, req, res,
    String(req.query.code ?? ''), req.query.state as string | undefined, undefined
  );
});
// Apple uses response_mode=form_post, so its callback arrives as a POST form body.
app.post('/api/auth/apple/callback', express.urlencoded({ extended: true }), (req, res) => {
  void handleOAuthCallback('apple', req, res, String(req.body.code ?? ''), req.body.state, req.body.user);
});

// ---- public: consent-gated events -------------------------------------------

app.post('/api/events', (req, res) => {
  const { type, payload, consent, anonId } = req.body ?? {};
  if (!type) return void res.status(400).json({ error: 'type required' });
  // PPL §11 / consent gating: without consent only anonymous, non-behavioral pings are stored
  const allowedWithoutConsent = ['page_view_aggregate'];
  if (!consent && !allowedWithoutConsent.includes(type)) return void res.json({ stored: false });
  db.prepare(`INSERT INTO events (type, payload, consent, anon_id) VALUES (?, ?, ?, ?)`).run(
    type, JSON.stringify(payload ?? {}), consent ? 1 : 0, consent ? String(anonId ?? '') : ''
  );
  res.json({ stored: true });
});

// ---- admin: stats -------------------------------------------------------------

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const revenue = (db.prepare(`SELECT COALESCE(SUM(total_cents),0) AS v FROM orders WHERE status != 'cancelled'`).get() as any).v;
  const orders = (db.prepare(`SELECT COUNT(*) AS v FROM orders WHERE status != 'cancelled'`).get() as any).v;
  const bundles = (db.prepare(`SELECT COALESCE(SUM(qty),0) AS v FROM order_lines`).get() as any).v;
  const aov = orders ? Math.round(revenue / orders) : 0;
  const lowStock = (db.prepare(
    `SELECT COUNT(*) AS v FROM item_variants v JOIN items i ON i.id = v.item_id
     WHERE (v.on_hand - v.reserved) <= i.reorder_point`
  ).get() as any).v;
  const events = (db.prepare(`SELECT COUNT(*) AS v FROM events`).get() as any).v;
  const topOutfits = db.prepare(
    `SELECT o.name, SUM(l.qty) AS sold, SUM(l.qty * l.unit_price_cents) AS revenue
     FROM order_lines l JOIN outfits o ON o.id = l.outfit_id
     GROUP BY o.id ORDER BY revenue DESC LIMIT 5`
  ).all();
  res.json({ revenueCents: revenue, orders, bundlesSold: bundles, aovCents: aov, lowStockVariants: lowStock, eventsCaptured: events, topOutfits });
});

// ---- admin: inventory ------------------------------------------------------------

app.get('/api/admin/inventory', requireAdmin, (_req, res) => {
  const items = db.prepare(`SELECT * FROM items ORDER BY sku`).all() as any[];
  const result = items.map((i) => {
    const variants = db
      .prepare(`SELECT size, color, on_hand, reserved FROM item_variants WHERE item_id = ? ORDER BY color, size`)
      .all(i.id) as any[];
    const gates = db
      .prepare(
        `SELECT o.id, o.slug, o.name FROM outfit_items oi JOIN outfits o ON o.id = oi.outfit_id
         WHERE oi.item_id = ? AND o.status = 'live'`
      )
      .all(i.id) as any[];
    return {
      id: i.id, sku: i.sku, name: i.name, type: i.type, sizing: i.sizing,
      costCents: i.cost_cents, reorderPoint: i.reorder_point,
      variants: variants.map((v) => ({
        size: v.size, color: v.color ?? '', onHand: v.on_hand, reserved: v.reserved,
        available: v.on_hand - v.reserved,
        low: v.on_hand - v.reserved <= i.reorder_point,
      })),
      gatesOutfits: gates,
    };
  });
  // per-outfit binding constraint
  const outfits = db.prepare(`SELECT id, slug, name FROM outfits WHERE status = 'live'`).all() as any[];
  const constraints = outfits.map((o) => {
    const av = outfitAvailability(o.id);
    const worst = av.reduce((m, a) => (a.available < m.available ? a : m), av[0] ?? { size: '-', available: 0, limitedBy: null });
    return { outfitId: o.id, slug: o.slug, name: o.name, perSize: av, binding: worst };
  });
  res.json({ items: result, outfitConstraints: constraints });
});

app.post('/api/admin/inventory/adjust', requireAdmin, (req, res) => {
  const { itemId, size, color, delta, kind, reason } = req.body ?? {};
  const validKinds = ['receiving', 'adjustment', 'return', 'write-off'];
  if (!itemId || !size || !Number.isInteger(delta) || delta === 0 || !validKinds.includes(kind))
    return void res.status(400).json({ error: 'itemId, size, non-zero integer delta and valid kind required' });
  const v = db.prepare(`SELECT on_hand, reserved FROM item_variants WHERE item_id = ? AND size = ? AND color = ?`).get(itemId, size, color ?? '') as any;
  if (!v) return void res.status(404).json({ error: 'variant not found' });
  if (v.on_hand + delta < 0) return void res.status(409).json({ error: 'would drive stock negative' });
  moveStock(itemId, size, color ?? '', delta, kind, reason ?? '', 'admin');
  res.json({ ok: true, onHand: v.on_hand + delta });
});

app.get('/api/admin/inventory/movements', requireAdmin, (req, res) => {
  const itemId = req.query.itemId ? Number(req.query.itemId) : null;
  const rows = itemId
    ? db.prepare(
        `SELECT m.*, i.name AS item_name, i.sku FROM stock_movements m JOIN items i ON i.id = m.item_id
         WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 100`
      ).all(itemId)
    : db.prepare(
        `SELECT m.*, i.name AS item_name, i.sku FROM stock_movements m JOIN items i ON i.id = m.item_id
         ORDER BY m.id DESC LIMIT 100`
      ).all();
  res.json(rows);
});

// ---- admin: catalog management -----------------------------------------------------

app.get('/api/admin/items', requireAdmin, (_req, res) => {
  const items = db.prepare(`SELECT * FROM items ORDER BY sku`).all() as any[];
  res.json(
    items.map((i) => ({
      ...i,
      gallery: itemImages(i.id),
      colors: itemColors(i.id),
      variants: db
        .prepare(`SELECT size, color, on_hand FROM item_variants WHERE item_id = ? ORDER BY color, size`)
        .all(i.id),
    }))
  );
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body ?? {};
  if (password === ADMIN_KEY) {
    res.json({ token: makeToken('__admin__') });
  } else {
    res.status(401).json({ error: 'Invalid admin password' });
  }
});

// All outfits (any status) with membership ids, for the edit/rebuild forms.
app.get('/api/admin/outfits', requireAdmin, (_req, res) => {
  const outfits = db.prepare(`SELECT * FROM outfits ORDER BY id DESC`).all() as any[];
  res.json(
    outfits.map((o) => ({
      ...outfitPublic(o),
      status: o.status,
      itemIds: (db.prepare(`SELECT item_id FROM outfit_items WHERE outfit_id = ?`).all(o.id) as any[]).map((r) => r.item_id),
      themeIds: (db.prepare(`SELECT theme_id FROM outfit_themes WHERE outfit_id = ?`).all(o.id) as any[]).map((r) => r.theme_id),
    }))
  );
});

app.get('/api/admin/themes', requireAdmin, (_req, res) => {
  const themes = db.prepare(`SELECT * FROM themes ORDER BY sort`).all() as any[];
  res.json(
    themes.map((t) => ({
      id: t.id, slug: t.slug, name: t.name, tagline: t.tagline, description: t.description,
      icon: t.icon, paletteFrom: t.palette_from, paletteTo: t.palette_to, heroImage: t.hero_image,
      published: !!t.published, sort: t.sort,
    }))
  );
});

app.post('/api/admin/themes', requireAdmin, (req, res) => {
  const { slug, name, tagline, description, icon, paletteFrom, paletteTo, heroImage } = req.body ?? {};
  if (!slug || !name) return void res.status(400).json({ error: 'slug and name required' });
  try {
    db.prepare(
      `INSERT INTO themes (slug, name, tagline, description, icon, palette_from, palette_to, hero_image, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM themes))`
    ).run(slug, name, tagline ?? '', description ?? '', icon ?? 'styler', paletteFrom ?? '#d0e8d9', paletteTo ?? '#ffdad6', heroImage ?? '');
    res.json({ ok: true });
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

app.delete('/api/admin/themes/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM outfit_themes WHERE theme_id = ?`).run(id);
    db.prepare(`DELETE FROM themes WHERE id = ?`).run(id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const inOutfits = (db.prepare(`SELECT COUNT(*) AS n FROM outfit_items WHERE item_id = ?`).get(id) as any).n;
  const inOrders = (db.prepare(`SELECT COUNT(*) AS n FROM order_item_lines WHERE item_id = ?`).get(id) as any).n;
  if (inOutfits > 0)
    return void res.status(409).json({ error: `This item is in ${inOutfits} outfit(s). Remove it from them first.` });
  if (inOrders > 0)
    return void res.status(409).json({ error: `This item is on ${inOrders} order(s). Set it to not-standalone instead of deleting.` });
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM item_variants WHERE item_id = ?`).run(id);
    db.prepare(`DELETE FROM stock_movements WHERE item_id = ?`).run(id);
    db.prepare(`DELETE FROM item_colors WHERE item_id = ?`).run(id);
    db.prepare(`DELETE FROM item_images WHERE item_id = ?`).run(id);
    db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/admin/outfits', requireAdmin, (req, res) => {
  const { slug, name, story, priceCents, priceFloorCents, salePriceCents, sizeRun, itemIds, themeIds, icon, paletteFrom, paletteTo, heroImage } = req.body ?? {};
  if (!slug || !name || !priceCents || !Array.isArray(itemIds) || itemIds.length === 0)
    return void res.status(400).json({ error: 'slug, name, priceCents and itemIds required' });
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO outfits (slug, name, story, price_cents, price_floor_cents, sale_price_cents, size_run, icon, palette_from, palette_to, hero_image, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`
    ).run(slug, name, story ?? '', priceCents, priceFloorCents ?? 0, salePriceCents ?? 0, JSON.stringify(sizeRun ?? ['3-4Y', '5-6Y', '7-8Y']),
      icon ?? 'styler', paletteFrom ?? '#d0e8d9', paletteTo ?? '#ffdad6', heroImage ?? '');
    const oid = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as any).id);
    for (const iid of itemIds) db.prepare(`INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)`).run(oid, iid);
    for (const tid of themeIds ?? []) db.prepare(`INSERT INTO outfit_themes (outfit_id, theme_id) VALUES (?, ?)`).run(oid, tid);
    if (Array.isArray(req.body?.gallery)) replaceOutfitImages(oid, req.body.gallery);
    db.exec('COMMIT');
    res.json({ ok: true, id: oid });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const orders = (
    status
      ? db.prepare(`SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 100`).all(status)
      : db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 100`).all()
  ) as any[];
  res.json(
    orders.map((o) => ({
      ...o,
      lines: db
        .prepare(
          `SELECT l.*, ou.name AS outfit_name FROM order_lines l JOIN outfits ou ON ou.id = l.outfit_id WHERE l.order_id = ?`
        )
        .all(o.id),
      itemLines: db
        .prepare(
          `SELECT il.*, i.name AS item_name FROM order_item_lines il JOIN items i ON i.id = il.item_id WHERE il.order_id = ?`
        )
        .all(o.id),
    }))
  );
});

// Order fulfillment: advance status; cancelling restores stock to the ledger.
app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  const valid = ['paid', 'shipped', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return void res.status(400).json({ error: 'invalid status' });
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as any;
  if (!order) return void res.status(404).json({ error: 'order not found' });

  db.exec('BEGIN');
  try {
    if (status === 'cancelled' && order.status !== 'cancelled') {
      // return every unit to stock
      const oLines = db.prepare(`SELECT * FROM order_lines WHERE order_id = ?`).all(id) as any[];
      for (const l of oLines) {
        const parts = db
          .prepare(`SELECT i.id, i.sizing, oi.color FROM outfit_items oi JOIN items i ON i.id = oi.item_id WHERE oi.outfit_id = ?`)
          .all(l.outfit_id) as any[];
        for (const p of parts) {
          const vsize = p.sizing === 'one-size' ? 'ONE' : l.size;
          moveStock(p.id, vsize, p.color ?? '', l.qty, 'return', `Order #${id} cancelled`, 'admin', id);
        }
      }
      const iLines = db.prepare(`SELECT * FROM order_item_lines WHERE order_id = ?`).all(id) as any[];
      for (const l of iLines) {
        moveStock(l.item_id, variantSizeFor(l.item_id, l.size), l.color ?? '', l.qty, 'return', `Order #${id} cancelled`, 'admin', id);
      }
    }
    db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(status, id);
    db.exec('COMMIT');
    res.json({ ok: true, status });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

// ---- admin: product management (create / edit items, variants, outfits, themes) ----

app.post('/api/admin/items', requireAdmin, (req, res) => {
  const { sku, name, type, sizing, costCents, listPriceCents, priceFloorCents, salePriceCents, detail, icon, reorderPoint, isSoldStandalone, imageUrl, gallery, colors, variants } = req.body ?? {};
  if (!sku || !name || !['garment', 'accessory', 'perfume'].includes(type) || !['sized', 'one-size'].includes(sizing))
    return void res.status(400).json({ error: 'sku, name, valid type and sizing required' });
  const colorList: { name: string; swatch?: string; imageUrl?: string }[] = Array.isArray(colors) ? colors.filter((c: any) => c?.name?.trim()) : [];
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO items (sku, name, type, sizing, cost_cents, list_price_cents, price_floor_cents, sale_price_cents, detail, icon, reorder_point, is_sold_standalone, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sku, name, type, sizing, costCents ?? 0, listPriceCents ?? 0, priceFloorCents ?? 0, salePriceCents ?? 0, detail ?? '', icon ?? 'apparel',
      reorderPoint ?? 5, isSoldStandalone === false ? 0 : 1, imageUrl ?? '');
    const itemId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as any).id);
    // register colors (metadata only; variants below carry the stock)
    colorList.forEach((c, idx) =>
      db.prepare(`INSERT OR IGNORE INTO item_colors (item_id, name, swatch, image_url, sort) VALUES (?, ?, ?, ?, ?)`).run(itemId, c.name, c.swatch ?? '', c.imageUrl ?? '', idx)
    );
    // variants: [{size, color?, onHand}]. one-size collapses size to 'ONE'; color '' = no colors.
    const vs: { size: string; color?: string; onHand?: number }[] = sizing === 'one-size'
      ? (Array.isArray(variants) && variants.length ? variants.map((v: any) => ({ ...v, size: 'ONE' })) : [{ size: 'ONE', onHand: variants?.[0]?.onHand ?? 0 }])
      : (variants ?? []);
    for (const v of vs) {
      const color = v.color ?? '';
      db.prepare(`INSERT OR IGNORE INTO item_variants (item_id, size, color, on_hand) VALUES (?, ?, ?, 0)`).run(itemId, v.size, color);
      if ((v.onHand ?? 0) > 0) moveStock(itemId, v.size, color, v.onHand!, 'initial', 'Opening stock', 'admin');
    }
    if (Array.isArray(gallery)) replaceItemImages(itemId, gallery);
    db.exec('COMMIT');
    res.json({ ok: true, id: itemId });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

app.patch('/api/admin/items/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as any;
  if (!item) return void res.status(404).json({ error: 'item not found' });
  const b = req.body ?? {};
  const fields: [string, any][] = [
    ['name', b.name], ['type', b.type], ['cost_cents', b.costCents], ['list_price_cents', b.listPriceCents],
    ['price_floor_cents', b.priceFloorCents], ['sale_price_cents', b.salePriceCents],
    ['detail', b.detail], ['icon', b.icon], ['reorder_point', b.reorderPoint],
    ['image_url', b.imageUrl],
    ['is_sold_standalone', b.isSoldStandalone === undefined ? undefined : b.isSoldStandalone ? 1 : 0],
  ].filter(([, v]) => v !== undefined) as [string, any][];
  db.exec('BEGIN');
  try {
    if (fields.length > 0)
      db.prepare(`UPDATE items SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(([, v]) => v), id);
    if (Array.isArray(b.colors)) syncItemColors(id, b.colors);
    if (Array.isArray(b.gallery)) replaceItemImages(id, b.gallery);
    db.exec('COMMIT');
  } catch (e: any) {
    db.exec('ROLLBACK');
    return void res.status(409).json({ error: e.message });
  }
  res.json({ ok: true });
});

app.post('/api/admin/items/:id/variants', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { size, color, onHand } = req.body ?? {};
  if (!size) return void res.status(400).json({ error: 'size required' });
  const item = db.prepare(`SELECT id FROM items WHERE id = ?`).get(id) as any;
  if (!item) return void res.status(404).json({ error: 'item not found' });
  db.prepare(`INSERT OR IGNORE INTO item_variants (item_id, size, color, on_hand) VALUES (?, ?, ?, 0)`).run(id, size, color ?? '');
  if (onHand > 0) moveStock(id, size, color ?? '', onHand, 'initial', 'Variant opening stock', 'admin');
  res.json({ ok: true });
});

app.patch('/api/admin/outfits/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const outfit = db.prepare(`SELECT * FROM outfits WHERE id = ?`).get(id) as any;
  if (!outfit) return void res.status(404).json({ error: 'outfit not found' });
  const b = req.body ?? {};
  if (b.status && !['draft', 'live', 'archived'].includes(b.status))
    return void res.status(400).json({ error: 'invalid status' });
  const fields: [string, any][] = [
    ['name', b.name], ['story', b.story], ['price_cents', b.priceCents], ['price_floor_cents', b.priceFloorCents],
    ['sale_price_cents', b.salePriceCents], ['status', b.status], ['rating', b.rating],
    ['icon', b.icon], ['hero_image', b.heroImage], ['palette_from', b.paletteFrom], ['palette_to', b.paletteTo],
    ['size_run', b.sizeRun ? JSON.stringify(b.sizeRun) : undefined],
  ].filter(([, v]) => v !== undefined) as [string, any][];
  db.exec('BEGIN');
  try {
    if (fields.length > 0)
      db.prepare(`UPDATE outfits SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(([, v]) => v), id);
    // full rebuild of membership when arrays are supplied
    if (Array.isArray(b.itemIds)) {
      db.prepare(`DELETE FROM outfit_items WHERE outfit_id = ?`).run(id);
      for (const iid of b.itemIds) db.prepare(`INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)`).run(id, iid);
    }
    if (Array.isArray(b.themeIds)) {
      db.prepare(`DELETE FROM outfit_themes WHERE outfit_id = ?`).run(id);
      for (const tid of b.themeIds) db.prepare(`INSERT INTO outfit_themes (outfit_id, theme_id) VALUES (?, ?)`).run(id, tid);
    }
    if (Array.isArray(b.gallery)) replaceOutfitImages(id, b.gallery);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

app.delete('/api/admin/outfits/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const refs = (db.prepare(`SELECT COUNT(*) AS n FROM order_lines WHERE outfit_id = ?`).get(id) as any).n;
  if (refs > 0)
    return void res.status(409).json({ error: `This outfit is on ${refs} order(s). Archive it instead to keep order history intact.` });
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM outfit_items WHERE outfit_id = ?`).run(id);
    db.prepare(`DELETE FROM outfit_themes WHERE outfit_id = ?`).run(id);
    db.prepare(`DELETE FROM outfit_images WHERE outfit_id = ?`).run(id);
    db.prepare(`DELETE FROM outfits WHERE id = ?`).run(id);
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e: any) {
    db.exec('ROLLBACK');
    res.status(409).json({ error: e.message });
  }
});

app.patch('/api/admin/themes/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const theme = db.prepare(`SELECT * FROM themes WHERE id = ?`).get(id) as any;
  if (!theme) return void res.status(404).json({ error: 'theme not found' });
  const b = req.body ?? {};
  const fields: [string, any][] = [
    ['name', b.name], ['tagline', b.tagline], ['description', b.description], ['icon', b.icon],
    ['palette_from', b.paletteFrom], ['palette_to', b.paletteTo], ['sort', b.sort], ['hero_image', b.heroImage],
    ['published', b.published === undefined ? undefined : b.published ? 1 : 0],
  ].filter(([, v]) => v !== undefined) as [string, any][];
  if (fields.length === 0) return void res.status(400).json({ error: 'no fields to update' });
  db.prepare(`UPDATE themes SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...fields.map(([, v]) => v), id);
  res.json({ ok: true });
});

// ---- admin: reorder automation ---------------------------------------------------

app.get('/api/admin/reorder', requireAdmin, (req, res) => {
  const coverDays = Number(req.query.coverDays ?? 30); // target days of stock to reorder up to
  const windowDays = 30; // sales velocity window
  const sales = db
    .prepare(
      `SELECT item_id, size, color, SUM(-delta) AS sold FROM stock_movements
       WHERE kind = 'sale' AND created_at >= datetime('now', ?)
       GROUP BY item_id, size, color`
    )
    .all(`-${windowDays} days`) as any[];
  const soldMap = new Map<string, number>();
  for (const s of sales) soldMap.set(`${s.item_id}:${s.size}:${s.color ?? ''}`, s.sold);

  const variants = db
    .prepare(
      `SELECT v.item_id, v.size, v.color, v.on_hand, v.reserved, i.name, i.sku, i.reorder_point
       FROM item_variants v JOIN items i ON i.id = v.item_id ORDER BY i.name, v.color, v.size`
    )
    .all() as any[];

  const rows = variants.map((v) => {
    const sold = soldMap.get(`${v.item_id}:${v.size}:${v.color ?? ''}`) ?? 0;
    const dailyRate = sold / windowDays;
    const available = v.on_hand - v.reserved;
    const daysOfStock = dailyRate > 0 ? Math.round(available / dailyRate) : null; // null = no recent sales
    const belowReorder = available <= v.reorder_point;
    const runningOut = daysOfStock !== null && daysOfStock < 14;
    const flagged = belowReorder || runningOut;
    // reorder up to the larger of: velocity-based cover, or one above the reorder point
    const target = Math.max(Math.ceil(dailyRate * coverDays), flagged ? v.reorder_point + 1 : 0);
    const suggestedQty = Math.max(0, target - available);
    return {
      itemId: v.item_id, sku: v.sku, name: v.name, size: v.size, color: v.color ?? '',
      available, reorderPoint: v.reorder_point, sold30: sold,
      dailyRate: Number(dailyRate.toFixed(2)), daysOfStock,
      flag: belowReorder ? 'below-reorder' : runningOut ? 'running-out' : 'ok',
      suggestedQty,
    };
  });

  const needsAttention = rows.filter((r) => r.flag !== 'ok' && r.suggestedQty > 0);
  res.json({ coverDays, windowDays, needsAttention, all: rows });
});

app.post('/api/admin/reorder/receive', requireAdmin, (req, res) => {
  const { itemId, size, color, qty, reason } = req.body ?? {};
  if (!itemId || !size || !Number.isInteger(qty) || qty <= 0)
    return void res.status(400).json({ error: 'itemId, size and positive qty required' });
  const v = db.prepare(`SELECT id FROM item_variants WHERE item_id = ? AND size = ? AND color = ?`).get(itemId, size, color ?? '');
  if (!v) return void res.status(404).json({ error: 'variant not found' });
  moveStock(itemId, size, color ?? '', qty, 'receiving', reason ?? 'Reorder received', 'admin');
  res.json({ ok: true });
});

// ---- admin: back-in-stock waitlist -----------------------------------------------

app.get('/api/admin/back-in-stock', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*,
         CASE WHEN b.kind = 'outfit' THEN o.name ELSE i.name END AS ref_name
       FROM back_in_stock b
       LEFT JOIN outfits o ON b.kind = 'outfit' AND o.id = b.ref_id
       LEFT JOIN items i ON b.kind = 'item' AND i.id = b.ref_id
       ORDER BY b.notified ASC, b.created_at DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/admin/back-in-stock/:id/notify', requireAdmin, (req, res) => {
  // Demo: marks the waiter notified. Production enqueues the actual email (Phase 3).
  db.prepare(`UPDATE back_in_stock SET notified = 1 WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- admin: image upload (photos everywhere) -------------------------------------

app.post('/api/admin/upload', requireAdmin, async (req, res) => {
  const { dataUrl } = req.body ?? {};
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return void res.status(400).json({ error: 'expected a base64 image data URL' });
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) return void res.status(400).json({ error: 'unsupported image type (png/jpg/webp/gif/avif)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 15 * 1024 * 1024) return void res.status(413).json({ error: 'image too large (max 15MB)' });
  
  if (process.env.CLOUDINARY_URL) {
    try {
      const result = await new Promise<any>((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'nayo' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(buf);
      });
      res.json({ url: result.secure_url });
    } catch (e: any) {
      console.error('Cloudinary upload error:', e);
      res.status(500).json({ error: 'Failed to upload to Cloudinary' });
    }
  } else {
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), buf);
    res.json({ url: `/api/uploads/${name}` });
  }
});

// ---- admin: customer analytics ---------------------------------------------------

app.get('/api/admin/customers', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT email,
              MAX(customer_name) AS name,
              COUNT(*) AS orders,
              SUM(total_cents) AS spend_cents,
              MIN(created_at) AS first_order,
              MAX(created_at) AS last_order
       FROM orders WHERE status != 'cancelled'
       GROUP BY email
       ORDER BY spend_cents DESC`
    )
    .all() as any[];

  const customers = rows.map((r) => {
    const tier = tierFor(r.email);
    return {
      email: r.email,
      name: r.name || r.email.split('@')[0],
      orders: r.orders,
      spendCents: r.spend_cents,
      aovCents: r.orders ? Math.round(r.spend_cents / r.orders) : 0,
      firstOrder: r.first_order,
      lastOrder: r.last_order,
      tier: tier.tier.name,
      hasAccount: !!db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(r.email),
    };
  });

  const totalCustomers = customers.length;
  const repeat = customers.filter((c) => c.orders >= 2).length;
  const totalRevenue = customers.reduce((n, c) => n + c.spendCents, 0);
  const totalOrders = customers.reduce((n, c) => n + c.orders, 0);
  const registered = customers.filter((c) => c.hasAccount).length;
  const tierCounts: Record<string, number> = { Insider: 0, Gold: 0, Platinum: 0 };
  for (const c of customers) tierCounts[c.tier] = (tierCounts[c.tier] ?? 0) + 1;
  const newThisMonth = (
    db.prepare(
      `SELECT COUNT(DISTINCT email) AS n FROM orders o
       WHERE status != 'cancelled'
         AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.email = o.email AND p.created_at < datetime('now','-30 days'))
         AND o.created_at >= datetime('now','-30 days')`
    ).get() as any
  ).n;

  res.json({
    summary: {
      totalCustomers,
      repeatCustomers: repeat,
      repeatRatePct: totalCustomers ? Math.round((repeat / totalCustomers) * 100) : 0,
      totalRevenueCents: totalRevenue,
      avgLtvCents: totalCustomers ? Math.round(totalRevenue / totalCustomers) : 0,
      aovCents: totalOrders ? Math.round(totalRevenue / totalOrders) : 0,
      registered,
      guestCheckouts: totalCustomers - registered,
      newThisMonth,
      tierCounts,
    },
    customers,
  });
});

// ---- serve the built frontend (single-service production deploy) ------------
// After `npm run build` in web/, the compiled SPA lives in web/dist. If present, this
// server hosts both the API and the site on one origin — the simplest thing to deploy.
const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log('Serving built frontend from web/dist');
}

const PORT = Number(process.env.PORT ?? 4141);
app.listen(PORT, () => console.log(`NAYO API listening on http://localhost:${PORT}`));
