"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backfillThemeImages = backfillThemeImages;
exports.backfillItemPrices = backfillItemPrices;
exports.backfillPriceFloors = backfillPriceFloors;
exports.seedIfEmpty = seedIfEmpty;
const db_js_1 = require("./db.js");
// Theme hero photography from the Stitch "Premium Juvenile Narrative" design system
const THEME_IMAGES = {
    school: 'https://lh3.googleusercontent.com/aida-public/AB6AXuD3kOdhwyuizz331fWllSV4bdKeo5eXyZo15zkMIS-jAq1m5W2dDPHCU5tv0RsyMpUnxqq1eZinkDDRj8IeINCvUTZmfHXL2GpjGpVD-PZ-5Y1oDlJya9CDIPm98d9T0Z8HPmY9rp0fTiSIXo7BT3K6uzwfbWVVKfvDcN_FSxrxvNlWSjhg4RSOYiACgRY3TtBa4xVh6ukRVRkCZEpfg4nDBw3A9GV0OAa826IyXQPzj8XSInQNibufTwG2YTrLLKqgSUo1PtIuvRM',
    'pool-party': 'https://lh3.googleusercontent.com/aida-public/AB6AXuD1Rmx5dCFLq3yT7Z-Rap2_WOM_CEcCzGywIRxUI2LfMjXucwF4gvtuhTXEVQF3yllZDbUmTI8Ma-p9hMpYRisjAXdTeaiCeCN5qQFqvkZ080QGpRixF5ytUH5T-eeQN5mjcZYFgNlxMrCZb6YpRDpXFime5fjBcbXvpHnRNnIjsi6eTdpYwTW2T_NlGC7CVDTN2hJKntbOoZYZvQwwUEcdB5ZbzES9pFZio6LG0B_ji-3-YkBtSLTeko0zoeB_CeVX4g2uwkEpr3A',
    'summer-vacation': 'https://lh3.googleusercontent.com/aida-public/AB6AXuAHsbqOHnZZjcrYRm8n8dl0bcxuSgK5x3XAdUJMDUpA3VlKGvSQFwbv3JU9LjlwSb4-f1InYZ2axz4Ay6fnrVZd4QbSHUMsHCperuBXOuWse9WxHrx06LHqFDi8Ty7wG2CHQjd2M4KolkdhBczHCx1zsgAfcvx4NjkyZouP94Em777oYrgL2CZ8pG_oevh45_biteFdGbQTLrMbAVEcZ8HoC7r2fza7RBjzyu2bv0eIANBQS6dyEFMWvB0jinML5nCifHg1S4T488s',
    'eco-minimalist': 'https://lh3.googleusercontent.com/aida-public/AB6AXuAQ56LgD7j0vHI1dVEfvOoI16oTbD5zVgkk7YCkv-jeCSDkHrpyQroKk1ZqhOcOsVqVt_nSkmpxfOnpGgErkwICK49P7j399aVTvXNrwdbwZEfefUJgLLAQoevn-ODG5obO41o21HpCpNr0neHFS_Iivj0cqizvHqliNbdRwhsGJUa4JXprtxPUg83mymkWYPpVoeyrmlfIDackEFis2lsRR8RxZM5GrAcHcOAM97dDHiHBQ3X0O0z1fWnINnPpZUYO6bNxemukoQ0',
};
function backfillThemeImages() {
    const stmt = db_js_1.db.prepare(`UPDATE themes SET hero_image = ? WHERE slug = ? AND hero_image = ''`);
    for (const [slug, url] of Object.entries(THEME_IMAGES))
        stmt.run(url, slug);
}
/** Give every item a standalone retail price (≈2.4× cost, ending in .90). */
function backfillItemPrices() {
    const items = db_js_1.db.prepare(`SELECT id, cost_cents, list_price_cents FROM items`).all();
    const stmt = db_js_1.db.prepare(`UPDATE items SET list_price_cents = ? WHERE id = ?`);
    for (const it of items) {
        if (it.list_price_cents > 0)
            continue;
        const price = Math.max(500, Math.round((it.cost_cents * 2.4) / 100) * 100 - 10); // e.g. 1400 → 3390 (₪33.90)
        stmt.run(price, it.id);
    }
}
/** Seed a loyalty floor at 80% of list where none is set — so the band works immediately.
 *  Never below cost: floor = max(cost, 80% of list). Seller can tune per product. */
function backfillPriceFloors() {
    const items = db_js_1.db.prepare(`SELECT id, cost_cents, list_price_cents, price_floor_cents FROM items`).all();
    const iStmt = db_js_1.db.prepare(`UPDATE items SET price_floor_cents = ? WHERE id = ?`);
    for (const it of items) {
        if (it.price_floor_cents > 0)
            continue;
        iStmt.run(Math.max(it.cost_cents, Math.round((it.list_price_cents * 0.8) / 10) * 10), it.id);
    }
    const outfits = db_js_1.db.prepare(`SELECT id, price_cents, price_floor_cents FROM outfits`).all();
    const oStmt = db_js_1.db.prepare(`UPDATE outfits SET price_floor_cents = ? WHERE id = ?`);
    for (const o of outfits) {
        if (o.price_floor_cents > 0)
            continue;
        oStmt.run(Math.round((o.price_cents * 0.8) / 10) * 10, o.id);
    }
}
function seedIfEmpty() {
    const count = db_js_1.db.prepare(`SELECT COUNT(*) AS n FROM themes`).get().n;
    if (count > 0)
        return;
    console.log('Seeding demo catalog…');
    const SIZES = ['3-4Y', '5-6Y', '7-8Y'];
    const insTheme = db_js_1.db.prepare(`INSERT INTO themes (slug, name, tagline, description, icon, palette_from, palette_to, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const themes = {};
    const themeRows = [
        ['school', 'Back to School', 'Sharp looks for sharp minds', 'Polished, playground-proof outfits that survive recess and look brilliant at pickup.', 'school', '#e4e2e1', '#c8c6c6'],
        ['summer-vacation', 'Summer Vacation', 'Pack the whole holiday in one box', 'Linen, straw and sunshine — resort-ready sets for little travelers.', 'beach_access', '#ffdad6', '#ff978c'],
        ['pool-party', 'Pool Party', 'Make a splash', 'Swim sets, terry robes and sun hats for the season’s best invitations.', 'pool', '#d0e8d9', '#b5ccbd'],
        ['eco-minimalist', 'Eco-Minimalist', 'Softly does it', 'Sustainable linen sets in earthy tones. Gentle on skin, gentle on the planet.', 'eco', '#f4f3f1', '#d0e8d9'],
    ].map((r, i) => [...r, i]);
    for (const [slug, name, tagline, description, icon, from, to, sort] of themeRows) {
        insTheme.run(slug, name, tagline, description, icon, from, to, sort);
        themes[slug] = Number(db_js_1.db.prepare(`SELECT id FROM themes WHERE slug = ?`).get(slug).id);
    }
    const insItem = db_js_1.db.prepare(`INSERT INTO items (sku, name, type, sizing, cost_cents, detail, icon, reorder_point)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const items = {};
    // sku, name, type, sizing, cost, detail, icon, reorder point
    const itemRows = [
        ['GAR-001', 'Sage Linen Romper', 'garment', 'sized', 1400, '100% European linen, sage green. Machine washable.', 'apparel', 5],
        ['GAR-002', 'Canvas Shorts', 'garment', 'sized', 900, 'Stone-washed cotton canvas, elastic waist.', 'apparel', 6],
        ['GAR-003', 'Striped Swimsuit', 'garment', 'sized', 1100, 'Navy & white stripe, UPF 50+ quick-dry.', 'pool', 5],
        ['GAR-004', 'Terry Cloth Robe', 'garment', 'sized', 1300, 'Mini terry robe with hood, ecru.', 'dry_cleaning', 4],
        ['GAR-005', 'Oxford Shirt', 'garment', 'sized', 1200, 'Crisp white oxford, soft collar.', 'apparel', 5],
        ['GAR-006', 'Chino Trousers', 'garment', 'sized', 1250, 'Tapered chinos in warm sand.', 'apparel', 5],
        ['GAR-007', 'Knit Cardigan', 'garment', 'sized', 1500, 'Organic cotton knit, oatmeal.', 'apparel', 4],
        ['GAR-008', 'Sailor Collar Dress', 'garment', 'sized', 1600, 'Navy sailor dress with white piping.', 'apparel', 4],
        ['ACC-001', 'Woven Straw Hat', 'accessory', 'one-size', 600, 'Hand-woven straw, adjustable band.', 'sunny', 8],
        ['ACC-002', 'Tan Leather Sandals', 'accessory', 'sized', 950, 'Soft leather, rubber sole.', 'steps', 5],
        ['ACC-003', 'Yellow Sunglasses', 'accessory', 'one-size', 400, 'Oversized frames, UV400.', 'eyeglasses', 10],
        ['ACC-004', 'Canvas Backpack', 'accessory', 'one-size', 850, 'Kid-sized canvas backpack, leather straps.', 'backpack', 6],
        ['ACC-005', 'Knee-High Socks (2pk)', 'accessory', 'sized', 300, 'Combed cotton, navy + cream.', 'checkroom', 12],
        ['PRF-001', 'Petit Parfum — Citron', 'perfume', 'one-size', 700, 'Alcohol-free kids’ eau fraîche, citrus.', 'water_drop', 8],
        ['PRF-002', 'Petit Parfum — Vanille', 'perfume', 'one-size', 700, 'Alcohol-free kids’ eau fraîche, vanilla.', 'water_drop', 8],
    ];
    for (const [sku, name, type, sizing, cost, detail, icon, rp] of itemRows) {
        insItem.run(sku, name, type, sizing, cost, detail, icon, rp);
        items[sku] = Number(db_js_1.db.prepare(`SELECT id FROM items WHERE sku = ?`).get(sku).id);
    }
    // stock per variant — includes low (<=5) and one sold-out chain for demo realism
    const stock = {
        'GAR-001': { '3-4Y': 12, '5-6Y': 4, '7-8Y': 9 },
        'GAR-002': { '3-4Y': 3, '5-6Y': 2, '7-8Y': 15 },
        'GAR-003': { '3-4Y': 0, '5-6Y': 0, '7-8Y': 0 },
        'GAR-004': { '3-4Y': 7, '5-6Y': 6, '7-8Y': 2 },
        'GAR-005': { '3-4Y': 20, '5-6Y': 18, '7-8Y': 11 },
        'GAR-006': { '3-4Y': 14, '5-6Y': 5, '7-8Y': 8 },
        'GAR-007': { '3-4Y': 9, '5-6Y': 9, '7-8Y': 3 },
        'GAR-008': { '3-4Y': 6, '5-6Y': 11, '7-8Y': 7 },
        'ACC-002': { '3-4Y': 10, '5-6Y': 4, '7-8Y': 12 },
        'ACC-005': { '3-4Y': 30, '5-6Y': 25, '7-8Y': 22 },
    };
    const oneSize = {
        'ACC-001': 18,
        'ACC-003': 3,
        'ACC-004': 16,
        'PRF-001': 24,
        'PRF-002': 5,
    };
    const insVariant = db_js_1.db.prepare(`INSERT INTO item_variants (item_id, size, on_hand) VALUES (?, ?, 0)`);
    for (const [sku, sizes] of Object.entries(stock)) {
        for (const [size, qty] of Object.entries(sizes)) {
            insVariant.run(items[sku], size);
            (0, db_js_1.moveStock)(items[sku], size, qty, 'initial', 'Opening stock', 'seed');
        }
    }
    for (const [sku, qty] of Object.entries(oneSize)) {
        insVariant.run(items[sku], 'ONE');
        (0, db_js_1.moveStock)(items[sku], 'ONE', qty, 'initial', 'Opening stock', 'seed');
    }
    const insOutfit = db_js_1.db.prepare(`INSERT INTO outfits (slug, name, story, price_cents, size_run, hero_image, palette_from, palette_to, icon, rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insOI = db_js_1.db.prepare(`INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)`);
    const insOT = db_js_1.db.prepare(`INSERT INTO outfit_themes (outfit_id, theme_id) VALUES (?, ?)`);
    const sageImg = 'https://lh3.googleusercontent.com/aida-public/AB6AXuDZ8cYT4RU7HWQwD_ma1EK5zcEj2FQBPYFI4x8ipqhjGn_bEMxp3H1lR1T7SKv1aDRv8Wi-OwIOysPfMdHMp_Af52S1oW6StwXXcI1bGLo0FyV6OuEz39ITEpcbsUVRDStwx09fXTy8xjG2VMTBO1cPThNtNG2ZHko_qM85nm8FVG2ojOTeD1UgDJnOrjQTzh1z1ioK4lY10QTeIEhaj614j_AQh4Msc_XEjHHZrS3waA5-YAlX-WHitTWeeqlRqF_OSO-zinsxfhQ';
    const poolImg = 'https://lh3.googleusercontent.com/aida-public/AB6AXuBl2us9WfLz_N_HvJTQ0NbGDFs-5AtflfPws-OVIHCIcweciL4WHsl-IBiqdnWr3Sq_b5A1WXGzKkSHs3wMBs-0O3kZHHMxKF_IsLzGoR3Xio01l7DiMryCubZCwI9XPz0bQHclp6Ngexux_2QKlNkhfFrT9YLKWVTLpnmkUhIuWdk9sIv2w8NV_jaJsefG8HkRHK3ydpgVWo8XvBuoApOkdmKwk56tTiSBGra914LsKvzDp4GDK7fjdDewHph9Xfek8sDtaTzVuic';
    //    slug, name, story, price, sizes, hero, from, to, icon, rating, itemSkus, themeSlugs
    const outfitRows = [
        ['sage-garden-set', 'The Sage Garden Set', 'Soft morning light, linen and straw — the set that started it all.', 6400, SIZES, sageImg, '#d0e8d9', '#e4e2e1', 'psychiatry', 4.9, ['GAR-001', 'ACC-001', 'ACC-002'], ['eco-minimalist', 'summer-vacation']],
        ['pool-party-splash', 'Pool Party Splash', 'Stripes, shades and a terry robe for the season’s best invitation.', 7800, SIZES, poolImg, '#d0e8d9', '#ffdad6', 'pool', 5.0, ['GAR-003', 'GAR-004', 'ACC-003', 'PRF-001'], ['pool-party']],
        ['first-day-hero', 'First Day Hero', 'Crisp oxford, chinos and a backpack that fits everything but nerves.', 7200, SIZES, '', '#e4e2e1', '#c8c6c6', 'school', 4.8, ['GAR-005', 'GAR-006', 'ACC-004', 'ACC-005'], ['school']],
        ['harbor-days', 'Harbor Days', 'Sailor collars and knee socks — nautical nostalgia, done right.', 6900, SIZES, '', '#ffdad6', '#ff978c', 'sailing', 4.7, ['GAR-008', 'ACC-005', 'ACC-001', 'PRF-002'], ['summer-vacation']],
        ['oat-cardigan-capsule', 'Oat & Canvas Capsule', 'A knit cardigan over canvas shorts — weekend uniform, elevated.', 6600, SIZES, '', '#f4f3f1', '#d0e8d9', 'eco', 4.6, ['GAR-007', 'GAR-002', 'ACC-002'], ['eco-minimalist', 'school']],
        ['petit-scholar', 'Petit Scholar', 'Cardigan, oxford and a spritz of vanilla courage for picture day.', 7500, SIZES, '', '#e4e2e1', '#ffdad6', 'school', 4.9, ['GAR-005', 'GAR-007', 'ACC-005', 'PRF-002'], ['school']],
    ];
    for (const [slug, name, story, price, sizes, hero, from, to, icon, rating, skus, themeSlugs] of outfitRows) {
        insOutfit.run(slug, name, story, price, JSON.stringify(sizes), hero, from, to, icon, rating);
        const oid = Number(db_js_1.db.prepare(`SELECT id FROM outfits WHERE slug = ?`).get(slug).id);
        for (const sku of skus)
            insOI.run(oid, items[sku]);
        for (const t of themeSlugs)
            insOT.run(oid, themes[t]);
    }
    // a few historical orders so the dashboard has numbers
    const insOrder = db_js_1.db.prepare(`INSERT INTO orders (email, customer_name, status, subtotal_cents, discount_cents, total_cents, tier_at_purchase, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`);
    const insLine = db_js_1.db.prepare(`INSERT INTO order_lines (order_id, outfit_id, size, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?)`);
    const demoOrders = [
        ['noa.levi@example.com', 'Noa Levi', 6400, 'sage-garden-set', 1, '-12 days'],
        ['maya.cohen@example.com', 'Maya Cohen', 7800, 'pool-party-splash', 1, '-9 days'],
        ['dana.mizrahi@example.com', 'Dana Mizrahi', 14400, 'first-day-hero', 2, '-6 days'],
        ['noa.levi@example.com', 'Noa Levi', 7500, 'petit-scholar', 1, '-3 days'],
        ['shira.katz@example.com', 'Shira Katz', 6900, 'harbor-days', 1, '-1 days'],
    ];
    for (const [email, cname, total, slug, qty, ago] of demoOrders) {
        insOrder.run(email, cname, 'delivered', total, 0, total, 'Insider', ago);
        const orderId = Number(db_js_1.db.prepare(`SELECT last_insert_rowid() AS id`).get().id);
        const o = db_js_1.db.prepare(`SELECT id, price_cents FROM outfits WHERE slug = ?`).get(slug);
        insLine.run(orderId, o.id, '5-6Y', qty, o.price_cents);
    }
    console.log('Seed complete.');
}
