/* Kea Tracker - board.js | data loading, board, drag and drop, task modal. */
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

