#!/usr/bin/env python3
"""
Pulls fresh NewsBreak data for the 3 configured accounts and merges it into
e18176716ee60c8f/data.json, preserving any existing entry dated before
2026-09-01 (hand-corrected historical August data) untouched.

Reads tokens from env vars: NEWSBREAK_TOKEN_VINI, NEWSBREAK_TOKEN_PRETORIAN,
NEWSBREAK_TOKEN_NEIA (set as GitHub Actions repo secrets).
"""
import json
import os
import urllib.request
from datetime import datetime, timezone

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "e18176716ee60c8f", "data.json")

ACCOUNTS = {
    "vini": "NEWSBREAK_TOKEN_VINI",
    "pretorian": "NEWSBREAK_TOKEN_PRETORIAN",
    "neia": "NEWSBREAK_TOKEN_NEIA",
}

PRESERVE_BEFORE = "2026-09-01"


def fetch_report(token, date_range):
    body = json.dumps({
        "name": "gha sync",
        "timezone": "America/Sao_Paulo",
        "dateRange": date_range,
        "dimensions": ["DATE"],
        "metrics": ["COST", "CLICK", "CPC"],
        "eventMetrics": [
            {"eventType": "initiate_checkout", "metrics": ["COUNT", "CPA"]},
            {"eventType": "complete_payment", "metrics": ["COUNT", "CPA", "VALUE"]},
        ],
    }).encode()
    req = urllib.request.Request(
        "https://business.newsbreak.com/business-api/v1/reports/getIntegratedReport",
        data=body,
        headers={"Content-Type": "application/json", "Access-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["data"]["rows"]


def row_to_doc(r):
    ic = r["eventCount"].get("initiate_checkout", 0)
    venda = r["eventCount"].get("complete_payment", 0)
    cost = r["costDecimal"] / 100
    fat = r.get("eventValueDecimal", {}).get("complete_payment", 0) / 100
    return {
        "date": r["date"],
        "cost": round(cost, 2),
        "click": r["click"],
        "cpc": round(r["cpcDecimal"] / 100, 4) if r["click"] else 0,
        "ic": ic,
        "custoIc": round(cost / ic, 2) if ic else None,
        "venda": venda,
        "faturamento": round(fat, 2),
        "cpa": round(cost / venda, 2) if venda else None,
        "roas": round(fat / cost, 4) if cost else None,
    }


def main():
    with open(DATA_PATH) as f:
        current = json.load(f)

    for key, env_var in ACCOUNTS.items():
        token = os.environ[env_var]
        existing = current["accounts"].setdefault(key, {})
        history = fetch_report(token, "LAST_30_DAYS")
        today = fetch_report(token, "TODAY")
        for r in history:
            if r["date"] < PRESERVE_BEFORE:
                continue
            existing[r["date"]] = row_to_doc(r)
        for r in today:
            doc = row_to_doc(r)
            doc["partial"] = True
            existing[r["date"]] = doc

    current["generatedAt"] = datetime.now(timezone.utc).isoformat()

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
