// functions/api/[[path]].js
// Cloudflare Pages Functions router for /api/*
// - No Node fs. Read JSON via fetch from /rules/*.json (must be in public/rules)

function json(resBody, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(resBody), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        ...extraHeaders,
      },
    });
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
  
  // ---- Rule engine (same semantics as your Firebase version) ----
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
        missing.push({ key, label: String(inp.label || key) });
      }
    }
    return missing;
  }
  
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
  
    function meetsMin(th, val) {
      const t = toNum(th);
      if (t == null) return true;
      if (val == null) return true;
      return val >= t;
    }
  
    if (!meetsMin(a.min_floors, floors)) return false;
    if (!meetsMin(a.min_height_m, height_m)) return false;
    if (!meetsMin(a.min_gross_area_m2, gross_area_m2)) return false;
  
    return true;
  }
  
  // ---- Static JSON loaders via fetch from deployed assets ----
  async function fetchJsonFromPublic(requestUrl, path) {
    const u = new URL(requestUrl);
    const url = new URL(path, u.origin);
    const r = await fetch(url.toString(), { headers: { "accept": "application/json" } });
    if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
    return await r.json();
  }
  
  async function loadAllRules(requestUrl) {
    const [base, checklists, ruleEngine, laws] = await Promise.all([
      fetchJsonFromPublic(requestUrl, "/rules/base_rules.json"),
      fetchJsonFromPublic(requestUrl, "/rules/checklists.json"),
      fetchJsonFromPublic(requestUrl, "/rules/rule_engine.json"),
      fetchJsonFromPublic(requestUrl, "/rules/laws.json"),
    ]);
    return { base, checklists, ruleEngine, laws };
  }
  
  function extractZoningList(baseRulesJson) {
    if (!baseRulesJson) return [];
    if (Array.isArray(baseRulesJson.list)) {
      return baseRulesJson.list
        .map((x) => (typeof x === "string" ? x : x?.zoning))
        .filter(Boolean);
    }
    if (Array.isArray(baseRulesJson.rules)) return baseRulesJson.rules.map((x) => x?.zoning).filter(Boolean);
    if (typeof baseRulesJson === "object") return Object.keys(baseRulesJson).filter((k) => !!k);
    return [];
  }
  
  function findRuleByZoning(baseRulesJson, zoning) {
    if (!baseRulesJson || !zoning) return null;
    if (Array.isArray(baseRulesJson.list)) {
      return baseRulesJson.list.find((x) => (typeof x === "string" ? x === zoning : x?.zoning === zoning)) || null;
    }
    if (Array.isArray(baseRulesJson.rules)) return baseRulesJson.rules.find((x) => x?.zoning === zoning) || null;
    if (typeof baseRulesJson === "object" && baseRulesJson[zoning]) return { zoning, ...baseRulesJson[zoning] };
    return null;
  }
  
  function getUsesCatalogFromBase(baseRulesJson) {
    const cat = baseRulesJson?.uses_catalog;
    if (!Array.isArray(cat) || cat.length === 0) return null;
    const cleaned = cat
      .map((x) => ({ code: String(x?.code || "").trim(), label: String(x?.label || "").trim() }))
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
  
  // ---- main router ----
  export async function onRequest(context) {
    const req = context.request;
  
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }});
    }
  
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, "/"); // "/geocode" etc
  
    let data;
    try {
      data = await loadAllRules(req.url);
    } catch (e) {
      // rules files missing -> you forgot public/rules/*
      return json({ ok: false, error: String(e?.message || e), hint: "public/rules/*.json 이 배포에 포함되어야 합니다." }, 500);
    }
  
    // /__env
    if (path === "/__env") {
      return json({
        ok: true,
        source: "cloudflare_pages_functions",
        has_rules: true,
        note: "Firebase Functions가 아니라 Pages Functions로 /api/* 제공 중",
      });
    }
  
    // /health
    if (path === "/health") {
      return json({ ok: true, status: "ok" });
    }
  
    // /calc
    if (path === "/calc") {
      const site = toNum(url.searchParams.get("site"));
      const coverage = toNum(url.searchParams.get("coverage"));
      const far = toNum(url.searchParams.get("far"));
      const floor = toNum(url.searchParams.get("floor")) ?? 3.3;
  
      if (site == null || site <= 0 || coverage == null || coverage <= 0 || far == null || far <= 0) {
        return json({ ok: false, error: "invalid params: site/coverage/far must be > 0" }, 400);
      }
  
      const maxBuildingArea_m2 = (site * coverage) / 100;
      const maxTotalFloorArea_m2 = (site * far) / 100;
      const estFloorsRaw = maxBuildingArea_m2 > 0 ? maxTotalFloorArea_m2 / maxBuildingArea_m2 : null;
      const estFloors = estFloorsRaw != null ? Math.max(1, Math.round(estFloorsRaw)) : null;
      const estHeight_m = estFloors != null ? estFloors * floor : null;
  
      return json({
        ok: true,
        result: { maxBuildingArea_m2, maxTotalFloorArea_m2, estFloors, estHeight_m },
        note: "※ 단순 산정입니다. 실제는 대지형상/도로/주차/높이제한/심의 등으로 달라질 수 있어요.",
      });
    }
  
    // /geocode , /reverse (Nominatim)
    async function nominatimFetch(nurl) {
      const r = await fetch(nurl, { headers: { "User-Agent": "my-archi-law-checker/0.3 (cloudflare)", "Accept-Language": "ko" }});
      if (!r.ok) throw new Error(`nominatim ${r.status} ${r.statusText}`);
      return r.json();
    }
  
    if (path === "/geocode") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json({ ok: false, error: "missing q" }, 400);
      try {
        const nurl = "https://nominatim.openstreetmap.org/search" + `?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
        const arr = await nominatimFetch(nurl);
        const first = Array.isArray(arr) && arr.length ? arr[0] : null;
        if (!first) return json({ ok: true, found: false, result: null });
        return json({ ok: true, found: true, result: { lat: first.lat, lon: first.lon, display_name: first.display_name }});
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }
  
    if (path === "/reverse") {
      const lat = toNum(url.searchParams.get("lat"));
      const lon = toNum(url.searchParams.get("lon"));
      if (lat == null || lon == null) return json({ ok: false, error: "missing lat/lon" }, 400);
      try {
        const nurl = "https://nominatim.openstreetmap.org/reverse" + `?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
        const rj = await nominatimFetch(nurl);
        const addr = rj?.address || {};
        const parts = [];
        if (addr.state) parts.push(addr.state);
        if (addr.city) parts.push(addr.city);
        if (addr.county) parts.push(addr.county);
        if (addr.town) parts.push(addr.town);
        if (addr.village) parts.push(addr.village);
        if (addr.suburb) parts.push(addr.suburb);
  
        return json({ ok: true, found: true, jurisdiction: parts.join(" ") || "", raw: addr });
      } catch (e) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }
  
    // /zoning/by-coord : (현재는 demo stub 유지)
    if (path === "/zoning/by-coord") {
      const lat = toNum(url.searchParams.get("lat"));
      const lon = toNum(url.searchParams.get("lon"));
      if (lat == null || lon == null) return json({ ok: false, error: "missing lat/lon" }, 400);
  
      return json({
        ok: true,
        found: true,
        zoning: "제1종일반주거지역",
        source: "demo_stub_cloudflare",
        hint: "VWorld는 무료키/도메인 이슈가 있어서 우선 demo로 유지. 다음 단계에서 Worker env로 키 넣고 연결.",
      });
    }
  
    // /rules/zoning
    if (path === "/rules/zoning") {
      const list = extractZoningList(data.base);
      const fallback = ["제1종일반주거지역","제2종일반주거지역","제3종일반주거지역","일반상업지역","준공업지역"];
      return json({ ok: true, list: list.length ? list : fallback, source: list.length ? "base_rules" : "fallback" });
    }
  
    // /rules/apply?zoning=
    if (path === "/rules/apply") {
      const zoning = String(url.searchParams.get("zoning") || "").trim();
      if (!zoning) return json({ ok: false, error: "missing zoning" }, 400);
  
      const rule = findRuleByZoning(data.base, zoning);
      if (!rule || typeof rule === "string") {
        return json({ ok: true, rule: { zoning, bcr_max: 60, far_max: 200, source: "fallback" } });
      }
      return json({ ok: true, rule: { ...rule, source: "base_rules" } });
    }
  
    // /uses
    if (path === "/uses") {
      const fromBase = getUsesCatalogFromBase(data.base);
      const fallback = [
        { code: "RES_HOUSE", label: "단독/다가구(주거)" },
        { code: "RES_MULTI", label: "공동주택(간이)" },
        { code: "NEIGHBOR_1", label: "제1종근린생활시설(간이)" },
        { code: "NEIGHBOR_2", label: "제2종근린생활시설(간이)" },
        { code: "OFFICE", label: "업무시설(간이)" },
      ];
      return json({ ok: true, list: fromBase || fallback, source: fromBase ? "base_rules.uses_catalog" : "fallback" });
    }
  
    // /uses/check?zoning=&use=
    if (path === "/uses/check") {
      const zoning = String(url.searchParams.get("zoning") || "").trim();
      const use = String(url.searchParams.get("use") || "").trim();
      if (!zoning) return json({ ok: false, error: "missing zoning" }, 400);
      if (!use) return json({ ok: false, error: "missing use" }, 400);
  
      const rule = findRuleByZoning(data.base, zoning);
      if (!rule || typeof rule === "string") {
        return json({ ok: true, zoning, use, status: "unknown", message: "❓ 해당 용도지역 룰이 없습니다(간이 판정 불가)", source: "base_rules_not_found" });
      }
  
      const usesMap = rule?.uses || {};
      const rawStatus = usesMap?.[use];
      const status = normalizeStatus(rawStatus || "unknown");
      const message = buildUseMessage(status);
      return json({ ok: true, zoning, use, status, message, source: "base_rules.rules[].uses" });
    }
  
    // /laws?all=1 | /laws?codes=A,B
    if (path === "/laws") {
      const all = String(url.searchParams.get("all") || "").trim();
      const codes = String(url.searchParams.get("codes") || "").trim();
      const db = data.laws || {};
  
      if (all === "1") {
        const out = {};
        Object.keys(db).forEach((k) => (out[k] = { code: k, ...db[k] }));
        return json({ ok: true, list: out, meta: { count: Object.keys(out).length, limited: false }, source: "file_fallback" });
      }
  
      if (!codes) return json({ ok: false, error: "missing codes (or use ?all=1)" }, 400);
  
      const arr = codes.split(",").map((s) => String(s).trim()).filter(Boolean);
      const out = {};
      const missing = [];
      for (const c of arr) {
        if (db[c]) out[c] = { code: c, ...db[c] };
        else missing.push(c);
      }
      return json({ ok: true, list: out, missing, meta: { count: Object.keys(out).length, requested: arr.length }, source: "file_fallback" });
    }
  
    // /laws/:code
    if (path.startsWith("/laws/")) {
      const code = decodeURIComponent(path.slice("/laws/".length)).trim();
      if (!code) return json({ ok: false, error: "missing code" }, 400);
      const db = data.laws || {};
      const picked = db[code] ? { code, ...db[code] } : null;
      return json({ ok: true, found: !!picked, code, data: picked, source: "file_fallback" });
    }
  
    // /checklists/enriched
    if (path === "/checklists/enriched") {
      const zoning = String(url.searchParams.get("zoning") || "").trim();
      const use = String(url.searchParams.get("use") || "").trim();
      const jurisdiction = String(url.searchParams.get("jurisdiction") || "").trim();
  
      const floors = toNum(url.searchParams.get("floors"));
      const height_m = toNum(url.searchParams.get("height_m"));
      const gross_area_m2 = toNum(url.searchParams.get("gross_area_m2"));
  
      const values = { floors, height_m, gross_area_m2 };
      const ctx = { zoning, use, jurisdiction, floors, height_m, gross_area_m2 };
  
      const listRaw = data.checklists?.default_conditional || [];
      const filtered = listRaw.filter((it) => passesAppliesTo(it, ctx));
  
      const ruleMap = indexRuleEngineById(data.ruleEngine);
      const enriched = filtered.map((it) => {
        const eng = ruleMap.get(String(it.id)) || {};
        const rule_set = eng.rule_set || null;
        const auto_rules = Array.isArray(eng.auto_rules) ? eng.auto_rules : [];
        const optional_inputs = Array.isArray(eng.optional_inputs) ? eng.optional_inputs : [];
  
        let server_judge = null;
        const judged = evaluateFirstMatch(auto_rules, values);
        if (judged) server_judge = judged;
        else if (rule_set && rule_set.default_result) {
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
  
        return { ...it, rule_set, auto_rules, optional_inputs, server_judge, missing_inputs };
      });
  
      return json({ ok: true, data: { default_conditional: enriched }, meta: { ctx }, source: "checklists+rule_engine" });
    }
  
    // /checklists/judge (POST)
    if (path === "/checklists/judge") {
      if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  
      const body = await req.json().catch(() => ({}));
      const contextIn = body.context || {};
      const zoning = String(contextIn.zoning || "").trim();
      const use = String(contextIn.use || "").trim();
      const jurisdiction = String(contextIn.jurisdiction || "").trim();
  
      const valuesIn = body.values || {};
      const values = {};
      for (const k of Object.keys(valuesIn)) {
        const v = valuesIn[k];
        const n = toNum(v);
        values[k] = n != null ? n : v;
      }
  
      const ctx = { zoning, use, jurisdiction };
      const listRaw = data.checklists?.default_conditional || [];
      const filtered = listRaw.filter((it) => passesAppliesTo(it, { ...ctx, ...values }));
  
      const ruleMap = indexRuleEngineById(data.ruleEngine);
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
        if (status === "need_input") missing_inputs = buildMissingInputs(it, values, optional_inputs);
  
        return { id: it.id, status, message, missing_inputs, judge: judged || null };
      });
  
      return json({ ok: true, data: { results }, meta: { ctx }, source: "judge_engine" });
    }
  
    // fallback
    return json({ ok: false, error: "not_found", path: url.pathname }, 404);
  }
  