#!/usr/bin/env python3
"""Generate the PARETO copy of the console from the OFFICIAL code (single source of truth).

The two systems run the same code; only the configuration below differs. Never edit the copy by hand:
change the official files, then run

    python3 scripts/make_copy.py --front <official index.html> --worker <official worker.js> \
        --keep-from <current copy index.html> --out-front <copy index.html> --out-worker <copy worker.js>

--keep-from supplies the copy's access key (it is embedded in the page, never stored in this script).
Use --inverse to turn a copy file back into official form (used once, to merge the copy's earlier work).
"""
import argparse, re, sys

OFF_HOST = "newbreak-costs-api.prof-leosantana.workers.dev"
CPY_HOST = "pareto-console-api.prof-leosantana.workers.dev"
OFF_REPO = "leosantan4/newsbreak"
CPY_REPO = "leosantan4/pc-7f3a91"

STATIC_OFF = """  const STATIC_ACCOUNTS = [
    {key:'vini', label:'Vini'},
    {key:'pretorian', label:'Pretorian'},
    {key:'neia', label:'Neia'},
    {key:'alan', label:'Alan'},
    {key:'troya', label:'Troya'},
  ];"""
STATIC_CPY = "  const STATIC_ACCOUNTS = [];"
DATA_OFF = "const data = {vini:{}, pretorian:{}, neia:{}, alan:{}, troya:{}};"
DATA_CPY = "const data = {};"
MANUAL_OFF = 'placeholder="2104680678696153090 - Juci&#10;2104680950134730754 - Juci 2"'
MANUAL_CPY = 'placeholder="ID da conta de anúncios - Nome&#10;ID da conta de anúncios - Nome 2"'
KEY_RE = re.compile(r"const COSTS_API_KEY = '([^']+)';")


def key_of(text):
    m = KEY_RE.search(text)
    if not m:
        sys.exit("COSTS_API_KEY not found")
    return m.group(1)


def front_swap(s, to_copy, own_key, other_key):
    pairs = [
        ("<title>RASTRO</title>", "<title>RASTRO · PARETO</title>"),
        ("localStorage.getItem('nb_theme')", "localStorage.getItem('pc_theme')"),
        ("TROYA-177 - 28/09", "PARETO-177 - 28/09"),
        ("localStorage.getItem('nb_' + key)", "localStorage.getItem('pc_' + key)"),
        ("localStorage.setItem('nb_' + key", "localStorage.setItem('pc_' + key"),
        (STATIC_OFF, STATIC_CPY), (DATA_OFF, DATA_CPY), (MANUAL_OFF, MANUAL_CPY),
        (OFF_HOST, CPY_HOST), ("const COSTS_API_KEY = '%s';" % own_key, "const COSTS_API_KEY = '%s';" % other_key),
    ]
    for a, b in pairs:
        src, dst = (a, b) if to_copy else (b, a)
        if src not in s:
            sys.exit("pattern missing (%s): %r" % ("official" if to_copy else "copy", src[:70]))
        s = s.replace(src, dst)
    return s


def worker_swap(s, to_copy):
    a = '"https://api.github.com/repos/%s/actions/workflows/sync.yml/dispatches"' % OFF_REPO
    b = '"https://api.github.com/repos/%s/actions/workflows/sync.yml/dispatches"' % CPY_REPO
    src, dst = (a, b) if to_copy else (b, a)
    if src not in s:
        sys.exit("worker pattern missing: %r" % src[:70])
    return s.replace(src, dst)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--front"); ap.add_argument("--worker")
    ap.add_argument("--keep-from", help="current copy index.html (supplies the copy's access key)")
    ap.add_argument("--official-key", help="official key (needed with --inverse)")
    ap.add_argument("--out-front"); ap.add_argument("--out-worker")
    ap.add_argument("--inverse", action="store_true")
    a = ap.parse_args()
    if a.front:
        s = open(a.front, encoding="utf-8").read()
        if a.inverse:
            copy_key = key_of(s)
            out = front_swap(s, False, a.official_key, copy_key)
        else:
            off_key = key_of(s)
            out = front_swap(s, True, off_key, key_of(open(a.keep_from, encoding="utf-8").read()))
        open(a.out_front, "w", encoding="utf-8").write(out)
    if a.worker:
        w = open(a.worker, encoding="utf-8").read()
        open(a.out_worker, "w", encoding="utf-8").write(worker_swap(w, not a.inverse))


if __name__ == "__main__":
    main()
