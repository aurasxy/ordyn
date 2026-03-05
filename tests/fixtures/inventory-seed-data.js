/**
 * Inventory Redesign Seed Data Generator
 * Generates test data for the Portfolio / Inventory V2 system.
 *
 * 4 tiers:
 *   - normalInventory() : 25 items (15 regular + 10 TCG)
 *   - normalSales()     : 12 sales across multiple platforms/dates
 *   - generateHeavy()   : 500 items + 50 sales (configurable)
 *   - generateExtreme() : 5000 items + 200 sales
 *
 * Also exports NORMAL_EXPECTED precomputed totals and daysAgo() helper.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'inv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Return an ISO date string for N days in the past (midnight UTC).
 * @param {number} n - days ago
 * @returns {string} ISO8601 string
 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

/**
 * Return YYYY-MM-DD local-style date string for N days ago.
 */
function daysAgoDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function makeLot(qty, costPerItem, daysBack, source) {
  return {
    id: uuid(),
    quantity: qty,
    originalQuantity: qty,
    costPerItem,
    acquiredAt: daysAgo(daysBack),
    source: source || 'manual',
    sourceRef: null,
    notes: ''
  };
}

function makeFees(grossRevenue, platform) {
  const presets = {
    'eBay':       { platformFeePercent: 13.25, paymentProcessingPercent: 0 },
    'TCGPlayer':  { platformFeePercent: 10.25, paymentProcessingPercent: 2.5 },
    'Mercari':    { platformFeePercent: 10, paymentProcessingPercent: 0 },
    'Facebook':   { platformFeePercent: 0, paymentProcessingPercent: 0 },
    'Local':      { platformFeePercent: 0, paymentProcessingPercent: 0 },
    'Other':      { platformFeePercent: 0, paymentProcessingPercent: 0 },
  };
  const preset = presets[platform] || presets['Other'];
  const platformFeeAmount = Math.round((grossRevenue * preset.platformFeePercent / 100) * 100) / 100;
  const paymentProcessingAmount = Math.round((grossRevenue * preset.paymentProcessingPercent / 100) * 100) / 100;
  const shippingCost = platform === 'Local' ? 0 : 4.50;
  const totalFees = Math.round((platformFeeAmount + paymentProcessingAmount + shippingCost) * 100) / 100;

  return {
    platformFeePercent: preset.platformFeePercent,
    platformFeeAmount,
    paymentProcessingPercent: preset.paymentProcessingPercent,
    paymentProcessingAmount,
    shippingCost,
    shippingCharged: 0,
    taxCollected: 0,
    taxRemitted: 0,
    flatFees: 0,
    totalFees
  };
}

function makePriceHistory(basePrice, entries) {
  const history = [];
  for (let i = entries; i >= 1; i--) {
    const jitter = (Math.random() - 0.5) * basePrice * 0.1;
    history.push({
      date: daysAgoDate(i),
      market: Math.round((basePrice + jitter) * 100) / 100,
      low: Math.round((basePrice * 0.85 + jitter) * 100) / 100,
      high: Math.round((basePrice * 1.2 + jitter) * 100) / 100
    });
  }
  return history;
}

// ---------------------------------------------------------------------------
// Normal Inventory: 15 regular + 10 TCG = 25 items
// ---------------------------------------------------------------------------

function normalInventory() {
  const now = new Date().toISOString();

  // 15 regular (non-TCG) items
  const regularItems = [
    { name: 'PS5 Slim Bundle', category: 'general', quantity: 2, costPerItem: 499.99, setName: '', sku: 'PS5-SLIM-001', condition: 'sealed', retailer: 'walmart', daysBack: 30 },
    { name: 'Nintendo Switch OLED', category: 'general', quantity: 1, costPerItem: 349.99, setName: '', sku: 'NSW-OLED-001', condition: 'sealed', retailer: 'target', daysBack: 25 },
    { name: 'Xbox Series X', category: 'general', quantity: 3, costPerItem: 499.99, setName: '', sku: 'XSX-001', condition: 'sealed', retailer: 'walmart', daysBack: 20 },
    { name: 'Pokemon Evolving Skies ETB', category: 'general', quantity: 5, costPerItem: 42.00, setName: 'Evolving Skies', sku: 'ES-ETB-001', condition: 'sealed', retailer: 'pokecenter', daysBack: 45 },
    { name: 'Scarlet & Violet UPC', category: 'general', quantity: 2, costPerItem: 119.99, setName: 'Scarlet & Violet', sku: 'SV-UPC-001', condition: 'sealed', retailer: 'target', daysBack: 15 },
    { name: 'Prismatic Evolutions Booster Bundle', category: 'general', quantity: 8, costPerItem: 27.99, setName: 'Prismatic Evolutions', sku: 'PE-BB-001', condition: 'sealed', retailer: 'walmart', daysBack: 5 },
    { name: 'Surging Sparks Booster Box', category: 'general', quantity: 4, costPerItem: 89.97, setName: 'Surging Sparks', sku: 'SS-BX-001', condition: 'sealed', retailer: 'pokecenter', daysBack: 40 },
    { name: 'Steam Deck 512GB', category: 'general', quantity: 1, costPerItem: 449.99, setName: '', sku: 'SD-512-001', condition: 'sealed', retailer: 'walmart', daysBack: 10 },
    { name: 'Meta Quest 3', category: 'general', quantity: 2, costPerItem: 499.99, setName: '', sku: 'MQ3-001', condition: 'sealed', retailer: 'target', daysBack: 8 },
    { name: 'Stellar Crown ETB', category: 'general', quantity: 6, costPerItem: 39.99, setName: 'Stellar Crown', sku: 'SC-ETB-001', condition: 'sealed', retailer: 'pokecenter', daysBack: 35 },
    { name: 'Paldea Evolved Booster Box', category: 'general', quantity: 3, costPerItem: 89.97, setName: 'Paldea Evolved', sku: 'PE2-BX-001', condition: 'sealed', retailer: 'walmart', daysBack: 50 },
    { name: 'Pokemon 151 ETB', category: 'general', quantity: 4, costPerItem: 49.99, setName: 'Pokemon 151', sku: '151-ETB-001', condition: 'sealed', retailer: 'target', daysBack: 60 },
    { name: 'Obsidian Flames Booster Box', category: 'general', quantity: 2, costPerItem: 89.97, setName: 'Obsidian Flames', sku: 'OF-BX-001', condition: 'sealed', retailer: 'pokecenter', daysBack: 55 },
    { name: 'DualSense Edge Controller', category: 'general', quantity: 3, costPerItem: 199.99, setName: '', sku: 'DSE-001', condition: 'sealed', retailer: 'walmart', daysBack: 12 },
    { name: 'Pokemon TCG Battle Academy', category: 'general', quantity: 10, costPerItem: 19.99, setName: '', sku: 'BA-001', condition: 'sealed', retailer: 'target', daysBack: 70 },
  ];

  // 10 TCG items (with tcgplayerId, priceData, priceHistory, analytics, etc.)
  const tcgItems = [
    { name: 'Charizard ex SAR 223/197', setName: 'Obsidian Flames', costPerItem: 32.50, quantity: 3, marketPrice: 45.99, lowPrice: 38.50, highPrice: 65.00, daysBack: 18, tcgplayerId: '507892' },
    { name: 'Pikachu VMAX 044/185', setName: 'Vivid Voltage', costPerItem: 18.00, quantity: 5, marketPrice: 28.50, lowPrice: 22.00, highPrice: 42.00, daysBack: 22, tcgplayerId: '231456' },
    { name: 'Umbreon VMAX Alt Art 215/203', setName: 'Evolving Skies', costPerItem: 95.00, quantity: 1, marketPrice: 180.00, lowPrice: 155.00, highPrice: 220.00, daysBack: 30, tcgplayerId: '249873' },
    { name: 'Mewtwo ex 158/165', setName: 'Pokemon 151', costPerItem: 12.00, quantity: 8, marketPrice: 15.99, lowPrice: 11.50, highPrice: 24.00, daysBack: 14, tcgplayerId: '492315' },
    { name: 'Lugia V Alt Art 186/195', setName: 'Silver Tempest', costPerItem: 45.00, quantity: 2, marketPrice: 72.50, lowPrice: 58.00, highPrice: 95.00, daysBack: 40, tcgplayerId: '392847' },
    { name: 'Rayquaza VMAX Alt Art 218/203', setName: 'Evolving Skies', costPerItem: 110.00, quantity: 1, marketPrice: 195.00, lowPrice: 170.00, highPrice: 250.00, daysBack: 28, tcgplayerId: '249999' },
    { name: 'Mew VMAX 114/264', setName: 'Fusion Strike', costPerItem: 8.50, quantity: 12, marketPrice: 6.25, lowPrice: 4.00, highPrice: 10.00, daysBack: 50, tcgplayerId: '263100' },
    { name: 'Giratina V Alt Art 186/196', setName: 'Lost Origin', costPerItem: 55.00, quantity: 2, marketPrice: 78.00, lowPrice: 65.00, highPrice: 100.00, daysBack: 35, tcgplayerId: '372984' },
    { name: 'Charizard VSTAR Rainbow 174/172', setName: 'Brilliant Stars', costPerItem: 22.00, quantity: 4, marketPrice: 18.50, lowPrice: 14.00, highPrice: 28.00, daysBack: 42, tcgplayerId: '268521' },
    { name: 'Moonbreon Promo SVP 130', setName: 'Promo', costPerItem: 75.00, quantity: 1, marketPrice: 120.00, lowPrice: 100.00, highPrice: 150.00, daysBack: 10, tcgplayerId: '516234' },
  ];

  const regularMapped = regularItems.map((r, i) => {
    const id = `inv-reg-${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      name: r.name,
      image: '',
      category: r.category,
      quantity: r.quantity,
      costPerItem: r.costPerItem,
      lots: [makeLot(r.quantity, r.costPerItem, r.daysBack, 'manual')],
      costMethod: 'wavg',
      createdAt: daysAgo(r.daysBack),
      updatedAt: now,
      setName: r.setName,
      sku: r.sku,
      condition: r.condition,
      language: 'EN',
      edition: '',
      isFoil: false,
      location: '',
      tags: [],
      linkedRetailer: r.retailer,
      linkedDrop: '',
      linkedItems: [],
      linkedOrderId: '',
      autoAdded: false,
      tcgplayerId: '',
      tcgplayerUrl: '',
      priceData: { marketPrice: null, lowPrice: null, midPrice: null, highPrice: null, totalListings: null, fetchedAt: '' },
      priceHistory: [],
      lastChecked: '',
      analytics: { change1d: { amount: 0, percent: 0 }, change7d: { amount: 0, percent: 0 }, change30d: { amount: 0, percent: 0 }, volatility7d: 0, spread: 0, trend: 'flat', signal: null, signalReason: '', lastComputed: '' },
      matchInfo: { method: 'none', confidence: 0, candidateCount: 0 },
      refreshState: { consecutiveErrors: 0, lastError: null, delisted: false, priority: 'normal' }
    };
  });

  const tcgMapped = tcgItems.map((t, i) => {
    const id = `inv-tcg-${String(i + 1).padStart(3, '0')}`;
    const historyEntries = 5 + Math.floor(Math.random() * 6); // 5-10 entries
    const priceHist = makePriceHistory(t.marketPrice, historyEntries);
    // Compute simple analytics from price history
    const latestPrice = priceHist.length > 0 ? priceHist[priceHist.length - 1].market : t.marketPrice;
    const oldestPrice = priceHist.length > 1 ? priceHist[0].market : latestPrice;
    const change30d = latestPrice - oldestPrice;
    const changePct30d = oldestPrice > 0 ? Math.round((change30d / oldestPrice) * 100 * 100) / 100 : 0;
    const trend = change30d > 0 ? 'up' : change30d < 0 ? 'down' : 'flat';

    // Compute signal
    let signal = null;
    let signalReason = '';
    if (t.marketPrice > t.costPerItem * 1.5 && changePct30d > 20) {
      signal = 'sell_now';
      signalReason = 'Strong uptrend, significant profit opportunity';
    } else if (t.marketPrice < t.costPerItem * 0.7) {
      signal = 'restock';
      signalReason = 'Price dropped below cost basis';
    } else if (t.marketPrice > t.costPerItem) {
      signal = 'hold';
      signalReason = 'Steady growth, moderate profit';
    }

    return {
      id,
      name: t.name,
      image: '',
      category: 'tcg_single',
      quantity: t.quantity,
      costPerItem: t.costPerItem,
      lots: [makeLot(t.quantity, t.costPerItem, t.daysBack, 'manual')],
      costMethod: 'wavg',
      createdAt: daysAgo(t.daysBack),
      updatedAt: now,
      setName: t.setName,
      sku: '',
      condition: 'NM',
      language: 'EN',
      edition: '',
      isFoil: false,
      location: '',
      tags: [],
      linkedRetailer: '',
      linkedDrop: '',
      linkedItems: [],
      linkedOrderId: '',
      autoAdded: false,
      tcgplayerId: t.tcgplayerId,
      tcgplayerUrl: `https://www.tcgplayer.com/product/${t.tcgplayerId}`,
      priceData: {
        marketPrice: t.marketPrice,
        lowPrice: t.lowPrice,
        midPrice: Math.round(((t.marketPrice + t.lowPrice) / 2) * 100) / 100,
        highPrice: t.highPrice,
        totalListings: Math.floor(Math.random() * 200) + 50,
        fetchedAt: daysAgo(1)
      },
      priceHistory: priceHist,
      lastChecked: daysAgo(1),
      analytics: {
        change1d: { amount: Math.round((Math.random() - 0.5) * 4 * 100) / 100, percent: Math.round((Math.random() - 0.5) * 6 * 100) / 100 },
        change7d: { amount: Math.round((Math.random() - 0.5) * 10 * 100) / 100, percent: Math.round((Math.random() - 0.5) * 15 * 100) / 100 },
        change30d: { amount: Math.round(change30d * 100) / 100, percent: changePct30d },
        volatility7d: Math.round(Math.random() * 3 * 100) / 100,
        spread: t.lowPrice && t.highPrice ? Math.round((t.lowPrice / t.highPrice) * 1000) / 1000 : 0,
        trend,
        signal,
        signalReason,
        lastComputed: daysAgo(0)
      },
      matchInfo: { method: 'url', confidence: 100, candidateCount: 1 },
      refreshState: { consecutiveErrors: 0, lastError: null, delisted: false, priority: t.marketPrice > 100 ? 'high' : 'normal' }
    };
  });

  return [...regularMapped, ...tcgMapped];
}

// ---------------------------------------------------------------------------
// Normal Sales: 12 sales
// ---------------------------------------------------------------------------

function normalSales() {
  const now = new Date().toISOString();
  const inv = normalInventory();

  // Helper to find item id by name prefix
  function findItem(prefix) {
    return inv.find(it => it.name.startsWith(prefix));
  }

  const salesDefs = [
    // Last 7 days sales (4)
    { item: findItem('PS5 Slim'), qty: 1, pricePerUnit: 599.99, platform: 'eBay', daysBack: 1, buyer: 'gamer2026' },
    { item: findItem('Charizard ex SAR'), qty: 1, pricePerUnit: 52.00, platform: 'TCGPlayer', daysBack: 2, buyer: 'collector101' },
    { item: findItem('Prismatic Evolutions'), qty: 2, pricePerUnit: 45.00, platform: 'eBay', daysBack: 3, buyer: 'pokefan99' },
    { item: findItem('Pikachu VMAX'), qty: 1, pricePerUnit: 30.00, platform: 'Mercari', daysBack: 5, buyer: 'pikachu_lover' },

    // Last 30 days sales (5)
    { item: findItem('Nintendo Switch'), qty: 1, pricePerUnit: 379.99, platform: 'eBay', daysBack: 12, buyer: 'switchfan' },
    { item: findItem('Stellar Crown'), qty: 2, pricePerUnit: 52.00, platform: 'TCGPlayer', daysBack: 15, buyer: 'tcg_store' },
    { item: findItem('Mew VMAX'), qty: 3, pricePerUnit: 5.50, platform: 'TCGPlayer', daysBack: 18, buyer: 'bulkseller' },
    { item: findItem('Umbreon VMAX'), qty: 1, pricePerUnit: 185.00, platform: 'eBay', daysBack: 20, buyer: 'umbreon_king' },
    { item: findItem('DualSense Edge'), qty: 1, pricePerUnit: 210.00, platform: 'Facebook', daysBack: 22, buyer: 'local_buyer1' },

    // Older sales (3)
    { item: findItem('Pokemon 151'), qty: 2, pricePerUnit: 55.00, platform: 'eBay', daysBack: 45, buyer: 'retro_collector' },
    { item: findItem('Charizard VSTAR'), qty: 2, pricePerUnit: 15.00, platform: 'Local', daysBack: 60, buyer: 'friend_joe' },
    { item: findItem('Pokemon TCG Battle'), qty: 3, pricePerUnit: 22.99, platform: 'Mercari', daysBack: 75, buyer: 'bargain_hunter' },
  ];

  return salesDefs.map((s, i) => {
    const id = `sale-norm-${String(i + 1).padStart(3, '0')}`;
    const grossRevenue = Math.round(s.qty * s.pricePerUnit * 100) / 100;
    const fees = makeFees(grossRevenue, s.platform);
    const netRevenue = Math.round((grossRevenue - fees.totalFees) * 100) / 100;
    const costBasis = Math.round(s.qty * (s.item ? s.item.costPerItem : 0) * 100) / 100;
    const profit = Math.round((netRevenue - costBasis) * 100) / 100;

    return {
      id,
      createdAt: daysAgo(s.daysBack),
      updatedAt: now,
      date: daysAgo(s.daysBack),
      inventoryItemId: s.item ? s.item.id : '',
      itemName: s.item ? s.item.name : 'Unknown Item',
      itemImage: null,
      retailer: s.item ? s.item.linkedRetailer : null,
      quantity: s.qty,
      pricePerUnit: s.pricePerUnit,
      grossRevenue,
      costBasis,
      costMethod: 'wavg',
      lotAllocations: s.item && s.item.lots.length > 0
        ? [{ lotId: s.item.lots[0].id, quantity: s.qty, costPerItem: s.item.costPerItem }]
        : [],
      fees,
      netRevenue,
      profit,
      platform: s.platform,
      buyer: s.buyer,
      notes: '',
      externalOrderId: '',
      status: 'completed',
      returnInfo: null
    };
  });
}

// ---------------------------------------------------------------------------
// Heavy / Extreme generators
// ---------------------------------------------------------------------------

function generateHeavy(invCount, salesCount) {
  invCount = invCount || 500;
  salesCount = salesCount || 50;
  const now = new Date().toISOString();
  const platforms = ['eBay', 'TCGPlayer', 'Mercari', 'Facebook', 'Local'];
  const retailers = ['walmart', 'target', 'pokecenter'];

  const items = [];
  for (let i = 0; i < invCount; i++) {
    const qty = 1 + Math.floor(Math.random() * 20);
    const cost = Math.round((1 + Math.random() * 199) * 100) / 100;
    const hasTcg = i < 100;
    const marketPrice = hasTcg ? Math.round((50 + Math.random() * 250) * 100) / 100 : null;
    const id = `inv-heavy-${String(i + 1).padStart(5, '0')}`;
    const daysBack = Math.floor(Math.random() * 90) + 1;

    items.push({
      id,
      name: `Item ${i + 1}`,
      image: '',
      category: hasTcg ? 'tcg_single' : 'general',
      quantity: qty,
      costPerItem: cost,
      lots: [makeLot(qty, cost, daysBack, 'manual')],
      costMethod: 'wavg',
      createdAt: daysAgo(daysBack),
      updatedAt: now,
      setName: hasTcg ? `Set ${(i % 10) + 1}` : '',
      sku: `HVY-${String(i + 1).padStart(5, '0')}`,
      condition: hasTcg ? 'NM' : 'sealed',
      language: 'EN',
      edition: '',
      isFoil: false,
      location: '',
      tags: [],
      linkedRetailer: retailers[i % retailers.length],
      linkedDrop: '',
      linkedItems: [],
      linkedOrderId: '',
      autoAdded: false,
      tcgplayerId: hasTcg ? String(100000 + i) : '',
      tcgplayerUrl: hasTcg ? `https://www.tcgplayer.com/product/${100000 + i}` : '',
      priceData: hasTcg
        ? { marketPrice, lowPrice: Math.round(marketPrice * 0.8 * 100) / 100, midPrice: Math.round(marketPrice * 0.9 * 100) / 100, highPrice: Math.round(marketPrice * 1.3 * 100) / 100, totalListings: 100, fetchedAt: daysAgo(1) }
        : { marketPrice: null, lowPrice: null, midPrice: null, highPrice: null, totalListings: null, fetchedAt: '' },
      priceHistory: hasTcg ? makePriceHistory(marketPrice, 7) : [],
      lastChecked: hasTcg ? daysAgo(1) : '',
      analytics: {
        change1d: { amount: 0, percent: 0 },
        change7d: { amount: 0, percent: 0 },
        change30d: { amount: 0, percent: 0 },
        volatility7d: 0, spread: 0, trend: 'flat', signal: null, signalReason: '', lastComputed: ''
      },
      matchInfo: { method: hasTcg ? 'url' : 'none', confidence: hasTcg ? 100 : 0, candidateCount: 0 },
      refreshState: { consecutiveErrors: 0, lastError: null, delisted: false, priority: 'normal' }
    });
  }

  const sales = [];
  for (let i = 0; i < salesCount; i++) {
    const itemIndex = Math.floor(Math.random() * invCount);
    const item = items[itemIndex];
    const qty = 1 + Math.floor(Math.random() * 3);
    const pricePerUnit = Math.round((item.costPerItem * (0.8 + Math.random() * 0.8)) * 100) / 100;
    const grossRevenue = Math.round(qty * pricePerUnit * 100) / 100;
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    const fees = makeFees(grossRevenue, platform);
    const netRevenue = Math.round((grossRevenue - fees.totalFees) * 100) / 100;
    const costBasis = Math.round(qty * item.costPerItem * 100) / 100;
    const profit = Math.round((netRevenue - costBasis) * 100) / 100;
    const daysBack = Math.floor(Math.random() * 90) + 1;

    sales.push({
      id: `sale-heavy-${String(i + 1).padStart(5, '0')}`,
      createdAt: daysAgo(daysBack),
      updatedAt: now,
      date: daysAgo(daysBack),
      inventoryItemId: item.id,
      itemName: item.name,
      itemImage: null,
      retailer: item.linkedRetailer,
      quantity: qty,
      pricePerUnit,
      grossRevenue,
      costBasis,
      costMethod: 'wavg',
      lotAllocations: item.lots.length > 0
        ? [{ lotId: item.lots[0].id, quantity: qty, costPerItem: item.costPerItem }]
        : [],
      fees,
      netRevenue,
      profit,
      platform,
      buyer: `buyer_${i + 1}`,
      notes: '',
      externalOrderId: '',
      status: 'completed',
      returnInfo: null
    });
  }

  return { inventory: items, sales };
}

function generateExtreme() {
  return generateHeavy(5000, 200);
}

// ---------------------------------------------------------------------------
// Precomputed expected values for normalInventory + normalSales
// ---------------------------------------------------------------------------

function computeExpected() {
  const inv = normalInventory();
  const sales = normalSales();

  const nonTcg = inv.filter(i => !i.tcgplayerId);
  const tcg = inv.filter(i => !!i.tcgplayerId);

  const totalInvested = Math.round(inv.reduce((sum, i) => sum + i.costPerItem * i.quantity, 0) * 100) / 100;
  const totalRevenue = Math.round(sales.reduce((sum, s) => sum + s.grossRevenue, 0) * 100) / 100;
  const totalProfit = Math.round(sales.reduce((sum, s) => sum + s.profit, 0) * 100) / 100;
  const ebayOnlySalesCount = sales.filter(s => s.platform === 'eBay').length;

  // Count sales within last 7 days
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const last7DaysSalesCount = sales.filter(s => new Date(s.date).getTime() >= sevenDaysAgoMs).length;

  return {
    inventoryItemCount: nonTcg.length,
    tcgItemCount: tcg.length,
    totalItems: inv.length,
    totalInvested,
    salesCount: sales.length,
    totalRevenue,
    totalProfit,
    ebayOnlySalesCount,
    last7DaysSalesCount
  };
}

const NORMAL_EXPECTED = computeExpected();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalInventory,
  normalSales,
  generateHeavy,
  generateExtreme,
  NORMAL_EXPECTED,
  daysAgo,
  daysAgoDate,
  uuid,
  makeFees,
  makeLot,
};
