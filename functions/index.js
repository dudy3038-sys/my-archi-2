/**
 * functions/index.js
 * ✅ B안: checklists.json(표시/입력/refs) + rule_engine.json(판정룰) 분리
 *
 * - checklists.json: item 기본 정보( title/why/inputs/refs/applies_to/logic_level/category 등 )
 * - rule_engine.json: rule_set / auto_rules / optional_inputs 등 "판정 로직"만
 *
 * 서버에서는 item.id 기준으로 merge하여 enriched/judge 모두 동일 로직 적용
 *
 * 결과 표준: allow | conditional | deny | need_input | unknown
 * warn -> conditional 정규화
 */

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
// ✅ rules 경로: functions/rules
// ------------------------------
const RULES_DIR = path.join(__dirname, "rules");

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

// ------------------------------
// ✅ base_rules.json
// ------------------------------
let RULES_CACHE = null;
function loadRules() {
  if (!IS_EMULATOR && RULES_CACHE) return RULES_CACHE;
  const filePath = path.join(RULES_DIR, "base_rules.json");
  if (!fs.existsSync(filePath)) throw new Error(`ENOENT rules: ${filePath}`);
  const json = readJson(filePath);
  if (!IS_EMULATOR) RULES_CACHE = json;
  return json;
}

// ------------------------------
// ✅ checklists.json (표시/입력/refs 중심)
// ------------------------------
let CHECKLISTS_CACHE = null;
function loadChecklists() {
  if (!IS_EMULATOR && CHECKLISTS_CACHE) return CHECKLISTS_CACHE;
  const filePath = path.join(RULES_DIR, "checklists.json");
  if (!fs.existsSync(filePath)) throw new Error(`ENOENT checklists: ${filePath}`);
  const json = readJson(filePath);
  if (!IS_EMULATOR) CHECKLISTS_CACHE = json;
  return json;
}

// ------------------------------
// ✅ rule_engine.json (판정 로직만)
// ------------------------------
let RULE_ENGINE_CACHE = null;
function loadRuleEngine() {
  if (!IS_EMULATOR && RULE_ENGINE_CACHE) return RULE_ENGINE_CACHE;
  const filePath = path.join(RULES_DIR, "rule_engine.json");
  if (!fs.existsSync(filePath)) throw new Error(`ENOENT rule_engine: ${filePath}`);
  const json = readJson(filePath);
  if (!IS_EMULATOR) RULE_ENGINE_CACHE = json;
  return json;
}

// ✅ rule_engine 인덱스 캐시(요청마다 build 방지)
let RULE_ENGINE_INDEX_CACHE = null;

function buildRuleEngineIndex(engineJson) {
  const items = Array.isArray(engineJson?.default_conditional) ? engineJson.default_conditional : [];
  const byId = {};
  items.forEach((it) => {
    const id = String(it?.id || "").trim();
    if (!id) return;
    byId[id] = it;
  });
  return { items, byId };
}

function loadRuleEngineIndex() {
  if (!IS_EMULATOR && RULE_ENGINE_INDEX_CACHE) return RULE_ENGINE_INDEX_CACHE;
  const engine = loadRuleEngine();
  const idx = buildRuleEngineIndex(engine);
  const result = { engine, index: idx };
  if (!IS_EMULATOR) RULE_ENGINE_INDEX_CACHE = result;
  return result;
}

// ------------------------------
// ✅ laws.json
// ------------------------------
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
// ✅ 유틸: 숫자 파싱
// ------------------------------
function toNum(v) {
  if (v === "" || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

// ------------------------------
// ✅ 유틸: 결과 표준화
// ------------------------------
function normalizeResult(r) {
  const s = String(r || "").trim().toLowerCase();
  if (s === "allow") return "allow";
  if (s === "deny") return "deny";
  if (s === "conditional") return "conditional";
  if (s === "warn") return "conditional"; // 호환
  if (s === "need_input") return "need_input";
  if (s === "unknown") return "unknown";
  return "unknown";
}

function iconForStatus(status) {
  if (status === "allow") return "✅";
  if (status === "conditional") return "⚠️";
  if (status === "deny") return "❌";
  if (status === "need_input") return "❓";
  return "❓";
}

// ------------------------------
// ✅ refs -> laws 결합
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
// ✅ Nominatim 설정
// ------------------------------
function getNominatimUserAgent() {
  if (process.env.NOMINATIM_UA && String(process.env.NOMINATIM_UA).trim()) {
    return String(process.env.NOMINATIM_UA).trim();
  }
  const contact = String(process.env.CONTACT_EMAIL || "").trim();
  if (contact) return `arch-check/1.0 (contact: ${contact})`;
  return "arch-check/1.0";
}

// ------------------------------
// ✅ applies_to 필터 (관대모드 기본)
// - "표시 유지" 목적: 숫자 기반 조건(min_*)은 값이 없으면 통과시켜 항목이 사라지지 않게 함
// - 단, zoning/use/jurisdiction 같은 명시적 범위 조건은 그대로 엄격하게 적용
// ------------------------------
function passesAppliesTo(item, ctx) {
  const a = item?.applies_to;
  if (!a) return true;

  const zoning = String(ctx?.zoning || "").trim();
  const use = String(ctx?.use || "").trim();
  const jurisdiction = String(ctx?.jurisdiction || "").trim();

  // 숫자 조건(없으면 null)
  const floors = toNum(ctx?.floors);
  const gross = toNum(ctx?.gross_area_m2);

  // ✅ 명시적 범위 조건은 "엄격" 유지
  if (Array.isArray(a.zoning_in) && a.zoning_in.length > 0) {
    if (!zoning || !a.zoning_in.includes(zoning)) return false;
  }
  if (Array.isArray(a.use_in) && a.use_in.length > 0) {
    if (!use || !a.use_in.includes(use)) return false;
  }
  if (Array.isArray(a.jurisdiction_in) && a.jurisdiction_in.length > 0) {
    if (!jurisdiction || !a.jurisdiction_in.includes(jurisdiction)) return false;
  }

  // ✅ 숫자 기반 조건은 "관대" 적용
  // - 값이 없으면(계산 전/미입력) → 일단 통과(표시 유지)
  // - 값이 있으면 → 조건 충족 시만 통과
  if (a.min_floors != null) {
    const minF = toNum(a.min_floors);
    if (minF != null && floors != null && floors < minF) return false;
  }
  if (a.min_gross_area_m2 != null) {
    const minG = toNum(a.min_gross_area_m2);
    if (minG != null && gross != null && gross < minG) return false;
  }

  return true;
}

// ------------------------------
// ✅ rule_engine + checklists merge
// - engine 우선, 없으면 base fallback
// ------------------------------
function mergeChecklistWithRuleEngine(baseItem, engineItem) {
  const merged = { ...(baseItem || {}) };

  if (!engineItem) {
    merged.rule_set = merged.rule_set || null;
    merged.auto_rules = merged.auto_rules || [];
    merged.optional_inputs = merged.optional_inputs || [];
    return merged;
  }

  if (engineItem.optional_inputs != null) merged.optional_inputs = engineItem.optional_inputs;
  if (engineItem.rule_set !=null) merged.rule_set = engineItem.rule_set;
  if (engineItem.auto_rules != null) merged.auto_rules = engineItem.auto_rules;

  if (engineItem.notes != null) merged.engine_notes = engineItem.notes;

  return merged;
}

// ------------------------------
// ✅ 입력 누락 체크 (optional_inputs 제외)
// ------------------------------
function getMissingInputs(item, values) {
  const inputs = Array.isArray(item?.inputs) ? item.inputs : [];
  const optional = new Set(Array.isArray(item?.optional_inputs) ? item.optional_inputs : []);

  const missing = [];
  for (const inp of inputs) {
    const key = inp?.key;
    if (!key) continue;
    if (optional.has(key)) continue;

    const type = String(inp.type || "text").toLowerCase();
    const raw = values?.[key];

    if (type === "number") {
      const n = toNum(raw);
      if (n == null) missing.push({ key, label: inp.label || key, type });
      continue;
    }

    const t = String(raw ?? "").trim();
    if (!t) missing.push({ key, label: inp.label || key, type });
  }
  return missing;
}

// ------------------------------
// ✅ 조건 평가(op 확장)
// ------------------------------
function evalCond(cond, values) {
  if (!cond || !cond.key || !cond.op) return false;

  const op = String(cond.op).trim().toLowerCase();
  const key = String(cond.key).trim();
  const raw = values?.[key];

  if (op === "missing") {
    if (raw === undefined || raw === null) return true;
    if (typeof raw === "number") return !Number.isFinite(raw);
    return String(raw).trim() === "";
  }
  if (op === "present") {
    if (raw === undefined || raw === null) return false;
    if (typeof raw === "number") return Number.isFinite(raw);
    return String(raw).trim() !== "";
  }

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

// ------------------------------
// ✅ 룰 매칭: when / when_all / when_any
// ------------------------------
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

// ------------------------------
// ✅ auto_rules 서버 판정 (priority desc)
// ------------------------------
function evalAutoRulesServer(item, values) {
  const rules = Array.isArray(item.auto_rules) ? item.auto_rules : [];
  if (!rules.length) return null;

  const sorted = rules.slice().sort((a, b) => (toNum(b.priority) ?? 0) - (toNum(a.priority) ?? 0));

  for (const rule of sorted) {
    if (!ruleMatches(rule, values)) continue;

    const matched =
      rule.when ||
      (Array.isArray(rule.when_all) ? { op: "and", items: rule.when_all } : null) ||
      (Array.isArray(rule.when_any) ? { op: "or", items: rule.when_any } : null);

    return {
      result: normalizeResult(rule.result),
      message: rule.message,
      matched,
      rule_id: rule.id || null,
      priority: toNum(rule.priority) ?? 0,
    };
  }

  return null;
}

// ------------------------------
// ✅ 디버그: rules 파일 존재 확인
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
      rule_engine: fs.existsSync(path.join(RULES_DIR, "rule_engine.json")),
    },
  });
});

// ------------------------------
// ✅ 테스트
// ------------------------------
app.get("/api/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

// ------------------------------
// ✅ 건축 기본 산정: GET /api/calc
// ------------------------------
app.get("/api/calc", (req, res) => {
  try {
    const site = Number(req.query.site);
    const coverage = Number(req.query.coverage);
    const far = Number(req.query.far);
    const floorH = Number(req.query.floor ?? 3.3);

    if (!Number.isFinite(site) || site <= 0) return sendError(res, 400, "site(대지면적)를 올바르게 입력해줘");
    if (!Number.isFinite(coverage) || coverage <= 0)
      return sendError(res, 400, "coverage(건폐율)를 올바르게 입력해줘");
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
        "User-Agent": getNominatimUserAgent(),
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
// ✅ 좌표 → 행정구역: GET /api/reverse?lat=..&lon=..
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
        "User-Agent": getNominatimUserAgent(),
        Accept: "application/json",
      },
    });

    if (!r.ok) throw new Error(`reverse fetch failed: ${r.status}`);
    const data = await r.json();

    const addr = data?.address || {};

    const state = addr.state || addr.province || "";
    const city = addr.city || addr.county || addr.municipality || addr.region || addr.state_district || "";

    const districtCandidates = [
      addr.city_district,
      addr.borough,
      addr.suburb,
      addr.district,
      addr.town,
      addr.village,
      addr.quarter,
      addr.neighbourhood,
    ].filter(Boolean);

    const pickDistrict = () => {
      if (districtCandidates.length === 0) return "";
      const preferred = districtCandidates.find((d) => /[구군시]$/.test(String(d)));
      return String(preferred || districtCandidates[0] || "").trim();
    };

    const district = pickDistrict();
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

    const status = normalizeResult((zoneRule.uses && zoneRule.uses[use]) || "unknown");

    const msgMap = {
      allow: "✅ 가능(간이)",
      conditional: "⚠️ 조건부 가능(추가 검토 필요)",
      deny: "❌ 불가(간이)",
      need_input: "❓ 입력 필요",
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
// ✅ 체크리스트 + (rule_engine merge) + 법령DB 결합: GET /api/checklists/enriched
// ------------------------------
app.get("/api/checklists/enriched", (req, res) => {
  try {
    const checklists = loadChecklists();
    const laws = loadLaws();

    const { engine, index: engineIndex } = loadRuleEngineIndex();

    const ctx = {
      zoning: String(req.query.zoning || "").trim(),
      use: String(req.query.use || "").trim(),
      jurisdiction: String(req.query.jurisdiction || "").trim(),

      floors: req.query.floors,
      gross_area_m2: req.query.gross_area_m2,
      road_width_m: req.query.road_width_m,
      height_m: req.query.height_m,
      setback_m: req.query.setback_m,
      use_hint: req.query.use_hint,
    };

    const baseItems = Array.isArray(checklists.default_conditional) ? checklists.default_conditional : [];

    // ✅ 관대 applies_to: 숫자값이 없으면 필터링하지 않음(항목 유지)
    const filtered = baseItems.filter((it) => passesAppliesTo(it, ctx));

    const enriched = filtered.map((baseIt) => {
      const engineIt = engineIndex.byId[String(baseIt.id || "").trim()] || null;
      const it = mergeChecklistWithRuleEngine(baseIt, engineIt);

      const refs = Array.isArray(it.refs) ? it.refs : [];
      const { lawMap } = buildLawMapFromRefs(refs, laws);

      const serverJudge = evalAutoRulesServer(it, ctx);
      const missing_inputs = getMissingInputs(it, ctx);

      return {
        ...it,
        laws: lawMap,
        server_judge: serverJudge,
        missing_inputs,
      };
    });

    return res.json({
      ok: true,
      meta: {
        context: ctx,
        count: enriched.length,
        rule_engine: {
          version: engine?.version || null,
          updated_at: engine?.updated_at || null,
          matched_items: enriched.length,
        },
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
// ✅ 브라우저 주소창 혼동 방지: GET /api/checklists/judge -> 405 안내
// ------------------------------
app.get("/api/checklists/judge", (req, res) => {
  return res.status(405).json({
    ok: false,
    error: "Method Not Allowed. 이 엔드포인트는 POST 전용입니다. (프론트에서 POST로 호출해야 합니다.)",
  });
});

// ------------------------------
// ✅ 서버 판정 엔진: POST /api/checklists/judge
// ✅ FIX: values(사용자 입력) + ctx(컨텍스트)를 합쳐 판정/누락체크/필터에 반영
// ------------------------------
app.post("/api/checklists/judge", (req, res) => {
  try {
    const checklists = loadChecklists();
    const lawsDb = loadLaws();

    const { engine, index: engineIndex } = loadRuleEngineIndex();

    const body = req.body || {};
    const context = body.context || {};
    const values = body.values || body || {};

    // (1) 컨텍스트는 우선순위: context -> values(호환)
    const ctx = {
      zoning: String(context.zoning ?? values.zoning ?? "").trim(),
      use: String(context.use ?? values.use ?? "").trim(),
      jurisdiction: String(context.jurisdiction ?? values.jurisdiction ?? "").trim(),

      floors: values.floors ?? context.floors,
      gross_area_m2: values.gross_area_m2 ?? context.gross_area_m2,
      road_width_m: values.road_width_m ?? context.road_width_m,
      height_m: values.height_m ?? context.height_m,
      setback_m: values.setback_m ?? context.setback_m,

      use_hint: values.use_hint ?? context.use_hint,
    };

    // ✅ (2) 판정에 쓰는 전체 값 = values + ctx (충돌 시 ctx 우선)
    const mergedValues = { ...(values || {}), ...(ctx || {}) };

    // ✅ 관대 applies_to: 숫자값이 없으면 필터링하지 않음(항목 유지)
    const baseItems = Array.isArray(checklists.default_conditional) ? checklists.default_conditional : [];
    const filteredBase = baseItems.filter((it) => passesAppliesTo(it, mergedValues));

    const results = [];
    const missingRefs = new Set();

    for (const baseIt of filteredBase) {
      const engineIt = engineIndex.byId[String(baseIt.id || "").trim()] || null;
      const it = mergeChecklistWithRuleEngine(baseIt, engineIt);

      const refs = Array.isArray(it.refs) ? it.refs : [];
      const { lawMap, missing } = buildLawMapFromRefs(refs, lawsDb);
      missing.forEach((c) => missingRefs.add(c));

      // ✅ 여기부터 전부 mergedValues로 평가
      const missing_inputs = getMissingInputs(it, mergedValues);
      const judged = evalAutoRulesServer(it, mergedValues);

      let status = "unknown";
      let message = "❓ 정보 없음(룰 추가 필요)";
      let matched = null;

      if (missing_inputs.length > 0) {
        status = "need_input";
        message = `${iconForStatus(status)} 입력 필요: ${missing_inputs.map((m) => m.label).join(", ")}`;
      } else if (judged) {
        status = normalizeResult(judged.result);
        message = judged.message || `${iconForStatus(status)} 판정됨`;
        matched = judged.matched || null;
      } else {
        const rs = it.rule_set || null;
        const rsDefaultResult = rs?.default_result ? normalizeResult(rs.default_result) : "";
        const rsDefaultMessage = String(rs?.default_message || "").trim();

        if (rsDefaultResult && rsDefaultResult !== "unknown") {
          status = rsDefaultResult;
          message = rsDefaultMessage || `${iconForStatus(status)} 기본 판정`;
        } else {
          const level = String(it.logic_level || "").trim().toLowerCase();
          if (level === "manual") {
            status = "conditional";
            message = "⚠️ 수동 검토 항목(지자체 조례/세부 기준 확인 필요)";
          } else if (level === "semi") {
            status = "conditional";
            message = "⚠️ 일부 자동 판정 가능하나 추가 검토 필요(입력/현장/지자체 확인)";
          } else {
            status = "unknown";
            message = "❓ 정보 없음(룰 추가 필요)";
          }
        }
      }

      results.push({
        id: it.id,
        title: it.title,
        why: it.why,
        category: it.category || null,
        logic_level: it.logic_level || null,

        inputs: it.inputs || [],
        optional_inputs: it.optional_inputs || [],

        missing_inputs,
        refs,
        laws: lawMap,

        judge: judged,
        status,
        message,
        matched,

        _engine_attached: Boolean(engineIt),
      });
    }

    return res.json({
      ok: true,
      meta: {
        context: ctx,
        count: results.length,
        missing_refs: Array.from(missingRefs),
        rule_engine: {
          version: engine?.version || null,
          updated_at: engine?.updated_at || null,
        },
      },
      data: { results },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 법령 DB API
// ------------------------------
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

app.get("/api/laws", (req, res) => {
  try {
    const laws = loadLaws();
    const all = String(req.query.all || "").trim() === "1";
    const codesRaw = String(req.query.codes || "").trim();

    if (!all && !codesRaw) {
      return sendError(
        res,
        400,
        "codes 파라미터가 필요합니다. 예) /api/laws?codes=BLD-ACT-44,FIRE-REG-05 (전체가 필요하면 /api/laws?all=1)"
      );
    }

    if (all) {
      return res.json({ ok: true, list: laws, meta: { count: Object.keys(laws || {}).length } });
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

    return res.json({
      ok: true,
      list,
      missing,
      meta: { requested: codes.length, found: Object.keys(list).length },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ 좌표 기반 간이 용도지역 판정 (더미)
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
      rule: { bcr_max: hit.bcr_max, far_max: hit.far_max },
    });
  } catch (e) {
    return sendError(res, 500, e);
  }
});

// ------------------------------
// ✅ region 설정
// ------------------------------
const FUNCTION_REGION = String(process.env.FUNCTION_REGION || "asia-northeast3").trim() || "asia-northeast3";
exports.api = onRequest({ region: FUNCTION_REGION }, app);
