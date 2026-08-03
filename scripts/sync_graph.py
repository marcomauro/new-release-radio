#!/usr/bin/env python3
"""Refresh the vendored archive snapshot (public/graph.json).

The radio fetches the live archive from New Release Atlas at runtime; this
script updates the copy that ships with the build, which is what answers when
the network (or the Atlas deploy) is not there — and what makes the PWA work
offline.

    python3 scripts/sync_graph.py                       # sibling checkout, else the live URL
    python3 scripts/sync_graph.py --from ../new-release-atlas/public/graph.json
    python3 scripts/sync_graph.py --url https://marcomauro.github.io/new-release-atlas/graph.json
    python3 scripts/sync_graph.py --check               # verify only, non-zero on drift

Standard library only, like the Atlas pipeline it mirrors.
"""

import argparse
import json
import os
import re
import shutil
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET = os.path.join(ROOT, "public", "graph.json")
README = os.path.join(ROOT, "README.md")

LIVE_URL = "https://marcomauro.github.io/new-release-atlas/graph.json"
SIBLINGS = [
    os.path.join(ROOT, "..", "new-release-atlas", "public", "graph.json"),
    os.path.join(ROOT, "..", "..", "new-release-atlas", "public", "graph.json"),
]

# The one line in the README that must agree with the data.
ARCHIVE_RE = re.compile(r"^Archive: .*$", re.MULTILINE)


def validate(raw):
    """The radio needs nodes, links and the link weights. Fail loudly, not late."""
    if not isinstance(raw, dict):
        raise ValueError("not a JSON object")
    for key in ("nodes", "links", "meta"):
        if key not in raw:
            raise ValueError(f"missing '{key}'")
    if not raw["nodes"]:
        raise ValueError("no nodes")
    missing = [f for f in ("id", "title", "artist", "genre") if f not in raw["nodes"][0]]
    if missing:
        raise ValueError(f"nodes are missing {missing}")
    link = raw["links"][0] if raw["links"] else None
    if link and "c" not in link and "weight" not in link:
        raise ValueError("links carry neither components nor weight")
    return raw


def load_source(path=None, url=None):
    if path:
        with open(path, encoding="utf-8") as fh:
            return validate(json.load(fh)), path
    if url:
        with urllib.request.urlopen(url, timeout=30) as r:  # noqa: S310 - fixed https URL
            return validate(json.loads(r.read().decode("utf-8"))), url
    for candidate in SIBLINGS:
        if os.path.exists(candidate):
            with open(candidate, encoding="utf-8") as fh:
                return validate(json.load(fh)), os.path.normpath(candidate)
    with urllib.request.urlopen(LIVE_URL, timeout=30) as r:  # noqa: S310
        return validate(json.loads(r.read().decode("utf-8"))), LIVE_URL


def archive_line(meta, genres):
    return (
        f"Archive: **{meta.get('unique_tracks', '?')} tracks · "
        f"{meta.get('edges', '?')} links · {len(genres)} genres** "
        f"(playlists {meta.get('playlist_range', '?')}, updated {meta.get('updated', '?')})."
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", help="path to a graph.json on disk")
    ap.add_argument("--url", help="URL to fetch graph.json from")
    ap.add_argument("--check", action="store_true", help="only verify the vendored copy + README")
    ap.add_argument("--no-readme", action="store_true", help="do not touch the README line")
    args = ap.parse_args()

    if args.check:
        try:
            with open(TARGET, encoding="utf-8") as fh:
                raw = validate(json.load(fh))
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL  public/graph.json: {exc}")
            return 1
        if args.no_readme:
            print(f"OK    {raw['meta'].get('unique_tracks')} tracks · snapshot valid")
            return 0
        expected = archive_line(raw["meta"], raw.get("genres", []))
        with open(README, encoding="utf-8") as fh:
            readme = fh.read()
        found = ARCHIVE_RE.search(readme)
        if not found:
            print("FAIL  README has no 'Archive:' line")
            return 1
        if found.group(0).strip() != expected.strip():
            print("FAIL  README drifted from the data")
            print(f"  README: {found.group(0)}")
            print(f"  data:   {expected}")
            return 1
        print(f"OK    {raw['meta'].get('unique_tracks')} tracks · README in sync")
        return 0

    try:
        raw, origin = load_source(args.src, args.url)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  could not read a valid archive: {exc}")
        return 1

    if os.path.exists(TARGET):
        shutil.copy2(TARGET, TARGET + ".bak")
    with open(TARGET, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False, separators=(",", ":"))

    meta = raw["meta"]
    print(f"synced from {origin}")
    print(
        f"  {meta.get('unique_tracks')} tracks · {meta.get('edges')} links · "
        f"{len(raw.get('genres', []))} genres · playlists {meta.get('playlist_range')} "
        f"· updated {meta.get('updated')}"
    )

    if not args.no_readme and os.path.exists(README):
        with open(README, encoding="utf-8") as fh:
            readme = fh.read()
        line = archive_line(meta, raw.get("genres", []))
        if ARCHIVE_RE.search(readme):
            new = ARCHIVE_RE.sub(lambda _: line, readme, count=1)
            if new != readme:
                with open(README, "w", encoding="utf-8") as fh:
                    fh.write(new)
                print("  README 'Archive:' line updated")
        else:
            print(f"  ! README has no 'Archive:' line — add it:\n    {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
