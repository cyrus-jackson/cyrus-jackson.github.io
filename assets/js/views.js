/* Kea Mission Control - views.js | modals, PRs, inspiration, progress, settings, demo, router, actions, events, init. */
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
function durLineHTML(issue) {
  const span = spanOf(issue), est = estOf(issue);
  let bit;
  if (span !== null) {
    bit = span.basis === 'work'
      ? `Took <b>${fmtDur(span.days)}</b> in progress → done`
      : `Took <b>${fmtDur(span.days)}</b> from created to done`;
  } else {
    const start = startedAtSync(issue);
    bit = start && colOf(issue) !== (S.columns[0] || {}).id
      ? `In progress <b>${fmtDur((Date.now() - new Date(start)) / 864e5)}</b> so far`
      : `Open <b>${fmtDur(openDays(issue))}</b> so far`;
  }
  const base = span !== null ? span.days : null;
  const cmp = est ? ` · estimated <b>${fmtDur(est)}</b>${base !== null ? ` (${(base / est).toFixed(1)}x)` : ''}` : '';
  const note = span !== null && span.basis === 'lead'
    ? ` <span style="color:var(--fg-faint)" title="This task never visited In Progress, so there is no work start to measure from.">· created → done</span>` : '';
  return `<div class="dur-line" id="tDur">${bit}${cmp}${note}</div>`;
}

// After the modal paints, resolve the work start from label history (one
// cached call) and upgrade the line in place when history knows more.
function refineDurLine(issue) {
  if (startedAtSync(issue) || !progressLabel() || S.demo || !S.token) return;
  fetchWorkStart(issue).then(start => {
    if (!start) return;
    const el = $('#tDur');
    if (el) el.outerHTML = durLineHTML(issue);
    if (S.view === 'board') renderBoard();
  });
}

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
        <div class="field" style="margin:0;flex:0 0 132px">
          <label>Estimate</label>
          <select class="select" id="tEst">
            <option value="">None</option>
            ${EST_CHOICES.map(d => `<option value="${d}" ${estOf(issue) === d ? 'selected' : ''}>${fmtDur(d)}</option>`).join('')}
          </select>
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
            S.labels.filter(l => !statusLabels.has(l.name.toLowerCase()) && !isEstLabel(l.name)).map(l => {
              const on = (issue.labels || []).some(x => (x.name || x) === l.name);
              return `<button class="chip ${on ? 'is-on' : ''}" data-lbl="${attr(l.name)}">
                        <i class="sw" style="background:#${esc(l.color)}"></i>${esc(l.name)}</button>`;
            }).join('') || '<span class="hint">No labels in this repo yet.</span>'}</div>
        </div>
      </div>

      ${durLineHTML(issue)}
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

  refineDurLine(issue);

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
    const estSel = $('#tEst', m).value;
    payload.labels = payload.labels.filter(n => !isEstLabel(n));
    if (estSel) payload.labels.push(estLabelName(parseFloat(estSel)));
    const msSel = $('#tMs', m).value;
    const curMs = issue.milestone ? String(issue.milestone.number) : '';
    if (msSel !== curMs) payload.milestone = msSel ? +msSel : null;
    if (S.closeOnDone) payload.state = toCol === 'done' ? 'closed' : 'open';
    if (S.demo) {
      Object.assign(issue, payload, { labels: payload.labels.map(n => ({ name: n, color: '5a6470' })), updated_at: new Date().toISOString() });
      closeModal(); render(); return;
    }
    try {
      if (estSel) await ensureLabel(estLabelName(parseFloat(estSel)), '5a6470', 'Kea Mission Control — estimate');
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
function streakHTML(closed) {
  if (!fxOn('streaks') || !closed.length) return '';
  const r = shipStreaks(closed.map(i => i.closed_at));
  const streak = n => n > 0 ? `${n}d` : '—';
  return `<div class="streak-row" title="Consecutive calendar days with at least one close">
    <span class="streak${r.current >= 7 ? ' hot' : ''}">🔥 <b>${streak(r.current)}</b> streak</span>
    <span class="streak">🏆 <b>${streak(r.longest)}</b> longest</span>
    <span class="streak">📦 <b>${r.bestWeek}</b> best week</span>
  </div>`;
}

function renderProgress() {
  const tasks = S.issues.filter(i => !isIdea(i));
  const closed = tasks.filter(i => i.closed_at).sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
  const weeks = [];
  const now = startOfWeek(new Date());
  for (let w = 7; w >= 0; w--) {
    const from = new Date(now); from.setDate(from.getDate() - w * 7);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    weeks.push({ from, n: closed.filter(i => { const d = new Date(i.closed_at); return d >= from && d < to; }).length });
  }
  const max = Math.max(1, ...weeks.map(w => w.n));
  const byCol = S.columns.map(c => ({ c, n: tasks.filter(i => colOf(i) === c.id).length }));
  const totalCol = Math.max(1, byCol.reduce((a, b) => a + b.n, 0));
  const openN = tasks.filter(i => i.state === 'open').length;
  const merged30 = S.prs.filter(p => p.merged_at && Date.now() - new Date(p.merged_at) < 30 * 864e5).length;

  // Days you actually shipped on, not days elapsed.
  const shipDays   = new Set(closed.map(i => dayKey(i.closed_at)));
  const perShipDay = shipDays.size ? closed.length / shipDays.size : 0;
  const spans      = closed.map(i => ({ i, s: spanOf(i) })).filter(x => x.s && x.s.days >= 0);
  const medSpan    = median(spans.map(x => x.s.days));
  const unmeasured = closed.filter(i => !startedAtSync(i));
  const openTasks  = tasks.filter(i => i.state === 'open');
  const times      = closed.map(i => +new Date(i.closed_at));
  const spanDays   = times.length ? (Math.max(...times) - Math.min(...times)) / 864e5 : null;

  // Only project when there is enough history to mean anything.
  const enough      = closed.length >= 3 && shipDays.size >= 2;
  const backlogDays = enough && perShipDay > 0 ? openTasks.length / perShipDay : null;
  const density     = spanDays && spanDays >= 1 ? shipDays.size / spanDays : null;   // share of days you ship
  const etaDays     = backlogDays && density ? backlogDays / density : null;
  const eta         = etaDays ? new Date(Date.now() + etaDays * 864e5) : null;

  const strip = [];
  for (let d = 29; d >= 0; d--) {
    const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - d);
    strip.push({ day, n: closed.filter(i => dayKey(i.closed_at) === dayKey(day)).length });
  }
  const stripMax = Math.max(1, ...strip.map(x => x.n));

  const withEst   = spans.filter(x => estOf(x.i));
  const estRatio  = withEst.length ? median(withEst.map(x => x.s.days / estOf(x.i))) : null;
  const slowest   = [...spans].sort((a, b) => b.s.days - a.s.days).slice(0, 5);

  $('#progWrap').innerHTML = `
    <div class="prog-wrap">
      <div class="stat-row">
        <div class="stat"><b>${openN}</b><span class="lab">Open tasks</span></div>
        <div class="stat"><b style="color:var(--ok)">${closed.length}</b><span class="lab">Completed</span></div>
        <div class="stat"><b style="color:var(--accent)">${weeks[weeks.length - 1].n}</b><span class="lab">Closed this week</span></div>
        <div class="stat"><b>${S.prs.filter(p => p.state === 'open').length}</b><span class="lab">Open PRs</span></div>
        <div class="stat"><b style="color:var(--merged)">${merged30}</b><span class="lab">Merged · 30 days</span></div>
      </div>

      ${streakHTML(closed)}

      <div class="panel">
        <h3>Tasks completed per week</h3>
        <div class="bars">${weeks.map(w => `
          <div class="bar-col">
            <div class="bar" style="height:${Math.max(3, w.n / max * 100)}%">${w.n ? `<span>${w.n}</span>` : ''}</div>
            <div class="bar-lab">${w.from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
          </div>`).join('')}</div>
      </div>

      <div class="panel">
        <h3>Time</h3>
        ${closed.length ? `
          <div class="stat-row" style="margin-bottom:16px">
            <div class="stat"><b>${shipDays.size}</b><span class="lab">Days shipped on</span></div>
            <div class="stat"><b>${perShipDay ? perShipDay.toFixed(1) : '—'}</b><span class="lab">Tasks per those days</span></div>
            <div class="stat"><b>${medSpan !== null ? fmtDur(medSpan) : '—'}</b><span class="lab">Median work time</span></div>
            <div class="stat"><b style="color:${backlogDays ? 'var(--accent)' : 'var(--fg-faint)'}">${backlogDays ? fmtDur(backlogDays) : '—'}</b><span class="lab">Backlog at that pace</span></div>
            <div class="stat"><b>${spanDays !== null ? fmtDur(spanDays) : '—'}</b><span class="lab">Span of done work</span></div>
          </div>

          <div class="micro" style="margin-bottom:7px">Last 30 days</div>
          <div class="daystrip">${strip.map(x => `
            <i class="dcell${x.n ? ' on' : ''}" style="${x.n ? `opacity:${(0.35 + 0.65 * x.n / stripMax).toFixed(2)}` : ''}"
               title="${x.day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} — ${x.n} closed"></i>`).join('')}</div>
          <div class="daystrip-legend"><span>${strip[0].day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span><span>today</span></div>

          <div class="callout info" style="margin-top:15px">
            <b>${closed.length}</b> task${closed.length === 1 ? '' : 's'} closed across <b>${shipDays.size}</b> day${shipDays.size === 1 ? '' : 's'}${
              spanDays !== null && spanDays >= 1 ? ` in a ${fmtDur(spanDays)} window` : ''}.
            ${backlogDays ? `The ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} are about <b>${fmtDur(backlogDays)}</b> of shipping days${
              eta ? `, landing around <b>${eta.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</b> at your current rhythm` : ''}.`
              : 'Not enough history yet to project the backlog — that needs three closed tasks across two days.'}
            <br><span style="color:var(--fg-faint)">Work time runs from first entry into In Progress to close. The tracker stamps the start when you drag a card there; older cards are measured from label history${
              unmeasured.length && progressLabel() ? ` — <button data-act="measure-work" style="background:none;border:none;padding:0;color:var(--accent);cursor:pointer;text-decoration:underline;font:inherit">measure ${unmeasured.length} unmeasured task${unmeasured.length === 1 ? '' : 's'}</button> (${unmeasured.length} API call${unmeasured.length === 1 ? '' : 's'}, then cached)` : ''}. Tasks that never visited In Progress fall back to created → done and are marked †.</span>
          </div>

          ${estRatio !== null ? `<div class="legend-row" style="margin-top:14px">
            <div class="legend-item"><span class="k">Estimate accuracy</span>
              <span class="track" title="Bar fills with overrun, capped at 3x. On target is a third of the way across.">
                <i style="width:${Math.min(100, (estRatio / 3) * 100).toFixed(0)}%;background:${estRatio > 1.5 ? 'var(--bad)' : estRatio > 1.1 ? 'var(--warn)' : 'var(--ok)'}"></i></span>
              <span class="v">${estRatio.toFixed(1)}x</span></div>
            <div style="font-size:12px;color:var(--fg-faint)">Across ${withEst.length} estimated task${withEst.length === 1 ? '' : 's'}, work took ${estRatio.toFixed(1)}x the estimate${estRatio > 1.2 ? ' — worth padding new ones' : estRatio < 0.8 ? ' — you are over-padding' : ', which is close'}. Set one in a task's Estimate field.</div>
          </div>` : `<div style="font-size:12px;color:var(--fg-faint);margin-top:14px">No estimates set yet — open a task and pick one in the Estimate field to start tracking estimate against actual.</div>`}

          ${slowest.length ? `<div style="margin-top:16px"><div class="micro" style="margin-bottom:7px">Longest to finish</div>
            <div class="legend-row">${slowest.map(({ i, s }) => `
              <div class="legend-item" style="gap:9px">
                <span class="mono" style="color:var(--fg-faint);min-width:44px">#${i.number}</span>
                <span style="flex:1">${esc(i.title)}${s.basis === 'lead' ? '<sup title="Never visited In Progress — measured created → done">†</sup>' : ''}</span>
                ${estOf(i) ? `<span class="dur est">~${fmtDur(estOf(i))}</span>` : ''}
                <span class="v" style="min-width:56px" title="${s.basis === 'work' ? 'In progress → done' : 'Created → done'}">${fmtDur(s.days)}</span>
              </div>`).join('')}</div></div>` : ''}`
          : '<span style="color:var(--fg-faint)">Nothing closed yet, so there is no timing to report.</span>'}
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

/* Resolve work starts for every closed task missing one, then repaint. One
   timeline read each, ETag-cached afterwards, so the second visit is free. */
async function measureWorkTime(btn) {
  const missing = S.issues.filter(i => i.closed_at && !isIdea(i) && !startedAtSync(i));
  if (!missing.length) { renderProgress(); return; }
  if (btn) { btn.disabled = true; btn.textContent = `measuring 0/${missing.length}…`; }
  let done = 0;
  await Promise.allSettled(missing.map(i =>
    fetchWorkStart(i).finally(() => {
      done++;
      if (btn) btn.textContent = `measuring ${done}/${missing.length}…`;
    })));
  renderProgress();
  toast(`Measured ${missing.length} task${missing.length === 1 ? '' : 's'}`, 'ok');
}

/* ---------- settings ---------- */
function renderSettings() {
  const a = assetCfg();
  $('#setWrap').innerHTML = `
    <div class="set-wrap">
      <img class="wordmark" src="assets/logo/kea-wordmark-360.png" alt="Kea" width="360" height="238">
      <div class="panel">
        <h3>GitHub connection</h3>
        ${S.user ? `<div class="row" style="margin-bottom:13px">
            <img class="avatar" style="width:30px;height:30px" src="${attr(S.user.avatar_url)}" alt="">
            <b>${esc(S.user.login)}</b><span style="color:var(--ok);font-size:12px">connected</span>
          <div class="field" style="margin:0;flex:0 0 150px"><label>Pet species</label>
            <select class="select" id="fxPetKind" style="max-width:150px">
              ${Object.entries(PET_KINDS).map(([id, name]) =>
                `<option value="${id}" ${petKind() === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}
            </select></div>
          <div class="field" style="margin:0;flex:0 0 150px"><label>Pet's name</label>
            <input class="input" id="fxPetName" value="${attr(S.pet.name)}" maxlength="24" style="max-width:150px"></div>
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
        <h3>Look &amp; feel</h3>
        <span class="hint">Dressing only — nothing here touches your data. Motion always yields to your OS reduce-motion setting.</span>
        <div class="fx-grid">
          <label><input type="checkbox" id="fxConfetti" ${S.fx.confetti ? 'checked' : ''}> Ship-it confetti <span class="hint">when a card lands in Done</span></label>
          <label><input type="checkbox" id="fxCovers" ${S.fx.covers ? 'checked' : ''}> Card covers <span class="hint">screenshot header on cards</span></label>
          <label><input type="checkbox" id="fxAmbient" ${S.fx.ambient ? 'checked' : ''}> Ambient dust <span class="hint">slow drift behind everything</span></label>
          <label><input type="checkbox" id="fxClocks" ${S.fx.clocks ? 'checked' : ''}> Launch clocks <span class="hint">live T-minus on milestones</span></label>
          <label><input type="checkbox" id="fxStreaks" ${S.fx.streaks ? 'checked' : ''}> Streaks &amp; records <span class="hint">in Progress</span></label>
          <label><input type="checkbox" id="fxPet" ${petKind() !== 'off' ? 'checked' : ''}> Sidebar pet <span class="hint">kea or roller, fed by shipped tasks</span></label>
          <label><input type="checkbox" id="fxWander" ${S.fx.wander !== false ? 'checked' : ''}> Kea wanders <span class="hint">flies the screen now and then</span></label>
        </div>
        <div class="row" style="margin-top:13px">
          <div class="field" style="margin:0;flex:0 0 170px"><label>Burst style</label>
            <select class="select" id="fxBoomStyle">
              ${Object.entries(BOOM_STYLES).map(([id, s]) =>
                `<option value="${id}" ${((S.fx.boomStyle || 'ticker') === id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select></div>
          <div class="field" style="margin:0;flex:0 0 150px"><label>Confetti amount</label>
            <select class="select" id="fxBoom">
              <option value="full" ${S.fx.boom !== 'gentle' ? 'selected' : ''}>Full burst</option>
              <option value="gentle" ${S.fx.boom === 'gentle' ? 'selected' : ''}>Gentle</option>
            </select></div>
          <div class="field" style="margin:0;flex:0 0 170px"><label>Ambient dust</label>
            <select class="select" id="fxDust">
              <option value="subtle" ${S.fx.dust !== 'lively' ? 'selected' : ''}>Subtle</option>
              <option value="lively" ${S.fx.dust === 'lively' ? 'selected' : ''}>Lively</option>
            </select></div>
          <span style="flex:1"></span>
          <button class="btn btn-primary btn-sm" data-act="fx-save" style="align-self:flex-end"><svg><use href="#i-check"/></svg>Save look</button>
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
  if (S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; }
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
  else if (S.view === 'milestones') {
    renderMilestones();
    if (fxOn('clocks') && !S.clockTimer) S.clockTimer = setInterval(tickClocks, 1000);
  }
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
        body: { name: c.label, color: String(c.color).replace('#', ''), description: `Kea Mission Control — ${c.name}` } });
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
  const pet = $('#pet');
  if (pet) pet.onclick = () => patPet();
  paintPet();
  schedulePetFlight();
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
    else if (act === 'measure-work') measureWorkTime(el);
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
    else if (act === 'fx-save') {
      S.fx = { ...S.fx,
        confetti: $('#fxConfetti').checked, boom: $('#fxBoom').value, boomStyle: $('#fxBoomStyle').value,
        covers: $('#fxCovers').checked, ambient: $('#fxAmbient').checked, dust: $('#fxDust').value,
        clocks: $('#fxClocks').checked, streaks: $('#fxStreaks').checked, pet: $('#fxPet').checked, wander: $('#fxWander').checked };
      const kind = $('#fxPetKind').value;
      if (PET_KINDS[kind] && kind !== S.pet.kind) {
        S.pet.kind = kind;
        // Fresh species, fresh default name — unless already renamed.
        if (S.pet.name === 'Kiri' || S.pet.name === 'Rollo') S.pet.name = kind === 'droid' ? 'Rollo' : 'Kiri';
      }
      store.set('fx', S.fx);
      const petName = $('#fxPetName').value.trim().slice(0, 24);
      if (petName) { S.pet.name = petName; savePet(); }
      initAmbient(); paintPet();
      toast('Look saved', 'ok'); render();
    }
    else if (act === 'assets-save') {
      const [o, r] = $('#sAssetRepo').value.trim().split('/');
      if (!o || !r) { toast('Use the owner/repo form', 'err'); return; }
      S.assets = { owner: o, repo: r, branch: $('#sAssetBranch').value.trim() || 'master', dir: $('#sAssetDir').value.trim() || 'data/uploads' };
      store.set('assets', S.assets); S.inspSha = null;
      toast('Assets repo saved', 'ok'); loadInspiration();
    }
    else if (act === 'cache-clear') { cacheClear(); toast('Request cache cleared', 'ok'); renderSettings(); }
    else if (act === 'export') {
      const blob = new Blob([JSON.stringify({ repos: S.repos, columns: S.columns, assets: S.assets, order: S.order, inspiration: S.inspiration, fx: S.fx }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kea-mission-control-backup.json'; a.click();
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
  const mark = $('#kMark');
  if (mark) { mark.classList.add('is-spinning'); setTimeout(() => mark.classList.remove('is-spinning'), 1150); }
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

