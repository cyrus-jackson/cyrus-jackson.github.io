# Kea Mission Control

A single-page project tracker that runs entirely in the browser and uses **GitHub as its database**.

- **Board** — Todo / In Progress / In Review / Done, drag and drop. Every card is a real GitHub issue; dropping it in another column rewrites its labels (and closes/reopens it) through the API.
- **Pull Requests** — open, draft, merged and closed PRs with branch, author, and CI check status. PRs are auto-linked to the issue they mention (`Closes #41`) or to the issue number in their branch name (`feat/41-edge-flux`), and show up as pills on the card.
- **Inspiration** — a customisable gallery of reference projects: link, image, tags, and a note on what exactly you want out of it. Synced as `data/inspiration.json` in this repo.
- **Progress** — completed-per-week chart, column distribution, recent activity, and a **Time** panel: days you
  actually shipped on (not days elapsed), tasks per those days, median work time, the backlog expressed
  in shipping days with a projected landing date, and a 30-day strip of which days had closes.
- **Estimates** — GitHub issues have no estimate field, so an estimate is stored as an `est:<n>d` label: native,
  visible and filterable on github.com, no extra API surface. Work time is never stored — it is derived, so it
  cannot go stale. Cards show what a task took (red if it ran well over its estimate), and Progress reports how
  far your estimates run from reality.

  Work time runs **in progress → done**. Dragging a card to In Progress stamps an invisible start marker in the
  same write, so measuring costs nothing; older cards are measured from GitHub's label history instead (one
  cached call each — Progress offers to fetch them all at once). Tasks that never visited In Progress fall back
  to created → done, and the UI marks those with a † rather than implying otherwise.
- **Look & feel** — milestone burndowns, live T-minus countdowns, shipping streaks, card covers, ship-it
  confetti (ticker tape, neon streaks, atompunk sparks, ember fountain or bubbles — your pick) and ambient
  dust. All of it is dressing over the same data, every piece has a toggle in
  Settings → Look & feel, and motion yields to your OS reduce-motion setting.
- **A sidebar kea** — a small parrot fed by shipped tasks, grumpy when neglected, asleep before 6am.
  Click to pat. Renameable, toggleable, entirely local.
- **Images** — drop an image into any task or reference. It gets committed to `data/uploads/` here and linked by raw URL.
- **Ideas** — a home for unformed game thinking, stored as issues labelled `idea` and **deliberately hidden
  from the board** so speculation never inflates the backlog. Each one still gets a number, comments and
  history, so an idea can be developed for months before *Promote to task* swaps its label and it becomes real
  work in a column and milestone.
- **Assets** — every image committed to the repo, in a grid with a transparency checkerboard, folder filters
  and a lightbox. Copy the raw URL or the markdown in one click, or push it straight to Inspiration. Private
  repos work too: `raw.githubusercontent` refuses them, so those images are fetched through the API and
  inlined instead.
- **Milestones** — every milestone with a segmented progress bar (done, then what remains, split by column),
  its due date read as urgency rather than a date, and an explicit *what's left* list grouped by where each
  task actually sits. Unassigned tasks get a one-click dropdown to file them into a milestone. Milestones are
  real GitHub milestones, so anything you set here shows up on github.com and vice versa.
- **Design Docs** — every markdown file in the repository (ARCHITECTURE, DESIGN, PALETTE, CHARACTERS…) rendered
  in-app, grouped by folder and searchable across every file at once. It walks the whole tree, so docs in a
  `Documentation/` folder and nested READMEs are found, while Unity's `ProjectSettings/*.txt`, `Library/`,
  `Temp/` and `node_modules/` are filtered out. A branch picker sits above the list, because design docs often
  land on a feature branch before they reach the default one. Hex codes render as colour swatches; click one
  to copy it.
- **Seven themes** — Kea Neon, Atompunk, Midnight, Terminal, Paper, Mist, Outrun. Picker is bottom-left.

### Things that save keystrokes

- **Tickable checklists** — click a `- [ ]` in a task and the issue body is rewritten on GitHub. No editor, no save.
- **Paste screenshots** — ⌘V an image into any task; it uploads to the assets repo and embeds itself.
- **Quick capture** — press `c` anywhere, type a thought, Enter. It becomes a Todo card without breaking flow.
  Shift+Enter opens the full editor with what you typed already in it.
- **Command palette** — ⌘K (Ctrl+K) to jump to any task, doc, view, repo or theme, or fire an action.
- **Import loose notes** — Settings → *Import tasks from a file* reads something like `ideas.txt` and turns it
  into real tasks. It understands three shapes: a heading line ending in `:` takes the following paragraph as
  its description; a block of bullets becomes one task per bullet; bullets under a heading become a tickable
  checklist inside that task. A milestone-plan JSON file (`{ "tasks": [{ "id", "title", "days", "track",
  "needs", "body" }] }`) is understood too: each task's `days` becomes its `est:<n>d` estimate label so the
  Time panel tracks it, while id, track and needs are kept as a header in the description.
- **Devlog** — Progress → *Devlog* builds a markdown summary of what shipped, merged and is in flight over a
  chosen window, ready to paste into a post.

No build step, no framework, no backend. Three files: `index.html`, `assets/app.css`, `assets/app.js`.

---

## Hosting

**Yes — GitHub Pages runs this exactly as-is.** It is pure static HTML/CSS/JS; the only network calls
are from your browser straight to `api.github.com`.

This repo is `cyrus-jackson.github.io`, so it publishes at the root of your user site.

### Turn Pages on (once)

1. Push this repo.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `master`, folder `/ (root)`.
3. Wait ~1 minute, then open **https://cyrus-jackson.github.io**.

The `.nojekyll` file is there so Jekyll does not touch the folder.

### What "hosting on Pages" does and does not mean

- The **page** is public — anyone with the URL sees the shell, the themes, and the demo data.
- Your **data** is not. Issues, PRs and images are fetched with a token that lives only in your
  browser's `localStorage`, is never committed, and is never sent anywhere except `api.github.com`.
  A stranger opening the URL just sees demo cards.
- Private repos work fine: your token reads them, the site never stores them.

### Other options, if you want them later

| Host | Why you'd pick it |
|---|---|
| **GitHub Pages** (current) | Free, zero config, same account as the data. |
| **Vercel** | Free too, but adds serverless functions — which buys you a proper *Sign in with GitHub* button instead of pasting a token (see below). Deploy = import the repo, framework preset "Other", no build command. |
| **Cloudflare Pages / Netlify** | Same as Vercel, if you prefer them. |

Nothing here needs a paid plan or anything from the Student Developer Pack.

---

## Connecting it to GitHub

1. Open the site → **Settings** → **Create a token** (or go to
   <https://github.com/settings/personal-access-tokens/new>).
2. Make a **fine-grained** token:
   - **Resource owner:** your account
   - **Repository access:** only the repos you want to track — plus `cyrus-jackson.github.io`
     (that is where images and the inspiration board are written)
   - **Permissions:**
     | Permission | Level | Why |
     |---|---|---|
     | Metadata | Read | required for everything |
     | Issues | Read and write | the board |
     | Pull requests | Read | the PR view |
     | Contents | Read and write | image uploads + `data/inspiration.json` |
     | Checks | Read | CI status on PRs *(optional)* |
   - **Expiration:** whatever you're comfortable re-doing. 90 days is a reasonable default.
3. Paste it into Settings → **Connect**.

Authenticated requests get 5,000 API calls per hour; the remaining budget is shown bottom-left.

### How it avoids burning that budget

Every `GET` stores its `ETag` alongside the response body in `localStorage` and replays it as
`If-None-Match` on the next request. GitHub answers unchanged data with `304 Not Modified`, and
**a conditional request that returns 304 does not count against the primary rate limit when it
carries an `Authorization` header** — so refreshing a board where nothing has changed is free.
The board still paints, from the cached body.

On top of that:

- the board paints from the cache before the network answers, so a reload is instant;
- CI check status (up to 12 calls) is only fetched when you actually open the Pull Requests tab;
- an implicit reload within 30 seconds of the last one is skipped — the Refresh button and `r` always go through.

A cold first load is about 5 calls. Every reload after that, with nothing changed upstream, is 0.
Settings shows how many responses have come back free, and has a **Clear request cache** button
if you ever want to force a full refetch.

### Board columns ↔ labels

Each column maps to a label, so the board still reads correctly on github.com:

| Column | Label |
|---|---|
| Todo | `status:todo` |
| In Progress | `status:in-progress` |
| In Review | `status:review` |
| Done | `status:done` *(and the issue is closed)* |

The board also filters to a single milestone, and any card sitting in In Progress or In Review with no
activity for 10 days gets a quiet `idle 18d` badge. That reads *days since anything touched the issue*, not
days spent in that column — GitHub bumps `updated_at` on any edit — so treat it as a nudge, not a stopwatch.

Rename columns or remap labels in Settings. **Settings → Create these labels on GitHub** makes them
for you in the active repo. An issue with no status label lands in the first column, so nothing gets lost.

Card order *within* a column is remembered per-browser (GitHub has no ordering field to store it in).

---

## Optional: replace the token with real sign-in

If you'd rather click *Sign in with GitHub* than paste a token, deploy the same folder to Vercel and
add one serverless function — Pages can't do this because OAuth requires a server to hold the client
secret.

1. Register an OAuth app at <https://github.com/settings/developers>, callback
   `https://<your-vercel-app>.vercel.app/api/callback`.
2. Add `api/callback.js` that exchanges `?code=` for a token via
   `POST https://github.com/login/oauth/access_token` using `CLIENT_ID` / `CLIENT_SECRET` from
   Vercel's environment variables, then sets it as an httpOnly cookie and redirects to `/`.
3. In `app.js`, replace the `S.token` read with a call to a `/api/token` endpoint that echoes the cookie.

Worth it if you ever share the board with someone else. Overkill for one person on one laptop.

---

## Logo

The brand mark in the sidebar is the 24-frame orbiting **K**, shipped as a single horizontal sprite
(`assets/logo/k-orbit-sprite.png`, 2304x96, **30 KB**) and stepped with CSS `steps(24)` — one request, no
JavaScript. It plays once on load, on hover, and continuously while the board is fetching, so the logo
doubles as the loading indicator. `KEA.png` is the wordmark, used on Settings, on the not-connected empty
state, and as the `og:image`.

The cell size is written as literal pixels (`1344px 56px` for 56px x 24 frames) rather than computed from
custom properties. `calc(var(--s) * var(--n))` multiplies a length from `var()` by a unitless number from
`var()`, which WebKit cannot type-check while parsing — it drops the declaration, `background-size` falls back
to `auto`, and the mark disappears in Safari while working in Chromium. Change the cell size and you change
all three numbers together.

### Rebuilding it

The source frames were exported with the **transparency checkerboard baked into the pixels** — their alpha
channel is fully opaque. `tools/build-logo.py` removes it and regenerates every derivative:

```bash
python3 tools/build-logo.py
```

Two things that make this harder than a colour key, both measured rather than guessed:

- A plain neutral/bright key eats about **51% of the K's upright**, because the letterform carries near-white
  highlight bands.
- A border-connected flood fill leaves the checkerboard **trapped inside the orbit ellipse**, which never
  touches the image edge.

So it keys by *texture*: candidate pixels are grouped into connected components, and a component is treated as
background only if its luminance alternates (std around 7 for a checkerboard, 1-3 for flat artwork). Edges are
feathered and un-premultiplied against the measured background grey to kill the white fringe.

If you ever re-export the frames **with real alpha**, this whole step becomes unnecessary — drop the keying and
just crop, resize and assemble.

The 24 source frames and the zip total **94 MB** and are gitignored; only the 470 KB of derivatives in
`assets/logo/` and the master `KEA.png` are committed.

The `localStorage` namespace stays `kea.tracker.` on purpose — renaming it would orphan every saved token,
board order and setting in browsers that already have them.

## Keyboard

`⌘K` command palette · `c` quick capture · `/` search · `n` new task · `r` refresh · `Esc` close dialog

## Layout

```
index.html          markup + inline SVG icon sprite
assets/app.css      design tokens, seven themes, components
assets/app.js       state, GitHub API, board, drag & drop, views
data/inspiration.json   written by the app
data/uploads/       images uploaded from the app
```
