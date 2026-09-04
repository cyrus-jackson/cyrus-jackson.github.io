/* Kea Mission Control - extras.js | quick capture, command palette, asset browser, ideas, milestones, docs reader, import, devlog. */
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
  for (const d of (S.docs || [])) push('Doc', d.path, '', () => { go('docs'); openDoc(d.path); }, 'i-doc');
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

/* Docs are found by walking the whole tree, not by listing the repo root.
   KeaGame keeps its design docs in Documentation/, and nested READMEs live
   under Sprites/ and tools/ — a root listing sees none of them. */
const DOC_RE   = /\.(md|markdown)$/i;
const TXT_RE   = /\.txt$/i;
const DOC_NOISE = /(^|\/)(node_modules|Library|Temp|obj|Build|Builds|Logs|\.git)(\/|$)/i;

function isDocPath(path) {
  if (DOC_NOISE.test(path)) return false;
  if (DOC_RE.test(path)) return true;
  if (!TXT_RE.test(path)) return false;
  // .txt is only a doc near the top or in a docs folder, so Unity's
  // ProjectSettings/ProjectVersion.txt does not turn up as design material.
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return dir === '' || /^(documentation|docs|design|notes)(\/|$)/i.test(dir);
}

async function repoBranch() {
  if (S.branch) return S.branch;
  const { owner, repo } = repoNow();
  try {
    const info = await ghGet(`/repos/${owner}/${repo}`);
    S.branch = info.default_branch || 'master';
  } catch { S.branch = 'master'; }
  return S.branch;
}

async function loadBranches() {
  if (S.branches) return S.branches;
  const { owner, repo } = repoNow();
  try {
    const bs = await ghGet(`/repos/${owner}/${repo}/branches?per_page=100`);
    S.branches = (Array.isArray(bs) ? bs : []).map(b => b.name);
  } catch { S.branches = []; }
  return S.branches;
}

async function loadDocs() {
  if (!S.token) { S.docs = []; return; }
  const { owner, repo } = repoNow();
  const branch = await repoBranch();
  S.docErr = null;
  try {
    const tree = await ghGet(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    S.docTruncated = !!(tree && tree.truncated);
    S.docs = ((tree && tree.tree) || [])
      .filter(n => n.type === 'blob' && isDocPath(n.path))
      .map(n => ({
        name: n.path.split('/').pop(),
        path: n.path,
        dir: n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '',
        size: n.size || 0,
      }))
      // root first, then shallowest folders, then alphabetical
      .sort((a, b) =>
        (a.dir === '' ? -1 : b.dir === '' ? 1 : 0) ||
        a.dir.split('/').length - b.dir.split('/').length ||
        a.dir.localeCompare(b.dir) ||
        a.name.localeCompare(b.name));
  } catch (e) {
    S.docs = []; S.docErr = e.message;
  }
  paintCounts();
}

async function docBody(path) {
  const branch = await repoBranch();
  const key = branch + ':' + path;
  S.docCache = S.docCache || {};
  if (S.docCache[key]) return S.docCache[key];
  const { owner, repo } = repoNow();
  const r = await ghGet(`/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
  const text = b64dec(r.content);
  S.docCache[key] = text;
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
      <p>This reads every markdown file in the active repository so you can keep ARCHITECTURE, DESIGN and PALETTE open beside the board.</p></div>`;
    return;
  }

  const groups = [];
  for (const d of docs) {
    const g = groups.find(x => x.dir === d.dir);
    (g || (groups[groups.push({ dir: d.dir, items: [] }) - 1])).items.push(d);
  }

  $('#docsWrap').innerHTML = `
    <div class="docs">
      <aside class="docs-nav">
        <div class="search docs-search"><svg><use href="#i-search"/></svg>
          <input id="docQ" type="search" placeholder="Search all docs…" value="${attr(S.docQ || '')}"></div>
        <select class="select docs-branch" id="docBranch" title="Branch to read">
          <option value="${attr(S.branch || '')}">${esc(S.branch || 'default branch')}</option>
        </select>
        <div class="docs-list">${groups.length ? groups.map(g => `
          ${g.dir ? `<div class="docs-group">${esc(g.dir)}</div>` : ''}
          ${g.items.map(d => `
            <button class="docs-item ${S.doc === d.path ? 'is-on' : ''}" data-doc="${attr(d.path)}" title="${attr(d.path)}">
              <span>${esc(d.name)}</span><i>${d.size >= 1024 ? Math.round(d.size / 1024) + 'k' : '<1k'}</i>
            </button>`).join('')}`).join('')
          : `<div class="hint" style="padding:10px;line-height:1.6">${
              S.docErr ? esc(S.docErr) : `No markdown found on <b>${esc(S.branch || '')}</b>. If your docs live on another branch, switch above.`}</div>`}
        </div>
        ${S.docTruncated ? '<div class="hint" style="padding:0 10px">Tree truncated by GitHub — some files may be missing.</div>' : ''}
      </aside>
      <article class="docs-body md" id="docPane">${
        S.doc ? '<div class="skel" style="height:60vh"></div>'
              : `<div class="empty"><svg><use href="#i-doc"/></svg><h3>${docs.length} document${docs.length === 1 ? '' : 's'} on ${esc(S.branch || '')}</h3>
                 <p>Pick one, or search across all of them at once. Hex codes render as swatches — click to copy.</p></div>`}</article>
    </div>`;

  // branch list is only worth fetching once the reader is actually open
  const bsel = $('#docBranch');
  if (bsel) {
    loadBranches().then(names => {
      if (!names.length || !$('#docBranch')) return;
      $('#docBranch').innerHTML = names.map(n =>
        `<option value="${attr(n)}" ${n === S.branch ? 'selected' : ''}>${esc(n)}</option>`).join('');
    });
    bsel.onchange = () => {
      S.branch = bsel.value;
      S.docs = null; S.doc = null; S.docCache = {}; S.docQ = '';
      renderDocs();
      loadDocs().then(renderDocs);
    };
  }

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
          <button class="doc-hit-head" data-doc="${attr(h.doc.path)}">${esc(h.doc.path)}<i>${h.total} match${h.total === 1 ? '' : 'es'}</i></button>
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

/* Milestone-plan JSON: { "tasks": [{ "id", "title", "days", "track", "needs", "body" }] },
   a bare [...] of such tasks, or { "milestones": [{ "tasks": [...] }]}.
   "days" becomes the estimate (est:<n>d label) on import; id/track/needs are
   kept as a header in the body so ordering info survives as real issues. */
function parseMilestoneJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  const lists = Array.isArray(doc) ? [doc]
    : Array.isArray(doc.tasks) ? [doc.tasks]
    : Array.isArray(doc.milestones) ? doc.milestones.map(m => m.tasks).filter(Array.isArray)
    : null;
  if (!lists) return null;
  const tasks = lists.flat();
  if (!tasks.length || !tasks.every(t => t && typeof t.title === 'string' && t.title.trim())) return null;
  return tasks.map(t => {
    const days = parseFloat(t.days);
    const needs = Array.isArray(t.needs) ? t.needs.filter(n => n !== undefined && n !== null && String(n).trim()) : [];
    const head = [
      [t.id ? String(t.id).trim() : '', Number.isFinite(days) && days > 0 ? `${days}d` : '', t.track ? `track ${String(t.track).trim()}` : ''].filter(Boolean).join(' · '),
      needs.length ? `Needs: ${needs.map(String).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const body = [head, String(t.body || '').trim()].filter(Boolean).join('\n\n');
    return { title: t.title.trim(), body, days: Number.isFinite(days) && days > 0 ? days : null };
  });
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
      const raw = b64dec(r.content);
      blocks = parseMilestoneJson(raw) || parseNotes(raw);
      out.innerHTML = blocks.length ? `
        <div class="micro" style="margin-bottom:8px">${blocks.length} block(s) found${blocks.some(b => b.days) ? ' · estimates from milestone-plan <code>days</code>' : ''}</div>
        <div class="imp-list">${blocks.map((b, i) => `
          <label class="imp-row">
            <input type="checkbox" checked data-imp="${i}">
            <div><b>${esc(b.title)}</b>${b.days ? ` <span class="dur est">~${esc(fmtDur(b.days))}</span>` : ''}${b.body ? `<span>${esc(b.body.slice(0, 180))}</span>` : ''}</div>
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
    if (!S.demo && col !== '__idea') {
      const ests = [...new Set(picked.map(b => b.days).filter(d => d))];
      for (const d of ests) {
        try { await ensureLabel(estLabelName(d), '5a6470', 'Kea Mission Control — estimate'); }
        catch (e) { toast(`Estimate label: ${e.message}`, 'err'); btn.disabled = false; return; }
      }
    }
    let made = 0;
    for (const b of picked) {
      btn.textContent = `Creating ${made + 1}/${picked.length}…`;
      try {
        if (col === '__idea') await createIdea(b.title, b.body);
        else await createTask({ title: b.title, body: b.body, col, labels: b.days ? [estLabelName(b.days)] : [] });
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

