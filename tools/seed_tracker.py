#!/usr/bin/env python3
"""
seed_tracker.py — turn a milestone JSON file into real GitHub issues.

The Kea Tracker at https://cyrus-jackson.github.io is a browser client over the
GitHub API. Tasks are issues, board columns are `status:*` labels, and milestones
are real GitHub milestones. Nothing is stored in the tracker itself, so writing
those objects from a shell puts them on the board exactly as the app would.

Estimates are `est:<n>d` labels (e.g. `est:0.5d`), which is the only form the
tracker's Progress page reads. A task's `days` from the JSON is stamped as such
a label on creation — the `---` footer keeps the human-readable copy, but the
label is what makes the Time panel track it.

    export GITHUB_TOKEN=github_pat_...            # never committed, never echoed
    python3 tools/seed_tracker.py tools/milestones/m1.json --dry-run
    python3 tools/seed_tracker.py tools/milestones/m1.json

Already seeded without estimates? Backfill just the missing labels:

    python3 tools/seed_tracker.py tools/milestones/m1.json --backfill-est --dry-run
    python3 tools/seed_tracker.py tools/milestones/m1.json --backfill-est

The token needs a fine-grained PAT on the target repository with:
    Metadata          Read
    Issues            Read and write

Re-running is safe. Issues are matched by exact title and skipped if they already
exist, so a half-finished run resumes instead of duplicating.

Standard library only — no pip install, no jq.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
import urllib.error
import urllib.request

API = "https://api.github.com"

# Mirrors DEFAULT_COLUMNS in assets/js/core.js, so the board reads the same
# whether a card was made here or in the browser.
COLUMNS = [
    {"id": "todo", "name": "Todo", "label": "status:todo", "color": "7d8ca3"},
    {"id": "progress", "name": "In Progress", "label": "status:in-progress", "color": "60dcec"},
    {"id": "review", "name": "In Review", "label": "status:review", "color": "d9ae3f"},
    {"id": "done", "name": "Done", "label": "status:done", "color": "4ad6a0"},
]

# Mirrors EST_RE / estLabelName in assets/js/core.js. The estimate dropdown only
# offers its choices, but the matcher accepts any positive number of days.
EST_RE = re.compile(r"^est:(\d+(?:\.\d+)?)d$", re.IGNORECASE)
EST_COLOR = "5a6470"
EST_DESC = "Kea Mission Control — estimate"

DIM, BOLD, RED, GREEN, YELLOW, RESET = (
    ("\033[2m", "\033[1m", "\033[31m", "\033[32m", "\033[33m", "\033[0m")
    if sys.stdout.isatty() else ("", "", "", "", "", "")
)


class ApiError(Exception):
    def __init__(self, status, message, path):
        super().__init__(f"{status} on {path}: {message}")
        self.status = status
        self.message = message


def api(token, method, path, body=None):
    """One GitHub API call. Returns (status, parsed_json)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "kea-seed-tracker")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(raw).get("message", raw)
        except json.JSONDecodeError:
            msg = raw
        raise ApiError(e.code, msg, path) from None
    except urllib.error.URLError as e:
        raise ApiError(0, f"network error: {e.reason}", path) from None


def paginate(token, path):
    """Every page of a list endpoint, without parsing Link headers."""
    out, page = [], 1
    sep = "&" if "?" in path else "?"
    while True:
        _, chunk = api(token, "GET", f"{path}{sep}per_page=100&page={page}")
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return out


def task_days(task):
    """The estimate for a task, or None. Accepts numbers and numeric strings."""
    try:
        d = float(task.get("days"))
    except (TypeError, ValueError):
        return None
    return d if d > 0 else None


def est_label_name(days):
    """Mirrors estLabelName in assets/js/core.js: est:0.5d, est:2d."""
    return f"est:{days:g}d"


def has_est(labels):
    """True if any label name already carries an estimate."""
    return any(EST_RE.match(str(l.get("name", l) if isinstance(l, dict) else l or ""))
               for l in (labels or []))


def footer(task):
    """The estimate and dependency line that goes at the bottom of each issue."""
    bits = []
    if task.get("track"):
        bits.append(f"Track {task['track']}")
    d = task_days(task)
    if d is not None:
        bits.append(f"{d:g} day" + ("" if d == 1 else "s"))
    needs = task.get("needs") or []
    bits.append("needs " + (", ".join(needs) if needs else "nothing"))
    return "\n\n---\n" + " · ".join(bits)


def ensure_labels(token, repo, dry):
    """Create the four board labels. 422 means it already exists, which is fine."""
    made = 0
    for c in COLUMNS:
        if dry:
            continue
        try:
            api(token, "POST", f"/repos/{repo}/labels", {
                "name": c["label"], "color": c["color"],
                "description": f"Kea Tracker — {c['name']}",
            })
            made += 1
        except ApiError as e:
            if e.status != 422:
                raise
    return made


def ensure_est_labels(token, repo, days_set, dry):
    """Create one est:<n>d label per distinct estimate. 422 means it exists."""
    made = 0
    for d in sorted(days_set):
        if dry:
            continue
        try:
            api(token, "POST", f"/repos/{repo}/labels", {
                "name": est_label_name(d), "color": EST_COLOR,
                "description": EST_DESC,
            })
            made += 1
        except ApiError as e:
            if e.status != 422:
                raise
    return made


def ensure_milestone(token, repo, spec, due, dry):
    """Find the milestone by title, or create it. Returns its number, or None."""
    title = spec["title"]
    existing = paginate(token, f"/repos/{repo}/milestones?state=all")
    for m in existing:
        if m["title"] == title:
            print(f"  {DIM}milestone already exists{RESET}  #{m['number']}  {title}")
            return m["number"]
    if dry:
        print(f"  {YELLOW}would create milestone{RESET}     {title}")
        return None
    body = {"title": title, "state": "open"}
    if spec.get("description"):
        body["description"] = spec["description"]
    if due:
        body["due_on"] = f"{due}T23:59:59Z"
    _, m = api(token, "POST", f"/repos/{repo}/milestones", body)
    print(f"  {GREEN}created milestone{RESET}          #{m['number']}  {title}")
    return m["number"]


def main():
    p = argparse.ArgumentParser(
        description="Create a milestone and its tasks as GitHub issues.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Set GITHUB_TOKEN (or GH_TOKEN) in your shell before running.",
    )
    p.add_argument("spec", help="milestone JSON file")
    p.add_argument("--repo", default="cyrus-jackson/KeaGame", help="owner/name")
    p.add_argument("--column", help="override the target column id")
    p.add_argument("--due", help="milestone due date, YYYY-MM-DD")
    p.add_argument("--backfill-est", action="store_true",
                   help="add missing est:<n>d labels to issues this spec already created")
    p.add_argument("--delay", type=float, default=1.0,
                   help="seconds between issue writes (default 1.0)")
    p.add_argument("--dry-run", action="store_true",
                   help="print what would happen and write nothing")
    args = p.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not token and not args.dry_run:
        sys.exit(
            f"{RED}No token.{RESET} This script never asks for one interactively.\n"
            "Set it in your own shell first:\n\n"
            "    export GITHUB_TOKEN=github_pat_...\n\n"
            "Make one at https://github.com/settings/personal-access-tokens/new\n"
            "with Metadata: Read and Issues: Read and write on this repository.\n"
            "Or preview without a token: --dry-run"
        )
    if args.backfill_est and not token:
        sys.exit(f"{RED}--backfill-est needs a token{RESET} to read existing issues.\n"
                 "Set GITHUB_TOKEN first; add --dry-run to preview without writing.")

    try:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"{RED}Could not read {args.spec}:{RESET} {e}")

    tasks = spec.get("tasks") or []
    if not tasks:
        sys.exit(f"{RED}No tasks in {args.spec}.{RESET}")

    col_id = args.column or spec.get("column") or "todo"
    col = next((c for c in COLUMNS if c["id"] == col_id), None)
    if col is None:
        sys.exit(f"{RED}Unknown column '{col_id}'.{RESET} "
                 f"Try one of: {', '.join(c['id'] for c in COLUMNS)}")

    mode = f"{YELLOW}DRY RUN{RESET} — nothing will be written" if args.dry_run else "writing"
    action = "backfilling estimates for" if args.backfill_est else "seeding"
    print(f"\n{BOLD}{spec.get('milestone', {}).get('title', 'Tasks')}{RESET}")
    print(f"{DIM}{args.repo} · {len(tasks)} tasks · {action} · column {col['name']} "
          f"({col['label']}) · {mode}{RESET}\n")

    have_token = bool(token)
    existing = {}
    milestone_no = None

    if have_token:
        try:
            api(token, "GET", f"/repos/{args.repo}")
        except ApiError as e:
            if e.status in (401, 403):
                sys.exit(f"{RED}Token rejected ({e.status}).{RESET} "
                         "Check it has Issues: Read and write on this repository.")
            if e.status == 404:
                sys.exit(f"{RED}{args.repo} not found or not visible to this token.{RESET}\n"
                         "For a private repo the token must list it under Repository access.")
            raise

        days_set = {d for t in tasks if (d := task_days(t)) is not None}
        made = ensure_labels(token, args.repo, args.dry_run)
        if made:
            print(f"  {GREEN}created {made} board label(s){RESET}")
        made_est = ensure_est_labels(token, args.repo, days_set, args.dry_run)
        if made_est:
            print(f"  {GREEN}created {made_est} estimate label(s){RESET}")

        milestone_no = ensure_milestone(
            token, args.repo, spec.get("milestone", {}), args.due, args.dry_run)

        issues = paginate(token, f"/repos/{args.repo}/issues?state=all")
        existing = {i["title"]: i for i in issues if "pull_request" not in i}
    else:
        print(f"  {DIM}no token — showing the plan only, no duplicate check{RESET}")

    print()
    created = skipped = refilled = failed = 0
    writes = 0
    for n, t in enumerate(tasks, 1):
        title = t["title"]
        tag = f"{DIM}[{n:>2}/{len(tasks)}]{RESET}"
        d = task_days(t)
        est = f" {DIM}{est_label_name(d)}{RESET}" if d is not None else ""

        if title in existing:
            if args.backfill_est and d is not None and not has_est(existing[title].get("labels")):
                if args.dry_run:
                    print(f"  {tag} {YELLOW}would add{RESET}{est} {title}")
                    refilled += 1
                    continue
                labels = [l["name"] for l in existing[title].get("labels", [])]
                labels.append(est_label_name(d))
                try:
                    api(token, "PATCH",
                        f"/repos/{args.repo}/issues/{existing[title]['number']}",
                        {"labels": labels})
                    print(f"  {tag} {GREEN}est {d:g}d{RESET} {title}")
                    refilled += 1
                    writes += 1
                except ApiError as e:
                    print(f"  {tag} {RED}FAILED{RESET} {title}\n         {e.message}")
                    failed += 1
                    if e.status in (401, 403):
                        print(f"\n{RED}Stopping — the token was rejected mid-run.{RESET}")
                        break
                if n < len(tasks):
                    time.sleep(args.delay)
                continue
            print(f"  {tag} {DIM}skip   {title}{RESET}")
            skipped += 1
            continue

        if args.dry_run:
            print(f"  {tag} {YELLOW}would create{RESET}{est} {title}")
            created += 1
            continue

        body = {
            "title": title,
            "body": t.get("body", "") + footer(t),
            "labels": [col["label"]] + ([est_label_name(d)] if d is not None else []),
        }
        if col_id == "progress":
            # Seeded straight into In Progress: no labeled event will ever
            # exist, so stamp the work start the tracker measures from.
            stamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            body["body"] = body["body"].rstrip() + f"\n\n<!-- started: {stamp} -->"
        if milestone_no is not None:
            body["milestone"] = milestone_no
        try:
            _, issue = api(token, "POST", f"/repos/{args.repo}/issues", body)
            print(f"  {tag} {GREEN}#{issue['number']:<5}{RESET} {title}")
            created += 1
            writes += 1
        except ApiError as e:
            print(f"  {tag} {RED}FAILED{RESET} {title}\n         {e.message}")
            failed += 1
            if e.status in (401, 403):
                print(f"\n{RED}Stopping — the token was rejected mid-run.{RESET}")
                break
        # GitHub throttles rapid content creation separately from the hourly
        # limit, so pace the writes rather than getting a 403 halfway through.
        if n < len(tasks):
            time.sleep(args.delay)

    verb = "would create" if args.dry_run else "created"
    summary = f"\n{BOLD}{verb} {created}{RESET}, skipped {skipped}"
    if args.backfill_est:
        summary += f", {verb} {refilled} estimate(s)" if args.dry_run else f", backfilled {refilled} estimate(s)"
    if failed:
        summary += f", {RED}failed {failed}{RESET}"
    print(summary)
    if not args.dry_run and (created or refilled):
        print(f"{DIM}Open https://cyrus-jackson.github.io and press r to refresh.{RESET}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
