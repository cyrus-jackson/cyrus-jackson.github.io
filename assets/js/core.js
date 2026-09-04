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
];

const IDEA_LABEL = 'idea';
const DEFAULT_STALE_DAYS = 10;

/* ---------- duration ----------
   GitHub issues carry no estimate field, so an estimate is stored as an
   `est:<n>d` label: native, visible on github.com, filterable there, and no
   extra API surface. Actual duration is never stored — it is derived from
   created_at and closed_at, so it cannot drift out of date.

   That derived figure is created -> done, which is lead time, not cycle time.
   An issue records no "work started" moment, so time spent sitting in the
   backlog is included. The UI says "created to done" for that reason. */
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

