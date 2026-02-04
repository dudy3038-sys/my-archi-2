/**
 * functions/index.js (FULL REPLACE)
 * Node 20 + firebase-functions v7 (v2 https)
 *
 * Endpoints used by public/script.js:
 *  - GET  /api/__env
 *  - GET  /api/calc?site&coverage&far&floor
 *  - GET  /api/geocode?q
 *  - GET  /api/reverse?lat&lon
 *  - GET  /api/zoning/by-coord?lat&lon
 *  - GET  /api/rules/zoning
 *  - GET  /api/rules/apply?zoning
 *  - GET  /api/uses
 *  - GET  /api/uses/check?zoning&use
 *  - GET  /api/checklists/enriched?... (zoning,use,jurisdiction,floors,height_m,gross_area_m2)
 *  - POST /api/checklists/judge   { context:{zoning,use,jurisdiction}, values:{...} }
 *  - GET  /api/laws?codes=A,B,C  | /api/laws?all=1
 *  - GET  /api/laws/:code
 */

const path = require("path");
const fs = require("fs");
const cors = require("cors");
const express = require("express");

const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");

// -------------------------
// Firebase Admin init
// -------------------------
try {
  admin.initializeApp();
} catch (e) {
  // emulator hot-reload safe
}

// -------------------------
// Env flags
// -------------------------
const RULES_DIR = path.join(__dirname, "rules");
const IS_EMULATOR =
  process.env.FUNCTIONS_EMULATOR === "true" ||
  process.env.FIREBASE_EMULATOR_HUB ||
  process.env.FIRESTORE_EMULATOR_HOST;

const FIRESTORE_LAWS = String(process.env.FIRESTORE_LAWS || "").toLowerCase() === "true";

// ✅ VWorld (optional) — 좌표로 용도지역 추정
// - 키가 없으면 demo_stub으로 동작
const VWORLD_KEY = String(process.env.VWORLD_KEY || "").trim();
const VWORLD_DOMAIN = String(process.env.VWORLD_DOMAIN || "").trim(); // 선택(키 발급 시 도메인 제한이 걸려있다면)
const VWORLD_ZONING_DATA = String(process.env.VWORLD_ZONING_DATA || "LT_C_UQ126").trim(); // 기본값: 문서 예시 데이터
const VWORLD_ENDPOINT = "https://api.vworld.kr/req/data";

// -------------------------
// Express app
// -------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// -------------------------
// Simple JSON file cache
// -------------------------
const _jsonCache = new Map(); // filepath -> { mtimeMs, data }

function readJsonFileSafe(absPath, fallback = null) {
  try {
    const st = fs.statSync(absPath);
    const cached = _jsonCache.get(absPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;

    const raw = fs.readFileSync(absPath, "utf8");
    const data = JSON.parse(raw);
    _jsonCache.set(absPath, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch (e) {
    return fallback;
  }
}

function fileExists(absPath) {
  try {
    fs.accessSync(absPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// -------------------------
// Data loaders
// -------------------------
function loadChecklists() {
  const p = path.join(RULES_DIR, "checklists.json");
  return readJsonFileSafe(p, { default_conditional: [] });
}

function loadRuleEngine() {
  const p = path.join(RULES_DIR, "rule_engine.json");
  return readJsonFileSafe(p, { default_conditional: [] });
}

function loadBaseRules() {
  const p = path.join(RULES_DIR, "base_rules.json");
  return readJsonFileSafe(p, null);
}

function loadLawsFromFile() {
  const p = path.join(RULES_DIR, "laws.json");
  return readJsonFileSafe(p, {});
}

// -------------------------
// Utilities
// -------------------------
function ok(res, payload) {
  res.json({ ok: true, ...payload });
}

function bad(res, error, status = 400, extra = {}) {
  res.status(status).json({ ok: false, error: String(error || "bad_request"), ...extra });
}

function toNum(v) {
  if (v === "" || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (v === "allow") return "allow";
  if (v === "deny") return "deny";
  if (v === "conditional") return "conditional";
  if (v === "need_input") return "need_input";
  if (v === "unknown") return "unknown";
  if (v === "warn") return "conditional";
  return "unknown";
}

function isMissing(val) {
  if (val === undefined || val === null) return true;
  if (typeof val === "number") return !Number.isFinite(val);
  return String(val).trim() === "";
}

// -------------------------
// Rule engine (same semantics as public/script.js)
// -------------------------
function evalCond(cond, values) {
  if (!cond || !cond.key || !cond.op) return false;

  const op = String(cond.op).trim().toLowerCase();
  const key = String(cond.key).trim();
  const raw = values ? values[key] : undefined;

  if (op === "missing") return isMissing(raw);
  if (op === "present") return !isMissing(raw);

  if (op === "in" || op === "not_in") {
    const arr = Array.isArray(cond.value) ? cond.value : [];
    const hit = arr.map((x) => String(x)).includes(String(raw));
    return op === "in" ? hit : !hit;
  }

  const vNum = toNum(raw);
  const tNum = toNum(cond.value);

  if (op === "eq") {
    if (vNum != null && tNum != null) return vNum === tNum;
    return String(raw) === String(cond.value);
  }
  if (op === "neq") {
    if (vNum != null && tNum != null) return vNum !== tNum;
    return String(raw) !== String(cond.value);
  }

  if (vNum == null || tNum == null) return false;
  if (op === "lt") return vNum < tNum;
  if (op === "lte") return vNum <= tNum;
  if (op === "gt") return vNum > tNum;
  if (op === "gte") return vNum >= tNum;

  return false;
}

function ruleMatches(rule, values) {
  if (!rule) return false;
  if (rule.when) return evalCond(rule.when, values);

  if (Array.isArray(rule.when_all) && rule.when_all.length > 0) {
    return rule.when_all.every((c) => evalCond(c, values));
  }
  if (Array.isArray(rule.when_any) && rule.when_any.length > 0) {
    return rule.when_any.some((c) => evalCond(c, values));
  }
  return false;
}

function evaluateFirstMatch(autoRules, values) {
  const rules = Array.isArray(autoRules) ? autoRules : [];
  const sorted = rules
    .slice()
    .sort((a, b) => (toNum(b.priority) ?? 0) - (toNum(a.priority) ?? 0));

  for (const r of sorted) {
    if (!ruleMatches(r, values)) continue;
    return {
      result: normalizeStatus(r.result),
      message: String(r.message || "").trim(),
      rule_id: r.id || null,
      priority: toNum(r.priority) ?? 0,
    };
  }
  return null;
}

function indexRuleEngineById(ruleEngineJson) {
  const map = new Map();
  const arr = ruleEngineJson?.default_conditional || [];
  arr.forEach((x) => {
    if (x && x.id) map.set(String(x.id), x);
  });
  return map;
}

function buildMissingInputs(checkItem, values, optionalKeys = []) {
  const inputs = Array.isArray(checkItem?.inputs) ? checkItem.inputs : [];
  const opt = new Set((optionalKeys || []).map((k) => String(k)));

  const missing = [];
  for (const inp of inputs) {
    if (typeof inp === "string") continue;
    const key = String(inp.key || "").trim();
    if (!key) continue;
    if (opt.has(key)) continue;

    const v = values ? values[key] : undefined;
    if (isMissing(v)) {
      missing.push({
        key,
        label: String(inp.label || key),
      });
    }
  }
  return missing;
}

// -------------------------
// applies_to filter (for enriched list)
// -------------------------
function passesAppliesTo(item, ctx) {
  const a = item?.applies_to;
  if (!a) return true;

  if (Array.isArray(a.zoning_in) && a.zoning_in.length > 0) {
    if (!a.zoning_in.includes(String(ctx.zoning || ""))) return false;
  }
  if (Array.isArray(a.use_in) && a.use_in.length > 0) {
    if (!a.use_in.includes(String(ctx.use || ""))) return false;
  }
  if (Array.isArray(a.jurisdiction_in) && a.jurisdiction_in.length > 0) {
    if (!a.jurisdiction_in.includes(String(ctx.jurisdiction || ""))) return false;
  }

  const floors = toNum(ctx.floors);
  const height_m = toNum(ctx.height_m);
  const gross_area_m2 = toNum(ctx.gross_area_m2);

  if (a.min_floors != null) {
    const th = toNum(a.min_floors);
    if (th != null && (floors == null || floors < th)) return false;
  }
  if (a.min_height_m != null) {
    const th = toNum(a.min_height_m);
    if (th != null && (height_m == null || height_m < th)) return false;
  }
  if (a.min_gross_area_m2 != null) {
    const th = toNum(a.min_gross_area_m2);
    if (th != null && (gross_area_m2 == null || gross_area_m2 < th)) return false;
  }

  return true;
}

// -------------------------
// Laws: Firestore or file fallback
// -------------------------
async function firestoreAvailable() {
  try {
    admin.firestore();
    return true;
  } catch {
    return false;
  }
}

async function getLawsByCodes(codes) {
  const unique = Array.from(
    new Set((codes || []).map((c) => String(c || "").trim()).filter(Boolean))
  );
  const out = {};
  const missing = [];

  if (FIRESTORE_LAWS && (await firestoreAvailable())) {
    try {
      const db = admin.firestore();
      const col = db.collection("laws");

      const chunks = [];
      for (let i = 0; i < unique.length; i += 10) chunks.push(unique.slice(i, i + 10));

      for (const ch of chunks) {
        const snap = await col.where(admin.firestore.FieldPath.documentId(), "in", ch).get();
        const foundIds = new Set();
        snap.forEach((doc) => {
          foundIds.add(doc.id);
          out[doc.id] = doc.data();
        });
        ch.forEach((c) => {
          if (!foundIds.has(c)) missing.push(c);
        });
      }

      return { list: out, missing, source: "firestore" };
    } catch (e) {
      // fallthrough
    }
  }

  const fileDb = loadLawsFromFile() || {};
  unique.forEach((c) => {
    if (fileDb[c]) out[c] = { code: c, ...fileDb[c] };
    else missing.push(c);
  });
  return { list: out, missing, source: "file_fallback" };
}

async function getAllLaws() {
  if (FIRESTORE_LAWS && (await firestoreAvailable())) {
    try {
      const db = admin.firestore();
      const snap = await db.collection("laws").limit(500).get();
      const out = {};
      snap.forEach((doc) => {
        out[doc.id] = doc.data();
      });
      return { list: out, limited: snap.size >= 500, source: "firestore_or_fallback" };
    } catch (e) {
      // file fallback
    }
  }
  const fileDb = loadLawsFromFile() || {};
  const out = {};
  Object.keys(fileDb).forEach((k) => {
    out[k] = { code: k, ...fileDb[k] };
  });
  return { list: out, limited: false, source: "file_fallback" };
}

// -------------------------
// ✅ VWorld: zoning lookup by coord (optional)
// -------------------------
function buildVworldUrlForPoint({ lon, lat }) {
  // VWorld 2D Data API 2.0: /req/data?service=data&request=GetFeature&data=...&geomFilter=POINT(x y)&key=...
  const params = new URLSearchParams();
  params.set("service", "data");
  params.set("version", "2.0");
  params.set("request", "GetFeature");
  params.set("format", "json");
  params.set("size", "1");
  params.set("data", VWORLD_ZONING_DATA);
  // EPSG:4326 default. geomFilter는 x=lon, y=lat
  params.set("geomFilter", `POINT(${lon} ${lat})`);
  params.set("key", VWORLD_KEY);
  if (VWORLD_DOMAIN) params.set("domain", VWORLD_DOMAIN);
  return `${VWORLD_ENDPOINT}?${params.toString()}`;
}

async function queryVworldZoning({ lon, lat }) {
  if (!VWORLD_KEY) {
    return { ok: true, found: false, zoning: "", source: "no_key" };
  }

  const url = buildVworldUrlForPoint({ lon, lat });
  const r = await fetch(url, {
    headers: {
      "User-Agent": "my-archi-law-checker/0.3 (firebase-functions)",
      "Accept-Language": "ko",
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`vworld ${r.status} ${r.statusText} ${t ? `(${t.slice(0, 160)}...)` : ""}`);
  }

  const data = await r.json().catch(() => null);
  if (!data) throw new Error("vworld invalid json");

  // 응답 구조는 문서상 result가 geojson 형태로 들어옴(성공 시 status=OK)
  const status = String(data?.status || "").toUpperCase();
  if (status !== "OK") {
    // NOT_FOUND도 있을 수 있음
    return { ok: true, found: false, zoning: "", source: "vworld_not_found", raw_status: status };
  }

  const featureCollection = data?.result;
  const feats = featureCollection?.features;
  const first = Array.isArray(feats) && feats.length ? feats[0] : null;

  // 문서에 나오는 속성 예: uname(용도지역명), sido_name, sigg_name...
  const uname = String(first?.properties?.uname || "").trim();
  if (!uname) return { ok: true, found: false, zoning: "", source: "vworld_no_uname" };

  return {
    ok: true,
    found: true,
    zoning: uname,
    source: "vworld_data_api",
    meta: {
      data: VWORLD_ZONING_DATA,
      sido_name: first?.properties?.sido_name || "",
      sigg_name: first?.properties?.sigg_name || "",
    },
  };
}

// -------------------------
// API: env/debug
// -------------------------
app.get("/api/__env", (req, res) => {
  ok(res, {
    dirname: __dirname,
    cwd: process.cwd(),
    RULES_DIR,
    IS_EMULATOR: !!IS_EMULATOR,
    FIRESTORE_LAWS,
    VWORLD: {
      enabled: !!VWORLD_KEY,
      data: VWORLD_ZONING_DATA,
      has_domain: !!VWORLD_DOMAIN,
    },
    FIRESTORE_AVAILABLE: !!process.env.FIRESTORE_EMULATOR_HOST || !!process.env.GCLOUD_PROJECT,
    exists: {
      base_rules: fileExists(path.join(RULES_DIR, "base_rules.json")),
      checklists: fileExists(path.join(RULES_DIR, "checklists.json")),
      laws_json: fileExists(path.join(RULES_DIR, "laws.json")),
      rule_engine: fileExists(path.join(RULES_DIR, "rule_engine.json")),
    },
  });
});

// -------------------------
// API: calc
// -------------------------
app.get("/api/calc", (req, res) => {
  const site = toNum(req.query.site);
  const coverage = toNum(req.query.coverage);
  const far = toNum(req.query.far);
  const floor = toNum(req.query.floor) ?? 3.3;

  if (site == null || site <= 0 || coverage == null || coverage <= 0 || far == null || far <= 0) {
    return bad(res, "invalid params: site/coverage/far must be > 0", 400);
  }

  const maxBuildingArea_m2 = (site * coverage) / 100;
  const maxTotalFloorArea_m2 = (site * far) / 100;

  const estFloorsRaw =
    maxBuildingArea_m2 > 0 ? maxTotalFloorArea_m2 / maxBuildingArea_m2 : null;
  const estFloors = estFloorsRaw != null ? Math.max(1, Math.round(estFloorsRaw)) : null;

  const estHeight_m = estFloors != null ? estFloors * floor : null;

  ok(res, {
    result: {
      maxBuildingArea_m2,
      maxTotalFloorArea_m2,
      estFloors,
      estHeight_m,
    },
    note: "※ 단순 산정입니다. 실제는 대지형상/도로/주차/높이제한/심의 등으로 달라질 수 있어요.",
  });
});

// -------------------------
// API: geocode / reverse (Nominatim)
// -------------------------
async function nominatimFetch(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "my-archi-law-checker/0.3 (firebase-functions emulator)",
      "Accept-Language": "ko",
    },
  });
  if (!r.ok) throw new Error(`nominatim ${r.status} ${r.statusText}`);
  return r.json();
}

app.get("/api/geocode", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return bad(res, "missing q", 400);

  try {
    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const data = await nominatimFetch(url);
    const first = Array.isArray(data) && data.length ? data[0] : null;

    if (!first) return ok(res, { found: false, result: null });

    ok(res, {
      found: true,
      result: {
        lat: first.lat,
        lon: first.lon,
        display_name: first.display_name,
      },
    });
  } catch (e) {
    bad(res, e, 500);
  }
});

app.get("/api/reverse", async (req, res) => {
  const lat = toNum(req.query.lat);
  const lon = toNum(req.query.lon);
  if (lat == null || lon == null) return bad(res, "missing lat/lon", 400);

  try {
    const url =
      "https://nominatim.openstreetmap.org/reverse" +
      `?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const data = await nominatimFetch(url);

    const addr = data?.address || {};
    const parts = [];
    if (addr.state) parts.push(addr.state);
    if (addr.city) parts.push(addr.city);
    if (addr.county) parts.push(addr.county);
    if (addr.town) parts.push(addr.town);
    if (addr.village) parts.push(addr.village);
    if (addr.suburb) parts.push(addr.suburb);

    ok(res, {
      found: true,
      jurisdiction: parts.join(" ") || "",
      raw: addr,
    });
  } catch (e) {
    bad(res, e, 500);
  }
});

// -------------------------
// ✅ API: zoning by coord (VWorld if configured, else demo stub)
// -------------------------
app.get("/api/zoning/by-coord", async (req, res) => {
  const lat = toNum(req.query.lat);
  const lon = toNum(req.query.lon);
  if (lat == null || lon == null) return bad(res, "missing lat/lon", 400);

  // 1) VWorld 키가 있으면 실조회 시도
  if (VWORLD_KEY) {
    try {
      const got = await queryVworldZoning({ lon, lat });
      if (got.found) {
        return ok(res, {
          found: true,
          zoning: got.zoning,
          source: got.source,
          meta: got.meta || null,
        });
      }
      // VWorld 조회는 되었지만 결과 없음
      return ok(res, {
        found: false,
        zoning: "",
        source: got.source || "vworld_not_found",
        meta: got.meta || null,
      });
    } catch (e) {
      // 실무에서는 여기서 바로 fail보다는 fallback 허용이 UX 좋음
      return ok(res, {
        found: true,
        zoning: "제1종일반주거지역",
        source: "demo_fallback_after_vworld_error",
        error: String(e?.message || e),
      });
    }
  }

  // 2) 키가 없으면 기존처럼 demo_stub
  ok(res, {
    found: true,
    zoning: "제1종일반주거지역",
    source: "demo_stub",
    hint: "VWORLD_KEY 미설정이라 demo_stub으로 동작 중",
  });
});

// -------------------------
// API: rules (base_rules.json 기반)
// -------------------------
function extractZoningList(baseRulesJson) {
  if (!baseRulesJson) return [];

  if (Array.isArray(baseRulesJson.list)) {
    return baseRulesJson.list
      .map((x) => (typeof x === "string" ? x : x?.zoning))
      .filter(Boolean);
  }

  if (Array.isArray(baseRulesJson.rules)) {
    return baseRulesJson.rules.map((x) => x?.zoning).filter(Boolean);
  }

  if (typeof baseRulesJson === "object") {
    return Object.keys(baseRulesJson).filter((k) => !!k);
  }

  return [];
}

function findRuleByZoning(baseRulesJson, zoning) {
  if (!baseRulesJson || !zoning) return null;

  if (Array.isArray(baseRulesJson.list)) {
    return (
      baseRulesJson.list.find((x) => (typeof x === "string" ? x === zoning : x?.zoning === zoning)) ||
      null
    );
  }
  if (Array.isArray(baseRulesJson.rules)) {
    return baseRulesJson.rules.find((x) => x?.zoning === zoning) || null;
  }
  if (typeof baseRulesJson === "object" && baseRulesJson[zoning]) {
    return { zoning, ...baseRulesJson[zoning] };
  }
  return null;
}

app.get("/api/rules/zoning", (req, res) => {
  const base = loadBaseRules();
  const list = extractZoningList(base);

  const fallback = [
    "제1종일반주거지역",
    "제2종일반주거지역",
    "제3종일반주거지역",
    "일반상업지역",
    "준공업지역",
  ];

  ok(res, {
    list: list.length ? list : fallback,
    source: list.length ? "base_rules" : "fallback",
  });
});

app.get("/api/rules/apply", (req, res) => {
  const zoning = String(req.query.zoning || "").trim();
  if (!zoning) return bad(res, "missing zoning", 400);

  const base = loadBaseRules();
  const rule = findRuleByZoning(base, zoning);

  if (!rule || typeof rule === "string") {
    return ok(res, {
      rule: { zoning, bcr_max: 60, far_max: 200, source: "fallback" },
    });
  }

  ok(res, { rule: { ...rule, source: "base_rules" } });
});

// -------------------------
// ✅ API: uses (base_rules.json의 uses_catalog / rules[].uses 기반)
// -------------------------
const USES_FALLBACK = [
  { code: "RES_HOUSE", label: "단독/다가구(주거)" },
  { code: "RES_MULTI", label: "공동주택(간이)" },
  { code: "NEIGHBOR_1", label: "제1종근린생활시설(간이)" },
  { code: "NEIGHBOR_2", label: "제2종근린생활시설(간이)" },
  { code: "OFFICE", label: "업무시설(간이)" },
];

function getUsesCatalogFromBase(baseRulesJson) {
  const cat = baseRulesJson?.uses_catalog;
  if (!Array.isArray(cat) || cat.length === 0) return null;
  const cleaned = cat
    .map((x) => ({
      code: String(x?.code || "").trim(),
      label: String(x?.label || "").trim(),
    }))
    .filter((x) => x.code);
  return cleaned.length ? cleaned : null;
}

function buildUseMessage(status) {
  const s = normalizeStatus(status);
  if (s === "allow") return "✅ 가능(1차 통과)";
  if (s === "conditional") return "⚠️ 조건부 가능(추가 검토 필요)";
  if (s === "deny") return "❌ 불가/제한 가능성 큼(추가 검토 필요)";
  if (s === "need_input") return "❓ 입력이 필요합니다(추가 정보 필요)";
  return "❓ 정보가 부족해요(간이 판정)";
}

app.get("/api/uses", (req, res) => {
  const base = loadBaseRules();
  const fromBase = getUsesCatalogFromBase(base);
  ok(res, {
    list: fromBase || USES_FALLBACK,
    source: fromBase ? "base_rules.uses_catalog" : "fallback",
  });
});

app.get("/api/uses/check", (req, res) => {
  const zoning = String(req.query.zoning || "").trim();
  const use = String(req.query.use || "").trim();
  if (!zoning) return bad(res, "missing zoning", 400);
  if (!use) return bad(res, "missing use", 400);

  const base = loadBaseRules();
  const rule = findRuleByZoning(base, zoning);

  if (!rule || typeof rule === "string") {
    const status = "unknown";
    return ok(res, {
      zoning,
      use,
      status,
      message: "❓ 해당 용도지역 룰이 없습니다(간이 판정 불가)",
      source: "base_rules_not_found",
    });
  }

  const usesMap = rule?.uses || {};
  const rawStatus = usesMap?.[use];
  const status = normalizeStatus(rawStatus || "unknown");
  const message = buildUseMessage(status);

  ok(res, {
    zoning,
    use,
    status,
    message,
    source: "base_rules.rules[].uses",
  });
});

// -------------------------
// API: laws
// -------------------------
app.get("/api/laws", async (req, res) => {
  try {
    const all = String(req.query.all || "").trim();
    const codes = String(req.query.codes || "").trim();

    if (all === "1") {
      const got = await getAllLaws();
      return ok(res, {
        list: got.list,
        meta: { count: Object.keys(got.list).length, limited: got.limited, limit: 500 },
        source: got.source,
      });
    }

    if (!codes) return bad(res, "missing codes (or use ?all=1)", 400);

    const arr = codes
      .split(",")
      .map((s) => String(s || "").trim())
      .filter(Boolean);

    const got = await getLawsByCodes(arr);
    ok(res, {
      list: got.list,
      missing: got.missing,
      meta: { count: Object.keys(got.list).length, requested: arr.length },
      source: got.source,
    });
  } catch (e) {
    bad(res, e, 500);
  }
});

app.get("/api/laws/:code", async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return bad(res, "missing code", 400);

    const got = await getLawsByCodes([code]);
    const picked = got.list[code] || null;
    ok(res, {
      found: !!picked,
      code,
      data: picked,
      source: got.source,
    });
  } catch (e) {
    bad(res, e, 500);
  }
});

// -------------------------
// API: checklists/enriched
// -------------------------
app.get("/api/checklists/enriched", async (req, res) => {
  try {
    const zoning = String(req.query.zoning || "").trim();
    const use = String(req.query.use || "").trim();
    const jurisdiction = String(req.query.jurisdiction || "").trim();

    const floors = toNum(req.query.floors);
    const height_m = toNum(req.query.height_m);
    const gross_area_m2 = toNum(req.query.gross_area_m2);

    const values = {
      floors,
      height_m,
      gross_area_m2,
    };

    const ctx = { zoning, use, jurisdiction, floors, height_m, gross_area_m2 };

    const checklists = loadChecklists();
    const ruleEngine = loadRuleEngine();
    const ruleMap = indexRuleEngineById(ruleEngine);

    const listRaw = checklists?.default_conditional || [];
    const filtered = listRaw.filter((it) => passesAppliesTo(it, ctx));

    const enriched = filtered.map((it) => {
      const eng = ruleMap.get(String(it.id)) || {};
      const rule_set = eng.rule_set || null;
      const auto_rules = Array.isArray(eng.auto_rules) ? eng.auto_rules : [];
      const optional_inputs = Array.isArray(eng.optional_inputs) ? eng.optional_inputs : [];

      let server_judge = null;
      const judged = evaluateFirstMatch(auto_rules, values);
      if (judged) {
        server_judge = judged;
      } else if (rule_set && rule_set.default_result) {
        server_judge = {
          result: normalizeStatus(rule_set.default_result),
          message: String(rule_set.default_message || "").trim(),
          rule_id: null,
          priority: 0,
        };
      }

      const missing_inputs =
        server_judge && server_judge.result === "need_input"
          ? buildMissingInputs(it, values, optional_inputs)
          : [];

      return {
        ...it,
        rule_set,
        auto_rules,
        optional_inputs,
        server_judge,
        missing_inputs,
      };
    });

    const refs = new Set();
    enriched.forEach((it) => {
      (it.refs || []).forEach((c) => refs.add(c));
    });
    const refArr = Array.from(refs);
    const got = await getLawsByCodes(refArr);

    ok(res, {
      data: { default_conditional: enriched },
      meta: { missing_refs: got.missing || [], ctx },
      source: "checklists+rule_engine",
    });
  } catch (e) {
    bad(res, e, 500);
  }
});

// -------------------------
// API: checklists/judge (POST)
// -------------------------
app.post("/api/checklists/judge", async (req, res) => {
  try {
    const body = req.body || {};
    const context = body.context || {};
    const zoning = String(context.zoning || "").trim();
    const use = String(context.use || "").trim();
    const jurisdiction = String(context.jurisdiction || "").trim();

    const valuesIn = body.values || {};
    const values = {};
    Object.keys(valuesIn).forEach((k) => {
      const v = valuesIn[k];
      const n = toNum(v);
      values[k] = n != null ? n : v;
    });

    const ctx = { zoning, use, jurisdiction };

    const checklists = loadChecklists();
    const ruleEngine = loadRuleEngine();
    const ruleMap = indexRuleEngineById(ruleEngine);

    const listRaw = checklists?.default_conditional || [];
    const filtered = listRaw.filter((it) => passesAppliesTo(it, { ...ctx, ...values }));

    const results = filtered.map((it) => {
      const eng = ruleMap.get(String(it.id)) || {};
      const rule_set = eng.rule_set || null;
      const auto_rules = Array.isArray(eng.auto_rules) ? eng.auto_rules : [];
      const optional_inputs = Array.isArray(eng.optional_inputs) ? eng.optional_inputs : [];

      const judged = evaluateFirstMatch(auto_rules, values);
      let status = "unknown";
      let message = "";

      if (judged) {
        status = normalizeStatus(judged.result);
        message = judged.message || "";
      } else if (rule_set) {
        status = normalizeStatus(rule_set.default_result);
        message = String(rule_set.default_message || "").trim();
      }

      let missing_inputs = [];
      if (status === "need_input") {
        missing_inputs = buildMissingInputs(it, values, optional_inputs);
      }

      return {
        id: it.id,
        status,
        message,
        missing_inputs,
        judge: judged || null,
      };
    });

    const refs = new Set();
    filtered.forEach((it) => {
      (it.refs || []).forEach((c) => refs.add(c));
    });
    const got = await getLawsByCodes(Array.from(refs));

    ok(res, {
      data: { results },
      meta: { missing_refs: got.missing || [], ctx },
      source: "judge_engine",
    });
  } catch (e) {
    bad(res, e, 500);
  }
});

// -------------------------
// Health
// -------------------------
app.get("/api/health", (req, res) => ok(res, { status: "ok" }));

// -------------------------
// Export Cloud Function
// -------------------------
exports.api = onRequest(
  {
    region: "asia-northeast3",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  app
);
