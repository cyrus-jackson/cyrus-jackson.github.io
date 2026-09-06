/* Kea Mission Control - core.js | state, utils, markdown, API, themes, chrome. Loaded first. */
'use strict';
/* ============================================================
   Kea Mission Control — core
   A static, GitHub-backed board. No build step, no backend.
   Part 1/4: state, utils, markdown, API, themes, chrome.
   ============================================================ */


const NS  = 'kea.tracker.';
const API = 'https://api.github.com';

const THEMES = [
  { id:'neon',     name:'Kea Neon',  sw:['#0b1220','#60dcec'] },
  { id:'atompunk', name:'Atompunk',  sw:['#1f1913','#d9ae3f'] },
  { id:'midnight', name:'Midnight',  sw:['#111114','#8b7cf6'] },
  { id:'terminal', name:'Terminal',  sw:['#05090c','#4ef08d'] },
  { id:'paper',    name:'Paper',     sw:['#f7f5f0','#1f6f7a'] },
  { id:'mist',     name:'Mist',      sw:['#eef2f8','#2563eb'] },
  { id:'outrun',   name:'Outrun',    sw:['#150826','#ff5df2'] },
];

const IDEA_LABEL = 'idea';
const DEFAULT_STALE_DAYS = 10;

/* ---------- duration ----------
   GitHub issues carry no estimate field, so an estimate is stored as an
   `est:<n>d` label: native, visible on github.com, filterable there, and no
   extra API surface. Actual duration is never stored — it is derived, so it
   cannot drift out of date.

   Work time runs from first entry into In Progress to close (cycle time).
   The start is stamped as an invisible `<!-- started: <iso> -->` marker the
   moment a card is dragged to In Progress — same PATCH, no extra call — and
   older cards are measured from GitHub's label history instead (see
   fetchWorkStart). Anything that never visited In Progress falls back to
   created -> done, and the UI says which basis each figure uses. */
const EST_RE = /^est:(\d+(?:\.\d+)?)d$/i;
const EST_CHOICES = [0.5, 1, 2, 3, 5, 8, 13];
const estLabelName = d => `est:${d}d`;
const isEstLabel = n => EST_RE.test(String(n || ''));

function estOf(issue) {
  for (const l of (issue.labels || [])) {
    const m = EST_RE.exec(String(l.name || l));
    if (m) return parseFloat(m[1]);
  }
  return null;
}

// The In Progress column, by stable id — never by display name, which the
// user is free to rename in Settings.
const progressCol = () => (S.columns || []).find(c => c.id === 'progress') || null;
const progressLabel = () => { const c = progressCol(); return c ? c.label : null; };

const START_RE = /<!--\s*started:\s*(\S+?)\s*-->/;
const startMarker = body => {
  const m = START_RE.exec(String(body || ''));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const withStartMarker = (body, iso) =>
  START_RE.test(String(body || '')) ? body : `${String(body || '').trimEnd()}\n\n<!-- started: ${iso} -->`;

const leadDays = i => i.closed_at ? (new Date(i.closed_at) - new Date(i.created_at)) / 864e5 : null;
const openDays = i => (Date.now() - new Date(i.created_at)) / 864e5;

function fmtDur(d) {
  if (d === null || d === undefined || !isFinite(d)) return '';
  if (d < 1) return Math.max(1, Math.round(d * 24)) + 'h';
  if (d < 10) return (Math.round(d * 10) / 10) + 'd';
  return Math.round(d) + 'd';
}

// local calendar day, so "days shipped" matches the days you remember working
const dayKey = v => { const d = new Date(v); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}

const DEFAULT_COLUMNS = [
  { id:'todo',     name:'Todo',        label:'status:todo',        color:'#7d8ca3' },
  { id:'progress', name:'In Progress', label:'status:in-progress', color:'#60dcec' },
  { id:'review',   name:'In Review',   label:'status:review',      color:'#d9ae3f' },
  { id:'done',     name:'Done',        label:'status:done',        color:'#4ad6a0' },
];

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch {} },
  del(k)    { try { localStorage.removeItem(NS + k); } catch {} },
};

/* ---------- state ---------- */
const S = {
  token   : store.get('token', ''),
  user    : null,
  repos   : store.get('repos', [{ owner:'cyrus-jackson', repo:'KeaGame' }]),
  active  : store.get('active', 0),
  columns : store.get('columns', DEFAULT_COLUMNS),
  assets  : store.get('assets', { owner:'cyrus-jackson', repo:'cyrus-jackson.github.io', dir:'data/uploads', branch:'master' }),
  closeOnDone: store.get('closeOnDone', true),
  staleDays: store.get('staleDays', DEFAULT_STALE_DAYS),
  order   : store.get('order', {}),
  inspiration: store.get('inspiration', []),
  inspSha : null,
  issues  : [],
  prs     : [],
  labels  : [],
  milestones: [],
  checks  : {},
  view    : 'board',
  q       : '',
  filters : [],
  msFilter: '',
  sort: store.get('sort', 'manual'),
  sorts: (() => {
    const per = store.get('sorts', {});
    if (per && Object.keys(per).length) return per;
    // one-time migration from the old board-wide sort
    const legacy = store.get('sort', 'manual');
    if (legacy && legacy !== 'manual') {
      return Object.fromEntries(store.get('columns', DEFAULT_COLUMNS).map(c => [c.id, legacy]));
    }
    return {};
  })(),
  lastCreated: null,
  assetList: null,
  assetDir: '',
  assetBranch: null,
  assetTruncated: false,
  assetErr: null,
  rate    : null,
  lastLoad: null,
  checksLoaded: false,
  demo    : false,
  loading : false,
};

const repoNow  = () => S.repos[S.active] || S.repos[0] || { owner:'', repo:'' };
const repoKey  = () => { const r = repoNow(); return r.owner + '/' + r.repo; };
// Self-heal configs written while the duplicate `assets` key nulled them.
if (!S.assets || !S.assets.owner) S.assets = { owner:'cyrus-jackson', repo:'cyrus-jackson.github.io', dir:'data/uploads', branch:'master' };
const assetCfg = () => S.assets && S.assets.owner ? S.assets : { owner:'cyrus-jackson', repo:'cyrus-jackson.github.io', dir:'data/uploads', branch:'master' };

// Work-start lookups resolved from the label timeline, so re-renders are
// free. Keyed by repo + issue + the progress label in force at lookup time,
// with the issue's updated_at so a newer timeline is re-read, not trusted.
const startCache = store.get('starts', {});
function startCacheSet(key, entry) {
  startCache[key] = entry;
  const keys = Object.keys(startCache);
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => delete startCache[k]);
  store.set('starts', startCache);
}
const startKey = (issue, label) => `${repoKey()}#${issue.number}#${String(label).toLowerCase()}`;

// Best-known work start without touching the network: the stamped marker,
// then a cached timeline lookup. Null means unknown, not zero.
function startedAtSync(issue) {
  const marked = startMarker(issue.body);
  if (marked) return marked;
  const label = progressLabel();
  if (!label) return null;
  const hit = startCache[startKey(issue, label)];
  if (hit && hit.upd === issue.updated_at && hit.start) return hit.start;
  return null;
}

// One timeline read per issue, then cached. Finds the first `labeled` event
// for the In Progress label — events arrive oldest-first, so a single page
// is enough even when the tail is truncated. Issues created carrying the
// label (seeded straight into a column) have no such event and resolve null,
// which the callers render as a created -> done fallback.
async function fetchWorkStart(issue) {
  const marked = startMarker(issue.body);
  if (marked) return marked;
  const label = progressLabel();
  if (!label || S.demo || !S.token) return null;
  const key = startKey(issue, label);
  const hit = startCache[key];
  if (hit && hit.upd === issue.updated_at) return hit.start;
  try {
    const { owner, repo } = repoNow();
    const r = await gh(`/repos/${owner}/${repo}/issues/${issue.number}/timeline?per_page=100`, {
      headers: { Accept: 'application/vnd.github.mockingbird-preview+json' },
    });
    const ev = (r.data || []).find(e => e.event === 'labeled' &&
      String((e.label || {}).name || '').toLowerCase() === label.toLowerCase());
    const start = ev ? new Date(ev.created_at).toISOString() : null;
    startCacheSet(key, { start, upd: issue.updated_at });
    return start;
  } catch { return null; }
}

// Preferred duration for a closed issue: work time when the start is known,
// otherwise lead time. `basis` tells the UI which one it got.
function spanOf(issue) {
  if (!issue.closed_at) return null;
  const start = startedAtSync(issue);
  if (start) {
    const d = (new Date(issue.closed_at) - new Date(start)) / 864e5;
    if (d >= 0) return { days: d, basis: 'work' };
  }
  const lead = leadDays(issue);
  return lead !== null ? { days: lead, basis: 'lead' } : null;
}
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- utils ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const attr = s => esc(s).replace(/\n/g, ' ');
const uid = () => Math.random().toString(36).slice(2, 10);

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const u = [[60,'m'],[3600,'h'],[86400,'d'],[604800,'w'],[2629800,'mo'],[31557600,'y']];
  for (let i = u.length - 1; i >= 0; i--) { const n = Math.floor(s / u[i][0]); if (n >= 1) return n + u[i][1] + ' ago'; }
  return 'just now';
}
const startOfWeek = d => { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setHours(0,0,0,0); x.setDate(x.getDate() - day); return x; };

function hex2rgb(h) {
  h = String(h || '888888').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) h = '888888';
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
const lum = ([r,g,b]) => (0.2126*r + 0.7152*g + 0.0722*b) / 255;
const isLightTheme = () => ['paper','mist'].includes(document.documentElement.dataset.theme);

function labelStyle(hex) {
  let rgb = hex2rgb(hex), L = lum(rgb), light = isLightTheme();
  if (light && L > 0.55) { const k = 0.5 / Math.max(L, .01); rgb = rgb.map(v => v * k); }
  if (!light && L < 0.42) { const k = Math.min(3.2, 0.48 / Math.max(L, .04)); rgb = rgb.map(v => Math.min(255, v * k)); }
  const c = rgb.map(v => v | 0);
  return `color:rgb(${c});border-color:rgba(${c},.42);background:rgba(${c},.13)`;
}

/* base64 that survives unicode and big files */
function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function b64dec(b) {
  const bin = atob(String(b).replace(/\s/g, ''));
  const arr = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(arr);
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

/* ---------- toasts ---------- */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<svg><use href="#i-${kind === 'err' ? 'x' : 'check'}"/></svg><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(16px)'; t.style.transition = 'all .2s'; }, 3200);
  setTimeout(() => t.remove(), 3500);
}

/* ---------- markdown (small + safe: everything is escaped first) ---------- */
const safeUrl = u => /^(https?:|mailto:|\/|\.|#)/i.test(String(u).trim()) ? String(u).trim() : '#';

function md(src, opts = {}) {
  let ti = 0;
  if (!src || !src.trim()) return '<p style="color:var(--fg-faint)">No description.</p>';

  const slots = [];
  const hold = html => { slots.push(html); return '\u0001' + (slots.length - 1) + '\u0001'; };
  const isBlock = i => /^<(pre|img)/.test(slots[i] || '');

  let s = esc(src.replace(/\r\n/g, '\n'));

  s = s.replace(/```[a-z0-9]*\n?([\s\S]*?)```/gi, (_, c) => hold(`<pre><code>${c.replace(/\n$/, '')}</code></pre>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, a, u) => hold(`<img src="${safeUrl(u)}" alt="${a}" loading="lazy">`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => hold(`<a href="${safeUrl(u)}" target="_blank" rel="noopener">${t}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + hold(`<a href="${safeUrl(u)}" target="_blank" rel="noopener">${u}</a>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  const out = [];
  let list = null, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) { flushP(); flushL(); continue; }

    const lone = t.match(/^\u0001(\d+)\u0001$/);
    if (lone && isBlock(+lone[1])) { flushP(); flushL(); out.push(t); continue; }

    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/)))      { flushP(); flushL(); out.push(`<h${m[1].length}>${m[2]}</h${m[1].length}>`); continue; }
    if (/^([-*_])\1{2,}$/.test(t))               { flushP(); flushL(); out.push('<hr>'); continue; }
    if ((m = t.match(/^>\s?(.*)$/)))             { flushP(); flushL(); out.push(`<blockquote>${m[1]}</blockquote>`); continue; }
    if ((m = t.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/))) {
      flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li class="task"><input type="checkbox" ${opts.tasks ? `data-ti="${ti++}"` : 'disabled'} ${m[1] !== ' ' ? 'checked' : ''}><span>${m[2]}</span></li>`); continue;
    }
    if ((m = t.match(/^[-*+]\s+(.*)$/))) {
      flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${m[1]}</li>`); continue;
    }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) {
      flushP(); if (list !== 'ol') { flushL(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${m[1]}</li>`); continue;
    }
    flushL(); para.push(t);
  }
  flushP(); flushL();

  let html = out.join('\n');
  for (let i = 0; i < 3 && html.includes('\u0001'); i++) {
    html = html.replace(/\u0001(\d+)\u0001/g, (whole, n) => slots[+n] !== undefined ? slots[+n] : whole);
  }
  return html;
}

function toggleTask(body, index) {
  const lines = String(body || '').split('\n');
  let n = 0, fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = lines[i].match(/^(\s*[-*+]\s+\[)([ xX])(\].*)$/);
    if (!m) continue;
    if (n++ === index) { lines[i] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3]; return lines.join('\n'); }
  }
  return null;
}

const firstImage = body => { const m = String(body || '').match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)/); return m ? m[1] : null; };
function taskProgress(body) {
  const all = String(body || '').match(/^\s*[-*+]\s+\[[ xX]\]/gm);
  if (!all || all.length < 2) return null;
  const done = String(body).match(/^\s*[-*+]\s+\[[xX]\]/gm) || [];
  return { done: done.length, total: all.length };
}

/* ---------- HTTP cache: ETag conditional requests ----------
   GitHub does not charge a 304 against the primary rate limit when the
   request carries an Authorization header, so every unchanged response
   below is free. We keep the etag AND the body, so a 304 still returns data. */
const CKEY = 'httpcache';
let httpCache = store.get(CKEY, {});
let cacheSaves = store.get('cacheSaves', 0);
let cacheTimer = null;

function cacheFlush() {
  const cutoff = Date.now() - 3 * 864e5;
  for (const k of Object.keys(httpCache)) if ((httpCache[k].ts || 0) < cutoff) delete httpCache[k];
  try { localStorage.setItem(NS + CKEY, JSON.stringify(httpCache)); }
  catch {
    // over quota — drop the biggest half and try once more
    const keys = Object.keys(httpCache)
      .sort((a, b) => JSON.stringify(httpCache[b]).length - JSON.stringify(httpCache[a]).length);
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => delete httpCache[k]);
    try { localStorage.setItem(NS + CKEY, JSON.stringify(httpCache)); } catch { httpCache = {}; }
  }
}
const cacheSave = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(cacheFlush, 800); };
function cacheClear() { httpCache = {}; cacheSaves = 0; store.set('cacheSaves', 0); cacheFlush(); }
const cacheBytes = () => { try { return (localStorage.getItem(NS + CKEY) || '').length; } catch { return 0; } };

/* ---------- GitHub API ---------- */
async function gh(path, opts = {}) {
  const url = path.startsWith('http') ? path : API + path;
  const method = opts.method || 'GET';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) };
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  if (opts.body) headers['Content-Type'] = 'application/json';

  // Only authenticated GETs are worth revalidating — an unauthenticated 304
  // still costs a request, so there is nothing to win there.
  const conditional = method === 'GET' && !!S.token && !opts.noCache;
  const hit = conditional ? httpCache[url] : null;
  if (hit && hit.etag) headers['If-None-Match'] = hit.etag;

  const init = { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined };
  // Bypass the browser's own HTTP cache so our conditional request is the one
  // that reaches GitHub and we actually observe the 304.
  if (conditional) init.cache = 'no-store';

  const res = await fetch(url, init);

  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem !== null) {
    S.rate = { rem: +rem, limit: +(res.headers.get('x-ratelimit-limit') || 0), reset: +(res.headers.get('x-ratelimit-reset') || 0) };
    paintConn();
  }

  if (res.status === 304 && hit) {
    hit.ts = Date.now();
    cacheSaves++; store.set('cacheSaves', cacheSaves);
    cacheSave(); paintConn();
    return { data: hit.data, link: hit.link, cached: true };
  }
  if (res.status === 204) return { data: null, link: null };

  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText || 'Request failed');
    err.status = res.status; err.data = data; err.link = res.headers.get('link');
    throw err;
  }

  const etag = res.headers.get('etag');
  if (conditional && etag) {
    httpCache[url] = { etag, data, link: res.headers.get('link'), ts: Date.now() };
    cacheSave();
  }
  return { data, link: res.headers.get('link') };
}

const ghGet = async (p) => (await gh(p)).data;

async function ghAll(path, maxPages = 4) {
  let out = [], url = path, n = 0;
  while (url && n++ < maxPages) {
    const r = await gh(url);
    out = out.concat(Array.isArray(r.data) ? r.data : []);
    const m = (r.link || '').match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}

/* ---------- themes ---------- */
function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  store.set('theme', id);
  $$('.theme-dot').forEach(d => d.classList.toggle('is-active', d.dataset.theme === id));
  paintThemeName(id);
  if (S.view === 'board') renderBoard();
  if (S.view === 'prs') renderPRs();
  initAmbient();
}
function paintThemes() {
  $('#themeDots').innerHTML = THEMES.map(t =>
    `<button class="theme-dot" data-theme="${t.id}" title="${esc(t.name)}" aria-label="${esc(t.name)} theme"
       style="background:linear-gradient(135deg, ${t.sw[0]} 0 52%, ${t.sw[1]} 52% 100%)"></button>`).join('')
    + '<span class="theme-name" id="themeName"></span>';
  const cur = store.get('theme', 'neon');
  $$('.theme-dot').forEach(d => d.classList.toggle('is-active', d.dataset.theme === cur));
  paintThemeName(cur);
  const dots = $('#themeDots');
  dots.addEventListener('pointerover', e => {
    const d = e.target.closest('.theme-dot');
    if (d) paintThemeName(d.dataset.theme);
  });
  dots.addEventListener('pointerleave', () => paintThemeName(document.documentElement.dataset.theme));
}
function paintThemeName(id) {
  const el = $('#themeName'); if (!el) return;
  const t = THEMES.find(x => x.id === id);
  el.textContent = t ? t.name : '';
}

/* ---------- sidebar chrome ---------- */
function paintConn() {
  const el = $('#conn'); if (!el) return;
  const rate = S.rate ? `${S.rate.rem}/${S.rate.limit} API calls left` : '';
  if (S.user) {
    el.innerHTML =
      `<div class="conn-user"><img src="${attr(S.user.avatar_url)}" alt=""><span>${esc(S.user.login)}</span></div>` +
      `<div style="display:flex;align-items:center;gap:6px"><i class="dot on"></i>${esc(rate || 'connected')}</div>`;
  } else {
    el.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><i class="dot off"></i>${S.demo ? 'Demo data' : 'Not connected'}</div>` +
      `<button class="btn btn-ghost btn-sm" data-act="goto-settings" style="justify-content:center">Connect GitHub</button>`;
  }
}
function paintRepos() {
  $('#repoSelect').innerHTML = S.repos.map((r, i) =>
    `<option value="${i}" ${i === S.active ? 'selected' : ''}>${esc(r.owner)}/${esc(r.repo)}</option>`).join('')
    + '<option value="__add">+ Add repository…</option>';
  $('#repoChip').textContent = repoKey();
}
function paintCounts() {
  // ideas are open issues but never board cards, so they must not inflate this
  const open = S.issues.filter(i => i.state === 'open' && !isIdea(i)).length;
  $('#cntBoard').textContent = open || '';
  $('#cntPrs').textContent = S.prs.filter(p => p.state === 'open').length || '';
  $('#cntInsp').textContent = S.inspiration.length || '';
  $('#cntMs').textContent = S.milestones.filter(m => m.state === 'open').length || '';
  $('#cntIdeas').textContent = S.issues.filter(isIdea).length || '';
  $('#cntAssets').textContent = (S.assetList || []).length || '';
}

/* ---------- look & feel ----------
   Every delight is a toggle in Settings → Look & feel, all on by default and
   merged over defaults so new toggles light up for existing browsers too.
   Motion (confetti, ambient dust) additionally yields to
   prefers-reduced-motion; static dressing (covers, clocks, streaks) does not. */
const DEFAULT_FX = { confetti: true, boom: 'full', boomStyle: 'ticker', covers: true, ambient: true, dust: 'subtle', clocks: true, streaks: true, pet: true, wander: true };
S.fx = { ...DEFAULT_FX, ...store.get('fx', {}) };

const fxOn = name => !!(S.fx && S.fx[name]);
const motionOk = () => !(typeof window !== 'undefined' && window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const raf = cb => (typeof requestAnimationFrame !== 'undefined'
  ? requestAnimationFrame(cb) : setTimeout(() => cb(Date.now()), 16));
const caf = id => (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame(id) : clearTimeout(id));

/* Ship-it confetti: a fixed pointer-transparent canvas that lives only for
   the burst. Five styles, each with its own palette, shapes and physics —
   pick one in Settings → Look & feel. */
const BOOM_STYLES = {
  ticker:   { name: 'Ticker tape',    colors: ['#60dcec', '#d9ae3f', '#c33f45', '#4ad6a0', '#8b7cf6', '#f7f5f0'] },
  neon:     { name: 'Neon streaks',   colors: ['#60dcec', '#ff5df2', '#b6ff5d', '#ff9f5d', '#8b7cf6'] },
  atompunk: { name: 'Atompunk sparks', colors: ['#d9ae3f', '#f2e8d5', '#c33f45', '#7d8ca3'] },
  embers:   { name: 'Ember fountain', colors: ['#ffb347', '#ff7b2e', '#ff3d00', '#d9ae3f'] },
  bubbles:  { name: 'Bubbles',        colors: ['#bfe9ff', '#f7f5f0', '#60dcec', '#4ad6a0'] },
};
const boomStyle = () => BOOM_STYLES[(S.fx && S.fx.boomStyle) || 'ticker'] || BOOM_STYLES.ticker;
let boomCanvas = null, boomParts = [], boomRaf = 0;
function spawnBoomPart(kind, x, y, i, colors) {
  const pick = colors[i % colors.length];
  const radial = () => { const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 6; return [Math.cos(a) * sp, Math.sin(a) * sp]; };
  switch (kind) {
    case 'neon': {
      const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 7;
      return { kind: 'streak', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.04, drag: 0.99,
        life: 40 + Math.random() * 30, color: pick, size: 1.6 + Math.random() * 1.6, glow: 8 };
    }
    case 'atompunk': {
      const [vx, vy] = radial();
      return i % 3 === 0
        ? { kind: 'star', x, y, vx, vy: vy - 2, g: 0.25, drag: 0.995, life: 55 + Math.random() * 35,
            color: pick, size: 3 + Math.random() * 3, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.25 }
        : { kind: 'dot', x, y, vx, vy: vy - 2, g: 0.25, drag: 0.995, life: 45 + Math.random() * 30,
            color: pick, size: 1.2 + Math.random() * 1.8 };
    }
    case 'embers': {
      const life = 60 + Math.random() * 40;
      return { kind: 'spark', x: x + (Math.random() - 0.5) * 12, y, vx: (Math.random() - 0.5) * 2.4,
        vy: -(2 + Math.random() * 5), g: -0.02, drag: 0.985, life, maxLife: life,
        color: pick, size: 1.5 + Math.random() * 2.5, glow: 6 };
    }
    case 'bubbles': {
      const life = 80 + Math.random() * 50;
      return { kind: 'bubble', x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 16,
        vx: (Math.random() - 0.5) * 0.8, vy: -(0.4 + Math.random() * 0.9), g: -0.015, drag: 1,
        life, color: pick, size: 2 + Math.random() * 5, ph: Math.random() * 6.28 };
    }
    default: {
      const [vx, vy] = radial();
      return { kind: 'rect', x, y, vx, vy: vy - 3.2, g: 0.22, drag: 1, life: 50 + Math.random() * 40,
        color: pick, size: 2 + Math.random() * 3.5, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3 };
    }
  }
}
function drawBoomStar(ctx, r) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 ? r * 0.45 : r, a = k * Math.PI / 5 - Math.PI / 2;
    ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill();
}
function drawBoomPart(ctx, p) {
  ctx.globalAlpha = Math.min(1, p.life / 30);
  switch (p.kind) {
    case 'streak':
      ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(1, p.size * 0.7);
      ctx.shadowBlur = p.glow || 0; ctx.shadowColor = p.color;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    case 'star':
      ctx.fillStyle = p.color;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0); drawBoomStar(ctx, p.size); ctx.restore();
      break;
    case 'dot':
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.29); ctx.fill();
      break;
    case 'spark':
      ctx.fillStyle = p.color;
      ctx.shadowBlur = p.glow || 0; ctx.shadowColor = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, p.size * (p.life / (p.maxLife || p.life))), 0, 6.29); ctx.fill();
      ctx.shadowBlur = 0;
      break;
    case 'bubble':
      ctx.globalAlpha = Math.min(0.55, p.life / 40);
      ctx.strokeStyle = p.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.29); ctx.stroke();
      break;
    default:
      ctx.fillStyle = p.color;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function celebrate(x, y) {
  if (!fxOn('confetti') || !motionOk() || typeof document === 'undefined') return;
  if (!boomCanvas) {
    boomCanvas = document.createElement('canvas');
    boomCanvas.id = 'boom';
    boomCanvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(boomCanvas);
  }
  boomCanvas.width = window.innerWidth;
  boomCanvas.height = window.innerHeight;
  const st = boomStyle();
  const key = Object.keys(BOOM_STYLES).find(k => BOOM_STYLES[k] === st) || 'ticker';
  const n = (S.fx.boom || 'full') === 'full' ? 90 : 28;
  for (let i = 0; i < n; i++) boomParts.push(spawnBoomPart(key, x, y, i, st.colors));
  if (!boomRaf) boomRaf = raf(boomTick);
}
function boomTick() {
  const c = boomCanvas;
  const ctx = c && c.getContext ? c.getContext('2d') : null;
  if (!ctx) { boomRaf = 0; return; }
  boomParts = boomParts.filter(p => p.life > 0);
  if (!boomParts.length) {
    ctx.clearRect(0, 0, c.width, c.height);
    if (c.parentNode) c.parentNode.removeChild(c);
    boomCanvas = null; boomRaf = 0;
    return;
  }
  boomRaf = raf(boomTick);
  ctx.clearRect(0, 0, c.width, c.height);
  for (const p of boomParts) {
    p.x += p.vx + (p.kind === 'bubble' ? Math.sin(p.life / 9 + (p.ph || 0)) * 0.35 : 0);
    p.y += p.vy; p.vy += p.g || 0; p.vx *= p.drag || 1;
    if (p.rot !== undefined) p.rot += p.vr || 0;
    p.life--;
    drawBoomPart(ctx, p);
  }
}

/* Ambient background: one fixed canvas behind the app, re-seeded on theme
   change, removed entirely when off. Most themes get tinted drifting dust;
   atompunk gets the full treatment — brass orbit rings with travelling
   electrons and four-point starbursts, the atomic-age furniture. */
const DUST_TINTS = { neon: '#60dcec', atompunk: '#d9ae3f', midnight: '#8b7cf6', terminal: '#4ef08d', paper: '#1f6f7a', mist: '#2563eb', outrun: '#ff5df2' };
const ATOM_TINTS = ['#d9ae3f', '#f2e8d5', '#b0762a', '#8a8f98'];
let dustCanvas = null, dustParts = [], dustRaf = 0;
function stopAmbient() {
  if (dustRaf) { caf(dustRaf); dustRaf = 0; }
  dustParts = [];
  if (typeof document !== 'undefined') {
    const old = document.getElementById('dust');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  dustCanvas = null;
}
function seedDustDot(c, tint) {
  return { kind: 'dot', x: Math.random() * c.width, y: Math.random() * c.height,
    r: 0.4 + Math.random() * 1.3, vy: 0.06 + Math.random() * 0.22, ph: Math.random() * 6.28,
    sp: 0.3 + Math.random() * 0.9, a: 0.12 + Math.random() * 0.3, tint };
}
function seedDustOrbit(c) {
  // An atomic ring: tilted ellipse, nucleus, one electron on the wire.
  const rx = 16 + Math.random() * 30;
  return { kind: 'orbit', x: rx + Math.random() * Math.max(rx, c.width - rx * 2), y: Math.random() * c.height,
    rx, ry: rx * (0.32 + Math.random() * 0.14), tilt: -0.45 + Math.random() * 0.9,
    spin: (Math.random() - 0.5) * 0.0012, vy: 0.05 + Math.random() * 0.12,
    ang: Math.random() * 6.28, espd: 0.008 + Math.random() * 0.02,
    nuc: 1.4 + Math.random() * 1.4, el: 1 + Math.random() * 1.2,
    ph: Math.random() * 6.28, a: 0.28 + Math.random() * 0.3,
    tint: ATOM_TINTS[(Math.random() * ATOM_TINTS.length) | 0] };
}
function seedDustSparkle(c) {
  // Four-point starburst that breathes rather than travels.
  return { kind: 'sparkle', x: Math.random() * c.width, y: Math.random() * c.height,
    r: 3 + Math.random() * 7, vy: 0.04 + Math.random() * 0.08, ph: Math.random() * 6.28,
    sp: 0.5 + Math.random() * 1.1, a: 0.2 + Math.random() * 0.28,
    tint: ATOM_TINTS[(Math.random() * ATOM_TINTS.length) | 0] };
}
function initAmbient() {
  stopAmbient();
  if (!fxOn('ambient') || !motionOk() || typeof document === 'undefined' || !document.body) return;
  const theme = (document.documentElement.dataset || {}).theme || 'neon';
  const c = document.createElement('canvas');
  c.id = 'dust';
  c.setAttribute('aria-hidden', 'true');
  document.body.prepend(c);
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  dustCanvas = c;
  const lively = (S.fx.dust || 'subtle') === 'lively';
  if (theme === 'atompunk') {
    // Fewer, bigger pieces — orbits need room to read as orbits.
    const n = lively ? 34 : 20, orbits = lively ? 22 : 13, sparkles = lively ? 7 : 4;
    for (let i = 0; i < n; i++) {
      dustParts.push(i < orbits ? seedDustOrbit(c) : i < orbits + sparkles ? seedDustSparkle(c)
        : { ...seedDustDot(c, ATOM_TINTS[(Math.random() * ATOM_TINTS.length) | 0]), a: 0.1 + Math.random() * 0.2 });
    }
  } else {
    const n = lively ? 110 : 45;
    const tint = DUST_TINTS[theme] || DUST_TINTS.neon;
    for (let i = 0; i < n; i++) dustParts.push(seedDustDot(c, tint));
  }
  dustRaf = raf(dustTick);
}
function drawDustSparkle(ctx, p, tw) {
  // Long thin diamond: the mid-century starburst in one path.
  const r = p.r * (0.75 + 0.25 * tw);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - r); ctx.quadraticCurveTo(p.x, p.y, p.x + r * 0.22, p.y);
  ctx.quadraticCurveTo(p.x, p.y, p.x, p.y + r);
  ctx.quadraticCurveTo(p.x, p.y, p.x - r * 0.22, p.y);
  ctx.quadraticCurveTo(p.x, p.y, p.x, p.y - r);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - r * 0.7, p.y); ctx.lineTo(p.x + r * 0.7, p.y);
  ctx.moveTo(p.x, p.y - r * 0.7); ctx.lineTo(p.x, p.y + r * 0.7);
  ctx.stroke();
}
function dustTick(t) {
  const c = dustCanvas;
  const ctx = c && c.getContext ? c.getContext('2d') : null;
  if (!ctx) { dustRaf = 0; return; }
  dustRaf = raf(dustTick);
  ctx.clearRect(0, 0, c.width, c.height);
  const now = (t || 0) / 1000;
  for (const p of dustParts) {
    const tw = 0.7 + 0.3 * Math.sin(now * (p.sp || 0.6) * 1.7 + p.ph);
    if (p.kind === 'orbit') {
      p.y -= p.vy; p.tilt += p.spin || 0; p.ang += p.espd;
      if (p.y < -p.rx - 6) { p.y = c.height + p.rx + 6; p.x = Math.random() * c.width; }
      const ex = p.x + Math.cos(p.ang) * p.rx, ey = p.y + Math.sin(p.ang) * p.ry;
      ctx.globalAlpha = p.a * tw;
      ctx.strokeStyle = p.tint; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, p.rx, p.ry, p.tilt, 0, 6.29); ctx.stroke();
      ctx.fillStyle = p.tint;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.nuc, 0, 6.29); ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, p.el, 0, 6.29); ctx.fill();
    } else if (p.kind === 'sparkle') {
      p.y -= p.vy;
      if (p.y < -14) { p.y = c.height + 14; p.x = Math.random() * c.width; }
      ctx.globalAlpha = p.a * tw;
      ctx.strokeStyle = p.tint; ctx.lineWidth = 1;
      drawDustSparkle(ctx, p, tw);
    } else {
      p.y -= p.vy; p.x += Math.sin(now * p.sp + p.ph) * 0.15;
      if (p.y < -4) { p.y = c.height + 4; p.x = Math.random() * c.width; }
      ctx.globalAlpha = p.a * tw;
      ctx.fillStyle = p.tint;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* Live countdown to a due date. Ticking is owned by the milestones view. */
function fmtCountdown(dueIso, nowMs = Date.now()) {
  if (!dueIso) return '';
  let s = Math.floor((new Date(dueIso) - nowMs) / 1000);
  const past = s < 0; s = Math.abs(s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60), sec = s % 60;
  const body = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  return (past ? 'T+' : 'T-') + body;
}

/* Shipping streaks from closed timestamps. Pure: weeks bucket Monday-Sunday. */
function shipStreaks(times) {
  const keys = [...new Set((times || []).map(v => dayKey(v)))];
  if (!keys.length) return { current: 0, longest: 0, bestWeek: 0, total: (times || []).length };
  const DAY = 864e5;
  const nums = keys.map(k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m, d).getTime(); })
    .sort((a, b) => a - b);
  let longest = 1, run = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] - nums[i - 1] === DAY) { run++; longest = Math.max(longest, run); }
    else run = 1;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let current = 0;
  if (today.getTime() - nums[nums.length - 1] <= DAY) {
    current = 1;
    for (let i = nums.length - 1; i > 0 && nums[i] - nums[i - 1] === DAY; i--) current++;
  }
  const weeks = {};
  for (const v of (times || [])) {
    const d = new Date(v), monday = new Date(d);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = dayKey(monday);
    weeks[k] = (weeks[k] || 0) + 1;
  }
  return { current, longest, bestWeek: Math.max(...Object.values(weeks)), total: (times || []).length };
}

/* ---------- the kea ----------
   A sidebar parrot fed by shipped tasks. Happiness decays 12/day away, a
   close is +8, a pat is +2. All state is local; the bird knows nothing. */
const DEFAULT_PET = { name: "Kiri", happy: 70, treats: 0, seen: null };
S.pet = { ...DEFAULT_PET, ...store.get("pet", {}) };
function applyPetDecay(now = Date.now()) {
  if (S.pet.seen) {
    const days = Math.floor((now - S.pet.seen) / 864e5);
    if (days > 0) S.pet.happy = Math.max(0, S.pet.happy - days * 12);
  }
  S.pet.seen = now;
  store.set("pet", S.pet);
}
applyPetDecay();

const petSleeping = (h = new Date().getHours()) => h < 6;
function petMood() {
  if (petSleeping()) return "sleeping";
  const h = S.pet.happy;
  return h >= 70 ? "playful" : h >= 35 ? "content" : "grumpy";
}
const PET_TITLES = [[0, "Hatchling"], [10, "Fledgling"], [30, "Kea"], [75, "Alpine ace"]];
const petTitle = () => petTitleFor(petKind() === "droid" ? "droid" : "kea");
function savePet() { S.pet.seen = Date.now(); store.set("pet", S.pet); }
// Shipping a task is a treat. Pats are affection with a cooldown.
function feedPet(n = 8) {
  S.pet.happy = Math.min(100, S.pet.happy + n);
  S.pet.treats++;
  savePet(); paintPet(true);
}
let lastPatToast = 0;
function patPet() {
  if (petKind() === "droid") { boopDroid(); return; }
  const el = typeof document !== "undefined" ? document.getElementById("pet") : null;
  if (el && el.classList) {
    el.classList.remove("is-hop");
    void el.offsetWidth;
    el.classList.add("is-hop");
    setTimeout(() => el.classList && el.classList.remove("is-hop"), 550);
  }
  if (petSleeping()) { toast("Shhh — " + S.pet.name + " is asleep. Back after 6am."); return; }
  const now = Date.now();
  S.pet.happy = Math.min(100, S.pet.happy + 2);
  savePet(); paintPet();
  if (now - lastPatToast < 6000) return;
  lastPatToast = now;
  const lines = { playful: "does a loop-the-loop", content: "leans into it", grumpy: "tolerates this. Barely." };
  toast(S.pet.name + " " + (lines[petMood()] || lines.content) + " · " + petTitle() + " · " + S.pet.treats + " treats");
}
function paintPet(bounce = false) {
  if (typeof document === "undefined") return;
  paintDroid(bounce);
  const el = document.getElementById("pet");
  if (!el) return;
  el.style.display = (fxOn("pet") && petKind() === "kea") ? "" : "none";
  const mood = petMood();
  el.classList.toggle("is-sleeping", mood === "sleeping");
  el.classList.toggle("is-grumpy", mood === "grumpy");
  if (bounce && mood !== "sleeping") {
    el.classList.remove("is-hop");
    void el.offsetWidth;
    el.classList.add("is-hop");
    setTimeout(() => el.classList && el.classList.remove("is-hop"), 550);
  }
  const nm = document.getElementById("petName");
  if (nm) nm.textContent = S.pet.name;
  el.title = S.pet.name + " · " + petTitle() + " · " + mood + " · " + S.pet.treats + " treats (click to pat)";
}

/* ---------- pet flights ----------
   Every 25–50s the kea stretches its wings: a twin lifts off the sidebar
   perch, wanders the viewport, and lands back home. Gated by the wander
   toggle, sleep, hidden tabs and reduced motion; silent by design. */
let petFlying = false;
function petFlightPath(w, h, n = 4) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: w * (0.08 + Math.random() * 0.8), y: h * (0.12 + Math.random() * 0.66) });
  return pts;
}
function shouldFlyPet() {
  return fxOn("pet") && petKind() === "kea" && (S.fx && S.fx.wander !== false) && motionOk() && !petSleeping() &&
    typeof document !== "undefined" && !document.hidden && !petFlying;
}
function schedulePetFlight() {
  if (typeof window === "undefined" || !window.setTimeout) return;
  window.setTimeout(() => {
    if (shouldFlyPet()) flyPet();
    schedulePetFlight();
  }, 25000 + Math.random() * 25000);
}
function flyPet() {
  const perch = document.getElementById("pet");
  const svg = perch && perch.querySelector ? perch.querySelector("svg") : null;
  if (!perch || !svg || !perch.getBoundingClientRect) return;
  petFlying = true;
  perch.style.visibility = "hidden";
  const box = perch.getBoundingClientRect();
  const twin = document.createElement("div");
  twin.id = "petFly";
  twin.className = "is-flying";
  twin.setAttribute("aria-hidden", "true");
  twin.appendChild(svg.cloneNode(true));
  document.body.appendChild(twin);
  const home = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const pts = [...petFlightPath(window.innerWidth, window.innerHeight), home];
  let x = home.x, y = home.y, leg = 0, last = null;
  const SPEED = 240;
  const step = (t) => {
    if (!document.getElementById("petFly")) { petFlying = false; return; }
    if (last === null) last = t || 0;
    const dt = Math.min(0.05, (((t || 0) - last) / 1000) || 0.016);
    last = t || 0;
    const target = pts[leg];
    const dx = target.x - x, dy = target.y - y, dist = Math.hypot(dx, dy) || 1;
    if (dist < 14) {
      leg++;
      if (leg >= pts.length) { landPet(twin, perch); return; }
    } else {
      x += dx / dist * SPEED * dt; y += dy / dist * SPEED * dt;
    }
    twin.style.transform = "translate(" + (x - 28) + "px," + (y - 28) + "px)";
    const inner = twin.firstChild;
    if (inner && inner.style) inner.style.transform = "rotate(" + Math.max(-18, Math.min(18, dx / dist * 22)) + "deg)";
    raf(step);
  };
  raf(step);
}
function landPet(twin, perch) {
  twin.style.opacity = "0";
  setTimeout(() => { if (twin.parentNode) twin.parentNode.removeChild(twin); }, 450);
  perch.style.visibility = "";
  petFlying = false;
}

/* ---------- the droid ----------
   The kea's stablemate: a round roller that patrols the bottom of the
   screen instead of perching. Same happiness/treats ledger, different job —
   shipping makes it spin, its antenna light shows its mood, and at night it
   parks and dims. Pure CSS motion; JS only mounts it and spins it. */
const PET_KINDS = { kea: "Kea parrot", droid: "Rollo roller" };
function petKind() {
  if (S.fx && S.fx.pet === false) return "off";
  const k = S.pet && S.pet.kind;
  return PET_KINDS[k] ? k : "kea";
}
const DROID_TITLES = [[0, "Bolt"], [10, "Roller"], [25, "Ranger"], [75, "High roller"]];
function petTitleFor(kind) {
  const ladder = kind === "droid" ? DROID_TITLES : PET_TITLES;
  let t = ladder[0][1];
  for (const [n, name] of ladder) if (S.pet.treats >= n) t = name;
  return t;
}
function droidSVG() {
  return '<svg viewBox="0 0 64 64" aria-hidden="true">' +
    '<g class="droid-ball">' +
    '<circle cx="32" cy="38" r="19" class="droid-shell"/>' +
    '<path d="M13 38 a19 19 0 0 1 38 0" class="droid-band"/>' +
    '<circle cx="32" cy="38" r="6.5" class="droid-hub"/>' +
    '<circle cx="32" cy="38" r="2.4" class="droid-core"/>' +
    '<circle cx="20" cy="30" r="2.6" class="droid-dot"/>' +
    '<circle cx="44" cy="46" r="2.6" class="droid-dot"/>' +
    '</g>' +
    '<g class="droid-dome">' +
    '<path d="M20 24 a12 12 0 0 1 24 0 Z" class="droid-dome-cap"/>' +
    '<rect x="28" y="13" width="8" height="4" rx="1.5" class="droid-lens"/>' +
    '<line x1="40" y1="12" x2="40" y2="5" class="droid-antenna"/>' +
    '<circle cx="40" cy="4.5" r="1.8" class="droid-light"/>' +
    '</g></svg>';
}
function paintDroid(bounce = false) {
  if (typeof document === "undefined" || !document.body) return;
  let el = document.getElementById("petDroid");
  if (petKind() !== "droid") {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "petDroid";
    el.setAttribute("aria-hidden", "false");
    el.innerHTML = droidSVG() + '<span class="droid-name" id="petDroidName"></span>';
    el.addEventListener("click", () => patPet());
    document.body.appendChild(el);
  }
  const mood = petMood();
  el.classList.toggle("is-sleeping", mood === "sleeping");
  el.classList.toggle("mood-" + mood, true);
  for (const m of ["playful", "content", "grumpy", "sleeping"]) if (m !== mood) el.classList.toggle("mood-" + m, false);
  if (bounce && mood !== "sleeping") {
    el.classList.remove("is-spin");
    void el.offsetWidth;
    el.classList.add("is-spin");
    setTimeout(() => el.classList && el.classList.remove("is-spin"), 700);
  }
  const nm = document.getElementById("petDroidName");
  if (nm) nm.textContent = S.pet.name;
  el.title = S.pet.name + " · " + petTitleFor("droid") + " · " + mood + " · " + S.pet.treats + " charges (click to boop)";
}
function boopDroid() {
  if (petSleeping()) { toast("Shhh — " + S.pet.name + " is parked for the night."); return; }
  const now = Date.now();
  S.pet.happy = Math.min(100, S.pet.happy + 2);
  savePet(); paintDroid(true);
  if (now - lastPatToast < 6000) return;
  lastPatToast = now;
  const beeps = ["Beep-boop!", "Bwoop-bee-doop!", "Beee-doo!"];
  toast(beeps[S.pet.treats % beeps.length] + " · " + petTitle() + " · " + S.pet.treats + " charges");
}
