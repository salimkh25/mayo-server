"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.outfitAvailability = outfitAvailability;
exports.moveStock = moveStock;
exports.itemAvailability = itemAvailability;
exports.variantSizeFor = variantSizeFor;
const node_sqlite_1 = require("node:sqlite");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
// DATA_DIR lets you put the SQLite file on a persistent disk in production (see GO-LIVE.md).
// Defaults to server/data for local development.
const dataDir = process.env.DATA_DIR
    ? node_path_1.default.resolve(process.env.DATA_DIR)
    : node_path_1.default.join(__dirname, '..', 'data');
node_fs_1.default.mkdirSync(dataDir, { recursive: true });
exports.db = new node_sqlite_1.DatabaseSync(node_path_1.default.join(dataDir, 'nayo.db'));
exports.db.exec(`
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
    on_hand INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    UNIQUE(item_id, size)
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
exports.db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
];
for (const sql of MIGRATIONS) {
    try {
        exports.db.exec(sql);
    }
    catch {
        /* column already exists */
    }
}
/** Effective availability of an outfit per size = min(available) across its items.
 *  One-size items (variant size 'ONE') constrain every size of the outfit. */
function outfitAvailability(outfitId) {
    const outfit = exports.db.prepare(`SELECT size_run FROM outfits WHERE id = ?`).get(outfitId);
    if (!outfit)
        return [];
    const sizes = JSON.parse(outfit.size_run);
    const rows = exports.db
        .prepare(`SELECT i.id AS item_id, i.name, i.sizing, v.size, (v.on_hand - v.reserved) AS available
       FROM outfit_items oi
       JOIN items i ON i.id = oi.item_id
       JOIN item_variants v ON v.item_id = i.id
       WHERE oi.outfit_id = ?`)
        .all(outfitId);
    return sizes.map((size) => {
        let min = Infinity;
        let limitedBy = null;
        for (const r of rows) {
            const applies = r.sizing === 'one-size' ? r.size === 'ONE' : r.size === size;
            if (!applies)
                continue;
            if (r.available < min) {
                min = r.available;
                limitedBy = r.name;
            }
        }
        if (min === Infinity)
            return { size, available: 0, limitedBy: null };
        return { size, available: Math.max(0, min), limitedBy };
    });
}
function moveStock(itemId, size, delta, kind, reason, actor, orderId) {
    exports.db.prepare(`INSERT INTO stock_movements (item_id, size, delta, kind, reason, actor, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(itemId, size, delta, kind, reason, actor, orderId ?? null);
    exports.db.prepare(`UPDATE item_variants SET on_hand = on_hand + ? WHERE item_id = ? AND size = ?`).run(delta, itemId, size);
}
/** Per-size standalone availability for an item (available = on_hand − reserved). */
function itemAvailability(itemId) {
    const rows = exports.db
        .prepare(`SELECT size, (on_hand - reserved) AS available FROM item_variants WHERE item_id = ? ORDER BY size`)
        .all(itemId);
    return rows.map((r) => ({ size: r.size, available: Math.max(0, r.available), limitedBy: null }));
}
/** The variant size to draw from for an item at a given outfit/selected size. */
function variantSizeFor(itemId, selectedSize) {
    const item = exports.db.prepare(`SELECT sizing FROM items WHERE id = ?`).get(itemId);
    return item?.sizing === 'one-size' ? 'ONE' : selectedSize;
}
