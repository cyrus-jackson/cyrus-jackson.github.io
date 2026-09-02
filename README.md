# Kea Tracker

A single-page project tracker that runs entirely in the browser and uses **GitHub as its database**.

- **Board** — Todo / In Progress / In Review / Done, drag and drop. Every card is a real GitHub issue; dropping it in another column rewrites its labels (and closes/reopens it) through the API.
- **Pull Requests** — open, draft, merged and closed PRs with branch, author, and CI check status. PRs are auto-linked to the issue they mention (`Closes #41`) or to the issue number in their branch name (`feat/41-edge-flux`), and show up as pills on the card.
- **Inspiration** — a customisable gallery of reference projects: link, image, tags, and a note on what exactly you want out of it. Synced as `data/inspiration.json` in this repo.
- **Progress** — completed-per-week chart, column distribution, recent activity.
- **Images** — drop an image into any task or reference. It gets committed to `data/uploads/` here and linked by raw URL.
- **Six themes** — Kea Neon, Atompunk, Midnight, Terminal, Paper, Mist. Picker is bottom-left.

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

## Keyboard

`/` search · `n` new task · `r` refresh · `Esc` close dialog

## Layout

```
index.html          markup + inline SVG icon sprite
assets/app.css      design tokens, six themes, components
assets/app.js       state, GitHub API, board, drag & drop, views
data/inspiration.json   written by the app
data/uploads/       images uploaded from the app
```
