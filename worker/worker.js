function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Key",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function loadCosts(env) {
  const raw = await env.COSTS_KV.get("costs");
  return raw ? JSON.parse(raw) : [];
}

async function saveCosts(env, costs) {
  await env.COSTS_KV.put("costs", JSON.stringify(costs));
}

async function loadTopups(env) {
  const raw = await env.COSTS_KV.get("topups");
  return raw ? JSON.parse(raw) : [];
}

async function saveTopups(env, topups) {
  await env.COSTS_KV.put("topups", JSON.stringify(topups));
}

// ---- Campanhas table: metrics per level for a period (the list endpoints carry no metrics). ----
const METRIC_RANGES = ["TODAY", "YESTERDAY", "LAST_3_DAYS", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "MONTH_TO_DATE"];
async function computeMetricsByLevel(env, range) {
  const out = { campaign: {}, adset: {}, ad: {} };
  const failed = [];
  const tokens = await getAllTokens(env, { visibleOnly: true });
  await Promise.all(tokens.map(async ([key, token]) => {
    try {
      const [c, a, d] = await Promise.all([
        nbFetchReport(token, range, ["CAMPAIGN"], ["IMPRESSION"]),
        nbFetchReport(token, range, ["AD_SET"], ["IMPRESSION"]),
        nbFetchReport(token, range, ["AD"], ["IMPRESSION"]),
      ]);
      for (const r of c) out.campaign[r.campaignId] = nbRowToDoc(r);
      for (const r of a) out.adset[r.adSetId] = nbRowToDoc(r);
      for (const r of d) out.ad[r.adId] = nbRowToDoc(r);
    } catch (e) { failed.push(key); }
  }));
  return { range, ...out, failedAccounts: failed, generatedAt: new Date().toISOString() };
}

// ---- Integrations: API keys pasted in the app (KV) override the server secrets of the same name. ----
const INTEGRATIONS = [
  { key: "VTURB_API_TOKEN", label: "Vturb", hint: "Token da API do Vturb" },
  { key: "REDTRACK_API_KEY", label: "RedTrack", hint: "API key do RedTrack (plataforma de vendas)" },
];
async function loadIntegrations(env) {
  const raw = await env.COSTS_KV.get("integrations");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
// env with the in-app keys layered on top (falls back to the Cloudflare secret when the app has none)
async function keyedEnv(env) {
  const saved = await loadIntegrations(env);
  const e = Object.create(env);
  for (const i of INTEGRATIONS) if (saved[i.key] && saved[i.key].value) e[i.key] = saved[i.key].value;
  return e;
}

const VTURB_BASE = "https://analytics.vturb.net";
const VTURB_PLAYER_ID = "6a83665cf9bdc38fd3f3718a"; // HONEY - RITUAL GATES- DICAPRIO - [42:02] - EM USO
const VTURB_VIDEO_DURATION = 3388;

async function vturbFetch(env, path, options = {}) {
  const resp = await fetch(`${VTURB_BASE}${path}`, {
    ...options,
    headers: {
      "X-Api-Token": env.VTURB_API_TOKEN,
      "X-Api-Version": "v1",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(`vturb ${path} -> ${resp.status}`);
  return resp.json();
}

function vturbFmtDate(d) {
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

async function vturbStatsByField(env, field, since) {
  const now = new Date();
  return vturbFetch(env, "/sessions/stats_by_field", {
    method: "POST",
    body: JSON.stringify({
      player_id: VTURB_PLAYER_ID,
      start_date: vturbFmtDate(since),
      end_date: vturbFmtDate(now),
      field,
      video_duration: VTURB_VIDEO_DURATION,
    }),
  });
}

async function vturbStats(env) {
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const [live, devices, countries] = await Promise.all([
    vturbFetch(env, `/sessions/live_users?player_id=${VTURB_PLAYER_ID}&minutes=5`),
    vturbStatsByField(env, "device_type", since24h),
    vturbStatsByField(env, "country", since24h),
  ]);
  const liveNow = Array.isArray(live) ? live.reduce((a, d) => a + (d.live_users || 0), 0) : 0;
  return { liveNow, devices, countries, updatedAt: new Date().toISOString() };
}

async function getCached(env, key, ttlSeconds, computeFn) {
  const raw = await env.COSTS_KV.get(key);
  if (raw) {
    try {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts < ttlSeconds * 1000) return cached.data;
    } catch {}
  }
  const data = await computeFn();
  await env.COSTS_KV.put(key, JSON.stringify({ ts: Date.now(), data }));
  return data;
}

function round2(x) { return Math.round(x * 100) / 100; }
function round4(x) { return Math.round(x * 10000) / 10000; }

function todayKeySaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function loadLibrary(env) {
  const raw = await env.COSTS_KV.get("library");
  return raw ? JSON.parse(raw) : [];
}
async function saveLibrary(env, items) {
  await env.COSTS_KV.put("library", JSON.stringify(items));
}
// Folder identity is a "/"-joined path of upper-case segments (e.g. "HL/LEVA1");
// "logo" is the special top-level logos folder and cannot have sub-folders.
function normFolderPath(raw) {
  const r = String(raw || "").trim();
  if (r.toLowerCase() === "logo") return "logo";
  return r
    .split("/")
    .map((seg) => seg.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))
    .filter(Boolean)
    .slice(0, 6)
    .join("/");
}

function libItemCategory(i) {
  return i.category === "logo" ? "logo" : String(i.category || "").toUpperCase();
}

async function loadLinks(env) {
  const raw = await env.COSTS_KV.get("links");
  return raw ? JSON.parse(raw) : {};
}
async function saveLinks(env, links) {
  await env.COSTS_KV.put("links", JSON.stringify(links));
}

async function loadCopyPresets(env) {
  const raw = await env.COSTS_KV.get("copy_presets");
  return raw ? JSON.parse(raw) : [];
}
async function saveCopyPresets(env, items) {
  await env.COSTS_KV.put("copy_presets", JSON.stringify(items));
}

const DEFAULT_NICHES = ["ED", "NP", "BS", "TN", "WL"];

async function loadNiches(env) {
  const raw = await env.COSTS_KV.get("niches");
  if (raw) return JSON.parse(raw);
  await env.COSTS_KV.put("niches", JSON.stringify(DEFAULT_NICHES));
  return DEFAULT_NICHES;
}
async function saveNiches(env, list) {
  await env.COSTS_KV.put("niches", JSON.stringify(list));
}

async function loadCcSettings(env) {
  const raw = await env.COSTS_KV.get("cc_settings");
  return raw ? JSON.parse(raw) : { brandName: "", logoLibraryId: null };
}
async function saveCcSettings(env, settings) {
  await env.COSTS_KV.put("cc_settings", JSON.stringify(settings));
}

async function loadNichePresets(env) {
  const raw = await env.COSTS_KV.get("niche_presets");
  return raw ? JSON.parse(raw) : {};
}
async function saveNichePresets(env, obj) {
  await env.COSTS_KV.put("niche_presets", JSON.stringify(obj));
}

async function loadBrandPresets(env) {
  const raw = await env.COSTS_KV.get("brand_presets");
  return raw ? JSON.parse(raw) : [];
}
async function saveBrandPresets(env, items) {
  await env.COSTS_KV.put("brand_presets", JSON.stringify(items));
}

async function loadAccountSettings(env) {
  const raw = await env.COSTS_KV.get("account_settings");
  return raw ? JSON.parse(raw) : {};
}
async function saveAccountSettings(env, settings) {
  await env.COSTS_KV.put("account_settings", JSON.stringify(settings));
}

const NB_BASE = "https://business.newsbreak.com/business-api/v1";
const NB_TOKEN_ENV = { vini: "NEWSBREAK_TOKEN_VINI", pretorian: "NEWSBREAK_TOKEN_PRETORIAN", neia: "NEWSBREAK_TOKEN_NEIA", alan: "NEWSBREAK_TOKEN_ALAN", troya: "NEWSBREAK_TOKEN_TROYA" };

// All usable [accountKey, token] pairs: the hardcoded 5 (env secrets) plus
// any self-service accounts registered via /accounts (tokens stored in KV).
// An account switched off in "Contas" still shows on the day it was switched off (e.g. restricted today) and disappears
// from the next day on; legacy switched-off accounts (no "since" date) are hidden right away. Their history stays in the records.
function accountVisible(settings, key, today) {
  const s = settings && settings[key];
  if (!s || s.active !== false) return true;
  return !!s.since && s.since === today;
}

// opts.visibleOnly: leave out the accounts that are switched off (live data, metrics, rules). Records/backfill use all.
async function getAllTokens(env, opts) {
  let entries = Object.entries(NB_TOKEN_ENV)
    .map(([key, envVar]) => [key, env[envVar]])
    .filter(([, token]) => !!token);
  const custom = await loadCustomAccounts(env);
  for (const [key, meta] of Object.entries(custom)) {
    if (meta && meta.token && !meta.createOnly) entries.push([key, meta.token]);
  }
  if (opts && opts.visibleOnly) {
    const st = await loadAccountSettings(env), today = todayKeySaoPaulo();
    entries = entries.filter(([key]) => accountVisible(st, key, today));
  }
  return entries;
}

async function nbFetchReport(token, dateRange, dimensions, extraMetrics) {
  const resp = await fetch(`${NB_BASE}/reports/getIntegratedReport`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Access-Token": token },
    body: JSON.stringify({
      name: "live worker",
      timezone: "America/Sao_Paulo",
      dateRange,
      dimensions: dimensions || ["DATE"],
      metrics: ["COST", "CLICK", "CPC", ...(extraMetrics || [])],
      eventMetrics: [
        { eventType: "initiate_checkout", metrics: ["COUNT", "CPA"] },
        { eventType: "complete_payment", metrics: ["COUNT", "CPA", "VALUE"] },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`nb report -> ${resp.status}`);
  const data = await resp.json();
  return data.data.rows;
}

function nbRowToDoc(r) {
  const ic = (r.eventCount && r.eventCount.initiate_checkout) || 0;
  const venda = (r.eventCount && r.eventCount.complete_payment) || 0;
  const cost = r.costDecimal / 100;
  const fat = ((r.eventValueDecimal && r.eventValueDecimal.complete_payment) || 0) / 100;
  return {
    date: r.date,
    cost: round2(cost),
    click: r.click,
    cpc: r.click ? round4(r.cpcDecimal / 100) : 0,
    ic,
    custoIc: ic ? round2(cost / ic) : null,
    venda,
    faturamento: round2(fat),
    cpa: venda ? round2(cost / venda) : null,
    roas: cost ? round4(fat / cost) : null,
    impression: r.impression || 0,
    cpm: r.impression ? round2((cost / r.impression) * 1000) : null,
    ctr: r.impression ? round2((r.click / r.impression) * 100) : null,
    partial: true,
  };
}

async function nbGetAdAccounts(token) {
  const rows = await nbFetchReport(token, "LAST_30_DAYS", ["AD_ACCOUNT"]);
  const seen = {};
  for (const r of rows) seen[r.adAccountId] = r.adAccount || r.adAccountId;
  return seen;
}

async function nbGetList(path, token, adAccountId) {
  let rows = [];
  let page = 1;
  while (true) {
    const qs = new URLSearchParams({ adAccountId, pageNo: String(page), pageSize: "500" });
    const resp = await fetch(`${NB_BASE}/${path}/getList?${qs}`, {
      headers: { "Content-Type": "application/json", "Access-Token": token },
    });
    if (!resp.ok) throw new Error(`nb ${path} getList -> ${resp.status}`);
    const data = (await resp.json()).data;
    rows = rows.concat(data.list);
    if (!data.hasNext) break;
    page++;
  }
  return rows;
}

function nbMetricsFor(map, id) {
  const m = map && map[id];
  if (!m) return { todayCost: null, todayClick: null, todayVenda: null, todayCpa: null };
  return {
    todayCost: m.cost, todayClick: m.click, todayVenda: m.venda, todayCpa: m.cpa,
    todayIc: m.ic, todayCustoIc: m.custoIc, todayFat: m.faturamento, todayImpr: m.impression,
    todayCpm: m.cpm, todayCtr: m.ctr, todayCpc: m.cpc,
  };
}

async function nbBuildCampaignsForAccount(token, accountKey, adAccountId, adAccountName, campaignMetrics, adsetMetrics, adMetrics) {
  const [rawCampaigns, rawAdsets, rawAds] = await Promise.all([
    nbGetList("campaign", token, adAccountId),
    nbGetList("ad-set", token, adAccountId),
    nbGetList("ad", token, adAccountId),
  ]);

  const adsetsByCampaign = {};
  for (const a of rawAdsets) {
    if (a.onlineStatus === "DELETED") continue;
    (adsetsByCampaign[a.campaignId] = adsetsByCampaign[a.campaignId] || []).push(a);
  }
  const adsByAdset = {};
  for (const a of rawAds) {
    if (a.onlineStatus === "DELETED") continue;
    (adsByAdset[a.adSetId] = adsByAdset[a.adSetId] || []).push(a);
  }

  const campaigns = [];
  for (const c of rawCampaigns) {
    if (c.onlineStatus === "DELETED") continue;
    const myAdsets = adsetsByCampaign[c.id] || [];
    const adsetSummaries = [];
    let anyAdsetReallyOn = false;
    for (const a of myAdsets) {
      const myAds = adsByAdset[a.id] || [];
      const adsOn = myAds.filter((ad) => ad.status === "ON").length;
      const adsetReallyOn = a.status === "ON" && adsOn > 0;
      if (adsetReallyOn) anyAdsetReallyOn = true;
      adsetSummaries.push({
        id: a.id, name: a.name, status: a.status, onlineStatus: a.onlineStatus,
        budget: a.budget != null ? a.budget / 100 : null,
        budgetType: a.budgetType, adsOn, adsTotal: myAds.length, reallyActive: adsetReallyOn,
        ads: myAds.map((ad) => {
          const content = (ad.creative && ad.creative.content) || {};
          return {
            id: ad.id, name: ad.name, status: ad.status, onlineStatus: ad.onlineStatus, auditStatus: ad.auditStatus,
            creativeType: ad.creative && ad.creative.type, assetUrl: content.assetUrl, headline: content.headline,
            ...(ad.auditStatus === "REJECTED" ? {
              statusTxt: ad.statusTxt || "", description: content.description, brandName: content.brandName,
              callToAction: content.callToAction, clickThroughUrl: content.clickThroughUrl, logoUrl: content.logoUrl,
            } : {}),
            ...nbMetricsFor(adMetrics, ad.id),
          };
        }),
        ...nbMetricsFor(adsetMetrics, a.id),
      });
    }
    const reallyActive = c.status === "ON" && anyAdsetReallyOn;
    const activeBudget = adsetSummaries.filter((a) => a.reallyActive && a.budget).reduce((s, a) => s + a.budget, 0);
    campaigns.push({
      id: c.id, name: c.name, accountKey, adAccountId, adAccountName,
      objective: c.objective, activeBudget: activeBudget ? round2(activeBudget) : null,
      status: c.status, onlineStatus: c.onlineStatus,
      adSetsOn: adsetSummaries.filter((a) => a.status === "ON").length,
      adSetsTotal: adsetSummaries.length, reallyActive, adSets: adsetSummaries,
      ...nbMetricsFor(campaignMetrics, c.id),
    });
  }
  return campaigns;
}

const REDTRACK_SOURCE_MAP = { VINI: "vini", PRETORIAN: "pretorian", NEIA: "neia", ALAN: "alan", TROYA: "troya" };

function redtrackAccountKey(source) {
  const upper = (source || "").toUpperCase();
  for (const [needle, key] of Object.entries(REDTRACK_SOURCE_MAP)) {
    if (upper.includes(needle)) return key;
  }
  return null;
}

async function rtFetchReport(env, dateFrom, dateTo) {
  const qs = new URLSearchParams({
    api_key: env.REDTRACK_API_KEY,
    group: "source,date",
    date_from: dateFrom,
    date_to: dateTo,
    timezone: "America/Sao_Paulo",
  });
  const resp = await fetch(`https://api.redtrack.io/report?${qs}`);
  if (!resp.ok) throw new Error(`redtrack report -> ${resp.status}`);
  return resp.json();
}

async function rtFetchRegionReport(env, dateFrom, dateTo) {
  const qs = new URLSearchParams({
    api_key: env.REDTRACK_API_KEY,
    group: "region",
    date_from: dateFrom,
    date_to: dateTo,
    timezone: "America/Sao_Paulo",
  });
  const resp = await fetch(`https://api.redtrack.io/report?${qs}`);
  if (!resp.ok) throw new Error(`redtrack region report -> ${resp.status}`);
  return resp.json();
}

async function computeVendasPorEstado(env, dateFrom, dateTo) {
  const rows = await rtFetchRegionReport(env, dateFrom, dateTo);
  const states = rows
    .map((r) => ({ region: r.region, vendas: r.convtype1 || 0, faturamento: round2(r.revenuetype1 || 0) }))
    .filter((s) => s.vendas > 0)
    .sort((a, b) => b.vendas - a.vendas);
  const totalVendas = states.reduce((a, s) => a + s.vendas, 0);
  const totalFaturamento = round2(states.reduce((a, s) => a + s.faturamento, 0));
  return { dateFrom, dateTo, states, totalVendas, totalFaturamento, generatedAt: new Date().toISOString() };
}

async function computeLivePainel(env) {
  const today = todayKeySaoPaulo();
  let rtByAccount = {};
  try {
    const rtRows = await rtFetchReport(env, today, today);
    for (const r of rtRows) {
      const key = redtrackAccountKey(r.source);
      if (!key) continue;
      rtByAccount[key] = { venda: r.convtype1 || 0, faturamento: round2(r.revenuetype1 || 0) };
    }
  } catch (e) {
    // RedTrack down: fall back to NB's own venda/faturamento below instead of failing the whole response.
  }

  const accounts = {};
  const subAccountCosts = {};
  const failedAccounts = [];
  const tokenEntries = await getAllTokens(env, { visibleOnly: true });
  await Promise.all(
    tokenEntries.map(async ([key, token]) => {
      try {
        const [rows, subRows] = await Promise.all([
          nbFetchReport(token, "TODAY"),
          nbFetchReport(token, "TODAY", ["AD_ACCOUNT"]),
        ]);
        const r = rows[0];
        const doc = r
          ? nbRowToDoc(r)
          : { date: today, cost: 0, click: 0, cpc: 0, ic: 0, custoIc: null, venda: 0, faturamento: 0, cpa: null, roas: null, partial: true };
        const rt = rtByAccount[key];
        if (rt) {
          doc.venda = rt.venda;
          doc.faturamento = rt.faturamento;
          doc.cpa = rt.venda ? round2(doc.cost / rt.venda) : null;
          doc.roas = doc.cost ? round4(rt.faturamento / doc.cost) : null;
          doc.vendaSource = "redtrack";
        }
        accounts[key] = doc;
        for (const sr of subRows) {
          subAccountCosts[sr.adAccountId] = { name: sr.adAccount || sr.adAccountId, cost: round2(sr.costDecimal / 100) };
        }
      } catch (e) {
        failedAccounts.push(key);
      }
    })
  );

  return { date: today, accounts, subAccountCosts, failedAccounts, generatedAt: new Date().toISOString() };
}

async function computeLiveCampanhas(env) {
  const failedAccounts = [];
  const tokenEntries = await getAllTokens(env, { visibleOnly: true });
  const custom = await loadCustomAccounts(env);
  const perAccount = await Promise.all(
    tokenEntries.map(async ([key, token]) => {
      const attempt = async () => {
        const manual = custom[key] && custom[key].manualAccounts;
        const extra = ["IMPRESSION"];
        const [adAccounts, campaignRows, adsetRows, adRows] = await Promise.all([
          manual && manual.length
            ? Object.fromEntries(manual.map((a) => [a.id, a.name]))
            : nbGetAdAccounts(token),
          nbFetchReport(token, "TODAY", ["CAMPAIGN"], extra).catch(() => []),
          nbFetchReport(token, "TODAY", ["AD_SET"], extra).catch(() => []),
          nbFetchReport(token, "TODAY", ["AD"], extra).catch(() => []),
        ]);
        const campaignMetrics = {};
        for (const r of campaignRows) campaignMetrics[r.campaignId] = nbRowToDoc(r);
        const adsetMetrics = {};
        for (const r of adsetRows) adsetMetrics[r.adSetId] = nbRowToDoc(r);
        const adMetrics = {};
        for (const r of adRows) adMetrics[r.adId] = nbRowToDoc(r);
        const perAdAccount = await Promise.all(
          Object.entries(adAccounts).map(([adAccountId, adAccountName]) =>
            nbBuildCampaignsForAccount(token, key, adAccountId, adAccountName, campaignMetrics, adsetMetrics, adMetrics)
          )
        );
        return perAdAccount.flat();
      };
      try {
        return await attempt();
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          return await attempt();
        } catch (e2) {
          failedAccounts.push(key);
          return [];
        }
      }
    })
  );
  return { campaigns: perAccount.flat(), failedAccounts, generatedAt: new Date().toISOString() };
}

// ---- NewsBreak campaign-creation proxy (keeps real tokens server-side) ----

async function loadCustomAccounts(env) {
  const raw = await env.COSTS_KV.get("custom_accounts");
  return raw ? JSON.parse(raw) : {};
}
async function saveCustomAccounts(env, accounts) {
  await env.COSTS_KV.put("custom_accounts", JSON.stringify(accounts));
}

async function tokenForAccountKey(env, accountKey) {
  const envVar = NB_TOKEN_ENV[accountKey];
  if (envVar && env[envVar]) return env[envVar];
  const custom = await loadCustomAccounts(env);
  if (custom[accountKey] && custom[accountKey].token) return custom[accountKey].token;
  throw new Error(`no token configured for ${accountKey}`);
}

async function nbApi(token, path, options = {}) {
  const isForm = options.body instanceof FormData;
  const resp = await fetch(`${NB_BASE}/${path}`, {
    ...options,
    headers: {
      "Access-Token": token,
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`nb ${path} -> ${resp.status} (non-JSON response)`);
  }
  if (data.code !== 0) {
    const listMsg = Array.isArray(data.errList) ? data.errList.map((e) => e.msg).join("; ") : null;
    const err = new Error(data.errMsg || listMsg || `nb ${path} -> code ${data.code}`);
    err.nbRaw = data;
    throw err;
  }
  return data.data;
}

async function nbGetAdminOrgs(token) {
  const data = await nbApi(token, "org/admin-orgs", { method: "GET" });
  return data.list || [];
}

// Fallback org id for tokens whose user isn't ORG_ADMIN (org/admin-orgs
// returns an empty list for them even though they can list ad accounts
// within their own org). Discovered from an existing campaign's orgId.
const NB_ORG_ID_FALLBACK = { alan: "2018483047221407745", troya: "2018483047221407745" };

async function nbGetAdAccountsForToken(token, accountKey, orgIdOverride) {
  let orgs = await nbGetAdminOrgs(token);
  if (!orgs.length && orgIdOverride) {
    orgs = [{ id: orgIdOverride }];
  } else if (!orgs.length && NB_ORG_ID_FALLBACK[accountKey]) {
    orgs = [{ id: NB_ORG_ID_FALLBACK[accountKey] }];
  }
  if (!orgs.length) return [];
  const qs = orgs.map((o) => `orgIds=${encodeURIComponent(o.id)}`).join("&");
  const data = await nbApi(token, `ad-account/getGroupsByOrgIds?${qs}`, { method: "GET" });
  const accounts = [];
  for (const org of data.list || []) {
    for (const acc of org.adAccounts || []) {
      accounts.push({ id: acc.id, name: acc.name });
    }
  }
  return accounts;
}

async function nbGetAdSetList(token, adAccountId, pageSize) {
  const qs = new URLSearchParams({ adAccountId, pageNo: "1", pageSize: String(pageSize || 20) });
  const data = await nbApi(token, `ad-set/getList?${qs}`, { method: "GET" });
  return data.list || [];
}

async function nbFindTrackingId(token, adAccountId) {
  const adSets = await nbGetAdSetList(token, adAccountId, 50);
  const withTracking = adSets.filter((a) => a.trackingId);
  if (!withTracking.length) return null;
  withTracking.sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0));
  return withTracking[0].trackingId;
}

async function nbCreateCampaign(token, { adAccountId, name, objective, status }) {
  const body = { adAccountId, name, objective };
  if (status) body.status = status;
  return nbApi(token, "campaign/create", { method: "POST", body: JSON.stringify(body) });
}

async function nbCreateAdSet(token, fields) {
  return nbApi(token, "ad-set/create", { method: "POST", body: JSON.stringify(fields) });
}

async function nbCreateAd(token, fields) {
  return nbApi(token, "ad/create", { method: "POST", body: JSON.stringify(fields) });
}

async function nbSetCampaignStatus(token, campaignId, status) {
  return nbApi(token, `campaign/updateStatus/${campaignId}`, { method: "PUT", body: JSON.stringify({ status }) });
}
async function nbSetAdSetStatus(token, adSetId, status) {
  return nbApi(token, `ad-set/updateStatus/${adSetId}`, { method: "PUT", body: JSON.stringify({ status }) });
}
async function nbSetAdStatus(token, adId, status) {
  return nbApi(token, `ad/updateStatus/${adId}`, { method: "PUT", body: JSON.stringify({ status }) });
}
async function nbSetAdSetBudget(token, adSetId, budgetCents, budgetType) {
  const body = { budget: budgetCents };
  if (budgetType) body.budgetType = budgetType;
  return nbApi(token, `ad-set/update/${adSetId}`, { method: "PUT", body: JSON.stringify(body) });
}

function concatUint8(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Strips EXIF/IPTC/comment metadata from a JPEG by dropping APP1 (EXIF/XMP),
// APP13 (Photoshop IPTC) and COM segments. Pure marker-level surgery — the
// entropy-coded image data after SOS is copied verbatim, so pixels never
// get re-encoded.
function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const chunks = [buf.subarray(0, 2)];
  let i = 2;
  const standalone = (m) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);
  const dropMarkers = new Set([0xe1, 0xed, 0xfe]); // APP1 (EXIF/XMP), APP13 (Photoshop/IPTC), COM
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte before real marker
    if (marker === 0xd9) { chunks.push(buf.subarray(i, i + 2)); return concatUint8(chunks); }
    if (standalone(marker)) { chunks.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 3 >= buf.length) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const segEnd = i + 2 + len;
    if (segEnd > buf.length) break;
    if (marker === 0xda) { // start of scan — header plus everything after is image data, copy as-is
      chunks.push(buf.subarray(i, segEnd));
      chunks.push(buf.subarray(segEnd));
      return concatUint8(chunks);
    }
    if (!dropMarkers.has(marker)) chunks.push(buf.subarray(i, segEnd));
    i = segEnd;
  }
  return buf; // unexpected structure — return original rather than risk a corrupt file
}

// Strips text/metadata chunks (tEXt, zTXt, iTXt, eXIf, tIME) from a PNG.
// Critical chunks (IHDR/PLTE/IDAT/IEND) and color-affecting ancillary ones
// (gAMA/iCCP/sRGB/etc.) are left untouched.
function stripPngMetadata(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 || !sig.every((b, idx) => buf[idx] === b)) return buf;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const chunks = [buf.subarray(0, 8)];
  let i = 8;
  const drop = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  while (i + 8 <= buf.length) {
    const len = dv.getUint32(i);
    const type = td(i + 4);
    const chunkEnd = i + 12 + len;
    if (chunkEnd > buf.length) break;
    if (!drop.has(type)) chunks.push(buf.subarray(i, chunkEnd));
    i = chunkEnd;
    if (type === "IEND") break;
  }
  return concatUint8(chunks);
}

// Strips EXIF/XMP RIFF chunks from a WebP, rewriting the outer RIFF size.
function stripWebpMetadata(buf) {
  if (buf.length < 12) return buf;
  const td = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (td(0) !== "RIFF" || td(8) !== "WEBP") return buf;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunks = [];
  let i = 12;
  const drop = new Set(["EXIF", "XMP "]);
  while (i + 8 <= buf.length) {
    const fourcc = td(i);
    const size = dv.getUint32(i + 4, true);
    const padded = size + (size % 2);
    const chunkEnd = i + 8 + padded;
    if (chunkEnd > buf.length) break;
    if (!drop.has(fourcc)) chunks.push(buf.subarray(i, chunkEnd));
    i = chunkEnd;
  }
  const body = concatUint8(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(buf.subarray(0, 4), 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(buf.subarray(8, 12), 8);
  out.set(body, 12);
  return out;
}

function gifSkipSubBlocks(buf, i) {
  while (i < buf.length) {
    const size = buf[i];
    i += 1;
    if (size === 0) return i; // terminator block
    i += size;
  }
  return i;
}

// Strips Comment Extensions and the XMP-in-GIF Application Extension
// ("XMP DataXMP") from a GIF. Frame data, the NETSCAPE2.0 loop extension
// and everything else that affects rendering is copied through untouched —
// we only ever drop whole extension blocks we've fully identified as pure
// metadata, never image data sub-blocks.
function stripGifMetadata(buf) {
  if (buf.length < 13 || buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return buf; // "GIF"
  const chunks = [buf.subarray(0, 13)];
  let i = 13;
  const packed = buf[10];
  if (packed & 0x80) {
    const gctSize = 3 * Math.pow(2, (packed & 0x07) + 1);
    chunks.push(buf.subarray(i, i + gctSize));
    i += gctSize;
  }
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x3b) { chunks.push(buf.subarray(i, i + 1)); return concatUint8(chunks); } // trailer
    if (b === 0x21) { // extension introducer
      const label = buf[i + 1];
      if (label === 0xfe) { // comment extension — drop
        i = gifSkipSubBlocks(buf, i + 2);
        continue;
      }
      if (label === 0xf9) { // graphic control extension — fixed size, keep
        const size = buf[i + 2];
        const end = i + 3 + size + 1;
        chunks.push(buf.subarray(i, end));
        i = end;
        continue;
      }
      if (label === 0x01) { // plain text extension — keep
        const size = buf[i + 2];
        const end = gifSkipSubBlocks(buf, i + 3 + size);
        chunks.push(buf.subarray(i, end));
        i = end;
        continue;
      }
      if (label === 0xff) { // application extension — drop only the XMP metadata block
        const size = buf[i + 2];
        const idStart = i + 3;
        const end = gifSkipSubBlocks(buf, idStart + size);
        let appId = "";
        for (let k = 0; k < size; k++) appId += String.fromCharCode(buf[idStart + k]);
        if (appId !== "XMP DataXMP") chunks.push(buf.subarray(i, end));
        i = end;
        continue;
      }
      return buf; // unknown extension label — bail, don't risk corruption
    }
    if (b === 0x2c) { // image descriptor — always keep, frame data
      const segStart = i;
      const imgPacked = buf[i + 9];
      let j = i + 10;
      if (imgPacked & 0x80) j += 3 * Math.pow(2, (imgPacked & 0x07) + 1);
      j += 1; // LZW minimum code size
      j = gifSkipSubBlocks(buf, j);
      chunks.push(buf.subarray(segStart, j));
      i = j;
      continue;
    }
    return buf; // unexpected byte — bail, don't risk corruption
  }
  return buf; // no trailer found — fallback to original
}

// Strips any metadata we know how to parse safely for the given content
// type. Falls back to the original bytes untouched (video, GIF, or any
// parse failure) rather than risk sending NewsBreak a corrupt asset.
function stripMetadataBytes(bytes, contentType) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    if (contentType === "image/jpeg" || contentType === "image/jpg") return stripJpegMetadata(buf);
    if (contentType === "image/png") return stripPngMetadata(buf);
    if (contentType === "image/webp") return stripWebpMetadata(buf);
    if (contentType === "image/gif") return stripGifMetadata(buf);
  } catch (e) {
    return buf;
  }
  return buf;
}

async function nbUploadAsset(token, { adAccountId, bytes, filename, contentType, mediaName }) {
  // NewsBreak sometimes answers with a gateway error (502 / non-JSON) for a perfectly good upload:
  // retry those transport failures (not real NB errors) a couple of times, rebuilding the form each time.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new FormData();
    form.append("asset", new Blob([bytes], { type: contentType }), filename);
    form.append("adAccountId", adAccountId);
    if (mediaName) {
      form.append("saveToMediaLibrary", "true");
      form.append("mediaName", mediaName);
    }
    try {
      return await nbApi(token, "ad/uploadAssets", { method: "POST", body: form });
    } catch (e) {
      // NewsBreak rejects re-uploading identical content to the same ad account,
      // but still hands back the existing asset's url/id in the error payload —
      // reuse it instead of failing, since the user legitimately reuses creatives.
      const existing = e.nbRaw && e.nbRaw.data;
      if (existing && existing.assetUrl) return existing;
      if (e.nbRaw) throw e; // a real NB answer: don't retry
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function triggerSync(env) {
  const cooldownKey = "lastSyncTrigger";
  const last = await env.COSTS_KV.get(cooldownKey);
  const now = Date.now();
  if (last && now - Number(last) < 90 * 1000) {
    return { ok: false, error: "cooldown", retryInMs: 90 * 1000 - (now - Number(last)) };
  }
  const resp = await fetch(
    "https://api.github.com/repos/leosantan4/newsbreak/actions/workflows/sync.yml/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "newbreak-costs-api-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (resp.status !== 204) {
    const text = await resp.text();
    return { ok: false, error: "github_dispatch_failed", status: resp.status, detail: text };
  }
  await env.COSTS_KV.put(cooldownKey, String(now));
  return { ok: true };
}

// ---- Push alerts for rejected ads (Pushcut). Inert unless the secret PUSHCUT_URL is set on the Worker. ----
function pushReason(txt) {
  const raw = String(txt || "").trim();
  const t = raw.toLowerCase();
  if (!raw) return "motivo não informado";
  if (/celebrit/.test(t)) return "uso de celebridade";
  if (/sexual|adult|nudity|nude/.test(t)) return "conteúdo sexual/adulto";
  if (/before.{0,12}after/.test(t)) return "antes e depois";
  if (/miracle|cure|medical|health claim|weight loss/.test(t)) return "alegação de saúde";
  if (/misleading|deceptive|clickbait|sensational/.test(t)) return "enganoso/sensacionalista";
  if (/landing page|website|destination/.test(t)) return "página de destino";
  if (/trademark|copyright/.test(t)) return "marca/direitos autorais";
  const clean = raw.replace(/^violation of advertising policy\s*[-–:]\s*/i, "").split(/(?<=[.!?])\s/)[0];
  return clean.length > 80 ? clean.slice(0, 77) + "…" : clean;
}

// campaign ON + ad set ON + ad ON + REJECTED (same rule as the Rejeições tab)
function rejectedActiveAds(data) {
  const out = [];
  for (const c of (data && data.campaigns) || []) {
    if (c.status !== "ON") continue;
    for (const s of c.adSets || []) {
      if (s.status !== "ON") continue;
      for (const ad of s.ads || []) {
        if (ad.auditStatus === "REJECTED" && ad.status === "ON") {
          out.push({ id: ad.id, name: ad.name, acc: c.accountKey, account: c.adAccountName || c.accountKey, reason: pushReason(ad.statusTxt) });
        }
      }
    }
  }
  return out;
}

// ---- Push recipients: the server default (secret PUSHCUT_URL) + people who paste their own Pushcut URL in the app. ----
const PUSH_TYPES = ["rejections", "rules"];
async function loadRecipients(env) {
  const raw = await env.COSTS_KV.get("push_recipients");
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
function validPushUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === "https:" && x.hostname === "api.pushcut.io" && x.pathname.length > 8; } catch { return false; }
}
function maskPushUrl(u) {
  try {
    const x = new URL(u);
    const seg = x.pathname.split("/").filter(Boolean);
    if (seg.length) seg[0] = "••••••";
    return x.origin + "/" + seg.join("/");
  } catch { return "••••••"; }
}
function recipientWants(r, type) {
  if (r.enabled === false) return false;
  const t = r.types || {};
  return type === "test" ? true : t[type] !== false;
}
async function pushTargets(env, type, onlyId) {
  const out = [];
  if (env.PUSHCUT_URL && (!onlyId || onlyId === "default")) out.push({ id: "default", url: env.PUSHCUT_URL });
  for (const r of await loadRecipients(env)) {
    if (onlyId) { if (r.id === onlyId) out.push({ id: r.id, url: r.url }); }
    else if (recipientWants(r, type)) out.push({ id: r.id, url: r.url });
  }
  return out;
}

async function sendPush(env, title, text, type, onlyId) {
  const targets = await pushTargets(env, type || "test", onlyId);
  if (!targets.length) return { ok: false, error: "not_configured" };
  const results = await Promise.all(targets.map(async (t) => {
    try {
      const resp = await fetch(t.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, text }) });
      return { id: t.id, ok: resp.ok, status: resp.status };
    } catch (e) { return { id: t.id, ok: false, error: "network" }; }
  }));
  const okCount = results.filter((r) => r.ok).length;
  const result = { ok: okCount > 0, sent: okCount, failed: results.length - okCount, status: (results.find((r) => !r.ok) || results[0]).status };
  await env.COSTS_KV.put("push_last", JSON.stringify({ at: Date.now(), title, ...result }));
  return result;
}

// First alert right away; then a reminder every PUSH_REPEAT_MIN minutes (default 30) while it stays rejected + active.
async function pushRejectedAlerts(env, data) {
  if (!(await pushTargets(env, "rejections")).length) return;
  const repeatMs = Math.max(5, Number(env.PUSH_REPEAT_MIN) || 30) * 60 * 1000;
  const now = Date.now();
  const raw = await env.COSTS_KV.get("push_state");
  const state = raw ? JSON.parse(raw) : {};
  const active = rejectedActiveAds(data);
  const failed = new Set((data && data.failedAccounts) || []);
  const next = {};
  for (const [id, st] of Object.entries(state)) { if (st && st.acc && failed.has(st.acc)) next[id] = st; } // account unreadable now: keep what we knew
  const fresh = [];
  const reminders = [];
  for (const ad of active) {
    const prev = state[ad.id];
    if (!prev) { fresh.push(ad); next[ad.id] = { first: now, last: now, acc: ad.acc }; }
    else if (now - prev.last >= repeatMs) { reminders.push(ad); next[ad.id] = { first: prev.first, last: now, acc: ad.acc }; }
    else next[ad.id] = { ...prev, acc: ad.acc };
  }
  const line = (a) => a.account + " · " + a.name + " — " + a.reason;
  let sentOk = true;
  if (fresh.length) {
    const r = await sendPush(env, (fresh.length > 1 ? "Anúncios recusados (" + fresh.length + ")" : "Anúncio recusado"), fresh.slice(0, 6).map(line).join("\n"), "rejections");
    sentOk = sentOk && r.ok;
    if (!r.ok) fresh.forEach((a) => { delete next[a.id]; }); // try again next minute
  }
  if (reminders.length) {
    const r = await sendPush(env, "Ainda recusado" + (reminders.length > 1 ? "s (" + reminders.length + ")" : ""), reminders.slice(0, 6).map(line).join("\n"), "rejections");
    if (!r.ok) reminders.forEach((a) => { next[a.id] = state[a.id]; });
  }
  await env.COSTS_KV.put("push_state", JSON.stringify(next)); // ads that left the list are forgotten, so a new rejection alerts again
}

// ---------------------------------------------------------------------------------------------
// Rules engine: evaluates every AD SET (never the campaign) on lifetime (last 30 days) metrics and acts.
// Metrics: cost ($), ic (initiate_checkout count), sales (complete_payment count), cpic (cost / ic).
// ---------------------------------------------------------------------------------------------
const RULE_METRICS = ["cost", "ic", "sales", "cpic", "cpc", "cpm", "ctr", "clicks", "impressions", "cpa", "roas", "revenue"];
const RULE_OPS = [">", ">=", "<", "<=", "="];
const RULE_ACTIONS = ["pause_adset", "set_budget", "notify"];
const DEFAULT_RULES = [
  { id: "r1", name: "Gasto > $50 sem checkout", enabled: true, scope: {}, margin: 5, action: { type: "pause_adset" },
    conditions: [{ metric: "cost", op: ">", value: 50 }, { metric: "ic", op: "<", value: 1 }] },
  { id: "r2", name: "Gasto ≥ $100, IC ≤ 1, sem venda", enabled: true, scope: {}, margin: 5, action: { type: "pause_adset" },
    conditions: [{ metric: "cost", op: ">=", value: 100 }, { metric: "ic", op: "<=", value: 1 }, { metric: "sales", op: "=", value: 0 }] },
  { id: "r3", name: "Gasto ≥ $150 sem venda", enabled: true, scope: {}, margin: 5, action: { type: "pause_adset" },
    conditions: [{ metric: "cost", op: ">=", value: 150 }, { metric: "sales", op: "=", value: 0 }] },
  { id: "r5", name: "Gasto ≥ $350, 1 venda, custo/IC ≥ $75", enabled: true, scope: {}, margin: 0, action: { type: "pause_adset" },
    conditions: [{ metric: "cost", op: ">=", value: 350 }, { metric: "sales", op: "=", value: 1 }, { metric: "cpic", op: ">=", value: 75 }] },
  { id: "r4", name: "Escalar: gasto ≥ $10 com checkout e venda → orçamento $1000", enabled: true, scope: {}, margin: 0, action: { type: "set_budget", budget: 1000 },
    conditions: [{ metric: "cost", op: ">=", value: 10 }, { metric: "ic", op: ">=", value: 1 }, { metric: "sales", op: ">=", value: 1 }] },
];

async function loadRules(env) {
  const raw = await env.COSTS_KV.get("rules");
  if (raw) { try { return JSON.parse(raw); } catch {} }
  await env.COSTS_KV.put("rules", JSON.stringify(DEFAULT_RULES));
  return DEFAULT_RULES.map((r) => ({ ...r }));
}
async function saveRules(env, rules) { await env.COSTS_KV.put("rules", JSON.stringify(rules)); }

function cleanRule(b, existingId) {
  const name = String((b && b.name) || "").trim().slice(0, 120);
  if (!name) return { error: "name_required" };
  const conditions = Array.isArray(b.conditions) ? b.conditions : [];
  if (!conditions.length || conditions.length > 8) return { error: "conditions_invalid" };
  const cleanConds = [];
  for (const c of conditions) {
    if (!c || RULE_METRICS.indexOf(c.metric) === -1 || RULE_OPS.indexOf(c.op) === -1 || !isFinite(Number(c.value))) return { error: "condition_invalid" };
    cleanConds.push({ metric: c.metric, op: c.op, value: Number(c.value), join: c.join === "or" ? "or" : "and" });
  }
  const a = b.action || {};
  if (RULE_ACTIONS.indexOf(a.type) === -1) return { error: "action_invalid" };
  const action = { type: a.type };
  if (a.type === "set_budget") {
    const bud = Number(a.budget);
    if (!isFinite(bud) || bud < 1 || bud > 100000) return { error: "budget_invalid" };
    action.budget = bud;
  }
  const s = b.scope || {};
  const scope = {};
  for (const k of ["accountKey", "adAccountId", "campaignId", "niche"]) if (s[k]) scope[k] = String(s[k]).slice(0, 80);
  for (const k of ["adAccountIds", "campaignIds", "niches"]) {
    if (Array.isArray(s[k]) && s[k].length) scope[k] = s[k].slice(0, 100).map((x) => String(x).slice(0, 120));
  }
  const margin = Math.max(0, Math.min(50, Number(b.margin) || 0));
  return { rule: { id: existingId || String(b.id || crypto.randomUUID()).slice(0, 60), name, enabled: b.enabled !== false, scope, margin, action, notify: b.notify !== false, conditions: cleanConds } };
}

function nicheOfName(name) {
  const m = String(name || "").split(" - ")[0].trim().toUpperCase();
  return m;
}

function ruleScopeOk(scope, ctx) {
  if (!scope) return true;
  if (scope.accountKey && scope.accountKey !== ctx.accountKey) return false;
  if (scope.adAccountId && scope.adAccountId !== ctx.adAccountId) return false;
  if (Array.isArray(scope.adAccountIds) && scope.adAccountIds.length && scope.adAccountIds.indexOf(ctx.adAccountId) === -1) return false;
  if (scope.campaignId && scope.campaignId !== ctx.campaignId) return false;
  if (scope.niche && String(scope.niche).toUpperCase() !== nicheOfName(ctx.campaignName)) return false;
  if (Array.isArray(scope.campaignIds) && scope.campaignIds.length && scope.campaignIds.indexOf(ctx.campaignId) === -1) return false;
  if (Array.isArray(scope.niches) && scope.niches.length && scope.niches.map((n) => String(n).toUpperCase()).indexOf(nicheOfName(ctx.campaignName)) === -1) return false;
  return true;
}

function ruleMetric(m, mt) {
  if (m === "cost") return mt.cost;
  if (m === "ic") return mt.ic;
  if (m === "sales") return mt.venda;
  if (m === "cpic") return mt.ic > 0 ? mt.cost / mt.ic : null;
  if (m === "cpc") return mt.click > 0 ? mt.cost / mt.click : null;
  if (m === "cpm") return mt.impression > 0 ? (mt.cost / mt.impression) * 1000 : null;
  if (m === "ctr") return mt.impression > 0 ? (mt.click / mt.impression) * 100 : null;
  if (m === "clicks") return mt.click || 0;
  if (m === "impressions") return mt.impression || 0;
  if (m === "cpa") return mt.venda > 0 ? mt.cost / mt.venda : null;
  if (m === "roas") return mt.cost > 0 ? (mt.faturamento || 0) / mt.cost : null;
  if (m === "revenue") return mt.faturamento || 0;
  return null;
}

function condOk(c, mt, margin) {
  const v = ruleMetric(c.metric, mt);
  if (v == null) return false;
  let th = Number(c.value);
  if (c.metric === "cost" && (c.op === ">" || c.op === ">=")) th -= Number(margin) || 0; // act early: the NB numbers lag
  return c.op === ">" ? v > th : c.op === ">=" ? v >= th : c.op === "<" ? v < th : c.op === "<=" ? v <= th : Math.abs(v - th) < 0.005;
}

// Conditions are chained with E (and) / OU (or); AND binds tighter than OR: "A E B OU C" = (A and B) or C.
function ruleMatches(rule, mt) {
  const groups = [];
  rule.conditions.forEach((c, i) => {
    if (i === 0 || c.join === "or") groups.push([c]); else groups[groups.length - 1].push(c);
  });
  return groups.some((g) => g.every((c) => condOk(c, mt, rule.margin)));
}

// Lifetime (last 30 days) metrics per ad set, per account key.
async function fetchLifetimeAdsetMetrics(env, errs) {
  const out = {};
  const tokens = await getAllTokens(env, { visibleOnly: true });
  await Promise.all(tokens.map(async ([key, token]) => {
    try {
      const rows = await nbFetchReport(token, "LAST_30_DAYS", ["AD_SET"], ["IMPRESSION"]);
      const map = {};
      for (const r of rows) map[r.adSetId] = nbRowToDoc(r);
      out[key] = map;
    } catch (e) { /* account unreadable this minute: its ad sets are skipped */ if (errs) errs.push(key + ': ' + String((e && e.message) || e)); }
  }));
  return out;
}

// Decide what every rule would do right now. Pure: does not touch NewsBreak.
function planRules(data, life, rules, state) {
  const plan = [];
  let evaluated = 0;
  const active = rules.filter((r) => r.enabled);
  for (const c of (data && data.campaigns) || []) {
    if (c.status !== "ON" || !life[c.accountKey]) continue;
    for (const s of c.adSets || []) {
      if (s.status !== "ON") continue;
      evaluated++;
      const mt = life[c.accountKey][s.id] || { cost: 0, ic: 0, venda: 0 };
      const ctx = { accountKey: c.accountKey, adAccountId: c.adAccountId, campaignId: c.id, campaignName: c.name };
      const hits = active.filter((r) => ruleScopeOk(r.scope, ctx) && ruleMatches(r, mt));
      const done = (r) => state[r.id + ":" + s.id];
      const base = { accountKey: c.accountKey, accountLabel: c.adAccountName || c.accountKey, campaignId: c.id, campaign: c.name, adsetId: s.id, adset: s.name,
        metrics: { cost: mt.cost, ic: mt.ic, sales: mt.venda }, budget: s.budget, budgetType: s.budgetType };
      // pause beats budget; notify rules are independent
      const pause = hits.find((r) => r.action.type === "pause_adset" && (!done(r) || mt.cost >= done(r).cost + 10));
      if (pause) plan.push({ ...base, rule: pause, kind: "pause_adset" });
      else {
        const budgetRule = hits.find((r) => r.action.type === "set_budget" && !done(r) && !(Number(s.budget) >= r.action.budget));
        if (budgetRule) plan.push({ ...base, rule: budgetRule, kind: "set_budget" });
      }
      for (const r of hits) if (r.action.type === "notify" && !done(r)) plan.push({ ...base, rule: r, kind: "notify" });
    }
  }
  return { plan, evaluated };
}

async function runRulesEngine(env, data) {
  const on = (await env.COSTS_KV.get("rules_engine_on")) === "1";
  if (!on) return { ran: false };
  const rules = await loadRules(env);
  const life = await fetchLifetimeAdsetMetrics(env);
  const stateRaw = await env.COSTS_KV.get("rules_state");
  const state = stateRaw ? JSON.parse(stateRaw) : {};
  const { plan, evaluated } = planRules(data, life, rules, state);
  const logRaw = await env.COSTS_KV.get("rules_log");
  const log = logRaw ? JSON.parse(logRaw) : [];
  const lines = [];
  for (const p of plan) {
    const entry = { at: Date.now(), ruleId: p.rule.id, ruleName: p.rule.name, accountKey: p.accountKey, account: p.accountLabel, campaign: p.campaign, adset: p.adset, adsetId: p.adsetId, metrics: p.metrics, action: p.kind, result: "ok", detail: "" };
    try {
      if (p.kind === "pause_adset") {
        await nbSetAdSetStatus(await tokenForAccountKey(env, p.accountKey), p.adsetId, "OFF");
        entry.detail = "conjunto pausado";
      } else if (p.kind === "set_budget") {
        await nbSetAdSetBudget(await tokenForAccountKey(env, p.accountKey), p.adsetId, Math.round(p.rule.action.budget * 100), p.budgetType || "DAILY");
        entry.detail = "orçamento $" + (p.budget != null ? p.budget : "?") + " → $" + p.rule.action.budget;
      } else entry.detail = "aviso";
      state[p.rule.id + ":" + p.adsetId] = { at: Date.now(), cost: p.metrics.cost };
      const mm = "gasto $" + p.metrics.cost + ", IC " + p.metrics.ic + ", vendas " + p.metrics.sales;
      if (p.rule.notify !== false || p.kind === "notify") lines.push((p.kind === "pause_adset" ? "Pausado: " : p.kind === "set_budget" ? "Orçamento $" + p.rule.action.budget + ": " : "Aviso: ") + p.accountLabel + " · " + p.adset + " — " + mm + " (" + p.rule.name + ")");
    } catch (e) {
      entry.result = "erro";
      entry.detail = String((e && e.message) || e).slice(0, 200);
      lines.push("FALHOU (" + (p.kind === "pause_adset" ? "pausar" : p.kind === "set_budget" ? "mudar orçamento" : "avisar") + "): " + p.accountLabel + " · " + p.adset + " (" + p.rule.name + ")");
    }
    log.unshift(entry);
  }
  if (plan.length) {
    await env.COSTS_KV.put("rules_state", JSON.stringify(state));
    await env.COSTS_KV.put("rules_log", JSON.stringify(log.slice(0, 200)));
    await env.COSTS_KV.delete("live_campanhas");
    if (lines.length) await sendPush(env, "Regras: " + lines.length + (lines.length === 1 ? " ação" : " ações"), lines.slice(0, 6).join("\n"), "rules");
  }
  return { ran: true, evaluated, actions: plan.length };
}

// ---------------------------------------------------------------------------------------------
// Taboola (Backstage API): OAuth client-credentials. Step 1 = connection only (token + accounts). `env` must be keyedEnv(env).
// ---------------------------------------------------------------------------------------------
const TABOOLA_BASE = "https://backstage.taboola.com/backstage";

// Several Taboola logins can be connected (KV "connections": { taboola: [{ id, name, clientId, clientSecret, accountId, createdAt }] }).
async function loadConnections(env) {
  const raw = await env.COSTS_KV.get("connections");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
async function saveConnections(env, all) {
  await env.COSTS_KV.put("connections", JSON.stringify(all));
  await env.COSTS_KV.delete("taboola_status");
}

async function taboolaToken(env, conn, force) {
  if (!conn || !conn.clientId || !conn.clientSecret) throw new Error("taboola_not_configured");
  const kvKey = `taboola_token:${conn.id}`;
  const cid = String(conn.clientId).slice(-6) + String(conn.clientSecret).slice(-4);
  if (!force) {
    const raw = await env.COSTS_KV.get(kvKey);
    if (raw) { try { const t = JSON.parse(raw); if (t.cid === cid && t.exp > Date.now() + 60000) return t.token; } catch {} }
  }
  const resp = await fetch(`${TABOOLA_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: conn.clientId, client_secret: conn.clientSecret, grant_type: "client_credentials" }).toString(),
  });
  if (!resp.ok) throw new Error(`taboola token -> ${resp.status}`);
  const j = await resp.json();
  if (!j || !j.access_token) throw new Error("taboola token -> sem access_token");
  const ttl = Math.max(300, (Number(j.expires_in) || 43200) - 120);
  await env.COSTS_KV.put(kvKey, JSON.stringify({ token: j.access_token, exp: Date.now() + ttl * 1000, cid }), { expirationTtl: ttl });
  return j.access_token;
}

async function taboolaFetch(env, conn, path, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await taboolaToken(env, conn, attempt > 0);
    const resp = await fetch(`${TABOOLA_BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(options.headers || {}) } });
    if (resp.status === 401 && attempt === 0) continue; // token expired/revoked: get a new one once
    if (!resp.ok) throw new Error(`taboola ${path} -> ${resp.status}`);
    return resp.json();
  }
  throw new Error("taboola auth -> 401");
}

async function taboolaAccounts(env, conn) {
  const j = await taboolaFetch(env, conn, "/api/1.0/users/current/allowed-accounts");
  const list = Array.isArray(j) ? j : (j && (j.results || j.accounts)) || [];
  return list.map((a) => ({ id: a.account_id || a.id, name: a.name || a.account_id || a.id, currency: a.currency || null, timezone: a.time_zone_name || null, active: a.is_active !== false }));
}

// Never expose the secret: only name + last 4 of the Client ID.
function publicConnection(c) {
  return { id: c.id, name: c.name, accountId: c.accountId || "", clientIdTail: String(c.clientId || "").slice(-4), createdAt: c.createdAt || null };
}

// ---- Taboola read layer (step B): advertiser accounts -> campaigns -> items, plus sites (= the "ad sets" of Taboola) ----
const TB_DATE = /^\d{4}-\d{2}-\d{2}$/;
function tbNum(x) { const n = Number(x); return isFinite(n) ? n : 0; }

async function taboolaReport(env, conn, acct, report, dim, params) {
  const qs = new URLSearchParams(params || {});
  return taboolaFetch(env, conn, `/api/1.0/${encodeURIComponent(acct)}/reports/${report}/dimensions/${dim}?${qs}`);
}

// Advertiser accounts under the connection's network account (the network itself holds no campaigns). Cached 1h.
async function taboolaAdvertisers(env, conn) {
  const key = `taboola_adv:${conn.id}`;
  return getCached(env, key, 3600, async () => {
    const j = await taboolaFetch(env, conn, `/api/1.0/${encodeURIComponent(conn.accountId)}/advertisers`);
    const list = Array.isArray(j) ? j : (j && j.results) || [];
    return list.map((a) => ({ id: a.account_id || a.id, name: a.name || a.account_id, currency: a.currency || "USD", timezone: a.time_zone_name || null, active: a.is_active !== false }));
  });
}

// Every advertiser account across all connected logins, with the connection that reaches it.
async function taboolaAllAdvertisers(env) {
  const conns = (await loadConnections(env)).taboola || [];
  const out = [], seen = new Set();
  for (const c of conns) {
    try {
      for (const a of await taboolaAdvertisers(env, c)) { if (!seen.has(a.id)) { seen.add(a.id); out.push({ ...a, conn: c }); } }
    } catch (e) { /* this login is unreachable right now: the others still load */ }
  }
  return out;
}

function tbMetrics(r) {
  const spent = tbNum(r.spent), clicks = tbNum(r.clicks), impressions = tbNum(r.impressions), conversions = tbNum(r.cpa_actions_num);
  return { spent: round2(spent), clicks, impressions, cpc: clicks ? round4(spent / clicks) : 0, ctr: impressions ? round4(clicks / impressions * 100) : 0, cpm: impressions ? round2(spent / impressions * 1000) : 0, conversions, cpa: conversions ? round2(spent / conversions) : null, revenue: round2(tbNum(r.conversions_value)) };
}

function tbCampaign(c, acct) {
  return {
    id: String(c.id), account: acct.id, accountName: acct.name, name: c.name || String(c.id),
    status: c.status || (c.is_active === false ? "PAUSED" : "RUNNING"), active: c.is_active !== false,
    approval: c.approval_state || null, rejectReason: (c.policy_review && c.policy_review.reject_reason) || null,
    bidType: c.bid_type || c.bid_strategy || null, bid: c.cpc != null ? tbNum(c.cpc) : null,
    dailyCap: c.daily_cap != null ? tbNum(c.daily_cap) : null, spendingLimit: c.spending_limit != null ? tbNum(c.spending_limit) : null, spendingModel: c.spending_limit_model || null,
    startDate: c.start_date || null, country: Array.isArray(c.country_targeting && c.country_targeting.value) ? c.country_targeting.value : null,
  };
}

async function computeTaboolaOverview(env, from, to) {
  const advs = await taboolaAllAdvertisers(env);
  let updatedAt = null;
  const accounts = await Promise.all(advs.map(async (a) => {
    try {
      const [camps, rep] = await Promise.all([
        taboolaFetch(env, a.conn, `/api/1.0/${encodeURIComponent(a.id)}/campaigns/`),
        taboolaReport(env, a.conn, a.id, "campaign-summary", "campaign_breakdown", { start_date: from, end_date: to }),
      ]);
      if (rep && rep["last-used-rawdata-update-time"]) updatedAt = updatedAt && updatedAt > rep["last-used-rawdata-update-time"] ? updatedAt : rep["last-used-rawdata-update-time"];
      const byId = {};
      for (const r of (rep && rep.results) || []) byId[String(r.campaign)] = tbMetrics(r);
      const list = ((camps && camps.results) || []).map((c) => ({ ...tbCampaign(c, a), ...(byId[String(c.id)] || tbMetrics({})) }));
      const total = tbMetrics({ spent: list.reduce((x, c) => x + c.spent, 0), clicks: list.reduce((x, c) => x + c.clicks, 0), impressions: list.reduce((x, c) => x + c.impressions, 0), cpa_actions_num: list.reduce((x, c) => x + c.conversions, 0), conversions_value: list.reduce((x, c) => x + c.revenue, 0) });
      return { id: a.id, name: a.name, currency: a.currency, ok: true, campaigns: list, total };
    } catch (err) {
      const m = String((err && err.message) || err); const st = (m.match(/-> (\d{3})/) || [])[1];
      return { id: a.id, name: a.name, ok: false, status: st ? Number(st) : null, campaigns: [], total: tbMetrics({}) };
    }
  }));
  return { from, to, dataUpdatedAt: updatedAt, generatedAt: new Date().toISOString(), accounts };
}

// Sites (publishers). Per account for the whole account, or limited to one campaign (campaign_site_day_breakdown, summed).
async function computeTaboolaSites(env, from, to, acctId, campaignId) {
  const advs = (await taboolaAllAdvertisers(env)).filter((a) => !acctId || a.id === acctId);
  const sites = [];
  let updatedAt = null;
  await Promise.all(advs.map(async (a) => {
    try {
      let rep, rows;
      if (campaignId) {
        rep = await taboolaReport(env, a.conn, a.id, "campaign-summary", "campaign_site_day_breakdown", { start_date: from, end_date: to, campaign: campaignId });
        const agg = new Map();
        for (const r of (rep && rep.results) || []) {
          const k = String(r.site_id || r.site);
          const cur = agg.get(k) || { site_id: r.site_id, site: r.site, site_name: r.site_name, spent: 0, clicks: 0, impressions: 0, cpa_actions_num: 0, conversions_value: 0 };
          cur.spent += tbNum(r.spent); cur.clicks += tbNum(r.clicks); cur.impressions += tbNum(r.impressions); cur.cpa_actions_num += tbNum(r.cpa_actions_num); cur.conversions_value += tbNum(r.conversions_value);
          agg.set(k, cur);
        }
        rows = [...agg.values()];
      } else {
        rep = await taboolaReport(env, a.conn, a.id, "campaign-summary", "site_breakdown", { start_date: from, end_date: to });
        rows = (rep && rep.results) || [];
      }
      if (rep && rep["last-used-rawdata-update-time"]) updatedAt = updatedAt && updatedAt > rep["last-used-rawdata-update-time"] ? updatedAt : rep["last-used-rawdata-update-time"];
      for (const r of rows) sites.push({ account: a.id, accountName: a.name, siteId: String(r.site_id || r.site), site: r.site_name || r.site || String(r.site_id), ...tbMetrics(r) });
    } catch (err) { /* one account failing does not hide the others */ }
  }));
  sites.sort((x, y) => y.spent - x.spent);
  return { from, to, campaign: campaignId || null, dataUpdatedAt: updatedAt, sites };
}

// Items (ads) of one campaign, with approval state and the metrics of the period.
async function computeTaboolaItems(env, from, to, acctId, campaignId) {
  const a = (await taboolaAllAdvertisers(env)).find((x) => x.id === acctId);
  if (!a) return { items: [], error: "account_not_found" };
  const [items, rep] = await Promise.all([
    taboolaFetch(env, a.conn, `/api/1.0/${encodeURIComponent(a.id)}/campaigns/${encodeURIComponent(campaignId)}/items/`),
    taboolaReport(env, a.conn, a.id, "top-campaign-content", "item_breakdown", { start_date: from, end_date: to, campaign: campaignId }).catch(() => null),
  ]);
  const byItem = {};
  for (const r of (rep && rep.results) || []) byItem[String(r.item)] = tbMetrics(r);
  const list = ((items && items.results) || []).map((i) => ({
    id: String(i.id), account: a.id, campaign: String(campaignId), title: i.title || i.description || String(i.id), url: i.url || null, thumbnail: i.thumbnail_url || null,
    status: i.status || null, active: i.is_active !== false, approval: i.approval_state || null, rejectReason: (i.policy_review && i.policy_review.reject_reason) || null,
    ...(byItem[String(i.id)] || tbMetrics({})),
  }));
  return { from, to, dataUpdatedAt: (rep && rep["last-used-rawdata-update-time"]) || null, items: list };
}

// ---- Taboola rules: (1) block_pattern = account-level blocklist by site NAME; (2) site_optimize = per-campaign site rules. ----
// Mode (KV taboola_engine_mode): "off" | "notify" (default: only logs/warns what it WOULD do) | "on" (acts).
const TBR_METRICS = ["cost", "clicks", "impressions", "conversions", "cpa", "cpc", "ctr"];
const TBR_OPS = [">", ">=", "<", "<=", "="];
const TBR_ACTIONS = ["block_site", "notify"];

async function tbrLoadRules(env) {
  const raw = await env.COSTS_KV.get("taboola_rules");
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
async function tbrMode(env) {
  const m = await env.COSTS_KV.get("taboola_engine_mode");
  return m === "on" || m === "off" ? m : "notify";
}

function tbrClean(b, existingId) {
  const type = b && b.type;
  if (type !== "block_pattern" && type !== "site_optimize") return { error: "type_invalid" };
  const name = String(b.name || "").trim().slice(0, 120);
  if (!name) return { error: "name_required" };
  const rule = { id: existingId || String(b.id || crypto.randomUUID()).slice(0, 60), type, name, enabled: b.enabled !== false, notify: b.notify !== false, accounts: [] };
  if (Array.isArray(b.accounts)) rule.accounts = b.accounts.slice(0, 20).map((x) => String(x).slice(0, 120));
  if (type === "block_pattern") {
    const pats = (Array.isArray(b.patterns) ? b.patterns : String(b.patterns || "").split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean);
    if (!pats.length || pats.length > 30 || pats.some((x) => x.length < 2 || x.length > 60)) return { error: "patterns_invalid" };
    const minClicks = Math.round(Number(b.minClicks));
    rule.patterns = pats;
    rule.minClicks = isFinite(minClicks) && minClicks >= 1 && minClicks <= 1000 ? minClicks : 1;
  } else {
    const conds = Array.isArray(b.conditions) ? b.conditions : [];
    if (!conds.length || conds.length > 8) return { error: "conditions_invalid" };
    rule.conditions = [];
    for (const c of conds) {
      if (!c || TBR_METRICS.indexOf(c.metric) === -1 || TBR_OPS.indexOf(c.op) === -1 || !isFinite(Number(c.value))) return { error: "condition_invalid" };
      rule.conditions.push({ metric: c.metric, op: c.op, value: Number(c.value), join: c.join === "or" ? "or" : "and" });
    }
    const act = b.action && b.action.type;
    if (TBR_ACTIONS.indexOf(act) === -1) return { error: "action_invalid" };
    rule.action = { type: act };
  }
  return { rule };
}

// returns the first pattern ("prefix") that the site name/id contains, or "" when none does
function tbrNameMatch(rule, row) {
  const names = [row.site_name, row.site, row.site_id].filter(Boolean).map((x) => String(x).toLowerCase());
  for (const p of rule.patterns) { const q = p.toLowerCase(); if (names.some((n) => n.includes(q))) return p; }
  return "";
}
function tbrCond(c, m) {
  const v = m[c.metric]; if (v === null || v === undefined) return false;
  if (c.op === ">") return v > c.value; if (c.op === ">=") return v >= c.value; if (c.op === "<") return v < c.value; if (c.op === "<=") return v <= c.value;
  return v === c.value;
}
function tbrMatches(rule, m) {
  const groups = [];
  rule.conditions.forEach((c, i) => { if (i === 0 || c.join === "or") groups.push([c]); else groups[groups.length - 1].push(c); });
  return groups.some((g) => g.every((c) => tbrCond(c, m)));
}
function tbrMetrics(r) {
  const x = tbMetrics(r);
  return { cost: x.spent, clicks: x.clicks, impressions: x.impressions, conversions: x.conversions, cpa: x.cpa, cpc: x.cpc, ctr: x.ctr };
}

async function taboolaWrite(env, conn, path, method, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await taboolaToken(env, conn, attempt > 0);
    const resp = await fetch(`${TABOOLA_BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (resp.status === 401 && attempt === 0) continue;
    if (!resp.ok) { const t = await resp.text().catch(() => ""); throw new Error(`taboola ${method} ${path} -> ${resp.status} ${t.slice(0, 120)}`); }
    return true;
  }
  throw new Error("taboola auth -> 401");
}

async function taboolaBlockedAtAccount(env, conn, acct) {
  try { const j = await taboolaFetch(env, conn, `/api/1.0/${encodeURIComponent(acct)}/block-publisher`); return new Set(((j && j.sites) || []).map((x) => String(x).toLowerCase())); }
  catch { return new Set(); }
}

// What would every enabled rule do right now? (pure reads; `state` filters what was already handled unless ignoreState)
async function planTaboolaRules(env, rules, state, ignoreState) {
  const advs = await taboolaAllAdvertisers(env);
  const today = todayKeySaoPaulo();
  const plan = [];
  let evaluated = 0;
  const active = rules.filter((r) => r.enabled);
  const blockRules = active.filter((r) => r.type === "block_pattern");
  const optRules = active.filter((r) => r.type === "site_optimize");
  const inScope = (r, a) => !r.accounts || !r.accounts.length || r.accounts.includes(a.id);
  const done = (k) => !ignoreState && state.done && state.done[k];
  const simmed = (k) => !ignoreState && state.sim && state.sim[k];
  for (const a of advs) {
    const mine = blockRules.filter((r) => inScope(r, a));
    if (mine.length) {
      let rep; try { rep = await taboolaReport(env, a.conn, a.id, "campaign-summary", "site_breakdown", { start_date: today, end_date: today }); } catch { continue; }
      const blocked = await taboolaBlockedAtAccount(env, a.conn, a.id);
      for (const r of (rep && rep.results) || []) {
        evaluated++;
        const id = String(r.site || r.site_id || "");
        if (!id || blocked.has(id.toLowerCase()) || tbNum(r.clicks) < 1) continue;
        for (const rule of mine) {
          const prefix = tbrNameMatch(rule, r);
          if (tbNum(r.clicks) < rule.minClicks || !prefix) continue;
          const key = `${rule.id}:${a.id}:${id}`;
          if (done(key)) continue;
          plan.push({ kind: "block_account", rule, account: a.id, accountName: a.name, conn: a.conn, siteId: id, site: r.site_name || id, prefix, metrics: tbrMetrics(r), key, simulated: !!simmed(key) });
          break;
        }
      }
    }
    const opts = optRules.filter((r) => inScope(r, a));
    if (opts.length) {
      let camps; try { camps = (await taboolaFetch(env, a.conn, `/api/1.0/${encodeURIComponent(a.id)}/campaigns/`)).results || []; } catch { continue; }
      const from = shiftDayKeySP(today, -29);
      for (const c of camps.filter((x) => x.status === "RUNNING")) {
        let rows; try {
          const rep = await getCached(env, `tbr_life:${a.id}:${c.id}`, 240, () => taboolaReport(env, a.conn, a.id, "campaign-summary", "campaign_site_day_breakdown", { start_date: from, end_date: today, campaign: String(c.id) }));
          const agg = new Map();
          for (const r of (rep && rep.results) || []) {
            const k = String(r.site || r.site_id); const cur = agg.get(k) || { site: r.site, site_id: r.site_id, site_name: r.site_name, spent: 0, clicks: 0, impressions: 0, cpa_actions_num: 0 };
            cur.spent += tbNum(r.spent); cur.clicks += tbNum(r.clicks); cur.impressions += tbNum(r.impressions); cur.cpa_actions_num += tbNum(r.cpa_actions_num); agg.set(k, cur);
          }
          rows = [...agg.values()];
        } catch { continue; }
        for (const r of rows) {
          evaluated++;
          const m = tbrMetrics(r), id = String(r.site || r.site_id || "");
          for (const rule of opts) {
            if (!tbrMatches(rule, m)) continue;
            const key = `${rule.id}:${a.id}:${c.id}:${id}`;
            if (done(key)) continue;
            plan.push({ kind: rule.action.type === "block_site" ? "block_campaign_site" : "notify", rule, account: a.id, accountName: a.name, conn: a.conn, campaignId: String(c.id), campaign: c.name, siteId: id, site: r.site_name || id, metrics: m, key, simulated: !!simmed(key) });
            break;
          }
        }
      }
    }
  }
  return { plan, evaluated, mode: null };
}

function shiftDayKeySP(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

async function runTaboolaRules(env, opts) {
  const mode = await tbrMode(env);
  if (mode === "off") return { ran: false, reason: "off" };
  let rules = await tbrLoadRules(env);
  if (opts && opts.onlyRuleId) rules = rules.filter((r) => r.id === opts.onlyRuleId).map((r) => ({ ...r, enabled: true })); // manual run: works even when the rule is paused
  if (!rules.some((r) => r.enabled)) return { ran: false };
  if (!((await loadConnections(env)).taboola || []).length) return { ran: false };
  const stRaw = await env.COSTS_KV.get("taboola_rules_state");
  const state = stRaw ? JSON.parse(stRaw) : {};
  state.done = state.done || {}; state.sim = state.sim || {};
  const { plan, evaluated } = await planTaboolaRules(env, rules, state, false);
  if (!plan.length) return { ran: true, evaluated, actions: 0, mode };
  const logRaw = await env.COSTS_KV.get("taboola_rules_log");
  const log = logRaw ? JSON.parse(logRaw) : [];
  const lines = [];
  const blockedAdd = [];
  const fresh = plan.filter((p) => !(mode === "notify" && p.simulated));
  // account-level blocks go in one PATCH per account
  const byAcct = new Map();
  for (const p of fresh.filter((x) => x.kind === "block_account")) { const l = byAcct.get(p.account) || []; l.push(p); byAcct.set(p.account, l); }
  const failedKeys = new Set();
  if (mode === "on") {
    for (const [acct, list] of byAcct) {
      try { await taboolaWrite(env, list[0].conn, `/api/1.0/${encodeURIComponent(acct)}/block-publisher`, "PATCH", { patch_operation: "ADD", sites: list.map((p) => p.siteId) }); }
      catch (e) { list.forEach((p) => { p.error = String((e && e.message) || e).slice(0, 200); failedKeys.add(p.key); }); }
    }
    for (const p of fresh.filter((x) => x.kind === "block_campaign_site")) {
      try { await taboolaWrite(env, p.conn, `/api/1.0/${encodeURIComponent(p.account)}/campaigns/${encodeURIComponent(p.campaignId)}`, "PATCH", { patch_operation: "ADD", publisher_targeting: { type: "EXCLUDE", value: [p.siteId] } }); }
      catch (e) { p.error = String((e && e.message) || e).slice(0, 200); failedKeys.add(p.key); }
    }
  }
  for (const p of fresh) {
    const failed = failedKeys.has(p.key);
    const verb = p.kind === "block_account" ? "bloquear na conta" : p.kind === "block_campaign_site" ? "bloquear na campanha" : "avisar";
    const entry = { at: Date.now(), ruleId: p.rule.id, ruleName: p.rule.name, kind: p.kind, account: p.accountName, campaign: p.campaign || null, site: p.site, siteId: p.siteId, metrics: p.metrics,
      result: failed ? "erro" : (mode === "on" ? "feito" : "simulado"), detail: failed ? p.error : (mode === "on" ? (p.kind === "notify" ? "aviso" : "site bloqueado") : "só aviso: teria feito — " + verb) };
    log.unshift(entry);
    if (!failed) { if (mode === "on") state.done[p.key] = Date.now(); else state.sim[p.key] = Date.now(); }
    if (p.kind === "block_account" && !failed) blockedAdd.push({ ruleId: p.rule.id, siteId: p.siteId, site: p.site, prefix: p.prefix || "", account: p.accountName, at: Date.now(), simulated: mode !== "on" });
    if (p.rule.notify !== false || p.kind === "notify" || failed) lines.push((failed ? "FALHOU: " : mode === "on" ? (p.kind === "notify" ? "Aviso: " : "Bloqueado: ") : "Teria bloqueado: ") + p.site + " · " + p.accountName + (p.campaign ? " · " + p.campaign : "") + " (" + p.rule.name + ", " + p.metrics.clicks + " cliques, $" + p.metrics.cost + ")");
  }
  if (blockedAdd.length) {
    const braw = await env.COSTS_KV.get("taboola_blocked");
    const all = braw ? JSON.parse(braw) : {};
    for (const b of blockedAdd) {
      const list = all[b.ruleId] || (all[b.ruleId] = []);
      const i = list.findIndex((x) => x.siteId === b.siteId && x.account === b.account);
      if (i >= 0) { if (!b.simulated) list[i] = b; } else list.unshift(b);
      if (list.length > 3000) list.length = 3000;
    }
    await env.COSTS_KV.put("taboola_blocked", JSON.stringify(all));
  }
  if (fresh.length) {
    await env.COSTS_KV.put("taboola_rules_state", JSON.stringify(state));
    await env.COSTS_KV.put("taboola_rules_log", JSON.stringify(log.slice(0, 200)));
    if (lines.length) await sendPush(env, "Taboola" + (mode === "notify" ? " (só aviso)" : "") + ": " + lines.length + (lines.length === 1 ? " site" : " sites"), lines.slice(0, 6).join("\n"), "rules");
  }
  return { ran: true, evaluated, actions: fresh.length, mode };
}


// ---- Ranking: daily per-ad snapshots (KV rk:<day>), joined with ad identity (rk_meta) and a campaign->niche map ----
const RK_RANGES = { "7": 7, "30": 30, "all": 100000 };

function rkNormHeadline(h) {
  let t = String(h || "").normalize("NFKC").toLowerCase();
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^["'\s]+/, "").replace(/[\s.…!?,;:"']+$/, "");
  return t;
}

function rkDayOf(d) {
  if (d == null) return null;
  if (typeof d === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    if (/^\d{8}$/.test(d)) return d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8);
    const n = Number(d); if (!isFinite(n)) return null; d = n;
  }
  if (typeof d === "number") {
    const ms = d < 1e11 ? d * 1000 : d;
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  }
  return null;
}

async function rkNicheCodes(env) {
  const list = await loadNiches(env);
  const out = new Set();
  for (const n of list || []) {
    const parts = String(n).split("/");
    if (parts.length === 1 && ["NEWSBREAK", "TABOOLA"].indexOf(parts[0].toUpperCase()) === -1) out.add(parts[0].toUpperCase());
    else if (parts.length === 2 && ["NEWSBREAK", "TABOOLA"].indexOf(parts[0].toUpperCase()) !== -1) out.add(parts[1].toUpperCase());
  }
  return out;
}

async function rkListDays(env) {
  const days = [];
  let cursor;
  do {
    const r = await env.COSTS_KV.list({ prefix: "rk:", cursor });
    for (const k of r.keys) days.push(k.name.slice(3));
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return days.sort();
}

async function rkStoreDay(env, day, adsMap) {
  const raw = await env.COSTS_KV.get("rk:" + day);
  let rec = { ads: {} };
  if (raw) { try { rec = JSON.parse(raw); if (!rec.ads) rec.ads = {}; } catch {} }
  Object.assign(rec.ads, adsMap);
  rec.at = Date.now();
  await env.COSTS_KV.put("rk:" + day, JSON.stringify(rec));
}

// opts: { backfill, yesterday }. Never throws for one failed account; reports it in the diagnostics.
async function rkRefresh(env, opts) {
  opts = opts || {};
  const diag = { rows: 0, failed: [], days: [], mode: opts.backfill ? "backfill" : "refresh" };
  const tokens = await getAllTokens(env, opts.backfill ? undefined : { visibleOnly: true });
  const today = todayKeySaoPaulo(), yesterday = shiftDayKeySP(today, -1);
  const perDay = {};
  const put = (day, r) => {
    if (!day || !r.adId) return;
    const d = nbRowToDoc(r);
    (perDay[day] = perDay[day] || {})[r.adId] = [d.cost, d.ic, d.venda, d.faturamento, d.click, d.impression];
  };
  await Promise.all(tokens.map(async ([key, token]) => {
    try {
      if (opts.backfill) {
        const rows = await nbFetchReport(token, "LAST_30_DAYS", ["DATE", "AD"], ["IMPRESSION"]);
        diag.rows += rows.length;
        if (rows.length && !diag.sample) diag.sample = { date: rows[0].date, keys: Object.keys(rows[0]).slice(0, 12) };
        for (const r of rows) put(rkDayOf(r.date), r);
      } else {
        const rows = await nbFetchReport(token, "TODAY", ["AD"], ["IMPRESSION"]);
        diag.rows += rows.length;
        for (const r of rows) put(today, r);
        if (opts.yesterday) { for (const r of await nbFetchReport(token, "YESTERDAY", ["AD"], ["IMPRESSION"])) put(yesterday, r); }
      }
    } catch (e) { diag.failed.push(key + ": " + String((e && e.message) || e).slice(0, 80)); }
  }));
  for (const day of Object.keys(perDay)) { await rkStoreDay(env, day, perDay[day]); diag.days.push(day); }
  // ad identity (number, headline, thumbnail, campaign) comes from the live snapshot; kept even after an ad is deleted
  try {
    const rawLive = await env.COSTS_KV.get("live_campanhas");
    const live = rawLive && JSON.parse(rawLive).data;
    if (live && live.campaigns) {
      const mraw = await env.COSTS_KV.get("rk_meta");
      const meta = mraw ? JSON.parse(mraw) : {};
      for (const c of live.campaigns) for (const a of c.adSets || []) for (const ad of a.ads || []) {
        meta[ad.id] = { k: c.accountKey, c: c.id, cn: c.name, an: c.adAccountName, n: ad.name, h: ad.headline || "", t: ad.assetUrl || "", ty: ad.creativeType || "" };
      }
      await env.COSTS_KV.put("rk_meta", JSON.stringify(meta));
    }
  } catch (e) { diag.metaError = String((e && e.message) || e).slice(0, 80); }
  // contas com token quebrado sempre falham; basta uma conta ter dado certo pra não repetir a importação
  if (opts.backfill && diag.days.length) await env.COSTS_KV.put("rk_backfilled", String(Date.now()));
  return diag;
}

async function rkLoadNicheMap(env) {
  const raw = await env.COSTS_KV.get("rk_niche_map");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function rkAddTotals(t, a) {
  t.cost += a[0]; t.ic += a[1]; t.venda += a[2]; t.fat += a[3]; t.click += a[4]; t.impr += a[5];
}
function rkTotals() { return { cost: 0, ic: 0, venda: 0, fat: 0, click: 0, impr: 0 }; }
function rkFinish(t) {
  return { ic: t.ic, venda: t.venda, click: t.click, impr: t.impr, cost: round2(t.cost), fat: round2(t.fat), lucro: round2(t.fat - t.cost), cpa: t.venda ? round2(t.cost / t.venda) : null, roas: t.cost ? round4(t.fat / t.cost) : null };
}

async function computeRank(env, daysKey) {
  const limit = RK_RANGES[daysKey] || 30;
  let allDays = await rkListDays(env);
  const days = allDays.slice(-limit);
  const sums = {};
  for (let i = 0; i < days.length; i += 40) {
    const chunk = days.slice(i, i + 40);
    const recs = await Promise.all(chunk.map((d) => env.COSTS_KV.get("rk:" + d)));
    for (const raw of recs) {
      if (!raw) continue;
      let rec; try { rec = JSON.parse(raw); } catch { continue; }
      for (const [adId, arr] of Object.entries(rec.ads || {})) { rkAddTotals(sums[adId] = sums[adId] || rkTotals(), arr); }
    }
  }
  const mraw = await env.COSTS_KV.get("rk_meta");
  const meta = mraw ? JSON.parse(mraw) : {};
  const nicheMap = await rkLoadNicheMap(env);
  const codes = await rkNicheCodes(env);
  let defNiche = String((await env.COSTS_KV.get("rk_default_niche")) || "").toUpperCase();
  if (!codes.has(defNiche)) defNiche = "";
  // order: niche in the campaign name -> niche marked by hand for that campaign -> the system's default niche (old campaigns)
  const nicheOf = (m) => {
    if (!m) return "";
    const byName = String(m.cn || "").split(" - ")[0].trim().toUpperCase();
    if (codes.has(byName)) return byName;
    return nicheMap[m.c] || defNiche;
  };
  const ads = {}, heads = {}, niches = {}, camps = {}, accounts = {};
  let total = rkTotals();
  for (const [adId, t] of Object.entries(sums)) {
    if (!t.cost && !t.venda && !t.ic) continue;
    const m = meta[adId];
    const niche = nicheOf(m);
    const num = m && /^\d{1,6}$/.test(String(m.n || "").trim()) ? String(m.n).trim() : "";
    const gkey = num ? (niche || "?") + "|" + num : "id|" + adId;
    const g = ads[gkey] = ads[gkey] || { key: gkey, niche, num, name: m ? m.n : "", headline: "", thumb: "", type: "", ids: 0, campaigns: new Set(), camps: {}, _best: -1, ...rkTotals() };
    rkAddTotals(g, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]);
    g.ids++;
    if (m) {
      g.campaigns.add(m.c);
      const cc = g.camps[m.c] = g.camps[m.c] || { id: m.c, name: m.cn, cost: 0, venda: 0 };
      cc.cost += t.cost; cc.venda += t.venda;
      if (t.cost > g._best) { g._best = t.cost; g.headline = m.h || g.headline; g.thumb = m.t || g.thumb; g.type = m.ty || g.type; }
    }
    // headlines (all niches together; the niches it ran in are listed)
    const hn = m ? rkNormHeadline(m.h) : "";
    if (hn) {
      const h = heads[hn] = heads[hn] || { key: hn, text: "", _best: -1, niches: new Set(), adKeys: new Set(), campaigns: new Set(), perNiche: {}, adMap: {}, ...rkTotals() };
      rkAddTotals(h, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]);
      h.adKeys.add(gkey); h.campaigns.add(m.c); h.niches.add(niche || "");
      const ha = h.adMap[gkey] = h.adMap[gkey] || { key: gkey, num, niche, cost: 0, venda: 0 };
      ha.cost += t.cost; ha.venda += t.venda;
      if (t.cost > h._best) { h._best = t.cost; h.text = m.h; }
      const pn = h.perNiche[niche || ""] = h.perNiche[niche || ""] || rkTotals();
      rkAddTotals(pn, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]);
    }
    const nk = niche || "";
    const n = niches[nk] = niches[nk] || { niche: nk, adKeys: new Set(), campaigns: new Set(), ...rkTotals() };
    rkAddTotals(n, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]); n.adKeys.add(gkey); if (m) n.campaigns.add(m.c);
    if (m) {
      const ak = (m.k || "?") + "|" + niche;
      const ac = accounts[ak] = accounts[ak] || { account: m.k || "?", niche, name: m.an || m.k || "?", ...rkTotals() };
      rkAddTotals(ac, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]);
      if (!niche) {
        const c = camps[m.c] = camps[m.c] || { id: m.c, name: m.cn, accountKey: ak, account: m.an || ak, ...rkTotals() };
        rkAddTotals(c, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]);
      }
    }
    rkAddTotals(total, [t.cost, t.ic, t.venda, t.fat, t.click, t.impr]);
  }
  const out = (g, extra) => ({ ...rkFinish(g), ...extra });
  return {
    days: days.length, from: days[0] || null, to: days[days.length - 1] || null, range: daysKey,
    sources: [out(total, { source: "newsbreak", label: "NewsBreak" })],
    niches: Object.values(niches).map((n) => out(n, { niche: n.niche, ads: n.adKeys.size, campaigns: n.campaigns.size })),
    ads: Object.values(ads).map((g) => out(g, { key: g.key, niche: g.niche, num: g.num, name: g.name, headline: g.headline, thumb: g.thumb, type: g.type, campaigns: g.campaigns.size, campaignsList: Object.values(g.camps).sort((a, b) => b.cost - a.cost).slice(0, 10).map((c) => ({ id: c.id, name: c.name, cost: round2(c.cost), venda: c.venda })) })),
    headlines: Object.values(heads).map((h) => out(h, { key: h.key, text: h.text, niches: [...h.niches], ads: h.adKeys.size, campaigns: h.campaigns.size, adList: Object.values(h.adMap).sort((a, b) => b.venda - a.venda || b.cost - a.cost).slice(0, 8).map((a) => ({ key: a.key, num: a.num, niche: a.niche, cost: round2(a.cost), venda: a.venda })), byNiche: Object.fromEntries(Object.entries(h.perNiche).map(([k, v]) => [k, rkFinish(v)])) })),
    accounts: Object.values(accounts).map((a) => out(a, { account: a.account, name: a.name, niche: a.niche })),
    unassigned: Object.values(camps).map((c) => out(c, { id: c.id, name: c.name, accountKey: c.accountKey, account: c.account })).sort((a, b) => b.cost - a.cost),
    defaultNiche: defNiche,
    generatedAt: new Date().toISOString(),
  };
}

export default {
  // Cron (every minute): keeps the live campaigns snapshot warm, so the page never waits on a cold read.
  async scheduled(event, env, ctx) {
    // the old */30 trigger on this Worker never had a handler; only the every-minute one does the work
    if (event && event.cron && event.cron !== "* * * * *") return;
    ctx.waitUntil((async () => {
      const started = Date.now();
      let note = "ok";
      try {
        const data = await computeLiveCampanhas(env);
        if (data) {
          await env.COSTS_KV.put("live_campanhas", JSON.stringify({ ts: Date.now(), data }));
          try { await pushRejectedAlerts(env, data); } catch (e) { note = "push_error:" + String((e && e.message) || e); }
          try { const rr = await runRulesEngine(env, data); if (rr && rr.ran) note += "; rules_eval:" + rr.evaluated + " rules_acoes:" + rr.actions; } catch (e) { note += "; rules_error:" + String((e && e.message) || e); }
          if ((data.failedAccounts || []).length) note = (note === "ok" ? "ok" : note) + "; failedAccounts:" + data.failedAccounts.join(",");
        }
      } catch (e) {
        note = "error:" + String((e && e.message) || e);
      }
      try {
        const at = new Date((event && event.scheduledTime) || Date.now());
        const first = !(await env.COSTS_KV.get("rk_backfilled"));
        if (first || at.getUTCMinutes() % 10 === 0) {
          const rr = await rkRefresh(env, first ? { backfill: true } : { yesterday: at.getUTCMinutes() % 30 === 0 });
          note += "; rank:" + rr.mode + " dias:" + rr.days.length + (rr.failed.length ? " falhas:" + rr.failed.length : "");
        }
      } catch (e) { note += "; rank_erro:" + String((e && e.message) || e).slice(0, 120); }
      try { const tr = await runTaboolaRules(env); if (tr && tr.ran) note += "; tb_regras_eval:" + tr.evaluated + " tb_acoes:" + tr.actions; } catch (e) { note += "; tb_regras_erro:" + String((e && e.message) || e).slice(0, 120); }
      await env.COSTS_KV.put("cron_heartbeat", JSON.stringify({ at: started, ms: Date.now() - started, note }));
    })());
  },
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (url.pathname === "/vturb/stats" && request.method === "GET") {
      try {
        const stats = await vturbStats(await keyedEnv(env));
        return json(stats, 200, origin);
      } catch (e) {
        return json({ error: "vturb_fetch_failed" }, 502, origin);
      }
    }

    if (url.pathname === "/live/vendas-estado" && request.method === "GET") {
      try {
        const today = todayKeySaoPaulo();
        const dateFrom = url.searchParams.get("date_from") || today;
        const dateTo = url.searchParams.get("date_to") || today;
        const data = await getCached(env, `vendas_estado:${dateFrom}:${dateTo}`, 600, async () => computeVendasPorEstado(await keyedEnv(env), dateFrom, dateTo));
        return json(data, 200, origin);
      } catch (e) {
        return json({ error: "vendas_estado_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/live/painel" && request.method === "GET") {
      try {
        const data = await getCached(env, "live_painel", 20, async () => computeLivePainel(await keyedEnv(env)));
        return json(data, 200, origin);
      } catch (e) {
        return json({ error: "live_painel_failed" }, 502, origin);
      }
    }

    if (url.pathname === "/live/campanhas" && request.method === "GET") {
      try {
        const data = await getCached(env, "live_campanhas", 10, () => computeLiveCampanhas(env));
        return json(data, 200, origin);
      } catch (e) {
        return json({ error: "live_campanhas_failed" }, 502, origin);
      }
    }

    if (url.pathname === "/library" && request.method === "GET") {
      const items = await loadLibrary(env);
      return json({ items }, 200, origin);
    }

    if (url.pathname === "/niches" && request.method === "GET") {
      const niches = await loadNiches(env);
      return json({ niches }, 200, origin);
    }

    if (url.pathname === "/niches" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const parent = body.parent ? normFolderPath(body.parent) : "";
      const leaf = normFolderPath(String(body.code || "").split("/").pop());
      if (!leaf || leaf === "logo") return json({ error: "invalid_code" }, 400, origin);
      const code = parent ? parent + "/" + leaf : leaf;
      if (code.split("/").length > 6) return json({ error: "too_deep" }, 400, origin);
      const niches = await loadNiches(env);
      if (parent && !niches.includes(parent)) return json({ error: "parent_not_found" }, 400, origin);
      if (!niches.includes(code)) {
        niches.push(code);
        await saveNiches(env, niches);
      }
      return json({ niches }, 201, origin);
    }

    if (url.pathname === "/niches/move" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const from = normFolderPath(body.path);
      const parent = body.parent ? normFolderPath(body.parent) : "";
      if (!from || from === "logo" || parent === "logo") return json({ error: "invalid_folder" }, 400, origin);
      if (parent === from || parent.startsWith(from + "/")) return json({ error: "invalid_target" }, 400, origin);
      const leaf = from.split("/").pop();
      const to = parent ? parent + "/" + leaf : leaf;
      const items = await loadLibrary(env);
      const niches = await loadNiches(env);
      if (to === from) return json({ niches, items }, 200, origin);
      if (parent && !niches.includes(parent)) return json({ error: "parent_not_found" }, 400, origin);
      const under = (c, root) => c === root || c.startsWith(root + "/");
      if (niches.some((n) => under(n, to)) || items.some((i) => under(libItemCategory(i), to))) {
        return json({ error: "name_conflict" }, 409, origin);
      }
      const remap = (c) => (c === from ? to : c.startsWith(from + "/") ? to + c.slice(from.length) : c);
      const nextNiches = niches.map(remap);
      let deepest = 0;
      nextNiches.forEach((n) => { deepest = Math.max(deepest, n.split("/").length); });
      items.forEach((i) => { if (under(libItemCategory(i), from)) deepest = Math.max(deepest, remap(libItemCategory(i)).split("/").length); });
      if (deepest > 6) return json({ error: "too_deep" }, 400, origin);
      items.forEach((i) => { if (under(libItemCategory(i), from)) i.category = remap(libItemCategory(i)); });
      await saveNiches(env, nextNiches);
      await saveLibrary(env, items);
      return json({ niches: nextNiches, items }, 200, origin);
    }

    if (url.pathname.match(/^\/niches\/[^/]+$/) && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const code = normFolderPath(decodeURIComponent(url.pathname.split("/")[2]));
      const items = await loadLibrary(env);
      if (items.some((i) => libItemCategory(i) === code || libItemCategory(i).startsWith(code + "/"))) {
        return json({ error: "niche_in_use" }, 409, origin);
      }
      const current = await loadNiches(env);
      if (current.some((n) => n.startsWith(code + "/"))) {
        return json({ error: "has_subfolders" }, 409, origin);
      }
      const niches = (await loadNiches(env)).filter((n) => n !== code);
      await saveNiches(env, niches);
      return json({ niches }, 200, origin);
    }

    if (url.pathname === "/library" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let form;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "invalid_form" }, 400, origin);
      }
      const file = form.get("file");
      const name = String(form.get("name") || (file && file.name) || "sem nome").slice(0, 200);
      const filename = String((file && file.name) || name).slice(0, 200);
      const rawCategory = String(form.get("category") || "").trim();
      if (!rawCategory) return json({ error: "missing_category" }, 400, origin);
      const category = normFolderPath(rawCategory);
      if (!category) return json({ error: "missing_category" }, 400, origin);
      if (!file || typeof file.arrayBuffer !== "function") {
        return json({ error: "missing_file" }, 400, origin);
      }
      const existingItems = await loadLibrary(env);
      if (existingItems.some((i) => i.name === name && libItemCategory(i) === category)) {
        return json({ error: "name_conflict_in_folder" }, 409, origin);
      }
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > 20 * 1024 * 1024) {
        return json({ error: "file_too_large", limitMb: 20 }, 400, origin);
      }
      const id = crypto.randomUUID();
      await env.COSTS_KV.put(`library-blob:${id}`, bytes);
      const items = existingItems;
      const entry = {
        id,
        name,
        filename,
        category,
        contentType: file.type || "application/octet-stream",
        size: bytes.byteLength,
        uploadedAt: new Date().toISOString(),
      };
      items.push(entry);
      await saveLibrary(env, items);
      return json({ items }, 201, origin);
    }

    if (url.pathname.match(/^\/library\/[^/]+\/file$/) && request.method === "GET") {
      const id = url.pathname.split("/")[2];
      const items = await loadLibrary(env);
      const meta = items.find((i) => i.id === id);
      const bytes = await env.COSTS_KV.get(`library-blob:${id}`, { type: "arrayBuffer" });
      if (!bytes || !meta) return json({ error: "not_found" }, 404, origin);
      return new Response(bytes, {
        status: 200,
        headers: { "Content-Type": meta.contentType, "Cache-Control": "public, max-age=86400", ...corsHeaders(origin) },
      });
    }

    if (url.pathname === "/library/rename" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const renames = Array.isArray(body.renames) ? body.renames : [];
      if (!renames.length || renames.length > 500) return json({ error: "invalid_renames" }, 400, origin);
      const items = await loadLibrary(env);
      const byId = new Map(items.map((i) => [i.id, i]));
      const next = new Map();
      for (const r of renames) {
        const name = String((r && r.name) || "").trim().slice(0, 200);
        if (!r || !byId.has(r.id) || !name) return json({ error: "invalid_renames" }, 400, origin);
        next.set(r.id, name);
      }
      // Validate the final state: names must stay unique inside each folder.
      const seen = new Set();
      for (const i of items) {
        const finalName = next.has(i.id) ? next.get(i.id) : i.name;
        const k = libItemCategory(i) + "\u0000" + finalName;
        if (seen.has(k)) return json({ error: "name_conflict_in_folder", name: finalName }, 409, origin);
        seen.add(k);
      }
      items.forEach((i) => { if (next.has(i.id)) i.name = next.get(i.id); });
      await saveLibrary(env, items);
      return json({ items }, 200, origin);
    }

    if (url.pathname.match(/^\/library\/[^/]+\/category$/) && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = url.pathname.split("/")[2];
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const rawCategory = String(body.category || "").trim();
      if (!rawCategory) return json({ error: "missing_category" }, 400, origin);
      const category = normFolderPath(rawCategory);
      if (!category) return json({ error: "missing_category" }, 400, origin);
      const items = await loadLibrary(env);
      const item = items.find((i) => i.id === id);
      if (!item) return json({ error: "not_found" }, 404, origin);
      if (items.some((i) => i.id !== id && i.name === item.name && libItemCategory(i) === category)) {
        return json({ error: "name_conflict_in_folder" }, 409, origin);
      }
      item.category = category;
      await saveLibrary(env, items);
      return json({ items }, 200, origin);
    }

    if (url.pathname.startsWith("/library/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = url.pathname.split("/")[2];
      if (!id) return json({ error: "missing_id" }, 400, origin);
      const items = await loadLibrary(env);
      const next = items.filter((i) => i.id !== id);
      await saveLibrary(env, next);
      await env.COSTS_KV.delete(`library-blob:${id}`);
      return json({ items: next }, 200, origin);
    }

    if (url.pathname === "/nb/ad-accounts" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const accountKey = url.searchParams.get("accountKey");
      try {
        const custom = await loadCustomAccounts(env);
        const manual = custom[accountKey] && custom[accountKey].manualAccounts;
        if (manual && manual.length) {
          return json({ accounts: manual }, 200, origin);
        }
        const token = await tokenForAccountKey(env, accountKey);
        const orgIdOverride = custom[accountKey] && custom[accountKey].orgId;
        const accounts = await nbGetAdAccountsForToken(token, accountKey, orgIdOverride);
        return json({ accounts }, 200, origin);
      } catch (e) {
        return json({ error: "nb_ad_accounts_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/tracking-id" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const accountKey = url.searchParams.get("accountKey");
      const adAccountId = url.searchParams.get("adAccountId");
      try {
        const token = await tokenForAccountKey(env, accountKey);
        const trackingId = await nbFindTrackingId(token, adAccountId);
        return json({ trackingId }, 200, origin);
      } catch (e) {
        return json({ error: "nb_tracking_id_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/links" && request.method === "GET") {
      const links = await loadLinks(env);
      return json({ links }, 200, origin);
    }

    if (url.pathname === "/links" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { adAccountId, accountKey, accountName, url: linkUrl } = body || {};
      if (!adAccountId || !linkUrl) return json({ error: "invalid_fields" }, 400, origin);
      const links = await loadLinks(env);
      links[adAccountId] = { accountKey, accountName, url: linkUrl, updatedAt: new Date().toISOString() };
      await saveLinks(env, links);
      return json({ links }, 200, origin);
    }

    if (url.pathname.startsWith("/links/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const adAccountId = decodeURIComponent(url.pathname.split("/")[2] || "");
      if (!adAccountId) return json({ error: "missing_id" }, 400, origin);
      const links = await loadLinks(env);
      delete links[adAccountId];
      await saveLinks(env, links);
      return json({ links }, 200, origin);
    }

    if (url.pathname === "/copy-presets" && request.method === "GET") {
      const items = await loadCopyPresets(env);
      return json({ items }, 200, origin);
    }

    if (url.pathname === "/cc-settings" && request.method === "GET") {
      const settings = await loadCcSettings(env);
      return json({ settings }, 200, origin);
    }

    if (url.pathname === "/cc-settings" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const settings = {
        brandName: String(body.brandName || "").slice(0, 100),
        logoLibraryId: body.logoLibraryId || null,
      };
      await saveCcSettings(env, settings);
      return json({ settings }, 200, origin);
    }

    if (url.pathname === "/niche-presets" && request.method === "GET") {
      const presets = await loadNichePresets(env);
      return json({ presets }, 200, origin);
    }

    if (url.pathname === "/niche-presets" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const niche = normFolderPath(body.niche);
      if (!niche || niche === "logo" || niche.includes("/")) return json({ error: "invalid_niche" }, 400, origin);
      const preset = body.preset;
      if (!preset || typeof preset !== "object" || JSON.stringify(preset).length > 8000) return json({ error: "invalid_preset" }, 400, origin);
      const presets = await loadNichePresets(env);
      presets[niche] = { ...preset, updatedAt: new Date().toISOString() };
      await saveNichePresets(env, presets);
      return json({ presets }, 200, origin);
    }

    if (url.pathname.startsWith("/niche-presets/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const niche = normFolderPath(decodeURIComponent(url.pathname.split("/")[2] || ""));
      const presets = await loadNichePresets(env);
      delete presets[niche];
      await saveNichePresets(env, presets);
      return json({ presets }, 200, origin);
    }

    if (url.pathname === "/brand-presets" && request.method === "GET") {
      const items = await loadBrandPresets(env);
      return json({ items }, 200, origin);
    }

    if (url.pathname === "/brand-presets" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { brandName, logoLibraryId, logoLabel } = body || {};
      if (!brandName || !logoLibraryId) return json({ error: "invalid_fields" }, 400, origin);
      const items = await loadBrandPresets(env);
      const entry = {
        id: crypto.randomUUID(),
        brandName: String(brandName).slice(0, 100),
        logoLibraryId: String(logoLibraryId),
        logoLabel: String(logoLabel || "").slice(0, 100),
        createdAt: new Date().toISOString(),
      };
      items.push(entry);
      await saveBrandPresets(env, items);
      return json({ items }, 201, origin);
    }

    if (url.pathname.startsWith("/brand-presets/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = url.pathname.split("/")[2];
      if (!id) return json({ error: "missing_id" }, 400, origin);
      const items = await loadBrandPresets(env);
      const next = items.filter((i) => i.id !== id);
      await saveBrandPresets(env, next);
      return json({ items: next }, 200, origin);
    }

    if (url.pathname === "/account-settings" && request.method === "GET") {
      const settings = await loadAccountSettings(env);
      return json({ settings }, 200, origin);
    }

    if (url.pathname === "/account-settings" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      if (!body.key || typeof body.active !== "boolean") return json({ error: "invalid_fields" }, 400, origin);
      const settings = await loadAccountSettings(env);
      const prev = settings[body.key];
      if (body.active) settings[body.key] = { active: true };
      else if (prev && prev.active === false) settings[body.key] = prev.since ? { active: false, since: prev.since } : { active: false };
      else settings[body.key] = { active: false, since: todayKeySaoPaulo() };
      await saveAccountSettings(env, settings);
      await env.COSTS_KV.delete("live_campanhas");
      await env.COSTS_KV.delete("live_painel");
      return json({ settings }, 200, origin);
    }

    if (url.pathname === "/accounts" && request.method === "GET") {
      const custom = await loadCustomAccounts(env);
      const accounts = Object.keys(custom).map((k) => ({ key: k, label: custom[k].label, createOnly: !!custom[k].createOnly }));
      return json({ accounts }, 200, origin);
    }

    if (url.pathname === "/accounts" && request.method === "POST") {
      const authKey = request.headers.get("X-Access-Key");
      if (authKey !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const label = String(body.label || "").trim().slice(0, 60);
      const token = String(body.token || "").trim();
      const orgId = String(body.orgId || "").trim() || null;
      if (!label) return json({ error: "missing_label" }, 400, origin);
      if (!token) return json({ error: "missing_token" }, 400, origin);
      let slug = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "conta";
      const custom = await loadCustomAccounts(env);
      let finalKey = slug;
      let n = 2;
      while (NB_TOKEN_ENV[finalKey] || custom[finalKey]) { finalKey = `${slug}-${n}`; n++; }
      custom[finalKey] = { label, token, orgId };
      await saveCustomAccounts(env, custom);
      const accounts = Object.keys(custom).map((k) => ({ key: k, label: custom[k].label }));
      return json({ accounts, key: finalKey }, 201, origin);
    }

    if (url.pathname.match(/^\/accounts\/[^/]+\/create-only$/) && request.method === "POST") {
      const authKey = request.headers.get("X-Access-Key");
      if (authKey !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const accKey = decodeURIComponent(url.pathname.split("/")[2]);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const custom = await loadCustomAccounts(env);
      if (!custom[accKey]) return json({ error: "not_found" }, 404, origin);
      custom[accKey].createOnly = body.createOnly === true;
      await saveCustomAccounts(env, custom);
      await env.COSTS_KV.delete("live_painel");
      await env.COSTS_KV.delete("live_campanhas");
      return json({ ok: true, createOnly: custom[accKey].createOnly }, 200, origin);
    }

    if (url.pathname.match(/^\/accounts\/[^/]+\/org-id$/) && request.method === "POST") {
      const authKey = request.headers.get("X-Access-Key");
      if (authKey !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const accKey = decodeURIComponent(url.pathname.split("/")[2]);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const orgId = String(body.orgId || "").trim();
      if (!orgId) return json({ error: "missing_org_id" }, 400, origin);
      const custom = await loadCustomAccounts(env);
      if (!custom[accKey]) return json({ error: "not_found" }, 404, origin);
      custom[accKey].orgId = orgId;
      await saveCustomAccounts(env, custom);
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname.match(/^\/accounts\/[^/]+\/manual-accounts$/) && request.method === "POST") {
      const authKey = request.headers.get("X-Access-Key");
      if (authKey !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const accKey = decodeURIComponent(url.pathname.split("/")[2]);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      const cleaned = accounts
        .map((a) => ({ id: String(a.id || "").trim(), name: String(a.name || "").trim() }))
        .filter((a) => a.id);
      if (!cleaned.length) return json({ error: "missing_accounts" }, 400, origin);
      const custom = await loadCustomAccounts(env);
      if (!custom[accKey]) return json({ error: "not_found" }, 404, origin);
      custom[accKey].manualAccounts = cleaned;
      await saveCustomAccounts(env, custom);
      return json({ ok: true, accounts: cleaned }, 200, origin);
    }

    if (url.pathname.match(/^\/accounts\/[^/]+$/) && request.method === "DELETE") {
      const authKey = request.headers.get("X-Access-Key");
      if (authKey !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const accKey = decodeURIComponent(url.pathname.split("/")[2]);
      const custom = await loadCustomAccounts(env);
      delete custom[accKey];
      await saveCustomAccounts(env, custom);
      const accounts = Object.keys(custom).map((k) => ({ key: k, label: custom[k].label }));
      return json({ accounts }, 200, origin);
    }

    if (url.pathname === "/copy-presets" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { headline, description, niche } = body || {};
      if (!headline || !description) return json({ error: "invalid_fields" }, 400, origin);
      const items = await loadCopyPresets(env);
      const entry = {
        id: crypto.randomUUID(),
        headline: String(headline).slice(0, 200),
        description: String(description).slice(0, 300),
        niche: String(niche || "").trim().toUpperCase().slice(0, 12) || null,
        createdAt: new Date().toISOString(),
      };
      items.push(entry);
      await saveCopyPresets(env, items);
      return json({ items }, 201, origin);
    }

    if (url.pathname.startsWith("/copy-presets/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = url.pathname.split("/")[2];
      if (!id) return json({ error: "missing_id" }, 400, origin);
      const items = await loadCopyPresets(env);
      const next = items.filter((i) => i.id !== id);
      await saveCopyPresets(env, next);
      return json({ items: next }, 200, origin);
    }

    if (url.pathname === "/nb/campaign" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      try {
        const token = await tokenForAccountKey(env, body.accountKey);
        const campaign = await nbCreateCampaign(token, body);
        return json({ campaign }, 201, origin);
      } catch (e) {
        return json({ error: "nb_create_campaign_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/adset" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      try {
        const token = await tokenForAccountKey(env, body.accountKey);
        const { accountKey, ...fields } = body;
        const adSet = await nbCreateAdSet(token, fields);
        return json({ adSet }, 201, origin);
      } catch (e) {
        return json({ error: "nb_create_adset_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/upload-asset" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      try {
        const token = await tokenForAccountKey(env, body.accountKey);
        const items = await loadLibrary(env);
        const meta = items.find((i) => i.id === body.libraryId);
        if (!meta) return json({ error: "library_item_not_found" }, 404, origin);
        const rawBytes = await env.COSTS_KV.get(`library-blob:${body.libraryId}`, { type: "arrayBuffer" });
        if (!rawBytes) return json({ error: "library_item_not_found" }, 404, origin);
        const bytes = stripMetadataBytes(rawBytes, meta.contentType);
        const uploaded = await nbUploadAsset(token, {
          adAccountId: body.adAccountId,
          bytes,
          filename: meta.filename || meta.name,
          contentType: meta.contentType,
          mediaName: body.mediaName || meta.name,
        });
        return json({ asset: uploaded }, 201, origin);
      } catch (e) {
        return json({ error: "nb_upload_asset_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/entity-status" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { accountKey, entityType, id, status } = body;
      if (!["campaign", "adset", "ad"].includes(entityType) || !id || !["ON", "OFF"].includes(status)) {
        return json({ error: "invalid_body" }, 400, origin);
      }
      try {
        const token = await tokenForAccountKey(env, accountKey);
        if (entityType === "campaign") await nbSetCampaignStatus(token, id, status);
        else if (entityType === "adset") await nbSetAdSetStatus(token, id, status);
        else await nbSetAdStatus(token, id, status);
        await env.COSTS_KV.delete("live_campanhas");
        return json({ ok: true }, 200, origin);
      } catch (e) {
        return json({ error: "nb_entity_status_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/adset-schedule" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { accountKey, id } = body;
      // endTime in epoch seconds; null/omitted = "no end date" (same sentinel the creation form uses)
      const endTime = body.endTime == null ? 2146878847 : Number(body.endTime);
      if (!id || !isFinite(endTime) || endTime <= 0) return json({ error: "invalid_body" }, 400, origin);
      try {
        const token = await tokenForAccountKey(env, accountKey);
        await nbApi(token, `ad-set/update/${id}`, { method: "PUT", body: JSON.stringify({ endTime }) });
        await env.COSTS_KV.delete("live_campanhas");
        return json({ ok: true, endTime }, 200, origin);
      } catch (e) {
        return json({ error: "nb_adset_schedule_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/adset-budget" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { accountKey, id } = body;
      const cents = Math.round(Number(body.budget) * 100);
      if (!id || !isFinite(cents) || cents <= 0) return json({ error: "invalid_body" }, 400, origin);
      try {
        const token = await tokenForAccountKey(env, accountKey);
        await nbSetAdSetBudget(token, id, cents, body.budgetType);
        await env.COSTS_KV.delete("live_campanhas");
        return json({ ok: true }, 200, origin);
      } catch (e) {
        return json({ error: "nb_adset_budget_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/ad-update" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { accountKey, id, fields } = body;
      if (!id || !fields || typeof fields !== "object") return json({ error: "invalid_body" }, 400, origin);
      try {
        const token = await tokenForAccountKey(env, accountKey);
        let out;
        for (let attempt = 0; ; attempt++) {
          try {
            out = await nbApi(token, `ad/update/${id}`, { method: "PUT", body: JSON.stringify(fields) });
            break;
          } catch (err) {
            if (err.nbRaw || attempt >= 2) throw err;
            await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          }
        }
        await env.COSTS_KV.delete("live_campanhas");
        return json({ ok: true, ad: out }, 200, origin);
      } catch (e) {
        return json({ error: "nb_ad_update_failed", detail: String(e.message || e), nb: e.nbRaw || null }, 502, origin);
      }
    }

    if (url.pathname === "/nb/ad" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      try {
        const token = await tokenForAccountKey(env, body.accountKey);
        const { accountKey, ...fields } = body;
        const ad = await nbCreateAd(token, fields);
        return json({ ad }, 201, origin);
      } catch (e) {
        return json({ error: "nb_create_ad_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/rank" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const days = url.searchParams.get("days") || "30";
      if (!RK_RANGES[days]) return json({ error: "invalid_days" }, 400, origin);
      try {
        const data = await getCached(env, "rank:" + days, 45, () => computeRank(env, days));
        return json({ ...data, backfilled: !!(await env.COSTS_KV.get("rk_backfilled")) }, 200, origin);
      } catch (e) {
        return json({ error: "rank_failed", detail: String((e && e.message) || e) }, 502, origin);
      }
    }

    if (url.pathname === "/rank/backfill" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      try {
        const diag = await rkRefresh(env, { backfill: true });
        for (const k of ["7", "30", "all"]) await env.COSTS_KV.delete("rank:" + k);
        return json(diag, 200, origin);
      } catch (e) {
        return json({ error: "rank_backfill_failed", detail: String((e && e.message) || e) }, 502, origin);
      }
    }

    if (url.pathname === "/rank/default-niche" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const niche = String(body.niche || "").trim().toUpperCase();
      if (niche) {
        const codes = await rkNicheCodes(env);
        if (!codes.has(niche)) return json({ error: "unknown_niche" }, 400, origin);
        await env.COSTS_KV.put("rk_default_niche", niche);
      } else await env.COSTS_KV.delete("rk_default_niche");
      for (const k of ["7", "30", "all"]) await env.COSTS_KV.delete("rank:" + k);
      return json({ ok: true, niche }, 200, origin);
    }

    if (url.pathname === "/rank/niche" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const ids = Array.isArray(body.campaignIds) ? body.campaignIds.map(String).filter(Boolean).slice(0, 500) : [];
      const niche = String(body.niche || "").trim().toUpperCase();
      if (!ids.length) return json({ error: "no_campaigns" }, 400, origin);
      if (niche) {
        const codes = await rkNicheCodes(env);
        if (!codes.has(niche)) return json({ error: "unknown_niche" }, 400, origin);
      }
      const map = await rkLoadNicheMap(env);
      for (const id of ids) { if (niche) map[id] = niche; else delete map[id]; }
      await env.COSTS_KV.put("rk_niche_map", JSON.stringify(map));
      for (const k of ["7", "30", "all"]) await env.COSTS_KV.delete("rank:" + k);
      return json({ ok: true, count: ids.length }, 200, origin);
    }

    if (url.pathname === "/metrics" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const range = url.searchParams.get("range") || "TODAY";
      if (METRIC_RANGES.indexOf(range) === -1) return json({ error: "invalid_range" }, 400, origin);
      try {
        const data = await getCached(env, "metrics:" + range, range === "TODAY" ? 15 : 60, () => computeMetricsByLevel(env, range));
        return json(data, 200, origin);
      } catch (e) {
        return json({ error: "metrics_failed", detail: String((e && e.message) || e) }, 502, origin);
      }
    }

    if (url.pathname === "/nb/entity-delete" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const { accountKey, entityType, id } = body;
      const path = { campaign: "campaign/delete/", adset: "ad-set/delete/", ad: "ad/delete/" }[entityType];
      if (!path || !id || !/^\d+$/.test(String(id)) || body.confirm !== true) return json({ error: "invalid_body" }, 400, origin);
      try {
        const token = await tokenForAccountKey(env, accountKey);
        await nbApi(token, path + id, { method: "DELETE" });
        await env.COSTS_KV.delete("live_campanhas");
        return json({ ok: true }, 200, origin);
      } catch (e) {
        return json({ error: "nb_entity_delete_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/rules" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const rules = await loadRules(env);
      const logRaw = await env.COSTS_KV.get("rules_log");
      const hb = await env.COSTS_KV.get("cron_heartbeat");
      return json({ rules, log: (logRaw ? JSON.parse(logRaw) : []).slice(0, 100), engineOn: (await env.COSTS_KV.get("rules_engine_on")) === "1", heartbeat: hb ? JSON.parse(hb) : null }, 200, origin);
    }

    if (url.pathname === "/rules" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const rules = await loadRules(env);
      const idx = body && body.id ? rules.findIndex((r) => r.id === body.id) : -1;
      const cleaned = cleanRule(body || {}, idx >= 0 ? rules[idx].id : null);
      if (cleaned.error) return json({ error: cleaned.error }, 400, origin);
      if (idx >= 0) rules[idx] = cleaned.rule; else rules.push(cleaned.rule);
      if (rules.length > 100) return json({ error: "too_many_rules" }, 400, origin);
      await saveRules(env, rules);
      return json({ rules }, 200, origin);
    }

    if (url.pathname.startsWith("/rules/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = decodeURIComponent(url.pathname.split("/")[2] || "");
      const rules = (await loadRules(env)).filter((r) => r.id !== id);
      await saveRules(env, rules);
      return json({ rules }, 200, origin);
    }

    if (url.pathname === "/rules/engine" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      await env.COSTS_KV.put("rules_engine_on", body && body.on ? "1" : "0");
      return json({ engineOn: !!(body && body.on) }, 200, origin);
    }

    if (url.pathname === "/rules/preview" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      try {
        const data = await getCached(env, "live_campanhas", 10, () => computeLiveCampanhas(env));
        const lifeErrors = [];
        const life = await fetchLifetimeAdsetMetrics(env, lifeErrors);
        const rules = await loadRules(env);
        const stateRaw = await env.COSTS_KV.get("rules_state");
        const { plan, evaluated } = planRules(data, life, rules, stateRaw ? JSON.parse(stateRaw) : {});
        const near = [];
        for (const c of data.campaigns || []) {
          if (c.status !== "ON" || !life[c.accountKey]) continue;
          for (const s of c.adSets || []) {
            if (s.status !== "ON") continue;
            const mt = life[c.accountKey][s.id] || { cost: 0, ic: 0, venda: 0 };
            if (mt.cost > 0) near.push({ account: c.adAccountName, campaign: c.name, adset: s.name, cost: mt.cost, ic: mt.ic, sales: mt.venda, budget: s.budget });
          }
        }
        near.sort((a, b) => b.cost - a.cost);
        return json({
          lifeAccounts: Object.keys(life), lifeErrors,
          evaluated,
          wouldDo: plan.map((p) => ({ rule: p.rule.name, action: p.kind, account: p.accountLabel, campaign: p.campaign, adset: p.adset, metrics: p.metrics, budget: p.budget })),
          activeAdsets: near.slice(0, 40),
        }, 200, origin);
      } catch (e) {
        return json({ error: "preview_failed", detail: String((e && e.message) || e) }, 502, origin);
      }
    }

    if (url.pathname === "/integrations" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const saved = await loadIntegrations(env);
      return json({ integrations: INTEGRATIONS.map((i) => ({
        key: i.key, label: i.label, hint: i.hint,
        source: saved[i.key] && saved[i.key].value ? "app" : (env[i.key] ? "server" : null),
        tail: saved[i.key] && saved[i.key].value ? String(saved[i.key].value).slice(-4) : null,
        updatedAt: saved[i.key] ? saved[i.key].updatedAt : null,
      })) }, 200, origin);
    }

    if (url.pathname === "/integrations" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const spec = INTEGRATIONS.find((i) => i.key === (body && body.key));
      const value = String((body && body.value) || "").trim();
      if (!spec) return json({ error: "unknown_integration" }, 400, origin);
      if (value.length < 8 || value.length > 400 || /\s/.test(value)) return json({ error: "value_invalid" }, 400, origin);
      const saved = await loadIntegrations(env);
      saved[spec.key] = { value, updatedAt: Date.now() };
      await env.COSTS_KV.put("integrations", JSON.stringify(saved));
      await env.COSTS_KV.delete("live_painel");
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname.startsWith("/integrations/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const k = decodeURIComponent(url.pathname.split("/")[2] || "");
      const saved = await loadIntegrations(env);
      delete saved[k];
      await env.COSTS_KV.put("integrations", JSON.stringify(saved));
      await env.COSTS_KV.delete("live_painel");
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === "/taboola/status" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const conns = (await loadConnections(env)).taboola || [];
      if (!conns.length) return json({ configured: false, connections: [] }, 200, origin);
      const data = await getCached(env, "taboola_status", 300, async () => {
        const out = [];
        for (const c of conns) {
          try { out.push({ id: c.id, name: c.name, ok: true, accounts: await taboolaAccounts(env, c) }); }
          catch (err) { const m = String((err && err.message) || err); const st = (m.match(/-> (\d{3})/) || [])[1]; out.push({ id: c.id, name: c.name, ok: false, status: st ? Number(st) : null, accounts: [] }); }
        }
        return out;
      });
      const okAny = data.some((c) => c.ok);
      return json({ configured: true, ok: okAny, status: okAny ? null : (data[0] && data[0].status) || null, accounts: data.flatMap((c) => c.accounts), connections: data }, 200, origin);
    }

    if (url.pathname.startsWith("/taboola/") && request.method === "GET" && ["overview", "sites", "items"].includes(url.pathname.split("/")[2])) {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const kind = url.pathname.split("/")[2];
      const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
      const acct = url.searchParams.get("account") || "", camp = url.searchParams.get("campaign") || "";
      if (!TB_DATE.test(from) || !TB_DATE.test(to) || from > to) return json({ error: "bad_dates" }, 400, origin);
      if (!/^[A-Za-z0-9_\-]{0,120}$/.test(acct) || !/^[A-Za-z0-9_\-]{0,40}$/.test(camp)) return json({ error: "bad_params" }, 400, origin);
      if (kind === "items" && (!acct || !camp)) return json({ error: "need_account_and_campaign" }, 400, origin);
      if (!((await loadConnections(env)).taboola || []).length) return json({ error: "taboola_not_configured" }, 200, origin);
      const ttl = to >= todayKeySaoPaulo() ? 20 : 300;
      try {
        const data = await getCached(env, `tb_${kind}:${from}:${to}:${acct}:${camp}`, ttl, () => kind === "overview" ? computeTaboolaOverview(env, from, to) : kind === "sites" ? computeTaboolaSites(env, from, to, acct, camp) : computeTaboolaItems(env, from, to, acct, camp));
        return json(data, 200, origin);
      } catch (err) { return json({ error: "taboola_failed", detail: String((err && err.message) || err).slice(0, 200) }, 502, origin); }
    }

    if (url.pathname.startsWith("/taboola/rules") && ["GET", "POST", "DELETE"].includes(request.method)) {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const sub = url.pathname.split("/")[3] || "";
      if (request.method === "GET" && !sub) {
        const logRaw = await env.COSTS_KV.get("taboola_rules_log");
        const braw = await env.COSTS_KV.get("taboola_blocked");
        const blocked = braw ? JSON.parse(braw) : {};
        const rules = (await tbrLoadRules(env)).map((r) => { const l = blocked[r.id] || []; return r.type === "block_pattern" ? { ...r, blockedCount: l.filter((x) => !x.simulated).length, simCount: l.filter((x) => x.simulated).length } : r; });
        return json({ rules, mode: await tbrMode(env), log: (logRaw ? JSON.parse(logRaw) : []).slice(0, 100) }, 200, origin);
      }
      if (request.method === "GET" && sub && url.pathname.split("/")[4] === "blocked") {
        const braw = await env.COSTS_KV.get("taboola_blocked");
        const list = (braw ? JSON.parse(braw) : {})[decodeURIComponent(sub)] || [];
        return json({ sites: list.sort((a, b) => b.at - a.at) }, 200, origin);
      }
      if (request.method === "POST" && sub && url.pathname.split("/")[4] === "run") {
        try { return json(await runTaboolaRules(env, { onlyRuleId: decodeURIComponent(sub) }), 200, origin); }
        catch (e) { return json({ error: "run_failed", detail: String((e && e.message) || e).slice(0, 200) }, 502, origin); }
      }
      if (request.method === "POST" && sub === "mode") {
        let body; try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
        const m = body && body.mode;
        if (!["off", "notify", "on"].includes(m)) return json({ error: "mode_invalid" }, 400, origin);
        await env.COSTS_KV.put("taboola_engine_mode", m);
        return json({ mode: m }, 200, origin);
      }
      if (request.method === "POST" && sub === "preview") {
        try {
          const rules = await tbrLoadRules(env);
          const { plan, evaluated } = await planTaboolaRules(env, rules, {}, true);
          return json({ evaluated, mode: await tbrMode(env), wouldDo: plan.map((p) => ({ rule: p.rule.name, action: p.kind, account: p.accountName, campaign: p.campaign || null, site: p.site, metrics: p.metrics })) }, 200, origin);
        } catch (e) { return json({ error: "preview_failed", detail: String((e && e.message) || e).slice(0, 200) }, 502, origin); }
      }
      if (request.method === "POST" && !sub) {
        let body; try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
        const rules = await tbrLoadRules(env);
        const idx = body && body.id ? rules.findIndex((r) => r.id === body.id) : -1;
        const cleaned = tbrClean(body || {}, idx >= 0 ? rules[idx].id : null);
        if (cleaned.error) return json({ error: cleaned.error }, 400, origin);
        if (idx >= 0) rules[idx] = cleaned.rule; else rules.push(cleaned.rule);
        if (rules.length > 60) return json({ error: "too_many_rules" }, 400, origin);
        await env.COSTS_KV.put("taboola_rules", JSON.stringify(rules));
        return json({ rules }, 200, origin);
      }
      if (request.method === "DELETE" && sub) {
        const rid = decodeURIComponent(sub);
        const rules = (await tbrLoadRules(env)).filter((r) => r.id !== rid);
        await env.COSTS_KV.put("taboola_rules", JSON.stringify(rules));
        const braw = await env.COSTS_KV.get("taboola_blocked");
        if (braw) { const all = JSON.parse(braw); delete all[rid]; await env.COSTS_KV.put("taboola_blocked", JSON.stringify(all)); }
        return json({ rules }, 200, origin);
      }
      return json({ error: "not_found" }, 404, origin);
    }

    if (url.pathname === "/connections" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const all = await loadConnections(env);
      return json({ taboola: (all.taboola || []).map(publicConnection) }, 200, origin);
    }

    if (url.pathname === "/connections" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      if (!body || body.tool !== "taboola") return json({ error: "unknown_tool" }, 400, origin);
      const name = String(body.name || "").trim().slice(0, 60);
      const clientId = String(body.clientId || "").trim();
      const clientSecret = String(body.clientSecret || "").trim();
      const accountId = String(body.accountId || "").trim();
      if (!name) return json({ error: "name_required" }, 400, origin);
      if (accountId.length < 3 || accountId.length > 120 || /\s/.test(accountId) || clientId.length < 6 || clientId.length > 200 || /\s/.test(clientId) || clientSecret.length < 8 || clientSecret.length > 400 || /\s/.test(clientSecret)) return json({ error: "value_invalid" }, 400, origin);
      const all = await loadConnections(env);
      const list = all.taboola || [];
      if (list.length >= 20) return json({ error: "too_many" }, 400, origin);
      const conn = { id: crypto.randomUUID(), name, clientId, clientSecret, accountId, createdAt: Date.now() };
      list.push(conn);
      all.taboola = list;
      await saveConnections(env, all);
      return json({ ok: true, connection: publicConnection(conn) }, 200, origin);
    }

    if (url.pathname === "/connections/test" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const conn = ((await loadConnections(env)).taboola || []).find((c) => c.id === (body && body.id));
      if (!conn) return json({ ok: false, error: "not_found" }, 200, origin);
      try {
        await taboolaToken(env, conn, true);
        const accs = await taboolaAccounts(env, conn);
        await env.COSTS_KV.delete("taboola_status");
        const accountFound = !conn.accountId || accs.some((a) => String(a.id).toLowerCase() === String(conn.accountId).toLowerCase());
        return json({ ok: true, accountFound, detail: accs.length + " conta(s): " + accs.slice(0, 4).map((a) => a.name).join(", ") + (accs.length > 4 ? "…" : "") }, 200, origin);
      } catch (err) {
        const m = String((err && err.message) || err); const st = (m.match(/-> (\d{3})/) || [])[1];
        return json({ ok: false, status: st ? Number(st) : null }, 200, origin);
      }
    }

    if (url.pathname.startsWith("/connections/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = decodeURIComponent(url.pathname.split("/")[2] || "");
      const all = await loadConnections(env);
      all.taboola = (all.taboola || []).filter((c) => c.id !== id);
      await saveConnections(env, all);
      await env.COSTS_KV.delete(`taboola_token:${id}`);
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === "/integrations/test" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const e = await keyedEnv(env);
      try {
        if (body.key === "VTURB_API_TOKEN") {
          if (!e.VTURB_API_TOKEN) return json({ ok: false, error: "not_configured" }, 200, origin);
          await vturbStats(e);
        } else if (body.key === "REDTRACK_API_KEY") {
          if (!e.REDTRACK_API_KEY) return json({ ok: false, error: "not_configured" }, 200, origin);
          const t = todayKeySaoPaulo();
          await rtFetchReport(e, t, t);
        } else return json({ error: "unknown_integration" }, 400, origin);
        return json({ ok: true }, 200, origin);
      } catch (err) {
        const m = String((err && err.message) || err);
        const st = (m.match(/-> (\d{3})/) || [])[1];
        return json({ ok: false, status: st ? Number(st) : null }, 200, origin);
      }
    }

    if (url.pathname === "/push/recipients" && request.method === "GET") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const recs = await loadRecipients(env);
      return json({ serverDefault: !!env.PUSHCUT_URL, recipients: recs.map((r) => ({ id: r.id, name: r.name, urlMasked: maskPushUrl(r.url), enabled: r.enabled !== false, types: { rejections: (r.types || {}).rejections !== false, rules: (r.types || {}).rules !== false }, createdAt: r.createdAt })) }, 200, origin);
    }

    if (url.pathname === "/push/recipients" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const recs = await loadRecipients(env);
      const idx = body && body.id ? recs.findIndex((r) => r.id === body.id) : -1;
      const name = String((body && body.name) || "").trim().slice(0, 60);
      if (!name) return json({ error: "name_required" }, 400, origin);
      const types = {};
      for (const t of PUSH_TYPES) types[t] = !(body.types && body.types[t] === false);
      if (idx >= 0) {
        if (body.url) { if (!validPushUrl(body.url)) return json({ error: "url_invalid" }, 400, origin); recs[idx].url = String(body.url).trim(); }
        recs[idx].name = name; recs[idx].types = types; if (body.enabled !== undefined) recs[idx].enabled = body.enabled !== false;
      } else {
        if (!validPushUrl(body.url)) return json({ error: "url_invalid" }, 400, origin);
        if (recs.length >= 20) return json({ error: "too_many" }, 400, origin);
        recs.push({ id: crypto.randomUUID(), name, url: String(body.url).trim(), enabled: true, types, createdAt: Date.now() });
      }
      await env.COSTS_KV.put("push_recipients", JSON.stringify(recs));
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname.startsWith("/push/recipients/") && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = decodeURIComponent(url.pathname.split("/")[3] || "");
      const recs = (await loadRecipients(env)).filter((r) => r.id !== id);
      await env.COSTS_KV.put("push_recipients", JSON.stringify(recs));
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === "/push/test" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const r = await sendPush(env, "Teste do aviso", "Se você viu isso, o aviso do RASTRO está funcionando.", "test", String((body && body.id) || "default"));
      return json(r, 200, origin);
    }

    if (url.pathname === "/push-test" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const r = await sendPush(env, "Teste do aviso", "Se você viu isso, o aviso de anúncio recusado está funcionando.");
      return json(r, 200, origin);
    }

    if (url.pathname === "/sync-now" && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const result = await triggerSync(env);
      return json(result, result.ok ? 200 : 429, origin);
    }

    if (url.pathname.startsWith("/topups")) {
      if (request.method === "GET") {
        const topups = await loadTopups(env);
        return json({ topups }, 200, origin);
      }
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);

      if (request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid_json" }, 400, origin);
        }
        const { accountId, accountName, date, amount } = body || {};
        if (!accountId || !date || typeof amount !== "number" || !isFinite(amount)) {
          return json({ error: "invalid_fields" }, 400, origin);
        }
        const topups = await loadTopups(env);
        const entry = {
          id: crypto.randomUUID(),
          accountId: String(accountId),
          accountName: String(accountName || accountId).slice(0, 200),
          date,
          amount,
        };
        topups.push(entry);
        await saveTopups(env, topups);
        return json({ topups }, 201, origin);
      }

      if (request.method === "DELETE") {
        const id = url.pathname.split("/")[2];
        if (!id) return json({ error: "missing_id" }, 400, origin);
        const topups = await loadTopups(env);
        const next = topups.filter((t) => t.id !== id);
        await saveTopups(env, next);
        return json({ topups: next }, 200, origin);
      }

      return json({ error: "method_not_allowed" }, 405, origin);
    }

    if (!url.pathname.startsWith("/costs")) {
      return json({ error: "not_found" }, 404, origin);
    }

    if (request.method === "GET") {
      const costs = await loadCosts(env);
      return json({ costs }, 200, origin);
    }

    const key = request.headers.get("X-Access-Key");
    if (key !== env.ACCESS_KEY) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400, origin);
      }
      const { date, name, value, paidBy } = body || {};
      if (!date || !name || typeof value !== "number" || !isFinite(value)) {
        return json({ error: "invalid_fields" }, 400, origin);
      }
      const costs = await loadCosts(env);
      const entry = { id: crypto.randomUUID(), date, name: String(name).slice(0, 200), value, paidBy: String(paidBy || "").slice(0, 200) };
      costs.push(entry);
      await saveCosts(env, costs);
      return json({ costs }, 201, origin);
    }

    if (request.method === "DELETE") {
      const id = url.pathname.split("/")[2];
      if (!id) return json({ error: "missing_id" }, 400, origin);
      const costs = await loadCosts(env);
      const next = costs.filter((c) => c.id !== id);
      await saveCosts(env, next);
      return json({ costs: next }, 200, origin);
    }

    return json({ error: "method_not_allowed" }, 405, origin);
  },
};

