const express = require("express");
const cors = require("cors");
const { onRequest } = require("firebase-functions/v2/https");

const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ------------------------------
// ✅ fetch 런타임 안전화 (Node 18 미만 대비)
// ------------------------------
let fetchFn = global.fetch;
async function ensureFetch() {
  if (fetchFn) return fetchFn;
  const undici = await import("undici");
  fetchFn = undici.fetch;
  return fetchFn;
}

function sendError(res, status, error) {
  return res.status(status).json({ ok: false, error: String(error) });
}

// ✅ 에뮬레이터(개발)에서는 캐시 끄기
const IS_EMULATOR =
  process.env.FUNCTIONS_EMULATOR === "true" ||
  !!process.env.FIREBASE_EMULATOR_HUB ||
  process.env.NODE_ENV !== "production";

// ------------------------------
// ✅ rules 경로를 "functions/rules"로 확정
// ------------------------------
const RULES_DIR = path.join(__dirname, "rules");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

let RULES_CACHE = null;
function loadRules() {
  if (!IS_EMULATOR && RULES_CACHE) return RULES_CACHE;
  const filePath = path.join(RULES_DIR, "base_rules.json");
  if (!fs.existsSync(filePath)) throw new Error(`ENOENT rules: ${filePath}`);
  const json = readJson(filePath);
  if (!IS_EMULATOR) RULES_CACHE = json;
  return json;
}

let CHECKLISTS_CACHE = null;
function loadChecklists() {
  if (!IS_EMULATOR && CHECKLISTS_CACHE) return CHECKLISTS_CACHE;
  const filePath = path.join(RULES_DIR, "checklists.json");
  if (!fs.existsSync(filePath)) throw new Error(`ENOENT checklists: ${filePath}`);
  const json = readJson(filePath);
  if (!IS_EMULATOR) CHECKLISTS_CACHE = json;
  return json;
}

let LAWS_CACHE = null;
function loadLaws() {
  if (!IS_EMULATOR && LAWS_CACHE) return LAWS_CACHE;
  const filePath = path.join(RULES_DIR, "laws.json");
  if (!fs.existsSync(filePath)) throw new Error(`ENOENT laws: ${filePath}`);
  const json = readJson(filePath);
  if (!IS_EMULATOR) LAWS_CACHE = json;
  return json;
}

// ------------------------------
// ✅ 유틸: 안전한 숫자 파싱
// ------------------------------
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------
// ✅ 유틸: auto_rules 서버 판정
// ------------------------------
function evalAutoRulesServer(item, values) {
  const rules = Array.isArray(item.auto_rules) ? item.auto_rules : [];
  for (const rule of rules) {
    const cond = rule.when;
    if (!cond) continue;

    const v = toNum(values?.[cond.key]);
    const target = toNum(cond.value);
    if (v == null || target == null) continue;

    let ok = false;
    if (cond.op === "lt") ok = v < target;
    if (cond.op === "lte") ok = v <= target;
    if (cond.op === "gt") ok = v > target;
    if (cond.op === "gte") ok = v >= target;
    if (cond.op === "eq") ok = v === target;

    if (ok) return { result: rule.result, message: rule.message, matched: cond };
  }
  return null;
}

// ------------------------------
// ✅ (선택) 체크리스트 필터링 룰 applies_to
// ------------------------------
function passesAppliesTo(item, ctx) {
  const a = item.applies_to;
  if (!a) return true;

  const zoning = (ctx.zoning || "").trim();
  const use = (ctx.use || "").trim();
  const jurisdiction = (ctx.jurisdiction || "").trim();
  const floors = toNum(ctx.floors);
  const gross = toNum(ctx.gross_area_m2);

  if (Array.isArray(a.zoning_in) && a.zoning_in.length > 0) {
    if (!zoning || !a.zoning_in.includes(zoning)) return false;
  }
  if (Array.isArray(a.use_in) && a.use_in.length > 0) {
    if (!use || !a.use_in.includes(use)) return false;
  }
  if (Array.isArray(a.jurisdiction_in) && a.jurisdiction_in.length > 0) {
    if (!jurisdiction || !a.jurisdiction_in.includes(jurisdiction)) return false;
  }
  if (a.min_floors != null) {
    const minF = toNum(a.min_floors);
    if (minF != null && (floors == null || floors < minF)) return false;
  }
  if (a.min_gross_area_m2 != null) {
    const minG = toNum(a.min_gross_area_m2);
    if (minG != null && (gross == null || gross < minG)) return false;
  }

  return true;
}

// ------------------------------
// ✅ 유틸: refs -> laws 결합
// ------------------------------
function buildLawMapFromRefs(refs, lawsDb) {
  const lawMap = {};
  const missing = [];
  (Array.isArray(refs) ? refs : []).forEach((code) => {
    if (lawsDb?.[code]) lawMap[code] = lawsDb[code];
    else missing.push(code);
  });
  return { lawMap, missing };
}

// ------------------------------
// ✅ 디버그: 현재 rules 파일 존재 확인
// ------------------------------
app.get("/api/debug/rules", (req, res) => {
  res.json({
    ok: true,
    __dirname,
    cwd: process.cwd(),
    RULES_DIR,
    exists: {
      base_rules: fs.existsSync(path.join(RULES_DIR, "base_rules.json")),
      checklists: fs.existsSync(path.join(RULES_DIR, "checklists.json")),
      laws: fs.existsSync(path.join(RULES_DIR, "laws.json")),
    },
  });
});

// ------------------------------
// ✅ 테스트
// ------------------------------
app.get("/api/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

// ------------------------------
// ✅ 건축 기본 산정: GET /api/calc
// 예) /api/calc?site=200&coverage=60&far=200&floor=3.3
// ------------------------------
app.get("/api/calc", (req, res) => {
  try {
    const site = Number(req.query.site);
    const coverage = Number(req.query.coverage);
    const far = Number(req.query.far);
    const floorH = Number(req.query.floor ?? 3.3);

    if (!Number.isFinite(site) || site <= 0) return sendError(res, 400, "site(대지면적)를 올바르게 입력해줘");
    if (!Number.isFinite(coverage) || coverage <= 0) return sendError(res, 400, "coverage(건폐율)를 올바르게 입력해줘");
    if (!Number.isFinite(far) || far <= 0) return sendError(res, 400, "far(용적률)를 올바르게 입력해줘");
    if (!Number.isFinite(floorH) || floorH <= 0) return sendError(res, 400, "floor(층고)를 올바르게 입력해줘");

    const maxBuildingArea = site * (coverage / 100);
    const maxTotalFloorArea = site * (far / 100);
    const estFloors = maxBuildingArea > 0 ? Math.max(1, Math.floor(maxTotalFloorArea / maxBuildingArea)) : 0;
    const estHeight = estFloors * floorH;

    const r2 = (n) => Math.round(n * 100) / 100;

    return res.json({
      ok: true,
      input: { site, coverage, far, floorH },
      result: {
        maxBuildingArea_m2: r2(maxBuildingArea),
        maxTotalFloorArea_m2: r2(maxTotalFloorArea),
        estFloors,
        estHeight_m: r2(estHeight),
      },
      note: "※ 단순 산정(법규/용도지역/일조/주차/높이제한 등은 미반영)",
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 주소 → 좌표 변환: GET /api/geocode?q=...
// ------------------------------
app.get("/api/geocode", async (req, res) => {
  try {
    const fetch = await ensureFetch();
    const q = String(req.query.q || "").trim();
    if (!q) return sendError(res, 400, "q(query) is required");

    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);

    const r = await fetch(url, {
      headers: {
        "User-Agent": "my-archi-1 (Firebase Emulator)",
        Accept: "application/json",
      },
    });

    if (!r.ok) throw new Error(`geocode fetch failed: ${r.status}`);
    const arr = await r.json();
    const hit = arr?.[0];
    if (!hit) return res.json({ ok: true, found: false, q });

    return res.json({
      ok: true,
      found: true,
      q,
      result: {
        display_name: hit.display_name,
        lat: Number(hit.lat),
        lon: Number(hit.lon),
      },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 좌표 → 행정구역(지자체) 추출: GET /api/reverse?lat=..&lon=..
// ------------------------------
app.get("/api/reverse", async (req, res) => {
  try {
    const fetch = await ensureFetch();
    const lat = toNum(req.query.lat);
    const lon = toNum(req.query.lon);
    if (lat == null || lon == null) return sendError(res, 400, "lat/lon required");

    const url =
      "https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=1&lat=" +
      encodeURIComponent(lat) +
      "&lon=" +
      encodeURIComponent(lon);

    const r = await fetch(url, {
      headers: {
        "User-Agent": "my-archi-1 (Firebase Emulator)",
        Accept: "application/json",
      },
    });

    if (!r.ok) throw new Error(`reverse fetch failed: ${r.status}`);
    const data = await r.json();

    const addr = data?.address || {};
    const state = addr.state || addr.province || "";
    const city = addr.city || addr.county || addr.municipality || addr.region || "";
    const district = addr.city_district || addr.borough || addr.suburb || addr.town || addr.village || "";

    const jurisdiction = [state, city, district].filter(Boolean).join(" ").trim();

    return res.json({
      ok: true,
      found: Boolean(jurisdiction),
      jurisdiction,
      raw: {
        display_name: data?.display_name || "",
        address: addr,
      },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 전체 용도지역 목록: GET /api/rules/zoning
// ------------------------------
app.get("/api/rules/zoning", (req, res) => {
  try {
    const rules = loadRules();
    const list = (rules.rules || []).map((r) => ({
      zoning: r.zoning,
      bcr_max: r.bcr_max,
      far_max: r.far_max,
    }));
    return res.json({ ok: true, list });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 룰 적용: GET /api/rules/apply?zoning=...
// ------------------------------
app.get("/api/rules/apply", (req, res) => {
  try {
    const zoning = String(req.query.zoning || "").trim();
    if (!zoning) return sendError(res, 400, "zoning is required");

    const rules = loadRules();
    const hit = (rules.rules || []).find((r) => r.zoning === zoning);

    if (!hit) return res.json({ ok: true, found: false, zoning });

    return res.json({
      ok: true,
      found: true,
      zoning,
      rule: {
        bcr_max: hit.bcr_max,
        far_max: hit.far_max,
        source: hit.source || null,
      },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ [용도] 카탈로그: GET /api/uses
// ------------------------------
app.get("/api/uses", (req, res) => {
  try {
    const rules = loadRules();
    return res.json({ ok: true, list: rules.uses_catalog || [] });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ [용도] zoning + useCode 판단: GET /api/uses/check?zoning=...&use=...
// ------------------------------
app.get("/api/uses/check", (req, res) => {
  try {
    const zoning = String(req.query.zoning || "").trim();
    const use = String(req.query.use || "").trim();

    if (!zoning) return sendError(res, 400, "zoning is required");
    if (!use) return sendError(res, 400, "use is required");

    const rules = loadRules();
    const zoneRule = (rules.rules || []).find((r) => r.zoning === zoning);

    if (!zoneRule) {
      return res.json({
        ok: true,
        found: false,
        zoning,
        use,
        status: "unknown",
        message: "해당 용도지역 룰이 없습니다.",
      });
    }

    const catalog = rules.uses_catalog || [];
    const useExists = catalog.some((u) => u.code === use);

    if (!useExists) {
      return res.json({
        ok: true,
        found: true,
        zoning,
        use,
        status: "unknown",
        message: "❓ 정보 없음(해당 용도 코드가 카탈로그에 없습니다. uses_catalog 확인 필요)",
      });
    }

    const status = (zoneRule.uses && zoneRule.uses[use]) || "unknown";

    const msgMap = {
      allow: "✅ 가능(간이)",
      conditional: "⚠️ 조건부 가능(추가 검토 필요)",
      deny: "❌ 불가(간이)",
      unknown: "❓ 정보 없음(룰 추가 필요)",
    };

    return res.json({
      ok: true,
      found: true,
      zoning,
      use,
      status,
      message: msgMap[status] || msgMap.unknown,
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 체크리스트 + 법령DB 결합: GET /api/checklists/enriched
// ------------------------------
app.get("/api/checklists/enriched", (req, res) => {
  try {
    const checklists = loadChecklists();
    const laws = loadLaws();

    const ctx = {
      zoning: String(req.query.zoning || "").trim(),
      use: String(req.query.use || "").trim(),
      jurisdiction: String(req.query.jurisdiction || "").trim(),
      floors: req.query.floors,
      gross_area_m2: req.query.gross_area_m2,
      road_width_m: req.query.road_width_m,
      height_m: req.query.height_m,
      setback_m: req.query.setback_m,
    };

    const items = Array.isArray(checklists.default_conditional) ? checklists.default_conditional : [];
    const filtered = items.filter((it) => passesAppliesTo(it, ctx));

    const enriched = filtered.map((it) => {
      const refs = Array.isArray(it.refs) ? it.refs : [];
      const { lawMap } = buildLawMapFromRefs(refs, laws);
      const serverJudge = evalAutoRulesServer(it, ctx);

      return {
        ...it,
        laws: lawMap,
        server_judge: serverJudge,
      };
    });

    return res.json({
      ok: true,
      meta: {
        context: ctx,
        count: enriched.length,
      },
      data: {
        ...checklists,
        default_conditional: enriched,
      },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 서버 판정 엔진: POST /api/checklists/judge
// ------------------------------
app.post("/api/checklists/judge", (req, res) => {
  try {
    const checklists = loadChecklists();
    const lawsDb = loadLaws();

    const body = req.body || {};
    const context = body.context || {};
    const values = body.values || body || {}; // flat으로 보내도 동작

    const ctx = {
      zoning: String(context.zoning ?? values.zoning ?? "").trim(),
      use: String(context.use ?? values.use ?? "").trim(),
      jurisdiction: String(context.jurisdiction ?? values.jurisdiction ?? "").trim(),
      floors: values.floors ?? context.floors,
      gross_area_m2: values.gross_area_m2 ?? context.gross_area_m2,
      road_width_m: values.road_width_m ?? context.road_width_m,
      height_m: values.height_m ?? context.height_m,
      setback_m: values.setback_m ?? context.setback_m,
    };

    const items = Array.isArray(checklists.default_conditional) ? checklists.default_conditional : [];
    const filtered = items.filter((it) => passesAppliesTo(it, ctx));

    const results = [];
    const missingRefs = new Set();

    for (const it of filtered) {
      const refs = Array.isArray(it.refs) ? it.refs : [];
      const { lawMap, missing } = buildLawMapFromRefs(refs, lawsDb);
      missing.forEach((c) => missingRefs.add(c));

      const judged = evalAutoRulesServer(it, ctx);

      results.push({
        id: it.id,
        title: it.title,
        why: it.why,
        logic_level: it.logic_level || null,
        inputs: it.inputs || [],
        refs,
        laws: lawMap,
        judge: judged, // {result,message,matched} 또는 null
      });
    }

    return res.json({
      ok: true,
      meta: {
        context: ctx,
        count: results.length,
        missing_refs: Array.from(missingRefs),
      },
      data: { results },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 법령 DB API  ✅✅✅ (이게 빠져서 /api/laws가 Cannot GET였음)
// ------------------------------

// 1) 단건 조회: GET /api/laws/BLD-ACT-44
app.get("/api/laws/:code", (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return sendError(res, 400, "code is required");

    const laws = loadLaws();
    const hit = laws[code];

    if (!hit) return res.json({ ok: true, found: false, code });

    return res.json({ ok: true, found: true, code, data: hit });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// 2) 다건/전체 조회: GET /api/laws?codes=BLD-ACT-44,FIRE-REG-05 또는 GET /api/laws
app.get("/api/laws", (req, res) => {
  try {
    const laws = loadLaws();
    const codesRaw = String(req.query.codes || "").trim();

    if (!codesRaw) {
      return res.json({ ok: true, list: laws });
    }

    const codes = codesRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const list = {};
    const missing = [];

    for (const c of codes) {
      if (laws[c]) list[c] = laws[c];
      else missing.push(c);
    }

    return res.json({ ok: true, list, missing });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 좌표 기반 간이 용도지역 판정 (더미 로직)
// GET /api/zoning/by-coord?lat=..&lon=..
// ------------------------------
app.get("/api/zoning/by-coord", (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return sendError(res, 400, "lat/lon required");
    }

    const rules = loadRules();

    let zoning = "제2종일반주거지역";
    if (lat > 37.6) zoning = "제3종일반주거지역";
    if (lat < 37.5) zoning = "제1종일반주거지역";

    const hit = (rules.rules || []).find((r) => r.zoning === zoning);
    if (!hit) return res.json({ ok: true, found: false, zoning });

    return res.json({
      ok: true,
      found: true,
      zoning: hit.zoning,
      rule: {
        bcr_max: hit.bcr_max,
        far_max: hit.far_max,
      },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// Hosting rewrite에서 function 이름을 "api"로 쓰고 있으니 exports.api 유지
exports.api = onRequest({ region: "us-central1" }, app);
