#!/usr/bin/env python3
"""
Pulls fresh NewsBreak data for the 3 configured accounts and merges it into
e18176716ee60c8f/data.json, preserving any existing entry dated before
2026-09-01 (hand-corrected historical August data) untouched.

Also pulls the campaign/ad-set/ad hierarchy and computes each campaign's
"real" active status (campaign ON, with at least one ON ad set, with at
least one ON ad inside it) so the dashboard doesn't have to guess.

Reads tokens from env vars: NEWSBREAK_TOKEN_VINI, NEWSBREAK_TOKEN_PRETORIAN,
NEWSBREAK_TOKEN_NEIA, REDTRACK_API_KEY (set as GitHub Actions repo secrets).

Venda/faturamento (and the cpa/roas derived from them) come from RedTrack,
not NewsBreak's own pixel — NewsBreak's "complete_payment" event undercounts
or overcounts real sales on several days (confirmed 2026-09-14/15/16), while
RedTrack sees the actual checkout postback. NewsBreak stays the cost source.
"""
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "e18176716ee60c8f", "data.json")

ACCOUNTS = {
    "vini": "NEWSBREAK_TOKEN_VINI",
    "pretorian": "NEWSBREAK_TOKEN_PRETORIAN",
    "neia": "NEWSBREAK_TOKEN_NEIA",
    "alan": "NEWSBREAK_TOKEN_ALAN",
    "troya": "NEWSBREAK_TOKEN_TROYA",
}

ACCOUNT_LABEL = {"vini": "Vini", "pretorian": "Pretorian", "neia": "Neia", "alan": "Alan", "troya": "Troya"}


def display_name(account_key, raw_name):
    """Friendly name for a sub-account, e.g. 'Pretorian-408433' instead of
    the raw 'NB_RN_GL_CQZ-408433' — too many sub-accounts to tell apart by id."""
    suffix = raw_name.rsplit("-", 1)[-1] if raw_name else ""
    return f"{ACCOUNT_LABEL.get(account_key, account_key)}-{suffix}"

PRESERVE_BEFORE = "2026-09-01"
BASE = "https://business.newsbreak.com/business-api/v1"
REDTRACK_BASE = "https://api.redtrack.io"
REDTRACK_SOURCE_MAP = {"VINI": "vini", "PRETORIAN": "pretorian", "NEIA": "neia", "ALAN": "alan", "TROYA": "troya"}

# NewsBreak's reported "cost" is only 97% of what's actually charged — the
# platform keeps a 3% fee on top. Real cost = reported cost / 0.97.
# PAUSED per user request on 2026-09-14 pending validation against investor
# contributions ("aportes") — set back to 1/0.97 to re-enable.
FEE_FACTOR = 1.0


def fetch_report(token, date_range, dimensions=None):
    body = json.dumps({
        "name": "gha sync",
        "timezone": "America/Sao_Paulo",
        "dateRange": date_range,
        "dimensions": dimensions or ["DATE"],
        "metrics": ["COST", "CLICK", "CPC"],
        "eventMetrics": [
            {"eventType": "initiate_checkout", "metrics": ["COUNT", "CPA"]},
            {"eventType": "complete_payment", "metrics": ["COUNT", "CPA", "VALUE"]},
        ],
    }).encode()
    req = urllib.request.Request(
        f"{BASE}/reports/getIntegratedReport",
        data=body,
        headers={"Content-Type": "application/json", "Access-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["data"]["rows"]


def row_to_doc(r):
    ic = r["eventCount"].get("initiate_checkout", 0)
    venda = r["eventCount"].get("complete_payment", 0)
    cost = (r["costDecimal"] / 100) * FEE_FACTOR
    fat = r.get("eventValueDecimal", {}).get("complete_payment", 0) / 100
    return {
        "date": r["date"],
        "cost": round(cost, 2),
        "click": r["click"],
        "cpc": round((r["cpcDecimal"] / 100) * FEE_FACTOR, 4) if r["click"] else 0,
        "ic": ic,
        "custoIc": round(cost / ic, 2) if ic else None,
        "venda": venda,
        "faturamento": round(fat, 2),
        "cpa": round(cost / venda, 2) if venda else None,
        "roas": round(fat / cost, 4) if cost else None,
    }


def redtrack_account_key(source_title):
    upper = (source_title or "").upper()
    for needle, key in REDTRACK_SOURCE_MAP.items():
        if needle in upper:
            return key
    return None


def fetch_redtrack_report(date_from, date_to):
    api_key = os.environ["REDTRACK_API_KEY"]
    qs = urllib.parse.urlencode({
        "api_key": api_key,
        "group": "source,date",
        "date_from": date_from,
        "date_to": date_to,
        "timezone": "America/Sao_Paulo",
    })
    req = urllib.request.Request(f"{REDTRACK_BASE}/report?{qs}", method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def build_redtrack_overrides():
    """Returns (by_account, earliest): by_account[key][date] = {venda, faturamento};
    earliest[key] = first date RedTrack has any row for that account. Dates
    before that per account are left on NewsBreak's numbers — the RedTrack
    campaign may not have existed yet, so a "no row" there doesn't mean
    zero sales."""
    today = datetime.now(ZoneInfo("America/Sao_Paulo")).strftime("%Y-%m-%d")
    rows = fetch_redtrack_report(PRESERVE_BEFORE, today)
    by_account, earliest = {}, {}
    for r in rows:
        key = redtrack_account_key(r.get("source"))
        if not key:
            continue
        date = r["date"]
        by_account.setdefault(key, {})[date] = {
            "venda": r.get("convtype1", 0) or 0,
            "faturamento": round(r.get("revenuetype1", 0) or 0, 2),
        }
        if key not in earliest or date < earliest[key]:
            earliest[key] = date
    return by_account, earliest


def apply_redtrack_overrides(existing, account_key, redtrack_by_account, redtrack_earliest):
    start = redtrack_earliest.get(account_key)
    if not start:
        return
    overrides = redtrack_by_account.get(account_key, {})
    for date, doc in existing.items():
        if date < start:
            continue
        o = overrides.get(date, {"venda": 0, "faturamento": 0})
        doc["venda"] = o["venda"]
        doc["faturamento"] = o["faturamento"]
        doc["cpa"] = round(doc["cost"] / o["venda"], 2) if o["venda"] else None
        doc["roas"] = round(o["faturamento"] / doc["cost"], 4) if doc["cost"] else None
        doc["vendaSource"] = "redtrack"


def get_ad_accounts(token):
    """Discover this token's ad account ids/names via a report call
    (there's no simple 'list my ad accounts' endpoint without org-admin)."""
    rows = fetch_report(token, "LAST_30_DAYS", dimensions=["AD_ACCOUNT"])
    seen = {}
    for r in rows:
        seen[r["adAccountId"]] = r.get("adAccount", r["adAccountId"])
    return seen


def get_list(path, token, ad_account_id):
    """GET .../getList with pagination, pageSize=500."""
    rows = []
    page = 1
    while True:
        qs = urllib.parse.urlencode({
            "adAccountId": ad_account_id,
            "pageNo": page,
            "pageSize": 500,
        })
        req = urllib.request.Request(
            f"{BASE}/{path}/getList?{qs}",
            headers={"Content-Type": "application/json", "Access-Token": token},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())["data"]
        rows.extend(data["list"])
        if not data.get("hasNext"):
            break
        page += 1
    return rows


def build_subaccount_costs(token, account_key, existing_sub_accounts):
    """Per-sub-account daily cost, so account balances (topup - spend) can be
    computed. Merges into existing_sub_accounts, keyed by ad account id."""
    history = fetch_report(token, "LAST_30_DAYS", dimensions=["DATE", "AD_ACCOUNT"])
    today = fetch_report(token, "TODAY", dimensions=["DATE", "AD_ACCOUNT"])
    for r in history + today:
        if r["date"] < PRESERVE_BEFORE:
            continue  # don't clobber the hand-corrected Aug 27-31 split (see fix_subaccount_august.py)
        acc_id = r["adAccountId"]
        acc = existing_sub_accounts.setdefault(acc_id, {"name": r.get("adAccount", acc_id), "costByDate": {}})
        acc["name"] = r.get("adAccount", acc["name"])
        acc["accountKey"] = account_key
        acc["displayName"] = display_name(account_key, acc["name"])
        acc["costByDate"][r["date"]] = round((r["costDecimal"] / 100) * FEE_FACTOR, 2)
    return existing_sub_accounts


def build_campaigns(token, account_key):
    campaigns = []
    ad_accounts = get_ad_accounts(token)
    for ad_account_id, ad_account_name in ad_accounts.items():
        raw_campaigns = get_list("campaign", token, ad_account_id)
        raw_adsets = get_list("ad-set", token, ad_account_id)
        raw_ads = get_list("ad", token, ad_account_id)

        adsets_by_campaign = {}
        for a in raw_adsets:
            if a.get("onlineStatus") == "DELETED":
                continue
            adsets_by_campaign.setdefault(a["campaignId"], []).append(a)

        ads_by_adset = {}
        for a in raw_ads:
            if a.get("onlineStatus") == "DELETED":
                continue
            ads_by_adset.setdefault(a["adSetId"], []).append(a)

        for c in raw_campaigns:
            if c.get("onlineStatus") == "DELETED":
                continue
            my_adsets = adsets_by_campaign.get(c["id"], [])
            adset_summaries = []
            any_adset_really_on = False
            for a in my_adsets:
                my_ads = ads_by_adset.get(a["id"], [])
                ads_on = sum(1 for ad in my_ads if ad.get("status") == "ON")
                adset_really_on = a.get("status") == "ON" and ads_on > 0
                if adset_really_on:
                    any_adset_really_on = True
                adset_summaries.append({
                    "id": a["id"],
                    "name": a["name"],
                    "status": a.get("status"),
                    "onlineStatus": a.get("onlineStatus"),
                    "budget": (a["budget"] / 100) if a.get("budget") is not None else None,
                    "budgetType": a.get("budgetType"),
                    "adsOn": ads_on,
                    "adsTotal": len(my_ads),
                    "reallyActive": adset_really_on,
                })
            really_active = c.get("status") == "ON" and any_adset_really_on
            active_budget = sum(a["budget"] for a in adset_summaries if a["reallyActive"] and a["budget"])
            campaigns.append({
                "id": c["id"],
                "name": c["name"],
                "accountKey": account_key,
                "adAccountId": ad_account_id,
                "adAccountName": ad_account_name,
                "objective": c.get("objective"),
                "activeBudget": round(active_budget, 2) if active_budget else None,
                "status": c.get("status"),
                "onlineStatus": c.get("onlineStatus"),
                "adSetsOn": sum(1 for a in adset_summaries if a["status"] == "ON"),
                "adSetsTotal": len(adset_summaries),
                "reallyActive": really_active,
                "adSets": adset_summaries,
            })
    return campaigns


def main():
    with open(DATA_PATH) as f:
        current = json.load(f)

    try:
        redtrack_by_account, redtrack_earliest = build_redtrack_overrides()
    except Exception as exc:
        print(f"[warn] RedTrack fetch failed, keeping existing venda/faturamento: {exc}")
        redtrack_by_account, redtrack_earliest = {}, {}

    previous_campaigns_by_key = {}
    for c in current.get("campaigns", []):
        previous_campaigns_by_key.setdefault(c.get("accountKey"), []).append(c)

    all_campaigns = []
    sub_accounts = current.setdefault("subAccounts", {})
    failed_accounts = []
    for key, env_var in ACCOUNTS.items():
        token = os.environ.get(env_var)
        if not token:
            print(f"[warn] {key}: no token set for {env_var}, skipping")
            all_campaigns.extend(previous_campaigns_by_key.get(key, []))
            continue
        try:
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

            apply_redtrack_overrides(existing, key, redtrack_by_account, redtrack_earliest)

            all_campaigns.extend(build_campaigns(token, key))
            build_subaccount_costs(token, key, sub_accounts)
        except Exception as exc:
            print(f"[warn] {key}: sync failed, keeping previous data: {exc}")
            failed_accounts.append(key)
            all_campaigns.extend(previous_campaigns_by_key.get(key, []))

    current["campaigns"] = all_campaigns
    current["generatedAt"] = datetime.now(timezone.utc).isoformat()
    current["failedAccounts"] = failed_accounts

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)

    if failed_accounts:
        # Don't fail the whole workflow run over accounts that were already
        # broken before this sync — healthy accounts still got fresh data,
        # and it's flagged in data.json (failedAccounts) for the dashboard.
        print(f"[warn] completed with failures: {failed_accounts}")


if __name__ == "__main__":
    main()
