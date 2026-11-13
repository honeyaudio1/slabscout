const app = document.getElementById('app');
const GAME = { pokemon: 'Pokémon', magic: 'Magic', yugioh: 'Yu-Gi-Oh!' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = v => (v >= 0 ? '+' : '−') + money(Math.abs(v));
const gradeTag = g => `<span class="tag ${esc(g.split(' ')[0])}">${esc(g)}</span>`;
const cardHref = c => '#/card/' + encodeURIComponent(c.id);
let stream = null, me = null, afterSignIn = null;

function drawAccount() {
  const el = document.getElementById('acct');
  el.innerHTML = me ? `<span class="who" title="${esc(me.email)}">${esc(me.name)}</span><button class="btn small" id="outBtn">Sign out</button>`
    : '<a class="btn primary" href="#/signin">Sign in</a>';
  const out = document.getElementById('outBtn');
  if (out) out.onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); me = null; drawAccount(); location.hash = '#/'; route(); };
}
const signInPrompt = (title, text) => `<section class="vault" style="text-align:center;padding:56px 24px"><div style="font-size:54px">🔐</div>
  <h1>${title}</h1><p class="muted">${text}</p>
  <p><a class="btn primary" href="#/signin">Sign in</a> <a class="btn" href="#/signup">Create an account</a></p></section>`;

function forgotPage() {
  app.innerHTML = `<section class="vault authbox"><h1>Reset your <span class="grad">password</span></h1>
    <p class="muted">Enter your account email and we'll send a link to choose a new password.</p>
    <form id="authForm"><label>Email<input name="email" type="email" autocomplete="email" required></label>
      <button class="btn primary">Send reset link</button></form>
    <p class="muted"><a href="#/signin">Back to sign in</a></p></section>`;
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = new FormData(e.target).get('email');
    const [s] = await Promise.all([api('/api/status').catch(() => ({})), api('/api/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }).catch(() => {})]);
    app.querySelector('.authbox').innerHTML = `<div style="font-size:48px">📬</div><h1>Check your <span class="grad">email</span></h1>
      <p class="muted">If an account exists for ${esc(email)}, a reset link is on its way. It works for one hour.</p>
      ${s.email ? '' : '<div class="notice">Email sending is not set up on this server yet, so the link was saved to <code>data/password-reset-links.txt</code> instead.</div>'}
      <p><a class="btn" href="#/signin">Back to sign in</a></p>`;
  };
}

function resetPage(token) {
  app.innerHTML = `<section class="vault authbox"><h1>Choose a new <span class="grad">password</span></h1>
    <form id="authForm"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="8" required><small class="muted">At least 8 characters.</small></label>
      <div class="error" id="authErr"></div><button class="btn primary">Save password</button></form>
    <p class="muted"><a href="#/forgot">Request a new link</a></p></section>`;
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    try {
      me = (await api('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: new FormData(e.target).get('password') }) })).user;
      drawAccount(); toast('✅ Password updated. You are signed in.'); location.hash = '#/collection';
    } catch (err) { document.getElementById('authErr').textContent = err.message; }
  };
}

function signInPage(mode) {
  if (me) { location.hash = '#/collection'; return; }
  const up = mode === 'signup';
  app.innerHTML = `<section class="vault authbox">
    <h1>${up ? 'Create your <span class="grad">account</span>' : 'Welcome <span class="grad">back</span>'}</h1>
    <p class="muted">${up ? 'Your collection and its growth chart are saved to your account.' : 'Sign in to see your collection.'}</p>
    <form id="authForm">
      ${up ? '<label>Name<input name="name" autocomplete="name" maxlength="60" placeholder="What should we call you?"></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="${up ? 8 : 1}" required>${up ? '<small class="muted">At least 8 characters.</small>' : ''}</label>
      <div class="error" id="authErr"></div>
      <button class="btn primary">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="muted">${up ? 'Already have an account? <a href="#/signin">Sign in</a>' : 'New here? <a href="#/signup">Create an account</a> · <a href="#/forgot">Forgot password?</a>'}</p></section>`;
  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      me = (await api(up ? '/api/signup' : '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })).user;
      drawAccount(); toast(`👋 ${up ? 'Welcome' : 'Welcome back'}, ${esc(me.name)}!`);
      const next = afterSignIn || '#/collection'; afterSignIn = null;
      if (location.hash === next) route(); else location.hash = next;
    } catch (err) { document.getElementById('authErr').textContent = err.message; }
  };
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ error: 'Bad response from server.' }));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed.'), j);
  return j;
}
const loading = msg => { app.innerHTML = `<div class="spinner">${esc(msg)}</div>`; };
const fail = e => { app.innerHTML = `<div class="panel error">${esc(e.message)}</div>`; };
function toast(html) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = Object.assign(document.createElement('div'), { className: 'toast', innerHTML: html });
  document.body.append(t); setTimeout(() => t.remove(), 3800);
}
function countUp(el, to, fmt = money) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 1100;
  const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
const cmp = (get, dir) => (a, b) => {
  const x = get(a), y = get(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
};

// Sortable table: cols = [{key, label, right, get, html}]
function sortable(host, cols, rows, state, opts = {}) {
  const draw = () => {
    const col = cols.find(c => c.key === state.key);
    const sorted = col ? [...rows].sort(cmp(col.get, state.dir)) : [...rows];
    const shown = opts.limit ? sorted.slice(0, state.limit || opts.limit) : sorted;
    host.innerHTML = `<div class="tablewrap"><table><thead><tr>${cols.map(c =>
      `<th class="${c.right ? 'right' : ''}" ${c.get ? `data-sort="${c.key}"` : ''}>${esc(c.label)}${state.key === c.key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(r => `<tr>${cols.map(c =>
      `<td class="${c.right ? 'right ' : ''}${c.cls || ''}">${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}" class="muted">Nothing to show.</td></tr>`}</tbody></table></div>
      ${opts.limit && sorted.length > shown.length ? `<p><button class="btn" data-more>Show more (${sorted.length - shown.length} more)</button></p>` : ''}`;
    host.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => {
      if (state.key === th.dataset.sort) state.dir *= -1; else { state.key = th.dataset.sort; state.dir = 1; }
      draw();
    });
    const more = host.querySelector('[data-more]');
    if (more) more.onclick = () => { state.limit = (state.limit || opts.limit) + 50; draw(); };
  };
  draw();
}

// Sortable grid of card tiles. sorts = [[label, compareFn]]; tile(item) returns inner html for extra lines.
function cardGrid(host, items, sorts, o = {}) {
  let sortIdx = 0, limit = o.limit || 60;
  const card = o.card || (x => x);
  const draw = () => {
    const sorted = sorts[sortIdx][1] ? [...items].sort(sorts[sortIdx][1]) : items;
    host.innerHTML = `<div class="row between" style="margin-bottom:14px"><span class="muted">${items.length} ${items.length === 1 ? 'card' : 'cards'}</span>
      <label class="muted">Sort <select>${sorts.map((s, i) => `<option value="${i}" ${i === sortIdx ? 'selected' : ''}>${esc(s[0])}</option>`).join('')}</select></label></div>
      <div class="grid">${sorted.slice(0, limit).map((it, i) => { const c = card(it); return `<a class="ccard" href="${cardHref(c)}" style="animation:rise .4s ${Math.min(i, 20) * 25}ms ease both">
        ${o.badge ? `<span class="badge">${o.badge(it)}</span>` : ''}
        ${o.remove ? `<button class="btn small rm" data-del="${esc(it.entryId)}">Remove</button>` : ''}
        <div class="art">${c.image ? `<img loading="lazy" src="${esc(c.image)}" alt="">` : '<span class="muted">No image</span>'}</div>
        <div class="nm">${esc(c.name)}</div>
        <div class="st">${esc([c.set, c.number && '#' + c.number].filter(Boolean).join(' · '))}</div>
        ${o.tile ? o.tile(it) : `<div class="pr">${money(c.price)}</div>`}</a>`; }).join('')}</div>
      ${sorted.length > limit ? `<p style="text-align:center;margin-top:18px"><button class="btn" data-more>Show more</button></p>` : ''}`;
    host.querySelector('select').onchange = e => { sortIdx = +e.target.value; draw(); };
    const more = host.querySelector('[data-more]');
    if (more) more.onclick = () => { limit += 60; draw(); };
    if (o.remove) host.querySelectorAll('[data-del]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); o.remove(b.dataset.del); });
  };
  draw();
}
const searchSorts = [
  ['Price: high to low', cmp(c => c.price, -1)], ['Price: low to high', cmp(c => c.price, 1)],
  ['Name: A to Z', cmp(c => c.name, 1)], ['Set', cmp(c => c.set, 1)], ['Newest first', cmp(c => c.year || null, -1)], ['Oldest first', cmp(c => c.year || null, 1)],
];

// Collection growth chart: points = [{date, value, cost}]
function growthChart(host, points) {
  if (points.length < 2) {
    host.innerHTML = `<div class="empty-chart"><div class="pulse"></div><b style="color:var(--ink)">Tracking started${points[0] ? ' on ' + esc(points[0].date) : ''}.</b><br>
      Your collection value is recorded every day the app runs, and the growth chart draws itself from there.</div>`;
    return;
  }
  const W = 1000, H = 300, L = 8, R = 8, T = 16, B = 30;
  const showCost = points.some(p => p.cost > 0);
  const ys = points.flatMap(p => showCost ? [p.value, p.cost] : [p.value]);
  let lo = Math.min(...ys), hi = Math.max(...ys); const pad = (hi - lo || hi || 1) * 0.15; lo = Math.max(0, lo - pad); hi += pad;
  const t = p => new Date(p.date + 'T00:00:00').getTime(), t0 = t(points[0]), t1 = t(points[points.length - 1]);
  const x = p => L + (W - L - R) * (t(p) - t0) / (t1 - t0), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const line = points.map(p => `${x(p).toFixed(1)},${y(p.value).toFixed(1)}`).join(' L');
  const upTrend = points[points.length - 1].value >= points[0].value, col = upTrend ? 'var(--up)' : 'var(--down)';
  let grid = '';
  for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3; grid += `<line class="gridl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L + 4}" y="${y(v) - 5}">${money(v).replace(/\.\d\d$/, '')}</text>`; }
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Collection value over time">
    <defs><linearGradient id="gfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${upTrend ? '#2ee6a6' : '#ff6b7a'}" stop-opacity=".38"/><stop offset="1" stop-color="${upTrend ? '#2ee6a6' : '#ff6b7a'}" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="M${line} L${x(points[points.length - 1])},${H - B} L${x(points[0])},${H - B} Z" fill="url(#gfill)"/>
    ${showCost ? `<path d="M${points.map(p => `${x(p).toFixed(1)},${y(p.cost).toFixed(1)}`).join(' L')}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="6 6"/>` : ''}
    <path d="M${line}" fill="none" stroke="${col}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 8px ${col})"/>
    <text x="${L}" y="${H - 8}">${esc(points[0].date)}</text><text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(points[points.length - 1].date)}</text>
    <line id="gx" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 4" visibility="hidden"/>
    <circle id="gdot" r="7" fill="${col}" stroke="#090b14" stroke-width="3" visibility="hidden"/>
    <circle cx="${x(points[points.length - 1])}" cy="${y(points[points.length - 1].value)}" r="5" fill="${col}"/>
    </svg><div class="tip" hidden></div>
    ${showCost ? '<div class="legend" style="margin-top:8px"><span><i style="background:' + col + '"></i>Collection value</span><span><i style="background:var(--muted)"></i>Cost basis (dashed)</span></div>' : ''}`;
  const svg = host.querySelector('svg'), tip = host.querySelector('.tip'), gx = host.querySelector('#gx'), dot = host.querySelector('#gdot');
  svg.onmousemove = e => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width * W;
    const p = points.reduce((a, b) => Math.abs(x(b) - mx) < Math.abs(x(a) - mx) ? b : a);
    gx.setAttribute('x1', x(p)); gx.setAttribute('x2', x(p)); dot.setAttribute('cx', x(p)); dot.setAttribute('cy', y(p.value));
    gx.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = (x(p) / W * r.width) + 'px'; tip.style.top = (y(p.value) / H * r.height) + 'px';
    tip.innerHTML = `<b>${money(p.value)}</b>${esc(p.date)} · ${p.cards} cards${showCost ? `<br><span class="muted">Cost ${money(p.cost)}</span>` : ''}`;
  };
  svg.onmouseleave = () => { tip.hidden = true; gx.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); };
}

// ------------------------------------------------------------------ pages

async function home() {
  const picks = ['Charizard', 'Pikachu', 'Umbreon', 'Black Lotus', 'Blue-Eyes White Dragon', 'Mewtwo', 'Rayquaza'];
  app.innerHTML = `<section class="hero">
    <h1>What's your collection<br><span class="grad">really worth?</span></h1>
    <p>Look up any Pokémon, Magic or Yu-Gi-Oh! card, compare raw and graded values, or point your camera at a card and let it identify itself.</p>
    <div class="chips">${picks.map(p => `<a class="chip" href="#/search/all/${encodeURIComponent(p)}">${esc(p)}</a>`).join('')}</div></section>
    <div id="mini"></div>
    <div class="features">
      <div class="panel"><span class="ico">📸</span><b>Scan a card</b><span class="muted">Snap a photo and get the card, set and number identified for you.</span><p><a class="btn primary" href="#/scan">Open scanner</a></p></div>
      <div class="panel"><span class="ico">💎</span><b>Raw vs graded</b><span class="muted">PSA, Beckett, CGC, SGC and TAG values side by side, with the multiple over raw.</span></div>
      <div class="panel"><span class="ico">📈</span><b>Watch it grow</b><span class="muted">Track every card you own and see your collection's value charted over time.</span><p><a class="btn" href="#/collection">My collection</a></p></div>
    </div>`;
  if (!me) return;
  try {
    const { items } = await api('/api/collection');
    const mini = document.getElementById('mini');
    if (!items.length || !mini) return;
    const total = items.reduce((s, i) => s + (i.value || 0) * i.qty, 0);
    const best = [...items].sort(cmp(i => i.value, -1)).filter(i => i.card.image).slice(0, 10);
    mini.innerHTML = `<section class="vault" style="margin-top:34px"><div class="row between"><div><div class="eyebrow">Your collection</div><div class="bignum" id="miniTotal">$0.00</div></div>
      <a class="btn primary" href="#/collection">Open collection →</a></div>
      <div class="strip">${best.map(i => `<a href="${cardHref(i.card)}" title="${esc(i.card.name)}"><img src="${esc(i.card.image)}" alt="${esc(i.card.name)}"></a>`).join('')}</div></section>`;
    countUp(document.getElementById('miniTotal'), total);
  } catch (e) { /* home still works without the collection summary */ }
}

async function searchPage(game, q) {
  document.getElementById('q').value = q;
  document.getElementById('gameSel').value = game;
  loading(`Searching for “${q}”…`);
  try {
    const { cards, errors } = await api(`/api/search?game=${encodeURIComponent(game)}&q=${encodeURIComponent(q)}`);
    app.innerHTML = `<h1>Results for <span class="grad">“${esc(q)}”</span></h1>
      ${errors.length ? `<div class="notice">Some sources did not respond: ${esc(errors.join('; '))}</div>` : ''}
      ${cards.length ? '<div id="g" style="margin-top:16px"></div>' : '<div class="panel muted" style="margin-top:16px">No cards found. Try a shorter name.</div>'}`;
    if (cards.length) cardGrid(app.querySelector('#g'), cards, searchSorts, { badge: c => `<span class="tag">${esc(GAME[c.game])}</span>` });
  } catch (e) { fail(e); }
}

function chart(history) {
  const series = [['Ungraded', 'var(--c1)'], ['PSA 9', 'var(--c2)'], ['PSA 10', 'var(--c3)']].filter(([g]) => history.some(h => h[g] != null));
  if (history.length < 2 || !series.length) return '<p class="muted">No sales history to chart for this card yet.</p>';
  const W = 760, H = 250, L = 56, R = 12, T = 10, B = 26;
  const max = Math.max(...history.flatMap(h => series.map(([g]) => h[g] || 0))) * 1.08;
  const x = i => L + i * (W - L - R) / (history.length - 1), y = v => T + (H - T - B) * (1 - v / max);
  let s = '';
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">$${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)}</text>`;
  }
  history.forEach((h, i) => { if (i % 2 === 0) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${h.month.slice(5)}/${h.month.slice(2, 4)}</text>`; });
  for (const [g, color] of series) {
    const pts = history.map((h, i) => h[g] != null ? [x(i), y(h[g]), h] : null).filter(Boolean);
    s += `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" points="${pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}"/>`;
    s += pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${color}"><title>${g} · ${p[2].month} · ${money(p[2][g])}</title></circle>`).join('');
  }
  return `<div class="legend">${series.map(([g, c]) => `<span><i style="background:${c}"></i>${g}</span>`).join('')}</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly median sold price by grade">${s}</svg>`;
}

async function cardPage(id) {
  loading('Loading card…');
  try {
    const d = await api('/api/card?id=' + encodeURIComponent(id));
    const c = d.card, raw = d.values.Ungraded?.value;
    const order = d.grades.filter(g => d.values[g]).concat(Object.keys(d.values).filter(g => !d.grades.includes(g)).sort());
    const sample = d.salesSource === 'sample', pg = d.priceGuideMatch;
    const comps = [...new Set(order.map(g => d.values[g].company).filter(Boolean))];
    const coName = co => d.companies[co] || co;
    const top = order.filter(g => g === 'Ungraded').concat(comps.map(co =>
      order.filter(g => d.values[g].company === co).sort((a, b) => d.values[b].grade - d.values[a].grade || a.length - b.length)[0]));
    const last = v => v.lastSold ? `Last sold ${money(v.lastSold.price)} · ${esc(v.lastSold.date)}` : '';
    app.innerHTML = `<div class="card-head">
      <div class="tilt">${c.imageLarge ? `<img src="${esc(c.imageLarge)}" alt="${esc(c.name)}">` : ''}</div>
      <div>
        <span class="tag">${esc(GAME[c.game])}</span>
        <h1 style="margin-top:8px">${esc(c.name)}${c.number ? ` <span class="muted">#${esc(c.number)}</span>` : ''}</h1>
        <div class="muted">${[c.set, c.setCode, c.rarity, c.year].filter(Boolean).map(esc).join(' · ')}</div>
        ${raw == null ? '<div class="notice">No market price is available for this printing.</div>' : ''}
        <div class="tiles">${top.map(g => { const v = d.values[g]; return `<div class="tile ${g === 'Ungraded' ? 'main' : ''}">
          <div class="k">${esc(g)}</div><div class="v">${money(v.value)}</div>
          <div class="s">${g === 'Ungraded' ? esc(c.priceSource || '') : raw ? (v.value / raw).toFixed(1) + '× ungraded' : ''}</div><div class="s">${last(v)}</div></div>`; }).join('')}</div>
        ${sample && raw != null ? `<div class="notice"><b>Graded values and sold listings below are sample estimates</b>, modelled from the real ungraded market price. Connect a price source to replace them. <a href="${esc(d.ebayUrl)}" target="_blank" rel="noopener">See real sold listings on eBay ↗</a></div>` : ''}
        ${pg ? `<div class="notice">Values are from PriceCharting, matched to <a href="${esc(pg.url)}" target="_blank" rel="noopener">${esc(pg.name)} · ${esc(pg.set)}</a>${pg.volume ? ` (${esc(pg.volume)} sales a year)` : ''}. Check that this is the right card. ${d.salesSource === 'none' ? `Individual sold listings are not part of this data. <a href="${esc(d.ebayUrl)}" target="_blank" rel="noopener">See sold listings on eBay ↗</a>` : ''}</div>` : ''}
        ${d.salesError ? `<div class="notice">${esc(d.salesError)}</div>` : ''}
        <form class="row panel" id="addForm">
          <b>Add to collection</b>
          <select name="grade">${d.grades.map(g => `<option>${esc(g)}</option>`).join('')}</select>
          <label>Qty <input type="number" name="qty" value="1" min="1"></label>
          <label>Paid $ <input type="number" name="paid" min="0" step="0.01" placeholder="each"></label>
          <button class="btn primary">＋ Add</button>
        </form>
      </div></div>
      ${comps.length ? `<h2>Graded values by company <small>· ${pg ? 'current PriceCharting values' : 'value is the median of the last 90 days'}</small></h2>
      <div class="chips" id="coChips" style="margin-bottom:12px"></div><div id="gradeTable"></div>` : ''}
      <h2>Price history <small>· monthly median sold price</small></h2>
      <div class="panel">${chart(d.history)}</div>
      <h2>Sold listings <small>· ${d.sales.length} ${sample ? 'sample comps' : 'eBay sales'}</small></h2>
      <div class="chips" id="gradeChips" style="margin-bottom:12px"></div><div id="sales"></div>`;

    const img = app.querySelector('.tilt img');
    if (img) {
      const box = img.parentElement;
      box.onmousemove = e => { const r = box.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
        img.style.transform = `rotateY(${px * 16}deg) rotateX(${-py * 16}deg) scale(1.03)`; };
      box.onmouseleave = () => { img.style.transform = ''; };
    }
    app.querySelector('#addForm').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (!me) { afterSignIn = location.hash; toast('Sign in to save cards to your collection · <a href="#/signin">Sign in</a>'); return; }
      try {
        const r = await api('/api/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardId: c.id, grade: f.get('grade'), qty: f.get('qty'), paid: f.get('paid') }) });
        toast(`🎉 Added ${esc(c.name)}! ${r.total != null ? `Collection now worth <span class="grad">${money(r.total)}</span>` : ''} · <a href="#/collection">View</a>`);
      } catch (err) { toast(esc(err.message)); }
    };

    const state = { key: 'date', dir: -1 }, salesCols = [
      { key: 'date', label: 'Sold', get: s => s.date, cls: 'nowrap' },
      { key: 'title', label: 'Listing', get: s => s.title, html: s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` },
      { key: 'grade', label: 'Grade', get: s => s.grade, html: s => gradeTag(s.grade) },
      { key: 'price', label: 'Price', right: true, cls: 'price', get: s => s.price, html: s => money(s.price) },
    ];
    let filter = 'All';
    const inCo = (grade, f) => f === 'All' || (f === 'Ungraded' ? grade === 'Ungraded' : grade.startsWith(f + ' '));
    const chips = app.querySelector('#gradeChips');
    const drawSales = () => {
      chips.innerHTML = ['All', 'Ungraded', ...comps.filter(c2 => c2 !== 'ANY')].map(g => `<button class="chip ${g === filter ? 'on' : ''}" data-f="${esc(g)}">${esc(g === 'All' || g === 'Ungraded' ? g : coName(g))}</button>`).join('');
      chips.querySelectorAll('button').forEach(b => b.onclick = () => { filter = b.dataset.f; state.limit = 0; drawSales(); });
      sortable(app.querySelector('#sales'), salesCols, d.sales.filter(s => inCo(s.grade, filter)), state, { limit: 25 });
    };
    if (comps.length) {
      const gState = { key: 'value', dir: -1 }, rows = order.filter(g => g !== 'Ungraded').map(g => ({ g, ...d.values[g] }));
      const gCols = [
        { key: 'company', label: 'Company', get: r => coName(r.company) },
        { key: 'grade', label: 'Grade', get: r => r.grade, html: r => gradeTag(r.g) },
        { key: 'value', label: 'Value', right: true, cls: 'price', get: r => r.value, html: r => money(r.value) },
        { key: 'mult', label: '× Ungraded', right: true, get: r => raw ? r.value / raw : null, html: r => raw ? (r.value / raw).toFixed(1) + '×' : '—' },
        { key: 'last', label: 'Last sold', right: true, cls: 'price', get: r => r.lastSold?.price, html: r => r.lastSold ? `<a href="${esc(r.lastSold.url)}" target="_blank" rel="noopener">${money(r.lastSold.price)}</a>` : '—' },
        { key: 'date', label: 'Sold on', get: r => r.lastSold?.date, cls: 'nowrap' },
        { key: 'count', label: 'Sales', right: true, get: r => r.count, html: r => r.count ?? '—' },
      ];
      let co = 'All';
      const coChips = app.querySelector('#coChips');
      const drawGrades = () => {
        coChips.innerHTML = ['All', ...comps].map(c2 => `<button class="chip ${c2 === co ? 'on' : ''}" data-f="${esc(c2)}">${esc(c2 === 'All' ? c2 : coName(c2))}</button>`).join('');
        coChips.querySelectorAll('button').forEach(b => b.onclick = () => { co = b.dataset.f; drawGrades(); });
        sortable(app.querySelector('#gradeTable'), gCols, rows.filter(r => co === 'All' || r.company === co), gState);
      };
      drawGrades();
    }
    drawSales();
  } catch (e) { fail(e); }
}

function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

function scanPage() {
  app.innerHTML = `<h1>Scan a <span class="grad">card</span></h1><p class="muted">Photograph the front of one card, filling the frame. Slabbed cards work too — the grade is read from the label.</p>
    <div id="keyNote">${me ? '' : '<div class="notice">Scanning needs an account. <a href="#/signin">Sign in</a> or <a href="#/signup">create one</a>.</div>'}</div>
    <div class="scanbox">
      <div class="panel">
        <div class="viewfinder" id="vf"><span class="muted" id="vfHint">📸 Camera or photo goes here</span><video id="cam" playsinline muted hidden></video><img id="preview" hidden alt="Your photo"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="camBtn">Use camera</button>
          <button class="btn primary" id="snapBtn" hidden>Capture</button>
          <label class="btn">Upload photo<input id="file" type="file" accept="image/*" capture="environment" hidden></label>
        </div>
      </div>
      <div id="result" class="panel"><span class="muted">Your result will appear here.</span></div>
    </div><div id="matches"></div>`;
  if (!me) afterSignIn = '#/scan';
  api('/api/status').then(s => { const n = document.getElementById('keyNote'); if (me && !s.scan && n) n.innerHTML =
    '<div class="notice">Scanning is not set up yet: add <code>ANTHROPIC_API_KEY=…</code> to the <code>.env</code> file next to <code>server.py</code> and restart the server.</div>'; }).catch(() => {});
  const cam = document.getElementById('cam'), preview = document.getElementById('preview'), snap = document.getElementById('snapBtn'),
    result = document.getElementById('result'), vf = document.getElementById('vf'), hint = document.getElementById('vfHint');

  const toDataUrl = src => { // downscale to keep uploads small
    const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight, k = Math.min(1, 1568 / Math.max(w, h));
    const cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.88);
  };
  const identify = async dataUrl => {
    preview.src = dataUrl; preview.hidden = false; cam.hidden = true; snap.hidden = true; hint.hidden = true; stopCamera();
    vf.classList.add('busy');
    result.innerHTML = '<span class="muted">Identifying card…</span>'; document.getElementById('matches').innerHTML = '';
    try {
      const d = await api('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) });
      const i = d.identified;
      if (!i.is_card) { result.innerHTML = '<b>No trading card found in this photo.</b><p class="muted">Try again with the card filling the frame.</p>'; return; }
      result.innerHTML = `<span class="tag">${esc(GAME[i.game] || 'Other')}</span> <span class="tag">${esc(i.confidence)} confidence</span>
        <h2 style="margin-top:12px">${esc(i.name)}</h2>
        <div>${[i.set, i.number && '#' + i.number, i.year, i.grade].filter(Boolean).map(esc).join(' · ')}</div>
        <p class="muted">${esc(i.notes)}</p>
        ${d.matches.length ? '' : `<p>No matching listing found. <a href="#/search/all/${encodeURIComponent(i.name)}">Search for “${esc(i.name)}”</a></p>`}`;
      if (d.matches.length) {
        document.getElementById('matches').innerHTML = `<h2>${d.exact ? 'Found it' : 'Possible matches'}</h2><div id="mt"></div>`;
        cardGrid(document.getElementById('mt'), d.matches, [['Best match', null], ...searchSorts], { badge: c => `<span class="tag">${esc(GAME[c.game])}</span>` });
      }
    } catch (e) { result.innerHTML = `<span class="error">${esc(e.message)}</span>`; }
    finally { vf.classList.remove('busy'); }
  };
  document.getElementById('camBtn').onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } });
      cam.srcObject = stream; cam.hidden = false; preview.hidden = true; snap.hidden = false; hint.hidden = true; await cam.play();
    } catch (e) { result.innerHTML = '<span class="error">Camera unavailable. Upload a photo instead.</span>'; }
  };
  snap.onclick = () => identify(toDataUrl(cam));
  document.getElementById('file').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image(); img.onload = () => { identify(toDataUrl(img)); URL.revokeObjectURL(img.src); }; img.src = URL.createObjectURL(f);
  };
}

async function collectionPage() {
  if (!me) { afterSignIn = '#/collection'; app.innerHTML = signInPrompt('Sign in to open your <span class="grad">collection</span>', 'Your cards, their value and your growth chart are saved to your account.'); return; }
  loading('Opening your collection…');
  try {
    const { items, history } = await api('/api/collection');
    if (!items.length) {
      app.innerHTML = `<section class="vault" style="text-align:center;padding:56px 24px"><div style="font-size:54px">🗃️</div>
        <h1>Your collection <span class="grad">starts here</span></h1><p class="muted">Search or scan a card, then tap “Add”. Its value is tracked from day one.</p>
        <p><a class="btn primary" href="#/scan">Scan a card</a> <a class="btn" href="#/search/all/Charizard">Browse cards</a></p></section>`;
      return;
    }
    const total = items.reduce((s, i) => s + (i.value || 0) * i.qty, 0);
    const costed = items.filter(i => i.paid != null);
    const cost = costed.reduce((s, i) => s + i.paid * i.qty, 0);
    const gain = costed.reduce((s, i) => s + ((i.value || 0) - i.paid) * i.qty, 0);
    const best = [...items].sort(cmp(i => i.value, -1))[0];
    const graded = items.filter(i => i.grade !== 'Ungraded').reduce((s, i) => s + i.qty, 0);
    const g = i => i.paid == null ? null : ((i.value || 0) - i.paid) * i.qty;
    app.innerHTML = `<section class="vault">
      <div class="row between" style="align-items:flex-start"><div>
        <div class="eyebrow">Collection value</div><div class="bignum" id="total">$0.00</div>
        <div class="row">${costed.length ? `<span class="pill ${gain >= 0 ? 'up' : 'down'}">${gain >= 0 ? '▲' : '▼'} ${signed(gain)}${cost ? ` (${(gain / cost * 100).toFixed(1)}%)` : ''} vs. what you paid</span>` : ''}<span id="rangePill"></span></div>
      </div><div class="chips" id="ranges"></div></div>
      <div class="growth" id="growth"></div>
      <div class="stats">
        <div class="stat"><div class="k">Cards</div><div class="v">${items.reduce((s, i) => s + i.qty, 0)}</div></div>
        <div class="stat"><div class="k">Graded</div><div class="v">${graded}</div></div>
        <div class="stat"><div class="k">Cost basis</div><div class="v">${costed.length ? money(cost) : '—'}</div></div>
        <div class="stat"><div class="k">👑 Top card</div><div class="v" title="${esc(best.card.name)}">${esc(best.card.name)} · ${money(best.value)}</div></div>
      </div></section>
      <div class="row between"><h2>Your cards</h2><button class="btn" id="csv">Export CSV</button></div><div id="g"></div>`;
    countUp(document.getElementById('total'), total);

    const ranges = [['1W', 7], ['1M', 30], ['3M', 91], ['1Y', 365], ['All', 0]];
    let range = 'All';
    const drawGrowth = () => {
      const days = ranges.find(r => r[0] === range)[1];
      const cut = days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : '';
      const pts = history.filter(p => p.date >= cut);
      document.getElementById('ranges').innerHTML = ranges.map(r => `<button class="chip ${r[0] === range ? 'on' : ''}">${r[0]}</button>`).join('');
      document.querySelectorAll('#ranges button').forEach(b => b.onclick = () => { range = b.textContent; drawGrowth(); });
      growthChart(document.getElementById('growth'), pts);
      const pill = document.getElementById('rangePill');
      if (pts.length > 1) {
        const d0 = pts[0].value, ch = pts[pts.length - 1].value - d0;
        pill.className = 'pill ' + (ch >= 0 ? 'up' : 'down');
        pill.textContent = `${ch >= 0 ? '▲' : '▼'} ${signed(ch)}${d0 ? ` (${(ch / d0 * 100).toFixed(1)}%)` : ''} since ${pts[0].date}`;
      } else { pill.className = ''; pill.textContent = ''; }
    };
    drawGrowth();

    cardGrid(app.querySelector('#g'), items, [
      ['Value: high to low', cmp(i => (i.value || 0) * i.qty, -1)], ['Value: low to high', cmp(i => (i.value || 0) * i.qty, 1)],
      ['Biggest gain', cmp(g, -1)], ['Biggest loss', cmp(g, 1)], ['Recently added', cmp(i => i.added, -1)],
      ['Name: A to Z', cmp(i => i.card.name, 1)], ['Set', cmp(i => i.card.set, 1)], ['Grade', cmp(i => i.grade, 1)],
    ], {
      card: i => i.card, badge: i => gradeTag(i.grade) + (i.qty > 1 ? ` <span class="tag">×${i.qty}</span>` : ''),
      tile: i => `<div class="pr">${money((i.value || 0) * i.qty)}</div>${g(i) == null ? '' : `<div class="st ${g(i) >= 0 ? 'up' : 'down'}" style="font-weight:700">${g(i) >= 0 ? '▲' : '▼'} ${signed(g(i))}</div>`}`,
      remove: async id => { await api('/api/collection?entry=' + encodeURIComponent(id), { method: 'DELETE' }); collectionPage(); },
    });
    document.getElementById('csv').onclick = () => {
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['Game', 'Card', 'Set', 'Number', 'Grade', 'Qty', 'Paid', 'Value', 'Added'],
        ...items.map(i => [GAME[i.card.game], i.card.name, i.card.set, i.card.number, i.grade, i.qty, i.paid, i.value, i.added])];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
      a.download = 'slabscout-collection.csv'; a.click();
    };
  } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ router

function route() {
  stopCamera();
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === parts[0]));
  window.scrollTo(0, 0);
  app.style.animation = 'none'; void app.offsetWidth; app.style.animation = '';
  if (parts[0] === 'search' && parts[2]) return searchPage(parts[1], parts.slice(2).join('/'));
  if (parts[0] === 'card' && parts[1]) return cardPage(parts.slice(1).join('/'));
  if (parts[0] === 'scan') return scanPage();
  if (parts[0] === 'collection') return collectionPage();
  if (parts[0] === 'signin' || parts[0] === 'signup') return signInPage(parts[0]);
  if (parts[0] === 'forgot') return forgotPage();
  if (parts[0] === 'reset' && parts[1]) return resetPage(parts[1]);
  home();
}
document.getElementById('searchForm').onsubmit = e => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (q.length >= 2) location.hash = `#/search/${document.getElementById('gameSel').value}/${encodeURIComponent(q)}`;
};
window.addEventListener('hashchange', route);
api('/api/me').then(r => { me = r.user; }).catch(() => {}).finally(() => { drawAccount(); route(); });
