/* ============================================================
   Kea Tracker — app.js
   A static, GitHub-backed board. No build step, no backend.
   Part 1/3: state, utils, markdown, API, themes, chrome.
   ============================================================ */
(() => {
'use strict';

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
  const open = S.issues.filter(i => i.state === 'open').length;
  $('#cntBoard').textContent = open || '';
  $('#cntPrs').textContent = S.prs.filter(p => p.state === 'open').length || '';
  $('#cntInsp').textContent = S.inspiration.length || '';
  $('#cntMs').textContent = S.milestones.filter(m => m.state === 'open').length || '';
  $('#cntIdeas').textContent = S.issues.filter(isIdea).length || '';
  $('#cntAssets').textContent = (S.assetList || []).length || '';
}

/* ============================================================
   Part 2/3: data loading, board, drag & drop, task modal
   ============================================================ */

function colOf(issue) {
  if (issue.state === 'closed' && S.closeOnDone) return 'done';
  const names = (issue.labels || []).map(l => String(l.name || l).toLowerCase());
  for (const c of S.columns) if (names.includes(c.label.toLowerCase())) return c.id;
  return S.columns[0].id;
}

function prLinks() {
  const map = {};
  for (const p of S.prs) {
    const nums = new Set();
    for (const m of ((p.title || '') + ' ' + (p.body || '')).matchAll(/#(\d{1,6})/g)) nums.add(+m[1]);
    const br = (p.head && p.head.ref) || '';
    const bm = br.match(/(?:^|[/_-])(\d{1,5})(?:[/_-]|$)/);
    if (bm) nums.add(+bm[1]);
    for (const n of nums) (map[n] = map[n] || []).push(p);
  }
  return map;
}

const isIdea = i => (i.labels || []).some(l => String(l.name || l).toLowerCase() === IDEA_LABEL);

// Days since anything touched the issue. Not the same as days in this column —
// any edit bumps updated_at — so it is labelled "idle", not "in progress for".
function idleDays(i) {
  return Math.floor((Date.now() - new Date(i.updated_at)) / 864e5);
}

const prState = p => p.draft ? 'draft' : p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';

/* ---------- loading ---------- */
function setLoading(on) {
  S.loading = on;
  $('#btnRefresh').classList.toggle('is-spinning', on);
}

function listPaths() {
  const { owner, repo } = repoNow();
  return {
    issues: `/repos/${owner}/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`,
    milestones: `/repos/${owner}/${repo}/milestones?state=all&per_page=100&sort=due_on`,
    pulls:  `/repos/${owner}/${repo}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
    labels: `/repos/${owner}/${repo}/labels?per_page=100`,
  };
}

// Paint from the last response we stored before the network answers. The
// revalidation that follows usually comes back 304, so this costs nothing.
function hydrateFromCache() {
  if (!S.token) return false;
  const u = listPaths();
  const iss = httpCache[API + u.issues], pr = httpCache[API + u.pulls];
  const lb = httpCache[API + u.labels], ms = httpCache[API + u.milestones];
  if (!iss || !Array.isArray(iss.data)) return false;
  S.issues = iss.data.filter(i => !i.pull_request);
  S.prs    = pr && Array.isArray(pr.data) ? pr.data : [];
  S.labels = lb && Array.isArray(lb.data) ? lb.data : [];
  S.milestones = ms && Array.isArray(ms.data) ? ms.data : [];
  S.demo = false;
  return true;
}

async function loadAll({ quiet = false, force = false } = {}) {
  if (!S.token) { loadDemo(); return; }
  const { owner, repo } = repoNow();
  if (!owner || !repo) return;
  // An implicit reload within 30s of the last one buys nothing; explicit
  // refresh always goes through.
  if (!force && S.lastLoad && S.lastLoad.key === repoKey() && Date.now() - S.lastLoad.t < 30000) return;
  setLoading(true);
  try {
    const u = listPaths();
    const [issues, prs, labels, milestones] = await Promise.all([
      ghAll(u.issues, 3),
      ghAll(u.pulls, 2),
      ghGet(u.labels).catch(() => []),
      ghGet(u.milestones).catch(() => []),
    ]);
    S.demo = false;
    S.issues = issues.filter(i => !i.pull_request);
    S.prs    = prs || [];
    S.labels = labels || [];
    S.milestones = milestones || [];
    $('#demoBanner')?.remove();
    S.lastLoad = { key: repoKey(), t: Date.now() };
    S.docs = null; S.docCache = {}; S.doc = null; S.assetList = null; S.assetDir = '';
    S.checksLoaded = false;
    if (!quiet) toast(`Loaded ${S.issues.length} tasks · ${S.prs.length} PRs`, 'ok');
    if (S.view === 'prs') loadChecks();
  } catch (e) {
    if (e.status === 401) toast('GitHub rejected the token — check Settings', 'err');
    else if (e.status === 404) toast(`Repo ${owner}/${repo} not found (or token lacks access)`, 'err');
    else toast(e.message || 'Failed to load', 'err');
    S.issues = []; S.prs = []; S.labels = [];
  } finally {
    setLoading(false);
    paintCounts(); render();
  }
}

async function loadChecks() {
  if (S.checksLoaded || !S.token) return;
  S.checksLoaded = true;
  const { owner, repo } = repoNow();
  const open = S.prs.filter(p => p.state === 'open').slice(0, 12);
  await Promise.all(open.map(async p => {
    try {
      const d = await ghGet(`/repos/${owner}/${repo}/commits/${p.head.sha}/check-runs?per_page=40`);
      const runs = (d && d.check_runs) || [];
      if (!runs.length) return;
      const fail = runs.filter(r => ['failure','timed_out','cancelled','action_required'].includes(r.conclusion)).length;
      const pend = runs.filter(r => r.status !== 'completed').length;
      S.checks[p.number] = { total: runs.length, fail, pend, ok: runs.length - fail - pend };
    } catch {}
  }));
  if (S.view === 'prs') renderPRs();
}

/* ---------- filtering ---------- */
function visibleIssues() {
  const q = S.q.trim().toLowerCase();
  return S.issues.filter(i => {
    if (isIdea(i)) return false;
    if (S.msFilter === 'none' && i.milestone) return false;
    if (S.msFilter && S.msFilter !== 'none' && (!i.milestone || String(i.milestone.number) !== S.msFilter)) return false;
    if (q) {
      const hay = `#${i.number} ${i.title} ${i.body || ''} ${(i.labels||[]).map(l=>l.name||l).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (S.filters.length) {
      const names = (i.labels || []).map(l => l.name || l);
      if (!S.filters.every(f => names.includes(f))) return false;
    }
    return true;
  });
}

function renderFilters() {
  const statusLabels = new Set(S.columns.map(c => c.label.toLowerCase()));
  const used = new Map();
  for (const i of S.issues) for (const l of (i.labels || [])) {
    const n = l.name || l; if (statusLabels.has(String(n).toLowerCase())) continue;
    used.set(n, l.color || '888888');
  }
  const openMs = S.milestones.filter(m => m.state === 'open');
  const msPicker = (S.view === 'board' && openMs.length) ? `
    <select class="select filter-ms" id="msFilter">
      <option value="">All milestones</option>
      ${openMs.map(m => `<option value="${m.number}" ${S.msFilter === String(m.number) ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}
      <option value="none" ${S.msFilter === 'none' ? 'selected' : ''}>No milestone</option>
    </select>` : '';

  const show = S.view === 'board' && (used.size || openMs.length);
  $('#filters').innerHTML = !show ? '' : msPicker +
    [...used].slice(0, 14).map(([n, c]) =>
      `<button class="chip ${S.filters.includes(n) ? 'is-on' : ''}" data-act="filter" data-label="${attr(n)}">
         <i class="sw" style="background:#${esc(c)}"></i>${esc(n)}</button>`).join('')
    + (S.filters.length ? `<button class="chip" data-act="filter-clear">Clear</button>` : '');
  const msf = $('#msFilter');
  if (msf) msf.onchange = () => { S.msFilter = msf.value; renderBoard(); };
}

/* ---------- board ---------- */
function cardHTML(i, links) {
  const cover = firstImage(i.body);
  const tp    = taskProgress(i.body);
  const prs   = (links[i.number] || []).slice(0, 3);
  const statusLabels = new Set(S.columns.map(c => c.label.toLowerCase()));
  const labels = (i.labels || []).filter(l => !statusLabels.has(String(l.name || l).toLowerCase())).slice(0, 4);
  const done = i.state === 'closed';
  return `
  <article class="card" data-num="${i.number}" tabindex="0">
    ${cover ? `<div class="card-cover"><img src="${attr(cover)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></div>` : ''}
    <div class="card-top">
      <span class="card-num">#${i.number}</span>
      ${done && !S.closeOnDone ? `<span class="pr-pill s-done"><svg><use href="#i-check"/></svg>closed</span>` : ''}
    </div>
    <div class="card-title ${done ? 'is-done' : ''}">${esc(i.title)}</div>
    ${labels.length ? `<div class="card-labels">${labels.map(l =>
      `<span class="lbl" style="${labelStyle(l.color)}">${esc(l.name || l)}</span>`).join('')}</div>` : ''}
    ${tp ? `<div class="prog" title="${tp.done}/${tp.total} subtasks"><i style="width:${Math.round(tp.done/tp.total*100)}%"></i></div>` : ''}
    ${prs.length ? `<div class="card-labels">${prs.map(p =>
      `<a class="pr-pill s-${prState(p)}" href="${attr(p.html_url)}" target="_blank" rel="noopener" title="${attr(p.title)}">
         <svg><use href="#i-pr"/></svg>#${p.number}</a>`).join('')}</div>` : ''}
    <div class="card-foot">
      ${(() => {
        const d = idleDays(i);
        const mid = ['progress', 'review'].includes(colOf(i));
        const limit = +S.staleDays > 0 ? +S.staleDays : DEFAULT_STALE_DAYS;
        return mid && d >= limit
          ? `<span class="stale" title="No activity for ${d} days">idle ${d}d</span>` : '';
      })()}
      ${i.comments ? `<span title="comments">${i.comments} 💬</span>` : ''}
      ${i.milestone ? `<span class="card-ms" title="Milestone"><svg><use href="#i-flag"/></svg>${esc(i.milestone.title)}</span>` : ''}
      <span class="spacer"></span>
      <span>${ago(i.updated_at)}</span>
      ${i.assignee ? `<img class="avatar" src="${attr(i.assignee.avatar_url)}" alt="${attr(i.assignee.login)}" title="${attr(i.assignee.login)}">` : ''}
    </div>
  </article>`;
}

function renderBoard() {
  const links = prLinks();
  const groups = {}; S.columns.forEach(c => groups[c.id] = []);
  for (const i of visibleIssues()) (groups[colOf(i)] = groups[colOf(i)] || []).push(i);

  const ord = S.order[repoKey()] || {};
  for (const c of S.columns) {
    const idx = ord[c.id] || [];
    groups[c.id].sort((a, b) => {
      const ia = idx.indexOf(a.number), ib = idx.indexOf(b.number);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return new Date(b.updated_at) - new Date(a.updated_at);
    });
  }
  if (groups.done) groups.done = groups.done.slice(0, 40);

  $('#board').innerHTML = S.columns.map(c => `
    <section class="col" data-col="${c.id}" style="--col:${c.color}">
      <div class="col-head">
        <i class="col-bar"></i><h3>${esc(c.name)}</h3><span class="n">${groups[c.id].length}</span>
      </div>
      <div class="col-body" data-list="${c.id}">${groups[c.id].map(i => cardHTML(i, links)).join('')}</div>
      <button class="col-add" data-act="new" data-col="${c.id}"><svg><use href="#i-plus"/></svg>Add task</button>
    </section>`).join('');

  if (!S.issues.length) {
    $('#board').innerHTML = `<div class="empty" style="width:100%">
      <svg><use href="#i-board"/></svg><h3>Nothing here yet</h3>
      <p>${S.token ? 'This repository has no issues. Create your first task with the New button.'
                   : 'Connect a GitHub token in Settings to load your real issues, or explore the demo data.'}</p></div>`;
  }
}

/* ---------- moving cards ---------- */
function persistOrder(colId, nums) {
  const k = repoKey();
  S.order[k] = S.order[k] || {};
  S.order[k][colId] = nums;
  store.set('order', S.order);
}

async function moveIssue(num, toCol, index) {
  const issue = S.issues.find(i => i.number === num);
  if (!issue) return;
  const col = S.columns.find(c => c.id === toCol);
  const from = colOf(issue);

  // remember manual order in the destination column
  const dest = [...$$(`[data-list="${toCol}"] .card`)].map(el => +el.dataset.num);
  persistOrder(toCol, dest);
  if (from === toCol) return;

  const statusLabels = new Set(S.columns.map(c => c.label.toLowerCase()));
  const keep = (issue.labels || []).map(l => l.name || l).filter(n => !statusLabels.has(String(n).toLowerCase()));
  const body = { labels: [...keep, col.label] };
  if (S.closeOnDone) body.state = toCol === 'done' ? 'closed' : 'open';

  // optimistic
  const prev = { labels: issue.labels, state: issue.state };
  issue.labels = body.labels.map(n => ({ name: n, color: (S.labels.find(l => l.name === n) || {}).color || '5a6470' }));
  if (body.state) issue.state = body.state;
  renderBoard(); paintCounts();

  if (S.demo) return;
  try {
    const { owner, repo } = repoNow();
    const r = await gh(`/repos/${owner}/${repo}/issues/${num}`, { method: 'PATCH', body });
    Object.assign(issue, r.data);
    toast(`#${num} → ${col.name}`, 'ok');
  } catch (e) {
    Object.assign(issue, prev);
    renderBoard();
    toast(`Could not move #${num}: ${e.message}`, 'err');
  }
}

/* ---------- generic pointer drag & drop ---------- */
function initDnD({ root, itemSel, listSel, onDrop, axisScroll }) {
  let st = null;
  const ghost = $('#dragGhost');

  const listsUnder = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest(listSel) : null;
  };

  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const item = e.target.closest(itemSel);
    if (!item || !root.contains(item)) return;
    if (e.target.closest('a,button,input,textarea,select')) return;
    st = { item, sx: e.clientX, sy: e.clientY, id: e.pointerId, active: false, from: item.closest(listSel) };
  });

  const move = e => {
    if (!st || e.pointerId !== st.id) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) < 6) return;
      st.active = true;
      const r = st.item.getBoundingClientRect();
      st.ox = st.sx - r.left; st.oy = st.sy - r.top;
      const clone = st.item.cloneNode(true);
      clone.classList.remove('is-dragging');
      clone.style.margin = '0';
      ghost.innerHTML = ''; ghost.appendChild(clone);
      ghost.style.width = r.width + 'px'; ghost.hidden = false;
      st.item.classList.add('is-dragging');
      st.ph = document.createElement('div'); st.ph.className = 'drop-line';
      document.body.style.userSelect = 'none';
      try { st.item.setPointerCapture(e.pointerId); } catch {}
    }
    e.preventDefault();
    ghost.style.left = (e.clientX - st.ox) + 'px';
    ghost.style.top  = (e.clientY - st.oy) + 'px';

    const list = listsUnder(e.clientX, e.clientY) || st.ph.parentNode || st.from;
    if (!list) return;
    $$('.drop-target').forEach(c => c.classList.remove('drop-target'));
    const colEl = list.closest('.col'); if (colEl) colEl.classList.add('drop-target');

    const kids = [...list.children].filter(c => c !== st.item && c !== st.ph && c.matches(itemSel));
    let before = null;
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = k; break; }
    }
    list.insertBefore(st.ph, before);

    if (axisScroll) {
      const box = axisScroll.getBoundingClientRect();
      if (e.clientX > box.right - 70) axisScroll.scrollLeft += 14;
      else if (e.clientX < box.left + 70) axisScroll.scrollLeft -= 14;
    }
    const lr = list.getBoundingClientRect();
    if (e.clientY > lr.bottom - 40) list.scrollTop += 10;
    else if (e.clientY < lr.top + 40) list.scrollTop -= 10;
  };

  const up = e => {
    if (!st || (e && e.pointerId !== undefined && e.pointerId !== st.id)) return;
    const s = st; st = null;
    if (!s.active) return;
    ghost.hidden = true; ghost.innerHTML = '';
    document.body.style.userSelect = '';
    s.item.classList.remove('is-dragging');
    $$('.drop-target').forEach(c => c.classList.remove('drop-target'));
    window.__dragEnd = Date.now();
    const list = s.ph.parentNode;
    if (list) {
      list.insertBefore(s.item, s.ph);
      s.ph.remove();
      const index = [...list.children].filter(c => c.matches(itemSel)).indexOf(s.item);
      onDrop(s.item, list, index, s.from);
    } else { s.ph.remove(); }
  };

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* ============================================================
   Part 3/3: modals, PRs, inspiration, progress, settings, init
   ============================================================ */

/* ---------- modal ---------- */
function escClose(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  const r = $('#modalRoot'); r.hidden = true; r.innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
function openModal(html, { wide = false, slim = false } = {}) {
  const root = $('#modalRoot');
  root.className = 'modal-root' + (slim ? ' top' : '');
  root.innerHTML = `<div class="modal${wide ? ' wide' : ''}${slim ? ' slim' : ''}">${html}</div>`;
  root.hidden = false;
  root.onclick = e => { if (e.target === root) closeModal(); };
  document.addEventListener('keydown', escClose);
  return root.firstElementChild;
}
const modalHead = title => `
  <div class="modal-head"><h2>${title}</h2>
    <button class="icon-btn" data-act="close"><svg><use href="#i-x"/></svg></button></div>`;

/* ---------- image upload ---------- */
async function uploadImage(file) {
  if (!S.token) throw new Error('Connect a GitHub token first (Settings)');
  if (file.size > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB');
  const a = assetCfg();
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-60);
  const path = `${a.dir}/${Date.now()}-${safe}`.replace(/^\/+/, '');
  const buf = await file.arrayBuffer();
  await gh(`/repos/${a.owner}/${a.repo}/contents/${path}`, {
    method: 'PUT',
    body: { message: `tracker: upload ${safe}`, content: bufToB64(buf), branch: a.branch },
  });
  return `https://raw.githubusercontent.com/${a.owner}/${a.repo}/${a.branch}/${path}`;
}

function wirePaste(scope, textarea, onUrl) {
  scope.addEventListener('paste', async e => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const mark = `![uploading ${esc(f.name || 'screenshot')}…]()`;
      insertAtCursor(textarea, mark);
      try {
        const url = await uploadImage(f);
        textarea.value = textarea.value.replace(mark, `![](${url})`);
        if (onUrl) onUrl(url);
        toast('Screenshot uploaded', 'ok');
      } catch (err) {
        textarea.value = textarea.value.replace(mark, '');
        toast(err.message, 'err');
      }
    }
  });
}

function insertAtCursor(el, text) {
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + text + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + text.length;
  el.focus();
}

function wireDropzone(zone, onUrl) {
  const pick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = () => handle([...inp.files]);
    inp.click();
  };
  async function handle(files) {
    for (const f of files.filter(f => f.type.startsWith('image/'))) {
      zone.textContent = `Uploading ${f.name}…`;
      try { onUrl(await uploadImage(f), f.name); toast('Image uploaded', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }
    zone.innerHTML = zone.dataset.idle;
  }
  zone.dataset.idle = zone.innerHTML;
  zone.addEventListener('click', pick);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('hot'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('hot'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('hot'); handle([...e.dataTransfer.files]); });
}

/* ---------- task modal ---------- */
async function openTask(num) {
  const issue = S.issues.find(i => i.number === num);
  if (!issue) return;
  const { owner, repo } = repoNow();
  const linked = (prLinks()[num] || []);
  const statusLabels = new Set(S.columns.map(c => c.label.toLowerCase()));
  const cur = colOf(issue);

  const m = openModal(`
    ${modalHead(`<span class="mono" style="color:var(--fg-faint)">#${num}</span> &nbsp;${esc(issue.title)}`)}
    <div class="modal-body">
      <div class="field">
        <label>Title</label>
        <input class="input" id="tTitle" value="${attr(issue.title)}">
      </div>
      <div class="row" style="margin-bottom:13px">
        <div class="field" style="margin:0;flex:0 0 190px">
          <label>Column</label>
          <select class="select" id="tCol">${S.columns.map(c =>
            `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="field" style="margin:0;flex:0 0 200px">
          <label>Milestone</label>
          <select class="select" id="tMs">
            <option value="">None</option>
            ${S.milestones.filter(x => x.state === 'open' || (issue.milestone && x.number === issue.milestone.number))
              .map(x => `<option value="${x.number}" ${issue.milestone && issue.milestone.number === x.number ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin:0;flex:1;min-width:200px">
          <label>Labels</label>
          <div class="row" id="tLabels" style="gap:5px">${
            S.labels.filter(l => !statusLabels.has(l.name.toLowerCase())).map(l => {
              const on = (issue.labels || []).some(x => (x.name || x) === l.name);
              return `<button class="chip ${on ? 'is-on' : ''}" data-lbl="${attr(l.name)}">
                        <i class="sw" style="background:#${esc(l.color)}"></i>${esc(l.name)}</button>`;
            }).join('') || '<span class="hint">No labels in this repo yet.</span>'}</div>
        </div>
      </div>

      <div class="tabs"><button class="tab is-on" data-tab="view">Description</button><button class="tab" data-tab="edit">Edit</button></div>
      <div id="tView" class="md">${md(issue.body, { tasks: true })}</div>
      <textarea class="textarea" id="tBody" hidden style="min-height:190px">${esc(issue.body || '')}</textarea>
      <div class="dropzone" id="tDrop" style="margin-top:11px" hidden>
        <svg style="vertical-align:-3px"><use href="#i-image"/></svg> Drop images here or click to upload — they are committed to your assets repo and linked in the description
      </div>

      ${linked.length ? `<div style="margin-top:18px"><div class="micro" style="margin-bottom:8px">Linked pull requests</div>
        <div class="pr-list">${linked.map(p => prRowHTML(p, true)).join('')}</div></div>` : ''}

      <div style="margin-top:20px">
        <div class="micro" style="margin-bottom:8px">Comments <span id="cCount"></span></div>
        <div id="tComments" class="md"><span style="color:var(--fg-faint)">Loading…</span></div>
        <textarea class="textarea" id="tNewComment" placeholder="Leave a comment…" style="min-height:70px;margin-top:9px"></textarea>
        <div class="row" style="justify-content:flex-end;margin-top:7px"><button class="btn btn-ghost btn-sm" id="tComment">Comment</button></div>
      </div>
    </div>
    <div class="modal-foot">
      <a class="btn btn-ghost" href="${attr(issue.html_url)}" target="_blank" rel="noopener"><svg><use href="#i-github"/></svg>Open on GitHub</a>
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="tSave"><svg><use href="#i-check"/></svg>Save</button>
    </div>`, { wide: true });

  const body = $('#tBody', m), view = $('#tView', m), drop = $('#tDrop', m);

  view.addEventListener('change', async e => {
    const box = e.target.closest('input[data-ti]');
    if (!box) return;
    const next = toggleTask(body.value, +box.dataset.ti);
    if (next === null) return;
    body.value = next;
    const tp = taskProgress(next);
    if (tp) toast(`${tp.done}/${tp.total} subtasks done`);
    if (S.demo) { issue.body = next; renderBoard(); return; }
    box.disabled = true;
    try {
      const r = await gh(`/repos/${owner}/${repo}/issues/${num}`, { method: 'PATCH', body: { body: next } });
      Object.assign(issue, r.data);
      renderBoard();
    } catch (err) {
      toast('Could not save: ' + err.message, 'err');
      body.value = toggleTask(next, +box.dataset.ti);
      box.checked = !box.checked;
    } finally { box.disabled = false; }
  });
  $$('.tab', m).forEach(t => t.onclick = () => {
    const edit = t.dataset.tab === 'edit';
    $$('.tab', m).forEach(x => x.classList.toggle('is-on', x === t));
    view.hidden = edit; body.hidden = !edit; drop.hidden = !edit;
    if (!edit) view.innerHTML = md(body.value, { tasks: true });
  });
  $$('#tLabels .chip', m).forEach(c => c.onclick = () => c.classList.toggle('is-on'));
  wireDropzone(drop, url => { body.value += `\n\n![](${url})\n`; });
  wirePaste(m, body);

  // comments
  (async () => {
    const box = $('#tComments', m);
    if (S.demo) { box.innerHTML = '<span style="color:var(--fg-faint)">Comments are disabled in demo mode.</span>'; return; }
    try {
      const cs = await ghGet(`/repos/${owner}/${repo}/issues/${num}/comments?per_page=50`);
      $('#cCount', m).textContent = cs.length ? `(${cs.length})` : '';
      box.innerHTML = cs.length ? cs.map(c => `
        <div style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:11px 13px;margin-bottom:8px;background:var(--sunken)">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:12px;color:var(--fg-faint)">
            <img class="avatar" src="${attr(c.user.avatar_url)}" alt=""><b style="color:var(--fg-dim)">${esc(c.user.login)}</b>${ago(c.created_at)}
          </div>${md(c.body)}</div>`).join('')
        : '<span style="color:var(--fg-faint)">No comments yet.</span>';
    } catch { box.innerHTML = '<span style="color:var(--fg-faint)">Could not load comments.</span>'; }
  })();

  $('#tComment', m).onclick = async () => {
    const txt = $('#tNewComment', m).value.trim();
    if (!txt || S.demo) return;
    try {
      await gh(`/repos/${owner}/${repo}/issues/${num}/comments`, { method: 'POST', body: { body: txt } });
      toast('Comment posted', 'ok'); closeModal(); loadAll({ quiet: true, force: true });
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#tSave', m).onclick = async () => {
    const chosen = $$('#tLabels .chip.is-on', m).map(c => c.dataset.lbl);
    const toCol = $('#tCol', m).value;
    const col = S.columns.find(c => c.id === toCol);
    const payload = { title: $('#tTitle', m).value.trim() || issue.title, body: body.value, labels: [...chosen, col.label] };
    const msSel = $('#tMs', m).value;
    const curMs = issue.milestone ? String(issue.milestone.number) : '';
    if (msSel !== curMs) payload.milestone = msSel ? +msSel : null;
    if (S.closeOnDone) payload.state = toCol === 'done' ? 'closed' : 'open';
    if (S.demo) {
      Object.assign(issue, payload, { labels: payload.labels.map(n => ({ name: n, color: '5a6470' })), updated_at: new Date().toISOString() });
      closeModal(); render(); return;
    }
    try {
      const r = await gh(`/repos/${owner}/${repo}/issues/${num}`, { method: 'PATCH', body: payload });
      Object.assign(issue, r.data);
      toast(`Saved #${num}`, 'ok'); closeModal(); render(); paintCounts();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- new task ---------- */
function openNewTask(colId, seed = '') {
  const { owner, repo } = repoNow();
  const statusLabels = new Set(S.columns.map(c => c.label.toLowerCase()));
  const m = openModal(`
    ${modalHead('New task')}
    <div class="modal-body">
      <div class="field"><label>Title</label><input class="input" id="nTitle" placeholder="What needs doing?" value="${attr(seed)}" autofocus></div>
      <div class="row" style="margin-bottom:13px">
        <div class="field" style="margin:0;flex:0 0 190px"><label>Column</label>
          <select class="select" id="nCol">${S.columns.map(c =>
            `<option value="${c.id}" ${c.id === (colId || 'todo') ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field" style="margin:0;flex:1;min-width:200px"><label>Labels</label>
          <div class="row" id="nLabels" style="gap:5px">${
            S.labels.filter(l => !statusLabels.has(l.name.toLowerCase())).map(l =>
              `<button class="chip" data-lbl="${attr(l.name)}"><i class="sw" style="background:#${esc(l.color)}"></i>${esc(l.name)}</button>`
            ).join('') || '<span class="hint">No labels yet.</span>'}</div></div>
      </div>
      <div class="field"><label>Description <span class="hint">— markdown, checklists and images all work</span></label>
        <textarea class="textarea" id="nBody" style="min-height:150px" placeholder="- [ ] first step&#10;- [ ] second step"></textarea></div>
      <div class="dropzone" id="nDrop"><svg style="vertical-align:-3px"><use href="#i-image"/></svg> Drop images here or click to upload</div>
    </div>
    <div class="modal-foot">
      <span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="nSave"><svg><use href="#i-plus"/></svg>Create task</button>
    </div>`, { wide: true });

  $$('#nLabels .chip', m).forEach(c => c.onclick = () => c.classList.toggle('is-on'));
  wireDropzone($('#nDrop', m), url => { $('#nBody', m).value += `\n\n![](${url})\n`; });
  wirePaste(m, $('#nBody', m));
  setTimeout(() => $('#nTitle', m).focus(), 40);

  $('#nSave', m).onclick = async () => {
    const title = $('#nTitle', m).value.trim();
    if (!title) { toast('A title is required', 'err'); return; }
    const toCol = $('#nCol', m).value;
    const col = S.columns.find(c => c.id === toCol);
    const labels = [...$$('#nLabels .chip.is-on', m).map(c => c.dataset.lbl), col.label];
    const payload = { title, body: $('#nBody', m).value, labels };
    if (S.demo) {
      S.issues.unshift({ number: Math.max(0, ...S.issues.map(i => i.number)) + 1, title, body: payload.body, state: toCol === 'done' ? 'closed' : 'open',
        labels: labels.map(n => ({ name: n, color: '5a6470' })), updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        closed_at: toCol === 'done' ? new Date().toISOString() : null, comments: 0, html_url: '#', user: { login: 'you' } });
      closeModal(); render(); paintCounts(); return;
    }
    try {
      const r = await gh(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: payload });
      S.issues.unshift(r.data);
      if (S.closeOnDone && toCol === 'done') await gh(`/repos/${owner}/${repo}/issues/${r.data.number}`, { method: 'PATCH', body: { state: 'closed' } });
      toast(`Created #${r.data.number}`, 'ok'); closeModal(); render(); paintCounts();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- pull requests ---------- */
function prRowHTML(p, compact) {
  const st = prState(p);
  const ck = S.checks[p.number];
  const checks = !ck ? '' : ck.fail ? `<span class="checks" style="color:var(--bad)">✕ ${ck.fail} failing</span>`
    : ck.pend ? `<span class="checks" style="color:var(--warn)">● ${ck.pend} running</span>`
    : `<span class="checks" style="color:var(--ok)">✓ ${ck.ok} passing</span>`;
  return `
  <div class="pr-row">
    <span class="pr-icon pr-pill s-${st}"><svg><use href="#i-pr"/></svg>${st}</span>
    <div class="pr-main">
      <a class="pr-title" href="${attr(p.html_url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <div class="pr-meta">
        <span class="mono">#${p.number}</span>
        ${p.user && p.user.avatar_url ? `<img class="avatar" src="${attr(p.user.avatar_url)}" alt="">` : ''}
        ${p.user ? `<span>${esc(p.user.login)}</span>` : ''}
        ${compact ? '' : `<span class="branch">${esc((p.head && p.head.ref) || '?')}</span>→<span class="branch">${esc((p.base && p.base.ref) || '?')}</span>`}
        ${checks}
        <span>${p.merged_at ? 'merged ' + ago(p.merged_at) : 'updated ' + ago(p.updated_at)}</span>
      </div>
    </div>
    <a class="icon-btn" href="${attr(p.html_url)}" target="_blank" rel="noopener" title="Open on GitHub"><svg><use href="#i-external"/></svg></a>
  </div>`;
}

function renderPRs() {
  const q = S.q.trim().toLowerCase();
  const list = S.prs.filter(p => !q || `#${p.number} ${p.title}`.toLowerCase().includes(q));
  const groups = [
    ['Open',   list.filter(p => p.state === 'open' && !p.draft)],
    ['Draft',  list.filter(p => p.state === 'open' && p.draft)],
    ['Merged', list.filter(p => p.merged_at)],
    ['Closed without merging', list.filter(p => p.state === 'closed' && !p.merged_at)],
  ].filter(g => g[1].length);

  $('#prWrap').innerHTML = groups.length ? groups.map(([name, rows]) => `
    <div class="pr-group">
      <h2>${esc(name)} <span class="nav-count">${rows.length}</span></h2>
      <div class="pr-list">${rows.slice(0, 40).map(p => prRowHTML(p)).join('')}</div>
    </div>`).join('')
    : `<div class="empty"><svg><use href="#i-pr"/></svg><h3>No pull requests</h3>
       <p>${S.token ? 'Nothing open or recently closed in this repository.' : 'Connect GitHub in Settings to see real pull requests.'}</p></div>`;
}

/* ---------- inspiration board ---------- */
const INSP_PATH = 'data/inspiration.json';

async function loadInspiration() {
  if (!S.token) { S.inspiration = store.get('inspiration', S.inspiration); return; }
  const a = assetCfg();
  try {
    const r = await ghGet(`/repos/${a.owner}/${a.repo}/contents/${INSP_PATH}?ref=${encodeURIComponent(a.branch)}`);
    S.inspSha = r.sha;
    const remote = JSON.parse(b64dec(r.content));
    if (Array.isArray(remote)) { S.inspiration = remote; store.set('inspiration', remote); }
  } catch (e) {
    // 404 = never synced yet (fresh clone, no data/inspiration.json). Stay local until first save.
    if (e.status !== 404) console.warn('inspiration load:', e.message);
  }
  paintCounts();
  if (S.view === 'inspiration') renderInspiration();
}

async function saveInspiration() {
  store.set('inspiration', S.inspiration);
  paintCounts();
  if (!S.token) { toast('Saved in this browser — connect GitHub to sync across devices'); return; }
  const a = assetCfg();
  const body = { message: 'tracker: update inspiration board', content: b64enc(JSON.stringify(S.inspiration, null, 2)), branch: a.branch };
  if (S.inspSha) body.sha = S.inspSha;
  try {
    const r = await gh(`/repos/${a.owner}/${a.repo}/contents/${INSP_PATH}`, { method: 'PUT', body });
    S.inspSha = r.data.content.sha;
    toast('Inspiration synced', 'ok');
  } catch (e) {
    if (e.status === 409 || e.status === 422) { S.inspSha = null; toast('Sync conflict — refresh, then save again', 'err'); }
    else toast('Sync failed: ' + e.message, 'err');
  }
}

function renderInspiration() {
  const tags = [...new Set(S.inspiration.flatMap(x => x.tags || []))].sort();
  const active = S.inspTag || '';
  const items = S.inspiration.filter(x => !active || (x.tags || []).includes(active));

  $('#inspWrap').innerHTML = `
    <div class="insp-head">
      <button class="btn btn-primary btn-sm" data-act="insp-new"><svg><use href="#i-plus"/></svg>Add reference</button>
      ${tags.length ? `<div class="row" style="gap:6px">
        <button class="chip ${!active ? 'is-on' : ''}" data-act="insp-tag" data-tag="">All</button>
        ${tags.map(t => `<button class="chip ${active === t ? 'is-on' : ''}" data-act="insp-tag" data-tag="${attr(t)}">${esc(t)}</button>`).join('')}
      </div>` : ''}
      <span style="flex:1"></span>
      <span style="font-size:11.5px;color:var(--fg-faint)">${S.token ? 'Synced to ' + esc(assetCfg().owner + '/' + assetCfg().repo) : 'This browser only'}</span>
    </div>
    ${items.length ? `<div class="insp-grid" id="inspGrid" data-list="insp">${items.map(x => `
      <article class="insp" data-id="${attr(x.id)}">
        <div class="insp-img" style="${x.image ? `background-image:url('${attr(x.image)}')` : ''}">${x.image ? '' : '<svg><use href="#i-image"/></svg>'}</div>
        <div class="insp-body">
          <div class="insp-title">${esc(x.title || 'Untitled')}</div>
          ${x.note ? `<div class="insp-note">${esc(x.note)}</div>` : ''}
          ${(x.tags || []).length ? `<div class="insp-tags">${x.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="insp-actions">
            ${x.url ? `<a class="icon-btn" href="${attr(x.url)}" target="_blank" rel="noopener" title="Open link"><svg><use href="#i-external"/></svg></a>` : ''}
            <button class="icon-btn" data-act="insp-edit" data-id="${attr(x.id)}" title="Edit"><svg><use href="#i-cog"/></svg></button>
            <button class="icon-btn danger" data-act="insp-del" data-id="${attr(x.id)}" title="Remove"><svg><use href="#i-trash"/></svg></button>
          </div>
        </div>
      </article>`).join('')}</div>`
    : `<div class="empty"><svg><use href="#i-spark"/></svg><h3>No references yet</h3>
       <p>Collect the games, screenshots and articles worth stealing from — a link, an image, and a note on exactly what you want out of it.</p>
       <button class="btn btn-primary" data-act="insp-new"><svg><use href="#i-plus"/></svg>Add your first reference</button></div>`}`;

  const grid = $('#inspGrid');
  if (grid) initDnD({
    root: grid, itemSel: '.insp', listSel: '[data-list="insp"]',
    onDrop: (item, list) => {
      const ids = [...list.children].map(c => c.dataset.id);
      S.inspiration.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      saveInspiration();
    },
  });
}

function openInspEdit(id) {
  const found = S.inspiration.find(i => i.id === id);
  const x = found || { id: uid(), title: '', url: '', image: '', note: '', tags: [] };
  const isNew = !found;
  const m = openModal(`
    ${modalHead(isNew ? 'Add reference' : 'Edit reference')}
    <div class="modal-body">
      <div class="field"><label>Title</label><input class="input" id="iT" value="${attr(x.title)}" placeholder="Oxygen Not Included — overlay language"></div>
      <div class="field"><label>Link</label><input class="input" id="iU" value="${attr(x.url)}" placeholder="https://…"></div>
      <div class="field"><label>Image URL</label><input class="input" id="iI" value="${attr(x.image)}" placeholder="https://… or upload below">
        <div class="dropzone" id="iDrop" style="margin-top:7px"><svg style="vertical-align:-3px"><use href="#i-image"/></svg> Drop an image or click to upload</div></div>
      <div class="field"><label>What to take from it</label>
        <textarea class="textarea" id="iN" style="min-height:80px;font-family:var(--font);font-size:13px" placeholder="Overlays dim everything unrelated instead of hiding it.">${esc(x.note)}</textarea></div>
      <div class="field"><label>Tags <span class="hint">comma separated</span></label>
        <input class="input" id="iG" value="${attr((x.tags || []).join(', '))}" placeholder="ui, colony-sim, art-direction"></div>
    </div>
    <div class="modal-foot"><span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="iSave"><svg><use href="#i-check"/></svg>${isNew ? 'Add' : 'Save'}</button></div>`);

  wireDropzone($('#iDrop', m), url => { $('#iI', m).value = url; });
  $('#iSave', m).onclick = () => {
    x.title = $('#iT', m).value.trim();
    x.url   = $('#iU', m).value.trim();
    x.image = $('#iI', m).value.trim();
    x.note  = $('#iN', m).value.trim();
    x.tags  = $('#iG', m).value.split(',').map(s => s.trim()).filter(Boolean);
    if (isNew) S.inspiration.unshift(x);
    closeModal(); renderInspiration(); saveInspiration();
  };
}

/* ---------- progress ---------- */
function renderProgress() {
  const closed = S.issues.filter(i => i.closed_at).sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
  const weeks = [];
  const now = startOfWeek(new Date());
  for (let w = 7; w >= 0; w--) {
    const from = new Date(now); from.setDate(from.getDate() - w * 7);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    weeks.push({ from, n: closed.filter(i => { const d = new Date(i.closed_at); return d >= from && d < to; }).length });
  }
  const max = Math.max(1, ...weeks.map(w => w.n));
  const byCol = S.columns.map(c => ({ c, n: S.issues.filter(i => colOf(i) === c.id).length }));
  const totalCol = Math.max(1, byCol.reduce((a, b) => a + b.n, 0));
  const openN = S.issues.filter(i => i.state === 'open').length;
  const merged30 = S.prs.filter(p => p.merged_at && Date.now() - new Date(p.merged_at) < 30 * 864e5).length;

  $('#progWrap').innerHTML = `
    <div class="prog-wrap">
      <div class="stat-row">
        <div class="stat"><b>${openN}</b><span class="lab">Open tasks</span></div>
        <div class="stat"><b style="color:var(--ok)">${closed.length}</b><span class="lab">Completed</span></div>
        <div class="stat"><b style="color:var(--accent)">${weeks[weeks.length - 1].n}</b><span class="lab">Closed this week</span></div>
        <div class="stat"><b>${S.prs.filter(p => p.state === 'open').length}</b><span class="lab">Open PRs</span></div>
        <div class="stat"><b style="color:var(--merged)">${merged30}</b><span class="lab">Merged · 30 days</span></div>
      </div>

      <div class="panel">
        <h3>Tasks completed per week</h3>
        <div class="bars">${weeks.map(w => `
          <div class="bar-col">
            <div class="bar" style="height:${Math.max(3, w.n / max * 100)}%">${w.n ? `<span>${w.n}</span>` : ''}</div>
            <div class="bar-lab">${w.from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
          </div>`).join('')}</div>
      </div>

      <div class="panel">
        <h3>Where everything sits</h3>
        <div class="legend-row">${byCol.map(({ c, n }) => `
          <div class="legend-item">
            <span class="k">${esc(c.name)}</span>
            <span class="track"><i style="width:${n / totalCol * 100}%;background:${esc(c.color)}"></i></span>
            <span class="v">${n}</span>
          </div>`).join('')}</div>
      </div>

      <div class="panel">
        <h3>Recently finished <button class="btn btn-ghost btn-sm" data-act="devlog" style="float:right;margin-top:-4px"><svg><use href="#i-copy"/></svg>Devlog</button></h3>
        <div class="legend-row">${closed.slice(0, 8).map(i => `
          <div class="legend-item" style="gap:9px">
            <span class="mono" style="color:var(--fg-faint);min-width:44px">#${i.number}</span>
            <span style="flex:1">${esc(i.title)}</span>
            <span class="v" style="min-width:74px">${ago(i.closed_at)}</span>
          </div>`).join('') || '<span style="color:var(--fg-faint)">Nothing closed yet.</span>'}</div>
      </div>
    </div>`;
}

/* ---------- settings ---------- */
function renderSettings() {
  const a = assetCfg();
  $('#setWrap').innerHTML = `
    <div class="set-wrap">
      <div class="panel">
        <h3>GitHub connection</h3>
        ${S.user ? `<div class="row" style="margin-bottom:13px">
            <img class="avatar" style="width:30px;height:30px" src="${attr(S.user.avatar_url)}" alt="">
            <b>${esc(S.user.login)}</b><span style="color:var(--ok);font-size:12px">connected</span>
            <span style="flex:1"></span>
            <button class="btn btn-danger btn-sm" data-act="disconnect">Disconnect</button></div>` : ''}
        <div class="field">
          <label>Fine-grained personal access token</label>
          <input class="input" id="sToken" type="password" value="${attr(S.token)}" placeholder="github_pat_…" autocomplete="off">
          <span class="hint">Kept in this browser's localStorage only — never committed, never sent anywhere but api.github.com.
          Needs <b>Issues: read &amp; write</b>, <b>Pull requests: read</b>, <b>Metadata: read</b> on your task repos,
          plus <b>Contents: read &amp; write</b> on the assets repo below.</span>
        </div>
        <div class="row">
          <button class="btn btn-primary btn-sm" data-act="connect"><svg><use href="#i-github"/></svg>Connect</button>
          <a class="btn btn-ghost btn-sm" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a token<svg><use href="#i-external"/></svg></a>
        </div>
        ${S.rate ? `<div class="kv" style="margin-top:13px"><b>API budget</b><span>${S.rate.rem} of ${S.rate.limit} left${S.rate.reset ? ' · resets ' + new Date(S.rate.reset * 1000).toLocaleTimeString() : ''}</span></div>` : ''}
      </div>

      <div class="panel">
        <h3>Repositories</h3>
        <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:13px">
          ${S.repos.map((r, i) => `<div class="repo-line">
             <span class="nm">${esc(r.owner)}/${esc(r.repo)}</span>
             ${i === S.active ? '<span class="tag">active</span>' : `<button class="btn btn-ghost btn-sm" data-act="repo-use" data-i="${i}">Use</button>`}
             <button class="icon-btn danger" data-act="repo-del" data-i="${i}"><svg><use href="#i-trash"/></svg></button>
           </div>`).join('')}
        </div>
        <div class="row"><input class="input" id="sNewRepo" placeholder="owner/repo" style="flex:1;min-width:170px">
          <button class="btn btn-ghost btn-sm" data-act="repo-add"><svg><use href="#i-plus"/></svg>Add</button></div>
      </div>

      <div class="panel">
        <h3>Board columns</h3>
        <span class="hint">Each column maps to a GitHub label, so the board still reads correctly on github.com.</span>
        <div style="display:flex;flex-direction:column;gap:7px;margin:13px 0">
          ${S.columns.map((c, i) => `<div class="row">
            <input class="input" style="flex:0 0 150px" data-col-name="${i}" value="${attr(c.name)}">
            <input class="input mono" style="flex:1;min-width:140px" data-col-label="${i}" value="${attr(c.label)}">
            <input type="color" value="${attr(c.color)}" data-col-color="${i}" style="width:38px;height:34px;border:1px solid var(--line);border-radius:8px;background:none;padding:2px;cursor:pointer">
          </div>`).join('')}
        </div>
        <label class="row" style="font-size:12.5px;color:var(--fg-dim);cursor:pointer">
          <input type="checkbox" id="sClose" ${S.closeOnDone ? 'checked' : ''} style="accent-color:var(--accent)">
          A closed issue means Done — and dragging a card to Done closes it
        </label>
        <label class="row" style="font-size:12.5px;color:var(--fg-dim);cursor:pointer;margin-top:8px">
          Flag cards in Progress / Review as idle after
          <input class="input mono" id="sStale" type="number" min="0" max="90" step="1" value="${attr(S.staleDays)}" style="width:64px;margin:0 6px"> days without activity
        </label>
        <div class="row" style="margin-top:13px">
          <button class="btn btn-primary btn-sm" data-act="cols-save"><svg><use href="#i-check"/></svg>Save columns</button>
          <button class="btn btn-ghost btn-sm" data-act="cols-labels">Create these labels on GitHub</button>
          <button class="btn btn-ghost btn-sm" data-act="cols-reset">Reset</button>
        </div>
      </div>

      <div class="panel">
        <h3>Assets &amp; sync</h3>
        <span class="hint">Uploaded images and the inspiration board are committed here. Must be a repo you can write to.</span>
        <div class="row" style="margin-top:13px">
          <input class="input" id="sAssetRepo" style="flex:1;min-width:180px" value="${attr(a.owner + '/' + a.repo)}" placeholder="owner/repo">
          <input class="input" id="sAssetBranch" style="flex:0 0 100px" value="${attr(a.branch)}" placeholder="branch">
          <input class="input" id="sAssetDir" style="flex:0 0 150px" value="${attr(a.dir)}" placeholder="data/uploads">
          <button class="btn btn-ghost btn-sm" data-act="assets-save">Save</button>
        </div>
      </div>

      <div class="panel">
        <h3>Local data</h3>
        <div class="kv"><b>Card order</b><span>${Object.keys(S.order).length} board(s) remembered in this browser</span></div>
        <div class="kv"><b>Inspiration</b><span>${S.inspiration.length} references</span></div>
        <div class="kv"><b>Request cache</b><span>${Object.keys(httpCache).length} cached responses · ${(cacheBytes() / 1024).toFixed(0)} KB</span></div>
        <div class="kv"><b>Calls saved</b><span>${cacheSaves} unchanged response(s) returned without spending rate limit</span></div>
        <div class="row" style="margin-top:13px">
          <button class="btn btn-ghost btn-sm" data-act="import"><svg><use href="#i-doc"/></svg>Import tasks from a file</button>
          <button class="btn btn-ghost btn-sm" data-act="cache-clear">Clear request cache</button>
          <button class="btn btn-ghost btn-sm" data-act="export">Export as JSON</button>
          <button class="btn btn-danger btn-sm" data-act="wipe">Clear local data</button>
        </div>
      </div>

      <div class="callout info">
        <b>Keyboard:</b> <kbd>⌘K</kbd> command palette · <kbd>c</kbd> quick capture · <kbd>/</kbd> search ·
        <kbd>n</kbd> new task · <kbd>r</kbd> refresh · <kbd>Esc</kbd> close dialog.
        Drag cards between columns to move them; the move is written straight to GitHub.
      </div>
    </div>`;
}

/* ---------- demo data (shown until a token is connected) ---------- */
function loadDemo() {
  S.demo = true;
  const L = (n, c) => ({ name: n, color: c });
  const day = 864e5, now = Date.now();
  const mk = (number, title, col, body, x = {}) => ({
    number, title, body, state: col === 'done' ? 'closed' : 'open',
    labels: [L(S.columns.find(c => c.id === col).label, '5a6470'), ...(x.labels || [])],
    created_at: new Date(now - (x.age || 20) * day).toISOString(),
    updated_at: new Date(now - (x.upd || 2) * day).toISOString(),
    closed_at: col === 'done' ? new Date(now - (x.upd || 2) * day).toISOString() : null,
    comments: x.comments || 0, html_url: 'https://github.com', user: { login: 'demo' },
  });
  S.issues = [
    mk(41, 'Edge-flux liquid solver: mass conservation test', 'progress',
      'Fluxes live on edges, then get applied to cells. Lock-free and deterministic.\n\n- [x] Flat SoA arrays\n- [x] Edge pass\n- [ ] Determinism across 10k ticks\n- [ ] Burst job split',
      { labels: [L('sim', '2fa8b8'), L('burst', 'd9ae3f')], comments: 4, upd: 0 }),
    mk(38, 'Thermal: integrate energy, never temperature', 'progress',
      'Integrating temperature directly breaks the detection model — the sensors read physical *quantities*.', { labels: [L('sim', '2fa8b8')], upd: 1 }),
    mk(45, 'Seven-sensor suspicion sampler at 1 Hz', 'todo',
      'Suspicion is measured, never awarded. Sensors: thermal, water, power, data, waste, traffic, logistics.', { labels: [L('design', 'c33f45')], upd: 3 }),
    mk(46, 'Cover identities define legitimate sensor bands', 'todo', 'A laundromat may run hot and wet. A bookshop may not.', { labels: [L('design', 'c33f45')], upd: 4 }),
    mk(47, 'Room detection via incremental flood fill', 'todo',
      'One shared union-find, instantiated three times: rooms, nav regions, network connectivity. Do not write three.', { labels: [L('sim', '2fa8b8')], upd: 5 }),
    mk(33, 'dekey.py: scale-free chroma discriminant', 'review',
      'Dividing by the brightest dominant channel fixes the dark-pixel under-scoring. Residual pink 2.6% → 0.04%.', { labels: [L('tools', '46a8b6')], comments: 2, upd: 1 }),
    mk(29, 'Kea.Core asmdef forbids UnityEngine', 'done', 'Enforced by assembly definition; CI fails the build if it creeps back in.', { labels: [L('architecture', 'a78bfa')], upd: 6 }),
    mk(24, '20 Hz tick with per-system divisors', 'done', 'fluid ×1, agents ×2, thermal ×4, sensors ×20, city ×1200 — phase offset to flatten frame time.', { labels: [L('architecture', 'a78bfa')], upd: 9 }),
    mk(21, 'One contiguous grid for surface and underground', 'done', '', { labels: [L('architecture', 'a78bfa')], upd: 12 }),
    mk(19, 'Drop gas simulation from scope', 'done', 'Air becomes a ventilation network; room air quality is a per-room scalar. Cuts half the cellular complexity.', { labels: [L('design', 'c33f45')], upd: 17 }),
    mk(12, 'Magenta chroma-key sprite pipeline', 'done', '', { labels: [L('tools', '46a8b6')], upd: 24 }),
  ];
  S.prs = [
    { number: 52, title: 'Edge-flux fluid solver (WIP)', state: 'open', draft: true, user: { login: 'cyrus-jackson' },
      head: { ref: 'feat/41-edge-flux', sha: 'a' }, base: { ref: 'master' }, html_url: 'https://github.com', body: 'Part of #41',
      updated_at: new Date(now - 0.4 * day).toISOString() },
    { number: 51, title: 'Thermal energy integration + conservation tests', state: 'open', draft: false, user: { login: 'cyrus-jackson' },
      head: { ref: 'feat/38-thermal', sha: 'b' }, base: { ref: 'master' }, html_url: 'https://github.com', body: 'Closes #38',
      updated_at: new Date(now - 1.2 * day).toISOString() },
    { number: 44, title: 'dekey: scale-free discriminant', state: 'closed', merged_at: new Date(now - day).toISOString(),
      user: { login: 'cyrus-jackson' }, head: { ref: 'fix/33-dekey', sha: 'c' }, base: { ref: 'master' },
      html_url: 'https://github.com', body: 'Fixes #33', updated_at: new Date(now - day).toISOString() },
  ];
  S.labels = [L('sim', '2fa8b8'), L('design', 'c33f45'), L('tools', '46a8b6'), L('architecture', 'a78bfa'), L('burst', 'd9ae3f')];
  S.checks = { 51: { total: 6, ok: 6, fail: 0, pend: 0 }, 52: { total: 6, ok: 4, fail: 0, pend: 2 } };
  if (!S.inspiration.length) S.inspiration = [
    { id: uid(), title: 'Oxygen Not Included — overlay language', url: 'https://www.klei.com/games/oxygen-not-included', image: '',
      note: 'Overlays dim everything unrelated instead of hiding it, so you keep spatial context while one system becomes legible.', tags: ['ui', 'colony-sim'] },
    { id: uid(), title: 'Ratopia — surface / underground split', url: '', image: '',
      note: 'Two worlds on one contiguous grid, sold by lighting and palette temperature rather than a loading screen.', tags: ['colony-sim', 'art-direction'] },
    { id: uid(), title: 'Atompunk enamel hardware', url: '', image: '',
      note: 'Two-tone bodies: saturated colour below, cream above, split by a chrome strip. Never one flat colour over a whole machine.', tags: ['art-direction'] },
  ];
  paintCounts(); render();
  if (!$('#demoBanner')) {
    const b = document.createElement('div');
    b.className = 'banner'; b.id = 'demoBanner';
    b.innerHTML = `<b>Demo data.</b><span>None of this is real yet — connect a GitHub token to load your own issues and pull requests.</span>
      <span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="goto-settings">Open settings</button>`;
    $('.topbar').after(b);
  }
}

/* ---------- router ---------- */
const TITLES = { board: 'Board', prs: 'Pull Requests', milestones: 'Milestones', ideas: 'Ideas', inspiration: 'Inspiration', assets: 'Assets', docs: 'Design Docs', progress: 'Progress', settings: 'Settings' };

function render() {
  $('#viewTitle').textContent = TITLES[S.view] || 'Board';
  $$('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === S.view));
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + S.view);
  $('#search').placeholder = { prs: 'Search pull requests…', ideas: 'Search ideas…', assets: 'Search file paths…' }[S.view] || 'Search tasks…';
  renderFilters();
  if (S.view === 'board') {
    renderBoard();
    initDnD({
      root: $('#board'), itemSel: '.card', listSel: '.col-body', axisScroll: $('#board'),
      onDrop: (item, list) => moveIssue(+item.dataset.num, list.dataset.list),
    });
  }
  else if (S.view === 'prs') { renderPRs(); loadChecks(); }
  else if (S.view === 'milestones') renderMilestones();
  else if (S.view === 'ideas') renderIdeas();
  else if (S.view === 'assets') renderAssets();
  else if (S.view === 'inspiration') renderInspiration();
  else if (S.view === 'docs') {
    renderDocs();
    if (S.token && !S.docs) loadDocs().then(() => { renderDocs(); if (S.doc) openDoc(S.doc); });
    else if (S.doc) openDoc(S.doc);
  }
  else if (S.view === 'progress') renderProgress();
  else if (S.view === 'settings') renderSettings();
}
function go(view) { S.view = view; store.set('view', view); render(); }

/* ---------- actions ---------- */
async function connect(token) {
  S.token = String(token || '').trim();
  store.set('token', S.token);
  if (!S.token) { S.user = null; S.inspSha = null; paintConn(); loadDemo(); renderSettings(); return; }
  try {
    S.user = await ghGet('/user');
    S.demo = false;
    const b = $('#demoBanner'); if (b) b.remove();
    toast(`Connected as ${S.user.login}`, 'ok');
    paintConn();
    await Promise.all([loadAll({ quiet: true }), loadInspiration()]);
    render();
  } catch (e) {
    S.user = null; paintConn();
    toast('Token rejected: ' + e.message, 'err');
  }
}

async function createStatusLabels() {
  const { owner, repo } = repoNow();
  let made = 0;
  for (const c of S.columns) {
    try {
      await gh(`/repos/${owner}/${repo}/labels`, { method: 'POST',
        body: { name: c.label, color: String(c.color).replace('#', ''), description: `Kea Tracker — ${c.name}` } });
      made++;
    } catch (e) { if (e.status !== 422) toast(`${c.label}: ${e.message}`, 'err'); }
  }
  toast(made ? `Created ${made} label(s)` : 'Those labels already exist', 'ok');
  loadAll({ quiet: true, force: true });
}

/* ---------- events ---------- */
function wire() {
  const drawer = open => { $('.sidebar').classList.toggle('open', open); $('#scrim').hidden = !open; };
  $('#btnMenu').onclick = () => drawer(!$('.sidebar').classList.contains('open'));
  $('#scrim').onclick = () => drawer(false);
  $('#nav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) { go(b.dataset.view); drawer(false); } });

  $('#repoSelect').addEventListener('change', e => {
    if (e.target.value === '__add') { paintRepos(); go('settings'); return; }
    S.active = +e.target.value; store.set('active', S.active);
    S.filters = []; paintRepos(); loadAll();
  });

  $('#btnRefresh').onclick = () => { loadAll({ force: true }); loadInspiration(); };
  $('#btnNew').onclick = () => S.view === 'inspiration' ? openInspEdit(null) : openNewTask('todo');

  let t;
  $('#search').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; render(); }, 170); });

  $('#themeDots').addEventListener('click', e => { const d = e.target.closest('.theme-dot'); if (d) applyTheme(d.dataset.theme); });

  document.addEventListener('click', e => {
    const docBtn = e.target.closest('[data-doc]');
    if (docBtn) { S.docQ = ''; openDoc(docBtn.dataset.doc); return; }
    const sw = e.target.closest('.swatch');
    if (sw) {
      navigator.clipboard?.writeText(sw.dataset.hex).then(() => toast(`Copied ${sw.dataset.hex}`, 'ok')).catch(() => {});
      return;
    }
    const asset = e.target.closest('.asset');
    if (asset) { openAsset(asset.dataset.path); return; }
    const card = e.target.closest('.card');
    if (card && !e.target.closest('a,button') && Date.now() - (window.__dragEnd || 0) > 250) { openTask(+card.dataset.num); return; }

    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act;

    if (act === 'close') closeModal();
    else if (act === 'import') openImport();
    else if (act === 'ms-new') openMilestoneEdit(null);
    else if (act === 'ms-edit') openMilestoneEdit(+el.dataset.ms);
    else if (act === 'ms-open') openTask(+el.dataset.num);
    else if (act === 'idea-new') openIdeaNew();
    else if (act === 'idea-open') openTask(+el.dataset.num);
    else if (act === 'idea-promote') openPromote(+el.dataset.num);
    else if (act === 'idea-tag') { S.ideaTag = el.dataset.tag; renderIdeas(); }
    else if (act === 'asset-dir') { S.assetDir = el.dataset.dir; renderAssets(); }
    else if (act === 'devlog') openDevlog();
    else if (act === 'capture') openCapture();
    else if (act === 'goto-settings') go('settings');
    else if (act === 'new') openNewTask(el.dataset.col);
    else if (act === 'filter') { const l = el.dataset.label; S.filters = S.filters.includes(l) ? S.filters.filter(x => x !== l) : [...S.filters, l]; render(); }
    else if (act === 'filter-clear') { S.filters = []; render(); }
    else if (act === 'insp-new') openInspEdit(null);
    else if (act === 'insp-edit') openInspEdit(el.dataset.id);
    else if (act === 'insp-del') { S.inspiration = S.inspiration.filter(x => x.id !== el.dataset.id); renderInspiration(); saveInspiration(); }
    else if (act === 'insp-tag') { S.inspTag = el.dataset.tag; renderInspiration(); }
    else if (act === 'connect') connect($('#sToken').value);
    else if (act === 'disconnect') connect('');
    else if (act === 'repo-use') { S.active = +el.dataset.i; store.set('active', S.active); paintRepos(); renderSettings(); loadAll(); }
    else if (act === 'repo-del') {
      S.repos.splice(+el.dataset.i, 1);
      if (!S.repos.length) S.repos = [{ owner: 'cyrus-jackson', repo: 'KeaGame' }];
      S.active = 0; store.set('repos', S.repos); store.set('active', 0);
      paintRepos(); renderSettings(); loadAll();
    }
    else if (act === 'repo-add') {
      const v = $('#sNewRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      const [o, r] = v.split('/');
      if (!o || !r) { toast('Use the owner/repo form', 'err'); return; }
      S.repos.push({ owner: o, repo: r }); S.active = S.repos.length - 1;
      store.set('repos', S.repos); store.set('active', S.active);
      paintRepos(); renderSettings(); loadAll();
    }
    else if (act === 'cols-save') {
      S.columns = S.columns.map((c, i) => ({ ...c,
        name:  $(`[data-col-name="${i}"]`).value.trim() || c.name,
        label: $(`[data-col-label="${i}"]`).value.trim() || c.label,
        color: $(`[data-col-color="${i}"]`).value }));
      S.closeOnDone = $('#sClose').checked;
      const stale = Math.max(0, Math.min(90, parseInt($('#sStale').value, 10) || 0)) || DEFAULT_STALE_DAYS;
      S.staleDays = stale;
      store.set('columns', S.columns); store.set('closeOnDone', S.closeOnDone); store.set('staleDays', S.staleDays);
      toast('Columns saved', 'ok'); renderSettings(); renderBoard();
    }
    else if (act === 'cols-reset') { S.columns = JSON.parse(JSON.stringify(DEFAULT_COLUMNS)); store.set('columns', S.columns); renderSettings(); }
    else if (act === 'cols-labels') createStatusLabels();
    else if (act === 'assets-save') {
      const [o, r] = $('#sAssetRepo').value.trim().split('/');
      if (!o || !r) { toast('Use the owner/repo form', 'err'); return; }
      S.assets = { owner: o, repo: r, branch: $('#sAssetBranch').value.trim() || 'master', dir: $('#sAssetDir').value.trim() || 'data/uploads' };
      store.set('assets', S.assets); S.inspSha = null;
      toast('Assets repo saved', 'ok'); loadInspiration();
    }
    else if (act === 'cache-clear') { cacheClear(); toast('Request cache cleared', 'ok'); renderSettings(); }
    else if (act === 'export') {
      const blob = new Blob([JSON.stringify({ repos: S.repos, columns: S.columns, assets: S.assets, order: S.order, inspiration: S.inspiration }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kea-tracker-backup.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    else if (act === 'wipe') {
      if (!confirm('Clear the token, board order, settings and inspiration cache from this browser?')) return;
      Object.keys(localStorage).filter(k => k.startsWith(NS)).forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!$('#modalRoot').hidden) closeModal();
      openPalette(); return;
    }
    if (e.target.matches('input,textarea,select') || !$('#modalRoot').hidden) return;
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === 'c') { e.preventDefault(); openCapture(); }
    else if (e.key === 'n' && S.view === 'board') { e.preventDefault(); openNewTask('todo'); }
    else if (e.key === 'r') { e.preventDefault(); loadAll({ force: true }); }
  });

}

/* ---------- init ---------- */
async function init() {
  applyTheme(store.get('theme', 'neon'));
  paintThemes(); paintRepos(); paintConn();
  S.view = store.get('view', 'board');
  wire();

  if (S.token) {
    if (hydrateFromCache()) { paintCounts(); }
    render();
    try { S.user = await ghGet('/user'); } catch { S.user = null; }
    paintConn();
    await Promise.all([loadAll({ quiet: true }), loadInspiration()]);
    render();
  } else {
    loadDemo();
  }
  paintCounts();
}

document.addEventListener('DOMContentLoaded', init);

/* ============================================================
   Part 4: quick capture, command palette, docs reader,
           ideas import, devlog
   ============================================================ */

/* ---------- shared task creation ---------- */
async function createTask({ title, body = '', labels = [], col = 'todo' }) {
  const column = S.columns.find(c => c.id === col) || S.columns[0];
  const payload = { title, body, labels: [...labels, column.label] };
  if (S.demo) {
    const issue = {
      number: Math.max(0, ...S.issues.map(i => i.number)) + 1, title, body,
      state: col === 'done' ? 'closed' : 'open',
      labels: payload.labels.map(n => ({ name: n, color: '5a6470' })),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      closed_at: col === 'done' ? new Date().toISOString() : null,
      comments: 0, html_url: '#', user: { login: 'you' },
    };
    S.issues.unshift(issue);
    return issue;
  }
  const { owner, repo } = repoNow();
  const r = await gh(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: payload });
  if (S.closeOnDone && col === 'done') {
    await gh(`/repos/${owner}/${repo}/issues/${r.data.number}`, { method: 'PATCH', body: { state: 'closed' } });
    r.data.state = 'closed';
  }
  S.issues.unshift(r.data);
  return r.data;
}

/* ---------- quick capture ---------- */
function openCapture(seed = '') {
  const m = openModal(`
    <div class="capture">
      <svg class="cap-icon"><use href="#i-bolt"/></svg>
      <input id="capIn" class="cap-in" placeholder="What's on your mind?" autocomplete="off" value="${attr(seed)}">
      <select id="capCol" class="select cap-col">${S.columns.map(c =>
        `<option value="${c.id}" ${c.id === 'todo' ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="__idea">💡 Idea</option></select>
    </div>
    <div class="cap-hint">
      <b>Enter</b> file it &nbsp;·&nbsp; <b>Shift ↵</b> open the full editor &nbsp;·&nbsp; <b>Esc</b> cancel
    </div>`, { slim: true });

  const input = $('#capIn', m);
  setTimeout(() => { input.focus(); input.select(); }, 30);

  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const title = input.value.trim();
    if (!title) return;
    if (e.shiftKey) { closeModal(); openNewTask($('#capCol', m).value, title); return; }
    e.preventDefault();
    input.disabled = true;
    const where = $('#capCol', m).value;
    try {
      const issue = where === '__idea' ? await createIdea(title, '') : await createTask({ title, col: where });
      closeModal(); render(); paintCounts();
      toast(where === '__idea' ? `Idea #${issue.number} saved` : `Filed as #${issue.number}`, 'ok');
    } catch (err) { input.disabled = false; toast(err.message, 'err'); }
  });
}

/* ---------- command palette ---------- */
function paletteItems() {
  const it = [];
  const push = (group, label, hint, run, icon) => it.push({ group, label, hint, run, icon });

  push('Action', 'New task', 'n', () => openNewTask('todo'), 'i-plus');
  push('Action', 'Quick capture', 'c', () => openCapture(), 'i-bolt');
  push('Action', 'Refresh from GitHub', 'r', () => { loadAll({ force: true }); loadInspiration(); }, 'i-refresh');
  push('Action', 'Add reference', '', () => openInspEdit(null), 'i-spark');
  push('Action', 'Import tasks from a repo file', '', () => openImport(), 'i-doc');
  push('Action', 'Generate devlog', '', () => openDevlog(), 'i-doc');
  push('Action', 'New milestone', '', () => { go('milestones'); openMilestoneEdit(null); }, 'i-flag');
  push('Action', 'New idea', '', () => { go('ideas'); openIdeaNew(); }, 'i-bulb');
  for (const i of S.issues.filter(isIdea).slice(0, 100)) {
    push('Idea', `#${i.number} ${i.title}`, '', () => openTask(i.number), 'i-bulb');
  }
  for (const x of S.milestones.filter(m => m.state === 'open')) {
    const st = msStats(x);
    push('Milestone', `${x.title} — ${st.pct}%`, `${st.remaining} left`, () => go('milestones'), 'i-flag');
  }

  for (const [v, t] of Object.entries(TITLES)) push('Go to', t, '', () => go(v), 'i-board');
  for (const t of THEMES) push('Theme', t.name, '', () => applyTheme(t.id), 'i-spark');
  S.repos.forEach((r, i) => push('Repository', `${r.owner}/${r.repo}`, '', () => {
    S.active = i; store.set('active', i); S.filters = []; paintRepos(); loadAll();
  }, 'i-github'));
  for (const d of (S.docs || [])) push('Doc', d.name, '', () => { go('docs'); openDoc(d.path); }, 'i-doc');
  for (const i of S.issues.slice(0, 300)) {
    push('Task', `#${i.number} ${i.title}`, S.columns.find(c => c.id === colOf(i)).name, () => openTask(i.number), 'i-board');
  }
  return it;
}

function openPalette() {
  const all = paletteItems();
  const m = openModal(`
    <div class="capture">
      <svg class="cap-icon"><use href="#i-search"/></svg>
      <input id="palIn" class="cap-in" placeholder="Jump to a task, view, theme…" autocomplete="off">
    </div>
    <div class="pal-list" id="palList"></div>`, { slim: true });

  const input = $('#palIn', m), list = $('#palList', m);
  let shown = [], cursor = 0;

  const score = (item, q) => {
    const hay = (item.group + ' ' + item.label).toLowerCase();
    if (!q) return 1;
    let i = 0;
    for (const ch of q) { i = hay.indexOf(ch, i); if (i < 0) return 0; i++; }
    return hay.includes(q) ? 3 : 1;
  };

  function draw() {
    const q = input.value.trim().toLowerCase();
    shown = all.map(x => ({ x, s: score(x, q) })).filter(r => r.s > 0)
               .sort((a, b) => b.s - a.s).slice(0, 60).map(r => r.x);
    cursor = Math.min(cursor, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length ? shown.map((x, i) => `
      <button class="pal-row ${i === cursor ? 'is-on' : ''}" data-i="${i}">
        <svg><use href="#${x.icon}"/></svg>
        <span class="pal-group">${esc(x.group)}</span>
        <span class="pal-label">${esc(x.label)}</span>
        ${x.hint ? `<kbd>${esc(x.hint)}</kbd>` : ''}
      </button>`).join('')
      : '<div class="pal-empty">Nothing matches.</div>';
    const on = list.querySelector('.is-on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  const run = i => { const x = shown[i]; if (!x) return; closeModal(); setTimeout(x.run, 0); };

  input.addEventListener('input', () => { cursor = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(cursor); }
  });
  list.addEventListener('click', e => { const r = e.target.closest('.pal-row'); if (r) run(+r.dataset.i); });

  draw();
  setTimeout(() => input.focus(), 30);
}

/* ---------- asset browser ---------- */
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

async function loadAssets() {
  if (!S.token) { S.assetList = []; return; }
  const { owner, repo } = repoNow();
  try {
    const info = await ghGet(`/repos/${owner}/${repo}`);
    const branch = info.default_branch || 'master';
    S.assetPrivate = !!info.private;
    S.assetBranch = branch;
    const tree = await ghGet(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    S.assetTruncated = !!(tree && tree.truncated);
    S.assetList = ((tree && tree.tree) || [])
      .filter(n => n.type === 'blob' && IMG_RE.test(n.path))
      .map(n => ({ path: n.path, size: n.size, sha: n.sha, dir: n.path.split('/').slice(0, -1).join('/') || '/', name: n.path.split('/').pop() }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch (e) { S.assetList = []; S.assetErr = e.message; }
  paintCounts();
}

const rawUrl = a => {
  const { owner, repo } = repoNow();
  return `https://raw.githubusercontent.com/${owner}/${repo}/${S.assetBranch || 'master'}/${a.path.split('/').map(encodeURIComponent).join('/')}`;
};

// Private repos will not serve raw.githubusercontent to an <img>, so fall back
// to pulling the blob through the API and handing the tag a data: URL.
async function hydrateAsset(img, path) {
  try {
    const { owner, repo } = repoNow();
    const r = await ghGet(`/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(S.assetBranch || 'master')}`);
    if (!r || !r.content) throw new Error('no content');
    const ext = (path.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    img.src = `data:${mime};base64,${r.content.replace(/\s/g, '')}`;
    img.dataset.hydrated = '1';
  } catch { img.closest('.asset').classList.add('is-broken'); }
}

function renderAssets() {
  if (!S.token) {
    $('#assetsWrap').innerHTML = `<div class="empty"><svg><use href="#i-grid"/></svg><h3>Connect GitHub first</h3>
      <p>This browses every image committed to the active repository.</p></div>`;
    return;
  }
  if (!S.assetList) {
    $('#assetsWrap').innerHTML = '<div class="insp-grid">' + Array(8).fill('<div class="skel" style="height:170px"></div>').join('') + '</div>';
    loadAssets().then(renderAssets);
    return;
  }
  const q = S.q.trim().toLowerCase();
  const dirs = [...new Set(S.assetList.map(a => a.dir))].sort();
  const active = S.assetDir || '';
  const items = S.assetList
    .filter(a => !active || a.dir === active)
    .filter(a => !q || a.path.toLowerCase().includes(q));

  $('#assetsWrap').innerHTML = `
    <div class="insp-head">
      ${dirs.length > 1 ? `<div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="chip ${!active ? 'is-on' : ''}" data-act="asset-dir" data-dir="">All</button>
        ${dirs.map(d => `<button class="chip ${active === d ? 'is-on' : ''}" data-act="asset-dir" data-dir="${attr(d)}">${esc(d)}</button>`).join('')}
      </div>` : ''}
      <span style="flex:1"></span>
      <span style="font-size:11.5px;color:var(--fg-faint)">
        ${items.length} image${items.length === 1 ? '' : 's'}${S.assetTruncated ? ' · tree truncated by GitHub' : ''}
      </span>
    </div>
    ${items.length ? `<div class="asset-grid">${items.map(a => `
      <figure class="asset" data-path="${attr(a.path)}">
        <div class="asset-img"><img loading="lazy" alt="${attr(a.name)}" src="${attr(rawUrl(a))}" data-path="${attr(a.path)}"></div>
        <figcaption>
          <span class="asset-name" title="${attr(a.path)}">${esc(a.name)}</span>
          <span class="asset-size">${a.size >= 1024 ? Math.round(a.size / 1024) + 'k' : a.size + 'b'}</span>
        </figcaption>
      </figure>`).join('')}</div>`
    : `<div class="empty"><svg><use href="#i-grid"/></svg><h3>No images committed yet</h3>
       <p>${esc(S.assetErr || 'Nothing matching an image extension is tracked in this repository on ' + (S.assetBranch || 'master') + '. Commit some art and it turns up here.')}</p></div>`}`;

  // raw.githubusercontent refuses private repos — swap those to data: URLs
  $$('.asset img').forEach(img => {
    img.onerror = () => { if (!img.dataset.hydrated) hydrateAsset(img, img.dataset.path); };
  });
}

function openAsset(path) {
  const a = (S.assetList || []).find(x => x.path === path);
  if (!a) return;
  const url = rawUrl(a);
  const { owner, repo } = repoNow();
  const m = openModal(`
    ${modalHead(esc(a.name))}
    <div class="modal-body" style="text-align:center">
      <div class="asset-big"><img src="${attr(url)}" alt="${attr(a.name)}" data-path="${attr(a.path)}"></div>
      <div class="mono" style="margin-top:12px;color:var(--fg-faint);font-size:12px">${esc(a.path)} · ${a.size >= 1024 ? Math.round(a.size / 1024) + ' KB' : a.size + ' B'}</div>
    </div>
    <div class="modal-foot">
      <a class="btn btn-ghost" href="https://github.com/${esc(owner)}/${esc(repo)}/blob/${esc(S.assetBranch || 'master')}/${esc(a.path)}" target="_blank" rel="noopener"><svg><use href="#i-github"/></svg>On GitHub</a>
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="asMd"><svg><use href="#i-copy"/></svg>Copy markdown</button>
      <button class="btn btn-ghost" id="asRef"><svg><use href="#i-spark"/></svg>Add to Inspiration</button>
      <button class="btn btn-primary" id="asUrl"><svg><use href="#i-link"/></svg>Copy URL</button>
    </div>`, { wide: true });

  const img = $('.asset-big img', m);
  img.onerror = () => hydrateAsset(img, a.path);
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'ok'); }
    catch { toast('Clipboard blocked — ' + text, 'err'); }
  };
  $('#asUrl', m).onclick = () => copy(url, 'URL');
  $('#asMd', m).onclick = () => copy(`![${a.name}](${url})`, 'Markdown');
  $('#asRef', m).onclick = () => {
    S.inspiration.unshift({ id: uid(), title: a.name, url: '', image: url, note: '', tags: ['asset'] });
    saveInspiration(); closeModal(); toast('Added to Inspiration', 'ok');
  };
}

/* ---------- ideas ----------
   An idea is a GitHub issue carrying the `idea` label and no status label.
   It is excluded from the board on purpose: unformed thinking should not
   inflate the backlog. Promoting swaps the label and it becomes a task. */

const ideaList = () => S.issues.filter(isIdea);

function ideaTags(i) {
  return (i.labels || []).map(l => l.name || l)
    .filter(n => String(n).toLowerCase() !== IDEA_LABEL &&
                 !S.columns.some(c => c.label.toLowerCase() === String(n).toLowerCase()));
}

function renderIdeas() {
  if (!S.token) {
    $('#ideasWrap').innerHTML = `<div class="empty"><svg><use href="#i-bulb"/></svg><h3>Connect GitHub first</h3>
      <p>Ideas are stored as issues labelled <code>${IDEA_LABEL}</code>, so they get numbers, comments and history — but never appear on the board until you promote one.</p></div>`;
    return;
  }
  const all = ideaList();
  const q = S.q.trim().toLowerCase();
  const tags = [...new Set(all.flatMap(ideaTags))].sort();
  const active = S.ideaTag || '';
  const items = all
    .filter(i => !active || ideaTags(i).includes(active))
    .filter(i => !q || `#${i.number} ${i.title} ${i.body || ''}`.toLowerCase().includes(q))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  $('#ideasWrap').innerHTML = `
    <div class="insp-head">
      <button class="btn btn-primary btn-sm" data-act="idea-new"><svg><use href="#i-plus"/></svg>New idea</button>
      ${tags.length ? `<div class="row" style="gap:6px">
        <button class="chip ${!active ? 'is-on' : ''}" data-act="idea-tag" data-tag="">All</button>
        ${tags.map(t => `<button class="chip ${active === t ? 'is-on' : ''}" data-act="idea-tag" data-tag="${attr(t)}">${esc(t)}</button>`).join('')}
      </div>` : ''}
      <span style="flex:1"></span>
      <span style="font-size:11.5px;color:var(--fg-faint)">${all.length} idea${all.length === 1 ? '' : 's'} · hidden from the board</span>
    </div>

    ${items.length ? `<div class="idea-grid">${items.map(i => {
      const img = firstImage(i.body);
      const body = String(i.body || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
      return `
      <article class="idea" data-num="${i.number}">
        ${img ? `<div class="idea-img" style="background-image:url('${attr(img)}')"></div>` : ''}
        <div class="idea-body">
          <div class="idea-top"><span class="mono">#${i.number}</span>${i.comments ? `<span class="mono">${i.comments} 💬</span>` : ''}
            <span style="flex:1"></span><span class="mono" style="color:var(--fg-faint)">${ago(i.updated_at)}</span></div>
          <div class="idea-title" data-act="idea-open" data-num="${i.number}">${esc(i.title)}</div>
          ${body ? `<div class="idea-note">${esc(body.slice(0, 220))}${body.length > 220 ? '…' : ''}</div>` : ''}
          ${ideaTags(i).length ? `<div class="insp-tags">${ideaTags(i).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="idea-actions">
            <button class="btn btn-ghost btn-sm" data-act="idea-promote" data-num="${i.number}"><svg><use href="#i-bolt"/></svg>Promote to task</button>
            <button class="icon-btn" data-act="idea-open" data-num="${i.number}" title="Open"><svg><use href="#i-external"/></svg></button>
          </div>
        </div>
      </article>`;
    }).join('')}</div>`
    : `<div class="empty"><svg><use href="#i-bulb"/></svg><h3>${all.length ? 'Nothing matches' : 'No ideas yet'}</h3>
       <p>Somewhere to put the half-thoughts — festivals, love interests, a mechanic you are not sure about — without them cluttering the board. Promote one when it becomes real work.</p>
       <button class="btn btn-primary" data-act="idea-new"><svg><use href="#i-plus"/></svg>Capture the first one</button></div>`}`;
}

function openIdeaNew() {
  const m = openModal(`
    ${modalHead('New idea')}
    <div class="modal-body">
      <div class="field"><label>The idea</label><input class="input" id="idT" placeholder="Characters get holidays during festivals" autofocus></div>
      <div class="field"><label>Where it goes <span class="hint">— markdown, images, half-finished thinking all fine</span></label>
        <textarea class="textarea" id="idB" style="min-height:150px" placeholder="A temporary schedule that takes them off work and out to a carnival.&#10;&#10;Open question: does suspicion drop or spike during a festival?"></textarea></div>
      <div class="field"><label>Tags <span class="hint">existing labels, comma separated</span></label>
        <input class="input" id="idG" placeholder="design, characters"></div>
      <div class="dropzone" id="idDrop"><svg style="vertical-align:-3px"><use href="#i-image"/></svg> Drop a reference image or click to upload</div>
    </div>
    <div class="modal-foot"><span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="idSave"><svg><use href="#i-plus"/></svg>Save idea</button></div>`, { wide: true });

  wireDropzone($('#idDrop', m), url => { $('#idB', m).value += `\n\n![](${url})\n`; });
  wirePaste(m, $('#idB', m));
  setTimeout(() => $('#idT', m).focus(), 40);

  $('#idSave', m).onclick = async () => {
    const title = $('#idT', m).value.trim();
    if (!title) { toast('Give it a name', 'err'); return; }
    const tags = $('#idG', m).value.split(',').map(t => t.trim()).filter(Boolean);
    try {
      await createIdea(title, $('#idB', m).value, tags);
      closeModal(); renderIdeas(); paintCounts();
      toast('Idea saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function createIdea(title, body, tags = []) {
  const labels = [IDEA_LABEL, ...tags];
  if (S.demo) {
    const issue = { number: Math.max(0, ...S.issues.map(i => i.number)) + 1, title, body, state: 'open',
      labels: labels.map(n => ({ name: n, color: 'd9ae3f' })), created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), closed_at: null, comments: 0, html_url: '#', user: { login: 'you' } };
    S.issues.unshift(issue); return issue;
  }
  const { owner, repo } = repoNow();
  await ensureIdeaLabel();
  const r = await gh(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, body, labels } });
  S.issues.unshift(r.data);
  return r.data;
}

async function ensureIdeaLabel() {
  if (S.labels.some(l => l.name.toLowerCase() === IDEA_LABEL)) return;
  const { owner, repo } = repoNow();
  try {
    const r = await gh(`/repos/${owner}/${repo}/labels`, { method: 'POST',
      body: { name: IDEA_LABEL, color: 'd9ae3f', description: 'Unformed — not on the board yet' } });
    S.labels.push(r.data);
  } catch (e) { if (e.status !== 422) throw e; }
}

function openPromote(num) {
  const issue = S.issues.find(i => i.number === num);
  if (!issue) return;
  const openMs = S.milestones.filter(m => m.state === 'open');
  const m = openModal(`
    ${modalHead(`Promote <span class="mono" style="color:var(--fg-faint)">#${num}</span>`)}
    <div class="modal-body">
      <p class="hint" style="margin:0 0 14px">This drops the <code>${IDEA_LABEL}</code> label and gives it a status, so it starts appearing on the board.</p>
      <div class="row">
        <div class="field" style="margin:0;flex:0 0 190px"><label>Into column</label>
          <select class="select" id="prCol">${S.columns.filter(c => c.id !== 'done').map(c =>
            `<option value="${c.id}" ${c.id === 'todo' ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        ${openMs.length ? `<div class="field" style="margin:0;flex:0 0 210px"><label>Milestone</label>
          <select class="select" id="prMs"><option value="">None</option>
            ${openMs.map(x => `<option value="${x.number}">${esc(x.title)}</option>`).join('')}</select></div>` : ''}
      </div>
    </div>
    <div class="modal-foot"><span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="prGo"><svg><use href="#i-bolt"/></svg>Promote</button></div>`);

  $('#prGo', m).onclick = async () => {
    const col = S.columns.find(c => c.id === $('#prCol', m).value);
    const keep = (issue.labels || []).map(l => l.name || l)
      .filter(n => String(n).toLowerCase() !== IDEA_LABEL);
    const body = { labels: [...keep, col.label] };
    const msSel = $('#prMs', m) ? $('#prMs', m).value : '';
    if (msSel) body.milestone = +msSel;
    if (S.demo) {
      issue.labels = body.labels.map(n => ({ name: n, color: '5a6470' }));
      closeModal(); render(); paintCounts(); return;
    }
    try {
      const { owner, repo } = repoNow();
      const r = await gh(`/repos/${owner}/${repo}/issues/${num}`, { method: 'PATCH', body });
      Object.assign(issue, r.data);
      closeModal(); render(); paintCounts();
      toast(`#${num} is now a task in ${col.name}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- milestones ---------- */
function msStats(ms) {
  const mine = S.issues.filter(i => i.milestone && i.milestone.number === ms.number);
  const byCol = {};
  S.columns.forEach(c => byCol[c.id] = []);
  for (const i of mine) (byCol[colOf(i)] = byCol[colOf(i)] || []).push(i);
  const done = (byCol.done || []).length;
  const total = mine.length;
  // GitHub's own counts include PRs; ours are issues only. Show the gap if any.
  const apiTotal = (ms.open_issues || 0) + (ms.closed_issues || 0);
  return { mine, byCol, done, total, apiTotal, remaining: total - done, pct: total ? Math.round(done / total * 100) : 0 };
}

function msDue(ms) {
  if (!ms.due_on) return { text: 'No due date', tone: 'none' };
  const d = new Date(ms.due_on);
  const days = Math.ceil((d - Date.now()) / 864e5);
  const on = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (days < 0)   return { text: `Overdue by ${-days} day${days === -1 ? '' : 's'}`, tone: 'bad', days, on };
  if (days === 0) return { text: 'Due today', tone: 'warn', days, on };
  if (days <= 14) return { text: `${days} day${days === 1 ? '' : 's'} left`, tone: days <= 7 ? 'warn' : 'ok', days, on };
  return { text: `Due ${on}`, tone: 'ok', days, on };
}

// Rough pace projection. Deliberately silent until there is enough history
// to say anything honest — three closed tasks is the floor.
function msPace(st) {
  const closed = st.mine.filter(i => i.closed_at);
  if (closed.length < 3 || !st.remaining) return null;
  const first = Math.min(...closed.map(i => +new Date(i.closed_at)));
  const weeks = Math.max(0.5, (Date.now() - first) / 6048e5);
  const rate = closed.length / weeks;
  if (rate <= 0) return null;
  const weeksLeft = st.remaining / rate;
  return { rate, weeksLeft, eta: new Date(Date.now() + weeksLeft * 6048e5) };
}

function msCardHTML(ms) {
  const st = msStats(ms), due = msDue(ms), pace = msPace(st);
  const open = S.columns.filter(c => c.id !== 'done');
  const verdict = (() => {
    if (!pace || !due.days) return null;
    if (due.tone === 'none') return null;
    const slack = due.days - pace.weeksLeft * 7;
    if (slack >= 3)  return { tone: 'ok',   text: `On track — about ${Math.round(pace.weeksLeft * 7)} days of work left, ${due.days} days available` };
    if (slack >= -3) return { tone: 'warn', text: `Tight — roughly ${Math.round(pace.weeksLeft * 7)} days of work against ${due.days} days left` };
    return { tone: 'bad', text: `Behind — about ${Math.round(-slack)} days short at ${pace.rate.toFixed(1)} tasks/week` };
  })();

  return `
  <section class="ms ${ms.state === 'closed' ? 'is-closed' : ''}">
    <header class="ms-head">
      <div class="ms-title">
        <h3>${esc(ms.title)}</h3>
        ${ms.state === 'closed' ? '<span class="pr-pill s-done">closed</span>' : ''}
        <span class="ms-due t-${due.tone}">${esc(due.text)}</span>
      </div>
      <div class="ms-actions">
        <span class="ms-frac"><b>${st.done}</b>/${st.total}</span>
        <button class="icon-btn" data-act="ms-edit" data-ms="${ms.number}" title="Edit milestone"><svg><use href="#i-cog"/></svg></button>
        <a class="icon-btn" href="${attr(ms.html_url || '#')}" target="_blank" rel="noopener" title="Open on GitHub"><svg><use href="#i-external"/></svg></a>
      </div>
    </header>

    <div class="ms-bar" role="progressbar" aria-valuenow="${st.pct}" aria-valuemin="0" aria-valuemax="100"
         aria-label="${esc(ms.title)}: ${st.done} of ${st.total} done">
      <i class="seg done" style="width:${st.total ? st.done / st.total * 100 : 0}%" title="Done: ${st.done}"></i>
      ${[...open].reverse().map(c => {
        const n = (st.byCol[c.id] || []).length;
        return n ? `<i class="seg" style="width:${n / Math.max(st.total, 1) * 100}%;background:${esc(c.color)}" title="${esc(c.name)}: ${n}"></i>` : '';
      }).join('')}
      <span class="ms-pct">${st.pct}%</span>
    </div>

    <div class="ms-legend">
      ${S.columns.map(c => {
        const n = c.id === 'done' ? st.done : (st.byCol[c.id] || []).length;
        return `<span class="ms-chip"><i style="background:${esc(c.color)}"></i>${esc(c.name)} <b>${n}</b></span>`;
      }).join('')}
      ${st.apiTotal > st.total ? `<span class="ms-chip warnish">showing ${st.total} of ${st.apiTotal} — the rest are pull requests or beyond the fetch limit</span>` : ''}
    </div>

    ${verdict ? `<div class="ms-verdict t-${verdict.tone}">${esc(verdict.text)}</div>` : ''}
    ${ms.description ? `<p class="ms-desc">${esc(ms.description)}</p>` : ''}

    ${st.remaining ? `
      <div class="ms-todo">
        <div class="micro">What's left — ${st.remaining} task${st.remaining === 1 ? '' : 's'}</div>
        ${['review', 'progress', 'todo'].map(id => {
          const col = S.columns.find(c => c.id === id); if (!col) return '';
          const list = st.byCol[id] || []; if (!list.length) return '';
          return `<div class="ms-group">
            <div class="ms-group-head"><i style="background:${esc(col.color)}"></i>${esc(col.name)}<b>${list.length}</b></div>
            ${list.map(i => `<button class="ms-task" data-act="ms-open" data-num="${i.number}">
                <span class="mono">#${i.number}</span><span class="t">${esc(i.title)}</span>
                ${taskProgress(i.body) ? `<span class="ms-sub">${taskProgress(i.body).done}/${taskProgress(i.body).total}</span>` : ''}
              </button>`).join('')}
          </div>`;
        }).join('')}
      </div>`
      : `<div class="ms-clear">${st.total ? 'Everything in this milestone is done.' : 'No tasks assigned yet — pick some from Unassigned below.'}</div>`}
  </section>`;
}

function renderMilestones() {
  if (!S.token) {
    $('#msWrap').innerHTML = `<div class="empty"><svg><use href="#i-flag"/></svg><h3>Connect GitHub first</h3>
      <p>Milestones are read from the repository, so this mirrors whatever you already have on github.com.</p></div>`;
    return;
  }
  const open = S.milestones.filter(m => m.state === 'open');
  const closed = S.milestones.filter(m => m.state === 'closed');
  const loose = S.issues.filter(i => !i.milestone && i.state === 'open');

  $('#msWrap').innerHTML = `
    <div class="ms-wrap">
      <div class="row" style="justify-content:space-between">
        <div class="micro">${open.length} open milestone${open.length === 1 ? '' : 's'}</div>
        <button class="btn btn-primary btn-sm" data-act="ms-new"><svg><use href="#i-plus"/></svg>New milestone</button>
      </div>

      ${open.length ? open.map(msCardHTML).join('')
        : `<div class="empty"><svg><use href="#i-flag"/></svg><h3>No open milestones</h3>
           <p>A milestone is just a named bucket with a due date. Make one, drop tasks into it, and this page shows how far through it you are and exactly what is left.</p>
           <button class="btn btn-primary" data-act="ms-new"><svg><use href="#i-plus"/></svg>Create the first one</button></div>`}

      ${loose.length ? `
        <section class="ms">
          <header class="ms-head"><div class="ms-title"><h3>Unassigned</h3>
            <span class="ms-due t-none">${loose.length} open task${loose.length === 1 ? '' : 's'} in no milestone</span></div></header>
          <div class="ms-todo">
            ${loose.slice(0, 40).map(i => `
              <div class="ms-task ms-loose">
                <span class="mono">#${i.number}</span>
                <span class="t" data-act="ms-open" data-num="${i.number}">${esc(i.title)}</span>
                <select class="select ms-assign" data-assign="${i.number}">
                  <option value="">Assign to…</option>
                  ${open.map(m => `<option value="${m.number}">${esc(m.title)}</option>`).join('')}
                </select>
              </div>`).join('')}
          </div>
        </section>` : ''}

      ${closed.length ? `<details class="ms-closed-wrap"><summary>${closed.length} closed milestone${closed.length === 1 ? '' : 's'}</summary>
        ${closed.map(msCardHTML).join('')}</details>` : ''}
    </div>`;

  $$('.ms-assign').forEach(sel => sel.onchange = () => assignMilestone(+sel.dataset.assign, sel.value ? +sel.value : null));
}

async function assignMilestone(num, msNumber) {
  const issue = S.issues.find(i => i.number === num);
  if (!issue) return;
  if (S.demo) {
    issue.milestone = msNumber ? S.milestones.find(m => m.number === msNumber) : null;
    renderMilestones(); return;
  }
  try {
    const { owner, repo } = repoNow();
    const r = await gh(`/repos/${owner}/${repo}/issues/${num}`, { method: 'PATCH', body: { milestone: msNumber } });
    Object.assign(issue, r.data);
    toast(msNumber ? `#${num} → ${S.milestones.find(m => m.number === msNumber).title}` : `#${num} removed from milestone`, 'ok');
    renderMilestones(); renderBoard();
  } catch (e) { toast(e.message, 'err'); renderMilestones(); }
}

function openMilestoneEdit(number) {
  const ms = S.milestones.find(m => m.number === number);
  const isNew = !ms;
  const due = ms && ms.due_on ? new Date(ms.due_on).toISOString().slice(0, 10) : '';
  const m = openModal(`
    ${modalHead(isNew ? 'New milestone' : 'Edit milestone')}
    <div class="modal-body">
      <div class="field"><label>Title</label><input class="input" id="msT" value="${attr(ms ? ms.title : '')}" placeholder="Vertical slice"></div>
      <div class="row" style="margin-bottom:13px">
        <div class="field" style="margin:0;flex:0 0 190px"><label>Due date</label><input class="input" id="msD" type="date" value="${attr(due)}"></div>
        <div class="field" style="margin:0;flex:0 0 160px"><label>State</label>
          <select class="select" id="msS">
            <option value="open" ${!ms || ms.state === 'open' ? 'selected' : ''}>Open</option>
            <option value="closed" ${ms && ms.state === 'closed' ? 'selected' : ''}>Closed</option>
          </select></div>
      </div>
      <div class="field"><label>Description</label><textarea class="textarea" id="msB" style="min-height:90px;font-family:var(--font);font-size:13px">${esc(ms ? (ms.description || '') : '')}</textarea></div>
    </div>
    <div class="modal-foot"><span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="msSave"><svg><use href="#i-check"/></svg>${isNew ? 'Create' : 'Save'}</button></div>`);

  $('#msSave', m).onclick = async () => {
    const title = $('#msT', m).value.trim();
    if (!title) { toast('A title is required', 'err'); return; }
    const body = { title, state: $('#msS', m).value, description: $('#msB', m).value };
    const d = $('#msD', m).value;
    if (d) body.due_on = new Date(d + 'T23:59:59Z').toISOString();
    const { owner, repo } = repoNow();
    try {
      const r = isNew
        ? await gh(`/repos/${owner}/${repo}/milestones`, { method: 'POST', body })
        : await gh(`/repos/${owner}/${repo}/milestones/${number}`, { method: 'PATCH', body });
      if (isNew) S.milestones.push(r.data); else Object.assign(ms, r.data);
      closeModal(); paintCounts(); renderMilestones();
      toast(isNew ? 'Milestone created' : 'Milestone saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- design docs reader ---------- */
async function loadDocs() {
  if (!S.token) { S.docs = []; return; }
  const { owner, repo } = repoNow();
  try {
    const entries = await ghGet(`/repos/${owner}/${repo}/contents/`);
    S.docs = (Array.isArray(entries) ? entries : [])
      .filter(e => e.type === 'file' && /\.(md|markdown|txt)$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, path: e.path, size: e.size }));
  } catch { S.docs = []; }
}

async function docBody(path) {
  S.docCache = S.docCache || {};
  if (S.docCache[path]) return S.docCache[path];
  const { owner, repo } = repoNow();
  const r = await ghGet(`/repos/${owner}/${repo}/contents/${path}`);
  const text = b64dec(r.content);
  S.docCache[path] = text;
  return text;
}

// PALETTE.md is mostly hex ramps — show them as colours, not text.
function withSwatches(html) {
  return html.replace(/<code>#([0-9a-fA-F]{6})<\/code>/g,
    (_, hex) => `<button class="swatch" data-hex="#${hex}" title="Copy #${hex}"><i style="background:#${hex}"></i><code>#${hex}</code></button>`);
}

async function openDoc(path) {
  S.doc = path;
  renderDocs();
  const pane = $('#docPane');
  if (!pane) return;
  pane.innerHTML = '<div class="skel" style="height:60vh"></div>';
  try {
    const text = await docBody(path);
    pane.innerHTML = withSwatches(md(text));
    pane.scrollTop = 0;
  } catch (e) { pane.innerHTML = `<div class="empty"><h3>Could not load ${esc(path)}</h3><p>${esc(e.message)}</p></div>`; }
}

async function docSearch(q) {
  const hits = [];
  for (const d of S.docs || []) {
    let text;
    try { text = await docBody(d.path); } catch { continue; }
    const lines = text.split('\n');
    const found = [];
    lines.forEach((l, i) => { if (l.toLowerCase().includes(q) && found.length < 4) found.push({ n: i + 1, l: l.trim().slice(0, 160) }); });
    if (found.length) hits.push({ doc: d, found, total: lines.filter(l => l.toLowerCase().includes(q)).length });
  }
  return hits;
}

function renderDocs() {
  const docs = S.docs || [];
  if (!S.token) {
    $('#docsWrap').innerHTML = `<div class="empty"><svg><use href="#i-doc"/></svg><h3>Connect GitHub first</h3>
      <p>This reads the markdown files at the root of the active repository so you can keep ARCHITECTURE, DESIGN and PALETTE open beside the board.</p></div>`;
    return;
  }
  $('#docsWrap').innerHTML = `
    <div class="docs">
      <aside class="docs-nav">
        <div class="search docs-search"><svg><use href="#i-search"/></svg>
          <input id="docQ" type="search" placeholder="Search all docs…" value="${attr(S.docQ || '')}"></div>
        <div class="docs-list">${docs.length ? docs.map(d => `
          <button class="docs-item ${S.doc === d.path ? 'is-on' : ''}" data-doc="${attr(d.path)}">
            <span>${esc(d.name)}</span><i>${(d.size || 0) >= 1024 ? Math.round(d.size / 1024) + 'k' : '<1k'}</i>
          </button>`).join('') : '<div class="hint" style="padding:10px">No markdown at the repo root.</div>'}</div>
      </aside>
      <article class="docs-body md" id="docPane">${
        S.doc ? '<div class="skel" style="height:60vh"></div>'
              : `<div class="empty"><svg><use href="#i-doc"/></svg><h3>${docs.length} documents</h3>
                 <p>Pick one, or search across all of them at once. Hex codes render as swatches — click to copy.</p></div>`}</article>
    </div>`;

  let t;
  const q = $('#docQ');
  if (q) q.addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      S.docQ = e.target.value;
      const term = S.docQ.trim().toLowerCase();
      const pane = $('#docPane');
      if (!term) { S.doc ? openDoc(S.doc) : renderDocs(); return; }
      pane.innerHTML = '<div class="skel" style="height:120px"></div>';
      const hits = await docSearch(term);
      pane.innerHTML = hits.length ? `<div class="doc-hits">${hits.map(h => `
        <div class="doc-hit">
          <button class="doc-hit-head" data-doc="${attr(h.doc.path)}">${esc(h.doc.name)}<i>${h.total} match${h.total === 1 ? '' : 'es'}</i></button>
          ${h.found.map(f => `<div class="doc-hit-line"><span class="mono">${f.n}</span>${esc(f.l)}</div>`).join('')}
        </div>`).join('')}</div>`
        : '<div class="empty"><p>Nothing found.</p></div>';
    }, 240);
  });
}

/* ---------- import loose notes as tasks ---------- */
/* Turn a loose notes file into tasks.
   Three shapes, in priority order:
     1. a block of bullets  -> one task per bullet
     2. a short line ending in ':' -> a heading; the NEXT block is its body
     3. anything else       -> first line is the title, the rest the body */
// bullets under a heading are subtasks — make them tickable
function asChecklist(body) {
  const lines = body.split('\n');
  const bullets = lines.filter(l => /^\s*[-*+]\s+/.test(l));
  if (bullets.length < 2 || bullets.length !== lines.filter(l => l.trim()).length) return body;
  return lines.map(l => l.replace(/^(\s*)[-*+]\s+(?!\[[ xX]\])/, '$1- [ ] ')).join('\n');
}

function parseNotes(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
    .map(b => b.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n').map(l => l.trim()).filter(Boolean);

    if (lines.length > 1 && lines.every(l => /^[-*+]\s+/.test(l))) {
      for (const l of lines) out.push({ title: l.replace(/^[-*+]\s+/, ''), body: '' });
      continue;
    }

    const head = lines[0].replace(/^[-*#\s]+/, '').trim();
    const isHeading = lines.length === 1 && head.length <= 80 && /:$/.test(head);
    if (isHeading && blocks[i + 1]) {
      out.push({ title: head.replace(/:$/, '').trim(), body: asChecklist(blocks[++i].trim()) });
      continue;
    }
    out.push({ title: head.replace(/:$/, '').trim(), body: lines.slice(1).join('\n').trim() });
  }
  return out.filter(b => b.title);
}

function openImport() {
  const m = openModal(`
    ${modalHead('Import tasks from a file')}
    <div class="modal-body">
      <div class="field">
        <label>File in ${esc(repoKey())}</label>
        <div class="row"><input class="input" id="impPath" value="ideas.txt" style="flex:1">
          <button class="btn btn-ghost btn-sm" id="impLoad">Read file</button></div>
        <span class="hint">Blocks separated by a blank line become one task each — first line is the title, the rest becomes the description.</span>
      </div>
      <div id="impOut"></div>
    </div>
    <div class="modal-foot"><span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Cancel</button>
      <button class="btn btn-primary" id="impGo" disabled><svg><use href="#i-plus"/></svg>Create selected</button></div>`, { wide: true });

  let blocks = [];
  $('#impLoad', m).onclick = async () => {
    const out = $('#impOut', m);
    out.innerHTML = '<div class="skel" style="height:80px"></div>';
    try {
      const { owner, repo } = repoNow();
      const r = await ghGet(`/repos/${owner}/${repo}/contents/${$('#impPath', m).value.trim()}`);
      blocks = parseNotes(b64dec(r.content));
      out.innerHTML = blocks.length ? `
        <div class="micro" style="margin-bottom:8px">${blocks.length} block(s) found</div>
        <div class="imp-list">${blocks.map((b, i) => `
          <label class="imp-row">
            <input type="checkbox" checked data-imp="${i}">
            <div><b>${esc(b.title)}</b>${b.body ? `<span>${esc(b.body.slice(0, 180))}</span>` : ''}</div>
          </label>`).join('')}</div>
        <div class="field" style="margin-top:13px"><label>Import as</label>
          <select class="select" id="impCol" style="max-width:230px">
            <option value="__idea" selected>💡 Ideas — kept off the board</option>
            ${S.columns.map(c => `<option value="${c.id}">Task in ${esc(c.name)}</option>`).join('')}
          </select></div>`
        : '<div class="callout info">No blocks found in that file.</div>';
      $('#impGo', m).disabled = !blocks.length;
    } catch (e) {
      out.innerHTML = `<div class="callout warn">${esc(e.status === 404 ? 'No such file in this repository.' : e.message)}</div>`;
      $('#impGo', m).disabled = true;
    }
  };

  $('#impGo', m).onclick = async () => {
    const picked = $$('[data-imp]', m).filter(c => c.checked).map(c => blocks[+c.dataset.imp]);
    const col = ($('#impCol', m) || {}).value || '__idea';
    const btn = $('#impGo', m); btn.disabled = true;
    let made = 0;
    for (const b of picked) {
      btn.textContent = `Creating ${made + 1}/${picked.length}…`;
      try {
        if (col === '__idea') await createIdea(b.title, b.body);
        else await createTask({ title: b.title, body: b.body, col });
        made++;
      }
      catch (e) { toast(`${b.title}: ${e.message}`, 'err'); break; }
    }
    closeModal(); render(); paintCounts();
    toast(`Imported ${made} ${col === '__idea' ? 'idea' : 'task'}(s)`, 'ok');
  };
}

/* ---------- devlog ---------- */
function openDevlog() {
  const build = days => {
    const since = Date.now() - days * 864e5;
    const done = S.issues.filter(i => i.closed_at && new Date(i.closed_at) >= since)
                         .sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
    const merged = S.prs.filter(p => p.merged_at && new Date(p.merged_at) >= since);
    const wip = S.issues.filter(i => i.state === 'open' && colOf(i) === 'progress');
    const d = new Date();
    let out = `## Devlog — ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}\n\n`;
    out += `_Last ${days} days on ${repoKey()}._\n\n`;
    if (done.length) out += `### Shipped\n\n${done.map(i => `- ${i.title} (#${i.number})`).join('\n')}\n\n`;
    if (merged.length) out += `### Merged\n\n${merged.map(p => `- ${p.title} (#${p.number})`).join('\n')}\n\n`;
    if (wip.length) out += `### In flight\n\n${wip.map(i => `- ${i.title} (#${i.number})`).join('\n')}\n\n`;
    if (!done.length && !merged.length && !wip.length) out += `_Nothing closed in this window._\n`;
    return out;
  };

  const m = openModal(`
    ${modalHead('Devlog')}
    <div class="modal-body">
      <div class="row" style="margin-bottom:12px">
        ${[7, 14, 30, 90].map(d => `<button class="chip ${d === 14 ? 'is-on' : ''}" data-days="${d}">${d} days</button>`).join('')}
      </div>
      <textarea class="textarea" id="dlOut" style="min-height:320px">${esc(build(14))}</textarea>
    </div>
    <div class="modal-foot"><span class="spacer"></span>
      <button class="btn btn-ghost" data-act="close">Close</button>
      <button class="btn btn-primary" id="dlCopy"><svg><use href="#i-copy"/></svg>Copy markdown</button></div>`, { wide: true });

  $$('[data-days]', m).forEach(b => b.onclick = () => {
    $$('[data-days]', m).forEach(x => x.classList.toggle('is-on', x === b));
    $('#dlOut', m).value = build(+b.dataset.days);
  });
  $('#dlCopy', m).onclick = async () => {
    try { await navigator.clipboard.writeText($('#dlOut', m).value); toast('Copied', 'ok'); }
    catch { $('#dlOut', m).select(); toast('Press ⌘C to copy'); }
  };
}

})();
