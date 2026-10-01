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
async function getAllTokens(env) {
  const entries = Object.entries(NB_TOKEN_ENV)
    .map(([key, envVar]) => [key, env[envVar]])
    .filter(([, token]) => !!token);
  const custom = await loadCustomAccounts(env);
  for (const [key, meta] of Object.entries(custom)) {
    if (meta && meta.token) entries.push([key, meta.token]);
  }
  return entries;
}

async function nbFetchReport(token, dateRange, dimensions) {
  const resp = await fetch(`${NB_BASE}/reports/getIntegratedReport`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Access-Token": token },
    body: JSON.stringify({
      name: "live worker",
      timezone: "America/Sao_Paulo",
      dateRange,
      dimensions: dimensions || ["DATE"],
      metrics: ["COST", "CLICK", "CPC"],
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
  return { todayCost: m.cost, todayClick: m.click, todayVenda: m.venda, todayCpa: m.cpa };
}

async function nbBuildCampaignsForAccount(token, accountKey, adAccountId, adAccountName, campaignMetrics, adsetMetrics) {
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
        ads: myAds.map((ad) => ({ id: ad.id, name: ad.name, status: ad.status, onlineStatus: ad.onlineStatus })),
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
  const tokenEntries = await getAllTokens(env);
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
  const tokenEntries = await getAllTokens(env);
  const custom = await loadCustomAccounts(env);
  const perAccount = await Promise.all(
    tokenEntries.map(async ([key, token]) => {
      try {
        const manual = custom[key] && custom[key].manualAccounts;
        const [adAccounts, campaignRows, adsetRows] = await Promise.all([
          manual && manual.length
            ? Object.fromEntries(manual.map((a) => [a.id, a.name]))
            : nbGetAdAccounts(token),
          nbFetchReport(token, "TODAY", ["CAMPAIGN"]).catch(() => []),
          nbFetchReport(token, "TODAY", ["AD_SET"]).catch(() => []),
        ]);
        const campaignMetrics = {};
        for (const r of campaignRows) campaignMetrics[r.campaignId] = nbRowToDoc(r);
        const adsetMetrics = {};
        for (const r of adsetRows) adsetMetrics[r.adSetId] = nbRowToDoc(r);
        const perAdAccount = await Promise.all(
          Object.entries(adAccounts).map(([adAccountId, adAccountName]) =>
            nbBuildCampaignsForAccount(token, key, adAccountId, adAccountName, campaignMetrics, adsetMetrics)
          )
        );
        return perAdAccount.flat();
      } catch (e) {
        failedAccounts.push(key);
        return [];
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
    throw e;
  }
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

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (url.pathname === "/vturb/stats" && request.method === "GET") {
      try {
        const stats = await vturbStats(env);
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
        const data = await getCached(env, `vendas_estado:${dateFrom}:${dateTo}`, 600, () => computeVendasPorEstado(env, dateFrom, dateTo));
        return json(data, 200, origin);
      } catch (e) {
        return json({ error: "vendas_estado_failed", detail: String(e.message || e) }, 502, origin);
      }
    }

    if (url.pathname === "/live/painel" && request.method === "GET") {
      try {
        const data = await getCached(env, "live_painel", 20, () => computeLivePainel(env));
        return json(data, 200, origin);
      } catch (e) {
        return json({ error: "live_painel_failed" }, 502, origin);
      }
    }

    if (url.pathname === "/live/campanhas" && request.method === "GET") {
      try {
        const data = await getCached(env, "live_campanhas", 25, () => computeLiveCampanhas(env));
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
      const code = String(body.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
      if (!code) return json({ error: "invalid_code" }, 400, origin);
      const niches = await loadNiches(env);
      if (!niches.includes(code)) {
        niches.push(code);
        await saveNiches(env, niches);
      }
      return json({ niches }, 201, origin);
    }

    if (url.pathname.match(/^\/niches\/[^/]+$/) && request.method === "DELETE") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const code = decodeURIComponent(url.pathname.split("/")[2]);
      const items = await loadLibrary(env);
      if (items.some((i) => i.category === code)) {
        return json({ error: "niche_in_use" }, 409, origin);
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
      const category = rawCategory === "logo" ? "logo" : rawCategory.toUpperCase().slice(0, 12);
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

    if (url.pathname.match(/^\/library\/[^/]+\/category$/) && request.method === "POST") {
      const key = request.headers.get("X-Access-Key");
      if (key !== env.ACCESS_KEY) return json({ error: "unauthorized" }, 401, origin);
      const id = url.pathname.split("/")[2];
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400, origin); }
      const rawCategory = String(body.category || "").trim();
      if (!rawCategory) return json({ error: "missing_category" }, 400, origin);
      const category = rawCategory === "logo" ? "logo" : rawCategory.toUpperCase().slice(0, 12);
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
      settings[body.key] = { active: body.active };
      await saveAccountSettings(env, settings);
      return json({ settings }, 200, origin);
    }

    if (url.pathname === "/accounts" && request.method === "GET") {
      const custom = await loadCustomAccounts(env);
      const accounts = Object.keys(custom).map((k) => ({ key: k, label: custom[k].label }));
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

