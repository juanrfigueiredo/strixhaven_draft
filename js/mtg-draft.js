// ══════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════
let setCode = '';
let draftState = null;
const setCardsCache = new Map();
const PACK_PLAYABLE_SIZE = 14;

const RAR_ORDER = { mythic:0, special:1, rare:2, uncommon:3, land:4, common:5 };
const RAR_COLOR = {
  mythic:'var(--mythic)', rare:'var(--rare)', uncommon:'var(--uncommon)',
  common:'var(--common)', land:'var(--land)', special:'var(--special)'
};

// ══════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════
function goTo(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  const activeBtn = document.querySelector('.nav-btn[data-page="' + name + '"]');
  if (activeBtn) activeBtn.classList.add('active');
  if (name === 'deck') renderDeckPage();
}

// ══════════════════════════════════════════
//  SCRYFALL
// ══════════════════════════════════════════
async function fetchAllPages(code) {
  const cards = [];
  let url = 'https://api.scryfall.com/cards/search?q=set%3A' + encodeURIComponent(code) + '&unique=prints&order=set';
  while (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.object === 'error') throw new Error(d.details);
    d.data.forEach(c => {
      const rarity = { mythic:'mythic', rare:'rare', uncommon:'uncommon', common:'common' }[c.rarity] || 'special';
      cards.push({
        name:  c.name,
        cost:  c.mana_cost || '',
        type:  c.type_line || '',
        rarity,
        image: c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || ''
      });
    });
    url = d.has_more ? d.next_page : null;
    if (url) await new Promise(res => setTimeout(res, 100));
  }
  return cards;
}

async function getCardsForSet(code) {
  if (setCardsCache.has(code)) return setCardsCache.get(code);
  const cards = await fetchAllPages(code);
  setCardsCache.set(code, cards);
  return cards;
}

function buildPool(cards) {
  const p = { mythic:[], rare:[], uncommon:[], common:[], land:[], special:[] };
  cards.forEach(c => (p[c.rarity] = p[c.rarity] || []).push(c));
  return p;
}

// ══════════════════════════════════════════
//  PACK GENERATION
// ══════════════════════════════════════════
function pickN(arr, n) {
  const pool = [...arr], out = [];
  for (let i = 0; i < n && pool.length; i++)
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

function makePack(pool) {
  const pack = [];
  const useMythic = pool.mythic.length > 0 && Math.random() < 1/8;
  if (useMythic)               pack.push(...pickN(pool.mythic, 1));
  else if (pool.rare.length)   pack.push(...pickN(pool.rare, 1));
  else if (pool.mythic.length) pack.push(...pickN(pool.mythic, 1));

  pack.push(...pickN(pool.uncommon, Math.min(3, pool.uncommon.length)));

  const left = Math.max(0, PACK_PLAYABLE_SIZE - pack.length);
  pack.push(...pickN(pool.common, Math.min(left, pool.common.length)));

  if (pack.length < PACK_PLAYABLE_SIZE) {
    const all = Object.values(pool).flat();
    pack.push(...pickN(all, PACK_PLAYABLE_SIZE - pack.length));
  }
  return pack;
}

function buildDraftPacks(pool, numPlayers, numPacks) {
  return Array.from({ length: numPacks }, () =>
    Array.from({ length: numPlayers }, () => makePack(pool))
  );
}

// ══════════════════════════════════════════
//  DRAFT SETUP
// ══════════════════════════════════════════
async function startDraft() {
  const code       = document.getElementById('s-set').value.trim().toLowerCase();
  const numPlayers = +document.getElementById('s-players').value;
  const numPacks   = +document.getElementById('s-packs').value;

  if (!code) { setStat('Please enter a set code.'); return; }

  const btn = document.getElementById('s-btn');
  btn.disabled = true;
  setStat('Fetching set data from Scryfall…');
  setProg(10);

  let cards;
  try { cards = await getCardsForSet(code); }
  catch (e) { setStat('Error: ' + e.message); btn.disabled = false; return; }

  if (!cards.length) {
    setStat('No cards found for "' + code.toUpperCase() + '". Check the set code.');
    btn.disabled = false;
    return;
  }

  setCode = code.toUpperCase();
  const pool = buildPool(cards);
  setStat(cards.length + ' cards loaded. Generating packs…');
  setProg(60);

  // packs[round][player]
  const packs = buildDraftPacks(pool, numPlayers, numPacks);

  // Track each AI player's picked cards for color-synergy logic
  const aiDecks = Array.from({ length: numPlayers }, () => []);

  draftState = {
    numPlayers, numPacks,
    round: 0, pick: 0,
    packs, deck: [], aiDecks,
    done: false
  };

  setProg(100);
  setStat('Draft ready! ' + numPlayers + ' players · ' + numPacks + ' packs each.');

  document.getElementById('nav-draft').disabled = false;
  document.getElementById('nav-deck').disabled  = false;
  btn.disabled = false;

  goTo('draft');
  renderPack();
}

function setStat(msg) { document.getElementById('s-status').textContent = msg; }
function setProg(p)   { document.getElementById('s-prog').style.width = p + '%'; }

// ══════════════════════════════════════════
//  AI PICK LOGIC
// ══════════════════════════════════════════

/**
 * Build a color-frequency map from a list of cards.
 * Returns { W: n, U: n, B: n, R: n, G: n }
 */
function buildColorCount(cards) {
  const count = {};
  cards.forEach(c => {
    (c.cost.match(/[WUBRG]/g) || []).forEach(col => {
      count[col] = (count[col] || 0) + 1;
    });
  });
  return count;
}

/**
 * Score a card against a color-frequency map.
 * Higher = better color fit.
 */
function colorSynergyScore(card, colorCount) {
  let score = 0;
  (card.cost.match(/[WUBRG]/g) || []).forEach(col => {
    score += colorCount[col] || 0;
  });
  return score;
}

/**
 * AI pick for a single player:
 * - Always take the highest rarity available.
 * - From pack 2 onward (round >= 1), break rarity ties using color synergy
 *   with the AI's already-picked cards.
 */
function aiPickBest(pack, aiPicks, round) {
  if (!pack.length) return -1;

  // Pre-compute color counts once per player per pick
  const colorCount = round >= 1 ? buildColorCount(aiPicks) : {};

  let bestIdx      = 0;
  let bestRar      = RAR_ORDER[pack[0].rarity] ?? 5;
  let bestColor    = round >= 1 ? colorSynergyScore(pack[0], colorCount) : 0;

  for (let i = 1; i < pack.length; i++) {
    const card   = pack[i];
    const rar    = RAR_ORDER[card.rarity] ?? 5;
    const color  = round >= 1 ? colorSynergyScore(card, colorCount) : 0;

    if (
      rar < bestRar ||
      (rar === bestRar && color > bestColor)
    ) {
      bestRar   = rar;
      bestColor = color;
      bestIdx   = i;
    }
  }

  return bestIdx;
}

// ══════════════════════════════════════════
//  DRAFT LOGIC
// ══════════════════════════════════════════
function renderPack() {
  if (!draftState || draftState.done) return;
  const { round, pick, numPacks, packs } = draftState;
  const humanPack = packs[round][0];
  const sorted = [...humanPack].sort((a,b) => (RAR_ORDER[a.rarity]??5) - (RAR_ORDER[b.rarity]??5));

  const grid = document.getElementById('d-grid');
  grid.innerHTML = '';

  sorted.forEach(card => {
    const origIdx = humanPack.indexOf(card);
    const btn = document.createElement('button');
    btn.className = 'pack-card';
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', 'Pick ' + card.name);

    if (card.image) {
      btn.innerHTML =
        '<img src="' + esc(card.image) + '" alt="' + esc(card.name) + '" loading="lazy">' +
        '<div class="r-dot" style="background:' + (RAR_COLOR[card.rarity]||'#888') + '"></div>';
    } else {
      btn.innerHTML =
        '<div class="card-fallback">' +
          '<div class="rp rp-' + card.rarity + '"></div>' +
          '<div class="cf-name">' + esc(card.name) + '</div>' +
          '<div class="cf-type">' + esc(shortType(card.type)) + '</div>' +
          '<div class="cf-cost">' + esc(card.cost) + '</div>' +
        '</div>';
    }

    btn.addEventListener('click', () => pickCard(origIdx));
    btn.addEventListener('mouseenter', e => showPreview(card, e));
    btn.addEventListener('mousemove', e => movePreview(e));
    btn.addEventListener('mouseleave', () => hidePreview());
    btn.addEventListener('focus', () => showPreviewForElement(card, btn));
    btn.addEventListener('blur', () => hidePreview());
    grid.appendChild(btn);
  });

  document.getElementById('d-round').textContent = 'Round ' + (round+1) + ' of ' + numPacks;
  document.getElementById('d-pick').textContent  = 'Pick ' + (pick+1) + ' · ' + humanPack.length + ' cards remaining';
  document.getElementById('d-pack-title').textContent = 'Pack ' + (round+1) + ' — choose a card';
  renderSidebar();
}

function pickCard(idx) {
  if (!draftState || draftState.done) return;
  const { round, numPlayers, packs, aiDecks } = draftState;
  const humanPack = packs[round][0];

  draftState.deck.push(humanPack.splice(idx, 1)[0]);
  draftState.pick++;

  // AI picks — rarity first, then color synergy from pack 2 onward
  for (let p = 1; p < numPlayers; p++) {
    const ap = packs[round][p];
    if (!ap.length) continue;
    const bestIdx = aiPickBest(ap, aiDecks[p], round);
    const [picked] = ap.splice(bestIdx, 1);
    aiDecks[p].push(picked);
  }

  if (humanPack.length > 0) {
    rotatePacks(round);
    renderPack();
  } else if (draftState.round + 1 < draftState.numPacks) {
    draftState.round++;
    draftState.pick = 0;
    renderPack();
  } else {
    // Draft complete
    draftState.done = true;
    renderSidebar();
    document.getElementById('d-grid').innerHTML =
      '<div class="empty-state">' +
        '<div class="es-icon">⚔️</div>' +
        '<div class="es-label">Draft Complete</div>' +
        '<div class="es-sub">Switch to My Deck to view your cards.</div>' +
      '</div>';
    document.getElementById('d-round').textContent = 'Draft Complete';
    document.getElementById('d-pick').textContent  = draftState.deck.length + ' cards picked';
    showToast('Draft done! Check My Deck →');
  }
}

function rotatePacks(round) {
  const { numPlayers, packs } = draftState;
  const rp  = packs[round];
  const out = new Array(numPlayers);
  for (let p = 0; p < numPlayers; p++) {
    // Even rounds pass left, odd rounds pass right
    const dest = round % 2 === 0
      ? (p - 1 + numPlayers) % numPlayers
      : (p + 1) % numPlayers;
    out[dest] = rp[p];
  }
  draftState.packs[round] = out;
}

function renderSidebar() {
  const deck = draftState?.deck || [];
  const sorted = [...deck].sort((a,b) => (RAR_ORDER[a.rarity]??5) - (RAR_ORDER[b.rarity]??5));
  const ul = document.getElementById('d-picks');
  ul.innerHTML = '';
  let lastR = null;
  sorted.forEach(card => {
    if (lastR !== null && lastR !== card.rarity) {
      const sep = document.createElement('li');
      sep.style.cssText = 'border-top:1px solid var(--border);margin:3px 0;padding:0;';
      ul.appendChild(sep);
    }
    lastR = card.rarity;
    const li = document.createElement('li');
    li.className = 'pick-item';
    li.innerHTML =
      '<div class="rp rp-' + card.rarity + '"></div>' +
      '<span class="pick-name">' + esc(card.name) + '</span>' +
      '<span class="pick-cost">' + esc(card.cost) + '</span>';
    if (card.image) {
      li.addEventListener('mouseenter', e => showPreview(card, e));
      li.addEventListener('mousemove',  e => movePreview(e));
      li.addEventListener('mouseleave', hidePreview);
    }
    ul.appendChild(li);
  });
  document.getElementById('d-count').textContent = deck.length + ' cards';
}

// ══════════════════════════════════════════
//  DECK PAGE
// ══════════════════════════════════════════
function renderDeckPage() {
  const deck = draftState?.deck || [];
  document.getElementById('dk-count').textContent = deck.length + ' cards';

  const sorted = [...deck].sort((a,b) => {
    const rd = (RAR_ORDER[a.rarity]??5) - (RAR_ORDER[b.rarity]??5);
    return rd !== 0 ? rd : a.name.localeCompare(b.name);
  });

  // Images grid
  const imgsEl = document.getElementById('dk-imgs');
  imgsEl.innerHTML = '';
  sorted.forEach(card => {
    const div = document.createElement('div');
    div.className = 'dk-card';
    if (card.image) {
      div.innerHTML =
        '<img src="' + esc(card.image) + '" alt="' + esc(card.name) + '" loading="lazy">' +
        '<div class="r-dot" style="background:' + (RAR_COLOR[card.rarity]||'#888') + '"></div>';
    } else {
      div.innerHTML =
        '<div class="card-fallback">' +
          '<div class="rp rp-' + card.rarity + '"></div>' +
          '<div class="cf-name">' + esc(card.name) + '</div>' +
          '<div class="cf-type">' + esc(shortType(card.type)) + '</div>' +
        '</div>';
    }
    div.addEventListener('mouseenter', e => showPreview(card, e));
    div.addEventListener('mousemove',  e => movePreview(e));
    div.addEventListener('mouseleave', hidePreview);
    imgsEl.appendChild(div);
  });

  // By type
  const buckets = {};
  sorted.forEach(c => {
    const t = mainType(c.type);
    (buckets[t] = buckets[t] || []).push(c);
  });
  const typesEl = document.getElementById('dk-types');
  typesEl.innerHTML = '';
  ['Creature','Instant','Sorcery','Enchantment','Artifact','Planeswalker','Battle','Land','Other'].forEach(t => {
    const group = buckets[t];
    if (!group?.length) return;
    const h = document.createElement('h4');
    h.textContent = t + ' (' + group.length + ')';
    typesEl.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'type-list';
    group.forEach(card => {
      const li = document.createElement('li');
      li.className = 'type-item';
      li.innerHTML =
        '<div class="rp rp-' + card.rarity + '"></div>' +
        '<span>' + esc(card.name) + '</span>' +
        '<span style="margin-left:auto;font-size:10px;color:var(--text-dim);font-family:monospace">' + esc(card.cost) + '</span>';
      ul.appendChild(li);
    });
    typesEl.appendChild(ul);
  });
}

// ══════════════════════════════════════════
//  EXPORT
// ══════════════════════════════════════════
function exportDeck() {
  const deck = draftState?.deck || [];
  if (!deck.length) { showToast('No cards yet!'); return; }
  const counts = {};
  deck.forEach(c => counts[c.name] = (counts[c.name]||0) + 1);
  const txt = Object.entries(counts).sort((a,b) => a[0].localeCompare(b[0])).map(([n,c]) => c+'x '+n).join('\n');
  copyText(txt, 'Deck list copied!');
}

function exportArena() {
  const deck = draftState?.deck || [];
  if (!deck.length) { showToast('No cards yet!'); return; }
  const counts = {};
  deck.forEach(c => counts[c.name] = (counts[c.name]||0) + 1);
  const txt = Object.entries(counts).sort((a,b) => a[0].localeCompare(b[0])).map(([n,c]) => c+' '+n+' ('+setCode+')').join('\n');
  copyText(txt, 'Arena format copied!');
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); showToast(msg); }
  catch { prompt('Copy:', text); }
}

// ══════════════════════════════════════════
//  PACK TOOL
// ══════════════════════════════════════════
let ptPool = null;
let ptCode = '';

async function ptFetch() {
  const code = document.getElementById('pt-set').value.trim().toLowerCase();
  if (!code) { ptStat('Enter a set code.'); return; }
  ptStat('Fetching…');
  try {
    const cards = await getCardsForSet(code);
    if (!cards.length) { ptStat('No cards found for "' + code.toUpperCase() + '".'); return; }
    ptCode = code.toUpperCase();
    ptPool = buildPool(cards);
    const parts = [];
    if (ptPool.mythic.length)   parts.push(ptPool.mythic.length + ' M');
    if (ptPool.rare.length)     parts.push(ptPool.rare.length + ' R');
    if (ptPool.uncommon.length) parts.push(ptPool.uncommon.length + ' U');
    if (ptPool.common.length)   parts.push(ptPool.common.length + ' C');
    ptStat(cards.length + ' cards loaded for ' + ptCode + '.');
    document.getElementById('pt-stats').textContent = parts.join(' · ');
    ptNewPack();
  } catch(e) { ptStat('Error: ' + e.message); }
}

function ptNewPack() {
  if (!ptPool) return;
  const pack = makePack(ptPool);
  const sorted = [...pack].sort((a,b) => (RAR_ORDER[a.rarity]??5) - (RAR_ORDER[b.rarity]??5));
  const list = document.getElementById('pt-list');
  list.innerHTML = '';
  let lastR = null;
  sorted.forEach(card => {
    if (lastR && lastR !== card.rarity) {
      const sep = document.createElement('li'); sep.className = 'pt-sep'; list.appendChild(sep);
    }
    lastR = card.rarity;
    const li = document.createElement('li');
    li.className = 'pt-item';
    li.innerHTML =
      '<div class="rp rp-' + card.rarity + '"></div>' +
      '<span class="pt-name">' + esc(card.name) + '</span>' +
      '<span class="pt-cost">' + esc(card.cost) + '</span>' +
      '<span class="pt-type">' + esc(shortType(card.type)) + '</span>';
    list.appendChild(li);
  });
  const imgs = document.getElementById('pt-imgs');
  imgs.innerHTML = '';
  sorted.forEach(card => {
    if (!card.image) return;
    const img = document.createElement('img');
    img.src = card.image; img.alt = card.name; img.title = card.name;
    imgs.appendChild(img);
  });
  document.getElementById('pt-title').textContent = ptCode + ' Booster Pack (' + pack.length + ' cards)';
  document.getElementById('pt-pack-area').style.display = 'block';
}

async function ptCopy() {
  const items = document.querySelectorAll('#pt-list .pt-item');
  if (!items.length) return;
  const lines = [...items].map(li => li.querySelector('.pt-name')?.textContent.trim()).filter(Boolean);
  await copyText(lines.join('\n'), 'Copied!');
}

function ptStat(msg) { document.getElementById('pt-status').textContent = msg; }

// ══════════════════════════════════════════
//  HOVER PREVIEW
// ══════════════════════════════════════════
function showPreview(card, e) {
  if (!card.image) return;
  document.getElementById('preview-img').src = card.image;
  document.getElementById('card-preview').classList.add('on');
  movePreview(e);
}
function showPreviewForElement(card, el) {
  const rect = el.getBoundingClientRect();
  showPreview(card, { clientX: rect.right, clientY: rect.top });
}
function movePreview(e) {
  const el = document.getElementById('card-preview');
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + 205 > window.innerWidth)  x = e.clientX - 210;
  if (y + 275 > window.innerHeight) y = e.clientY - 278;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}
function hidePreview() { document.getElementById('card-preview').classList.remove('on'); }

// ══════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════
function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function shortType(t) { return (t||'').split('//')[0].trim().slice(0,28); }
function mainType(t) {
  if (!t) return 'Other';
  const s = t.split('//')[0];
  for (const o of ['Creature','Instant','Sorcery','Enchantment','Artifact','Planeswalker','Battle','Land'])
    if (s.includes(o)) return o;
  return 'Other';
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 2200);
}

// ══════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════
function initEventListeners() {
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => goTo(btn.dataset.page));
  });

  document.querySelector('[data-action="start-draft"]').addEventListener('click', startDraft);
  document.querySelector('[data-action="export-deck"]').addEventListener('click', exportDeck);
  document.querySelector('[data-action="export-arena"]').addEventListener('click', exportArena);
  document.querySelector('[data-action="pt-fetch"]').addEventListener('click', ptFetch);
  document.querySelector('[data-action="pt-new-pack"]').addEventListener('click', ptNewPack);
  document.querySelector('[data-action="pt-copy"]').addEventListener('click', ptCopy);

  document.getElementById('pt-set').addEventListener('keydown', e => { if (e.key === 'Enter') ptFetch(); });
  document.getElementById('s-set').addEventListener('keydown', e => { if (e.key === 'Enter') startDraft(); });
}

initEventListeners();