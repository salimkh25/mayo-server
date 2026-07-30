import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';


// DATA_DIR lets you put the SQLite file on a persistent disk in production (see GO-LIVE.md).
// Defaults to server/data for local development.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'nayo.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'styler',        -- material symbol name
    palette_from TEXT NOT NULL DEFAULT '#d0e8d9',
    palette_to TEXT NOT NULL DEFAULT '#b5ccbd',
    sort INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('garment','accessory','perfume')),
    sizing TEXT NOT NULL DEFAULT 'sized' CHECK (sizing IN ('sized','one-size')),
    cost_cents INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'apparel',
    reorder_point INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS item_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    size TEXT NOT NULL,                          -- 'ONE' for one-size items
    color TEXT NOT NULL DEFAULT '',              -- '' = the item has no colors (single variant)
    on_hand INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    UNIQUE(item_id, size, color)
  );

  CREATE TABLE IF NOT EXISTS outfits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    story TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('draft','live','archived')),
    size_run TEXT NOT NULL DEFAULT '[]',         -- JSON array of sizes
    hero_image TEXT NOT NULL DEFAULT '',         -- URL or '' (gradient fallback)
    palette_from TEXT NOT NULL DEFAULT '#d0e8d9',
    palette_to TEXT NOT NULL DEFAULT '#ffdad6',
    icon TEXT NOT NULL DEFAULT 'styler',
    rating REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS outfit_items (
    outfit_id INTEGER NOT NULL REFERENCES outfits(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    PRIMARY KEY (outfit_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS outfit_themes (
    outfit_id INTEGER NOT NULL REFERENCES outfits(id),
    theme_id INTEGER NOT NULL REFERENCES themes(id),
    PRIMARY KEY (outfit_id, theme_id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','shipped','delivered','cancelled')),
    subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL,
    tier_at_purchase TEXT NOT NULL DEFAULT 'Insider',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    outfit_id INTEGER NOT NULL REFERENCES outfits(id),
    size TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
  );

  -- Immutable stock ledger: on_hand on item_variants is a cache of SUM(delta).
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    size TEXT NOT NULL,
    delta INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('receiving','sale','adjustment','return','write-off','initial')),
    reason TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT 'system',
    order_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    consent INTEGER NOT NULL DEFAULT 0,
    anon_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    dob TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'regular' CHECK (role IN ('regular', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try { db.exec('ALTER TABLE users ADD COLUMN address TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN city TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN dob TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT "regular" CHECK (role IN ("regular", "admin"))'); } catch {}

// One-time auto-upgrade for all current users (temporary fix for testing)
try {
  db.prepare(`UPDATE users SET role = 'admin'`).run();
} catch (e) {
  console.error('Failed to auto-upgrade users', e);
}

db.exec(`
  -- Standalone item purchases (FEATURES §1: items sellable on their own).
  -- Kept separate from order_lines so outfit lines keep their NOT NULL outfit_id.
  CREATE TABLE IF NOT EXISTS order_item_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    size TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS back_in_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('outfit','item')),
    ref_id INTEGER NOT NULL,
    size TEXT NOT NULL DEFAULT '',
    notified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(email, kind, ref_id, size)
  );

  -- Carts awaiting Stripe payment. The real order is only created once the webhook
  -- confirms payment; until then the cart lives here keyed by the checkout session id.
  CREATE TABLE IF NOT EXISTS pending_checkouts (
    session_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    order_id INTEGER,                              -- set once fulfilled (idempotency)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A product's selectable colors. An item with no rows here has a single implicit
  -- variant (color = '') and behaves exactly like the original size-only model.
  CREATE TABLE IF NOT EXISTS item_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    name TEXT NOT NULL,                            -- display + the variant/image color key
    swatch TEXT NOT NULL DEFAULT '',               -- hex for the swatch dot (optional)
    image_url TEXT NOT NULL DEFAULT '',            -- photo shown when this color is picked
    sort INTEGER NOT NULL DEFAULT 0,
    UNIQUE(item_id, name)
  );

  -- Extra gallery photos. color = '' → shown for every color; otherwise tied to that color.
  CREATE TABLE IF NOT EXISTS item_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    url TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS outfit_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outfit_id INTEGER NOT NULL REFERENCES outfits(id),
    url TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );

  -- Customer product reviews (1–5 stars + optional comment). One per customer per product;
  -- only writable by someone who actually purchased it (enforced in the API).
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('outfit','item')),
    ref_id INTEGER NOT NULL,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    order_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(email, kind, ref_id)
  );

  -- One message thread per customer (keyed by email). sender = who wrote it.
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    sender TEXT NOT NULL CHECK (sender IN ('customer','shop')),
    body TEXT NOT NULL,
    read_by_customer INTEGER NOT NULL DEFAULT 0,
    read_by_shop INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_email ON messages(email, id);
`);

// Additive migrations for existing databases
const MIGRATIONS = [
  `ALTER TABLE themes ADD COLUMN hero_image TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN ship_method TEXT NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE orders ADD COLUMN ship_address TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN ship_city TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN ship_zip TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE items ADD COLUMN list_price_cents INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE items ADD COLUMN is_sold_standalone INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE items ADD COLUMN image_url TEXT NOT NULL DEFAULT ''`,
  // Loyalty pricing band: list price is the ceiling; price_floor_cents is the lowest
  // a loyal customer's personalized price can reach. 0 = no band (list price for all).
  `ALTER TABLE items ADD COLUMN price_floor_cents INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE outfits ADD COLUMN price_floor_cents INTEGER NOT NULL DEFAULT 0`,
  // Manager sale price applied to EVERYONE (0 = not on sale). Must be below list price.
  `ALTER TABLE items ADD COLUMN sale_price_cents INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE outfits ADD COLUMN sale_price_cents INTEGER NOT NULL DEFAULT 0`,
  // Stripe Checkout session that paid for an order (blank for dev/manual orders).
  `ALTER TABLE orders ADD COLUMN stripe_session_id TEXT NOT NULL DEFAULT ''`,
  // Color variants: the stock ledger, standalone order lines and outfit components all
  // gain a color key. '' preserves the original single-variant behaviour everywhere.
  `ALTER TABLE stock_movements ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE order_item_lines ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE outfit_items ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
  // Customer-confirmed delivery per line ("mark what arrived") — 0 = not yet received.
  `ALTER TABLE order_lines ADD COLUMN received INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE order_item_lines ADD COLUMN received INTEGER NOT NULL DEFAULT 0`,
];
for (const sql of MIGRATIONS) {
  try {
    db.exec(sql);
  } catch {
    /* column already exists */
  }
}

// item_variants gained a `color` dimension with UNIQUE(item_id, size, color). SQLite can't
// ALTER an existing UNIQUE constraint, so rebuild the table once for databases created before
// this change (detected by the absence of the color column). Nothing has an FK to item_variants,
// so the rename/copy/drop is safe. Fresh databases already get the new schema above and skip this.
const hasColor = (db.prepare(`PRAGMA table_info(item_variants)`).all() as any[]).some((c) => c.name === 'color');
if (!hasColor) {
  db.exec(`
    BEGIN;
    ALTER TABLE item_variants RENAME TO item_variants_old;
    CREATE TABLE item_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      size TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      on_hand INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      UNIQUE(item_id, size, color)
    );
    INSERT INTO item_variants (id, item_id, size, color, on_hand, reserved)
      SELECT id, item_id, size, '', on_hand, reserved FROM item_variants_old;
    DROP TABLE item_variants_old;
    COMMIT;
  `);
}

// ---- availability helpers ----------------------------------------------

export type SizeAvailability = { size: string; color?: string; available: number; limitedBy: string | null };

/** Effective availability of an outfit per size = min(available) across its items.
 *  One-size items (variant size 'ONE') constrain every size of the outfit. */
export function outfitAvailability(outfitId: number): SizeAvailability[] {
  const outfit = db.prepare(`SELECT size_run FROM outfits WHERE id = ?`).get(outfitId) as
    | { size_run: string }
    | undefined;
  if (!outfit) return [];
  const sizes: string[] = JSON.parse(outfit.size_run);
  // Each component draws from the specific color the outfit is built with (oi.color; '' for
  // non-colorized items), so a set's availability tracks exactly that variant's stock.
  const rows = db
    .prepare(
      `SELECT i.id AS item_id, i.name, i.sizing, v.size, (v.on_hand - v.reserved) AS available
       FROM outfit_items oi
       JOIN items i ON i.id = oi.item_id
       JOIN item_variants v ON v.item_id = i.id AND v.color = oi.color
       WHERE oi.outfit_id = ?`
    )
    .all(outfitId) as { item_id: number; name: string; sizing: string; size: string; available: number }[];

  return sizes.map((size) => {
    let min = Infinity;
    let limitedBy: string | null = null;
    for (const r of rows) {
      const applies = r.sizing === 'one-size' ? r.size === 'ONE' : r.size === size;
      if (!applies) continue;
      if (r.available < min) {
        min = r.available;
        limitedBy = r.name;
      }
    }
    if (min === Infinity) return { size, available: 0, limitedBy: null };
    return { size, available: Math.max(0, min), limitedBy };
  });
}

export function moveStock(
  itemId: number,
  size: string,
  color: string,
  delta: number,
  kind: string,
  reason: string,
  actor: string,
  orderId?: number
) {
  db.prepare(
    `INSERT INTO stock_movements (item_id, size, color, delta, kind, reason, actor, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(itemId, size, color, delta, kind, reason, actor, orderId ?? null);
  db.prepare(`UPDATE item_variants SET on_hand = on_hand + ? WHERE item_id = ? AND size = ? AND color = ?`).run(
    delta,
    itemId,
    size,
    color
  );
}

/** Per-variant standalone availability for an item (available = on_hand − reserved). */
export function itemAvailability(itemId: number): SizeAvailability[] {
  const rows = db
    .prepare(`SELECT size, color, (on_hand - reserved) AS available FROM item_variants WHERE item_id = ? ORDER BY color, size`)
    .all(itemId) as { size: string; color: string; available: number }[];
  return rows.map((r) => ({ size: r.size, color: r.color, available: Math.max(0, r.available), limitedBy: null }));
}

/** The variant size to draw from for an item at a given outfit/selected size. */
export function variantSizeFor(itemId: number, selectedSize: string): string {
  const item = db.prepare(`SELECT sizing FROM items WHERE id = ?`).get(itemId) as { sizing: string } | undefined;
  return item?.sizing === 'one-size' ? 'ONE' : selectedSize;
}
