// In-browser replacement for the SlabScout server, used by the GitHub Pages build.
// Card data is fetched straight from the public card APIs; the collection lives in this browser's localStorage.
(() => {
  const GRADES = ['Ungraded', 'PSA 10', 'PSA 9', 'PSA 8', 'PSA 7', 'BGS 10', 'BGS 9.5', 'BGS 9', 'BGS 8.5',
    'CGC 10', 'CGC 9.5', 'CGC 9', 'SGC 10', 'SGC 9.5', 'SGC 9', 'TAG 10'];
  const COMPANIES = { PSA: 'PSA', BGS: 'Beckett (BGS)', CGC: 'CGC', SGC: 'SGC', TAG: 'TAG', ACE: 'ACE', ANY: 'Any company' };
  const GAME_LABEL = { pokemon: 'Pokemon', magic: 'Magic', yugioh: 'Yu-Gi-Oh' };
  const GRADE_MULT = { 'Ungraded': [1, 0], 'PSA 10': [5, 28], 'PSA 9': [2.1, 14], 'PSA 8': [1.5, 9], 'PSA 7': [1.15, 6],
    'BGS 10': [9, 60], 'BGS 9.5': [3.4, 20], 'BGS 9': [1.8, 12], 'BGS 8.5': [1.4, 9], 'CGC 10': [4, 24], 'CGC 9.5': [2.6, 16],
    'CGC 9': [1.8, 11], 'SGC 10': [3.6, 22], 'SGC 9.5': [2.3, 14], 'SGC 9': [1.7, 10], 'TAG 10': [3.2, 20] };
  const TCGDEX = 'https://api.tcgdex.net/v2/en', EUR_USD = 1.08;
  const fnum = v => { const f = parseFloat(v); return f > 0 ? f : null; };
  const iso = d => d.toISOString().slice(0, 10);
  const round2 = v => Math.round(v * 100) / 100;
  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  const memo = new Map();
  const cached = (key, fn) => { if (!memo.has(key)) memo.set(key, fn().catch(e => { memo.delete(key); throw e; })); return memo.get(key); };
  async function getJson(url, okStatuses = []) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) { if (okStatuses.includes(r.status)) return null; throw new Error(`Card data source returned ${r.status}.`); }
    return r.json();
  }

  // ---- Pokémon (TCGdex)
  const pokemonYear = id => cached('pkset:' + id, async () => ((await getJson(`${TCGDEX}/sets/${encodeURIComponent(id)}`)).releaseDate || '').slice(0, 4)).catch(() => '');
  async function pokemonCard(c) {
    const pricing = c.pricing || {}, tcg = pricing.tcgplayer || {};
    const variants = Object.fromEntries(Object.entries(tcg).filter(([, v]) => v && typeof v === 'object'));
    let price = null, source = 'TCGplayer market';
    for (const k of ['holofoil', '1st-edition-holofoil', 'unlimited-holofoil', 'normal', 'reverse-holofoil', ...Object.keys(variants)]) {
      price = fnum(variants[k]?.marketPrice) || fnum(variants[k]?.midPrice);
      if (price) break;
    }
    if (!price) {
      const eur = fnum(pricing.cardmarket?.avg30) || fnum(pricing.cardmarket?.avg);
      if (eur) { price = round2(eur * EUR_USD); source = 'Cardmarket average, converted to USD (approx.)'; }
    }
    const s = c.set || {};
    return { id: 'pokemon:' + c.id, game: 'pokemon', name: c.name, set: s.name, setCode: s.id, number: c.localId,
      rarity: c.rarity, year: s.id ? await pokemonYear(s.id) : '',
      image: c.image ? c.image + '/low.webp' : null, imageLarge: c.image ? c.image + '/high.webp' : null, price, priceSource: source };
  }
  const pokemonFetch = id => cached('pk:' + id, async () => pokemonCard(await getJson(`${TCGDEX}/cards/${encodeURIComponent(id)}`)));
  async function searchPokemon(q) {
    let brief = await getJson(`${TCGDEX}/cards?name=${encodeURIComponent(q.trim())}`);
    brief = [...brief.filter(b => b.image), ...brief.filter(b => !b.image)].slice(0, 48);
    return (await Promise.all(brief.map(b => pokemonFetch(b.id).catch(() => null)))).filter(Boolean);
  }

  // ---- Magic (Scryfall)
  function magicCard(c) {
    const imgs = c.image_uris || c.card_faces?.[0]?.image_uris || {}, p = c.prices || {};
    return { id: 'magic:' + c.id, game: 'magic', name: c.name, set: c.set_name, setCode: (c.set || '').toUpperCase(),
      number: c.collector_number, rarity: c.rarity ? c.rarity[0].toUpperCase() + c.rarity.slice(1) : '', year: (c.released_at || '').slice(0, 4),
      image: imgs.small, imageLarge: imgs.normal, price: fnum(p.usd) || fnum(p.usd_foil) || fnum(p.usd_etched),
      priceSource: 'TCGplayer market (via Scryfall)' };
  }
  async function searchMagic(q) {
    const d = await getJson('https://api.scryfall.com/cards/search?' + new URLSearchParams({ q: q + ' game:paper', unique: 'prints', order: 'released' }), [404]);
    return d ? d.data.slice(0, 40).map(magicCard) : [];
  }

  // ---- Yu-Gi-Oh! (YGOPRODeck)
  function yugiohCards(c) {
    const img = c.card_images?.[0] || {}, fallback = fnum(c.card_prices?.[0]?.tcgplayer_price);
    return (c.card_sets || []).slice(0, 12).map(s => ({ id: `yugioh:${c.id}:${s.set_code || ''}`, game: 'yugioh', name: c.name,
      set: s.set_name, setCode: s.set_code || '', number: s.set_code || '', rarity: s.set_rarity, year: '',
      image: img.image_url_small, imageLarge: img.image_url, price: fnum(s.set_price) || fallback, priceSource: 'TCGplayer' }));
  }
  async function searchYugioh(q) {
    const d = await getJson('https://db.ygoprodeck.com/api/v7/cardinfo.php?' + new URLSearchParams({ fname: q, num: 12, offset: 0 }), [400]);
    return d ? d.data.flatMap(yugiohCards).slice(0, 40) : [];
  }

  const SEARCHERS = { pokemon: searchPokemon, magic: searchMagic, yugioh: searchYugioh };
  async function search(q, game) {
    const games = SEARCHERS[game] ? [game] : Object.keys(SEARCHERS), errors = [];
    const lists = await Promise.all(games.map(g => cached(`search:${g}:${q.toLowerCase()}`, () => SEARCHERS[g](q))
      .catch(e => { errors.push(`${GAME_LABEL[g]}: ${e.message}`); return []; })));
    return { cards: lists.flat(), errors };
  }
  function getCard(id) {
    const [game, ...rest] = id.split(':');
    return cached('card:' + id, async () => {
      if (game === 'pokemon') return pokemonFetch(rest.join(':'));
      if (game === 'magic') return magicCard(await getJson('https://api.scryfall.com/cards/' + encodeURIComponent(rest[0])));
      if (game === 'yugioh') {
        const prints = yugiohCards((await getJson('https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + encodeURIComponent(rest[0]))).data[0]);
        return prints.find(p => p.setCode === rest[1]) || prints[0] || null;
      }
      return null;
    });
  }

  // ---- sample comps (same model as the server; not real sales)
  function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  }
  const ebayUrl = (card, grade) => 'https://www.ebay.com/sch/i.html?' + new URLSearchParams({
    _nkw: [card.name, card.set, card.number].filter(Boolean).join(' ') + (grade && grade !== 'Ungraded' ? ' ' + grade : ''), LH_Sold: 1, LH_Complete: 1 });
  function demoSales(card) {
    if (!card.price) return [];
    const r = rng(card.id), uni = (a, b) => a + r() * (b - a), int = (a, b) => Math.floor(uni(a, b + 1));
    const trend = [1]; for (let i = 0; i < 13; i++) trend.push(trend[i] * (1 + uni(-0.08, 0.07)));
    const label = [card.year, GAME_LABEL[card.game], card.set, card.name, card.number && '#' + card.number].filter(Boolean).join(' ');
    const out = [], now = Date.now();
    for (const [grade, [mult, floor]] of Object.entries(GRADE_MULT)) {
      const n = grade === 'Ungraded' ? 42 : grade.startsWith('PSA') ? int(14, 26) : int(4, 14);
      for (let i = 0; i < n; i++) {
        const ago = int(1, 365), price = (card.price * mult + floor) * trend[Math.floor(ago / 30)] * uni(0.86, 1.16);
        const suffix = grade === 'Ungraded' ? ['NM', 'Near Mint', 'LP', 'Raw'][int(0, 3)] : grade;
        out.push({ date: iso(new Date(now - ago * 864e5)), title: `${label} ${suffix}`, price: round2(Math.max(price, 0.25)), grade, url: ebayUrl(card, grade), source: 'sample' });
      }
    }
    return out;
  }
  function market(card) {
    const sales = demoSales(card).sort((a, b) => b.date.localeCompare(a.date));
    const cutoff = iso(new Date(Date.now() - 90 * 864e5)), byGrade = {}, months = {};
    for (const s of sales) { (byGrade[s.grade] ||= []).push(s); ((months[s.date.slice(0, 7)] ||= {})[s.grade] ||= []).push(s.price); }
    const values = {};
    for (const [g, rows] of Object.entries(byGrade)) {
      let recent = rows.filter(x => x.date >= cutoff).map(x => x.price); if (!recent.length) recent = rows.slice(0, 5).map(x => x.price);
      const [company, num] = g.split(' ');
      values[g] = { value: round2(median(recent)), count: rows.length, company: num ? company : '', grade: fnum(num),
        lastSold: { price: rows[0].price, date: rows[0].date, url: rows[0].url } };
    }
    if (card.price) values.Ungraded = { ...(values.Ungraded || { company: '', grade: null, lastSold: null }), value: card.price, count: (byGrade.Ungraded || []).length };
    const history = Object.keys(months).sort().slice(-13).map(m => ({ month: m, ...Object.fromEntries(Object.entries(months[m]).map(([g, p]) => [g, round2(median(p))])) }));
    return { sales, values, history, salesSource: 'sample', valueSource: 'sample', priceGuideMatch: null, salesError: null, ebayUrl: ebayUrl(card) };
  }
  const valueFor = (card, grade) => market(card).values[grade]?.value ?? card.price;

  // ---- collection (this browser only)
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  async function collectionView() {
    const items = load('ss_items', []);
    await Promise.all(items.map(async it => { try { const fresh = await getCard(it.card.id); if (fresh) it.card = fresh; } catch { /* keep the saved copy */ } }));
    save('ss_items', items);
    return items.map(it => ({ ...it, value: valueFor(it.card, it.grade) }));
  }
  function snapshot(items) {
    const hist = load('ss_history', {});
    if (items.length || Object.keys(hist).length) {
      hist[iso(new Date())] = { value: round2(items.reduce((s, i) => s + (i.value || 0) * i.qty, 0)),
        cost: round2(items.reduce((s, i) => s + (i.paid != null ? i.paid * i.qty : 0), 0)), cards: items.reduce((s, i) => s + i.qty, 0) };
      save('ss_history', hist);
    }
    return Object.keys(hist).sort().map(d => ({ date: d, ...hist[d] }));
  }

  window.LOCAL_API = async (path, opts = {}) => {
    const u = new URL(path, location.origin), q = u.searchParams, method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.pathname === '/api/status') return { scan: false, ebay: false, priceGuide: false, email: false, static: true };
    if (u.pathname === '/api/me') return { user: { id: 0, name: 'This device', email: '' } };
    if (u.pathname === '/api/search') return (q.get('q') || '').trim().length < 2 ? { cards: [], errors: [] } : search(q.get('q').trim(), q.get('game') || 'all');
    if (u.pathname === '/api/card') {
      const card = await getCard(q.get('id') || '');
      if (!card) throw new Error('Card not found.');
      return { card, grades: GRADES, companies: COMPANIES, ...market(card) };
    }
    if (u.pathname === '/api/collection') {
      if (method === 'POST') {
        const card = await getCard(body.cardId || '');
        if (!card) throw new Error('Card not found.');
        const item = { entryId: Math.random().toString(36).slice(2, 12), card, grade: GRADES.includes(body.grade) ? body.grade : 'Ungraded',
          qty: Math.max(1, parseInt(body.qty) || 1), paid: fnum(body.paid), added: new Date().toISOString().slice(0, 19) };
        save('ss_items', [...load('ss_items', []), item]);
        const hist = snapshot(await collectionView());
        return { ok: true, item, total: hist.length ? hist[hist.length - 1].value : null };
      }
      if (method === 'DELETE') { save('ss_items', load('ss_items', []).filter(i => i.entryId !== q.get('entry'))); snapshot(await collectionView()); return { ok: true }; }
      const items = await collectionView();
      return { items, history: snapshot(items) };
    }
    throw new Error('Not available in this version.');
  };
})();
