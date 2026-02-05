// functions/api/[[path]].js
// Cloudflare Pages Functions catch-all API router
// - Frontend calls /api/*
// - This file must live under: functions/api/[[path]].js

export async function onRequest(context) {
  const { request, env, params } = context;

  // [[path]] can be a string or array depending on match depth
  const segs = Array.isArray(params?.path)
    ? params.path
    : typeof params?.path === "string"
      ? params.path.split("/").filter(Boolean)
      : [];

  const pathname = new URL(request.url).pathname; // e.g. /api/geocode
  const method = request.method.toUpperCase();

  try {
    /* =========================
       helpers
    ========================= */
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });

    const readJson = async () => {
      const text = await request.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    // Read JSON from static assets (public/...) via Pages ASSETS binding
    // Put your json files under public/rules/*.json
    const assetJson = async (assetPath) => {
      if (!env?.ASSETS) return null;
      const u = new URL(assetPath, request.url);
      const r = await env.ASSETS.fetch(new Request(u.toString(), { method: "GET" }));
      if (!r.ok) return null;
      try {
        return await r.json();
      } catch {
        return null;
      }
    };

    const notFound = (msg = "not_found") => json({ ok: false, error: msg, path: pathname }, 404);

    /* =========================
       loaders
    ========================= */
    const loadBaseRules = async () =>
      (await assetJson("/rules/base_rules.json")) || (await assetJson("/public/rules/base_rules.json"));

    const loadRuleEngine = async () =>
      (await assetJson("/rules/rule_engine.json")) || (await assetJson("/public/rules/rule_engine.json"));

    const loadChecklists = async () =>
      (await assetJson("/rules/checklists.json")) || (await assetJson("/public/rules/checklists.json"));

    const loadLaws = async () =>
      (await assetJson("/rules/laws.json")) || (await assetJson("/public/rules/laws.json"));

    // ✅ base_rules.json 포맷 차이 흡수:
    // - 구버전: { zoning_rules: [...] }
    // - 신버전: { rules: [...] }
    const getZoningRulesArray = (base) => {
      const a =
        (Array.isArray(base?.zoning_rules) && base.zoning_rules) ||
        (Array.isArray(base?.rules) && base.rules) ||
        [];
      return a;
    };

    const getChecklistArray = (raw) => {
      const items = raw?.default_conditional || raw?.items || raw?.checklists || [];
      return Array.isArray(items) ? items : [];
    };

    /* =========================
       rule engine helpers
    ========================= */
    const normalizeStatus = (s) => {
      const v = String(s || "").trim().toLowerCase();
      if (v === "allow") return "allow";
      if (v === "deny") return "deny";
      if (v === "conditional") return "conditional";
      if (v === "need_input") return "need_input";
      if (v === "unknown") return "unknown";
      if (v === "warn") return "conditional"; // legacy
      return "unknown";
    };

    const toNum = (v) => {
      if (v === "" || v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const isMissingValue = (v) => {
      if (v === undefined || v === null) return true;
      if (typeof v === "number") return !Number.isFinite(v);
      return String(v).trim() === "";
    };

    const evalCond = (cond, values) => {
      if (!cond || !cond.key || !cond.op) return false;

      const op = String(cond.op).trim().toLowerCase();
      const key = String(cond.key).trim();
      const raw = values?.[key];

      if (op === "missing") return isMissingValue(raw);
      if (op === "present") return !isMissingValue(raw);

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
    };

    const ruleMatches = (rule, values) => {
      if (!rule) return false;

      if (rule.when) return evalCond(rule.when, values);

      if (Array.isArray(rule.when_all) && rule.when_all.length > 0) {
        return rule.when_all.every((c) => evalCond(c, values));
      }

      if (Array.isArray(rule.when_any) && rule.when_any.length > 0) {
        return rule.when_any.some((c) => evalCond(c, values));
      }

      return false;
    };

    const evaluateAutoRules = (engineItem, values) => {
      const rules = Array.isArray(engineItem?.auto_rules) ? engineItem.auto_rules : [];
      if (!rules.length) return null;

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
    };

    const buildNeedKeys = (checkItem, engineItem) => {
      const inputs = Array.isArray(checkItem?.inputs) ? checkItem.inputs : [];
      const keys = inputs
        .map((x) => (typeof x === "string" ? x : x?.key))
        .filter(Boolean)
        .map(String);

      const optional = new Set(
        (Array.isArray(engineItem?.optional_inputs) ? engineItem.optional_inputs : [])
          .filter(Boolean)
          .map(String)
      );

      return keys.filter((k) => !optional.has(k));
    };

    const computeMissingInputs = (needKeys, values) => {
      const missing = [];
      for (const k of needKeys) {
        const v = values?.[k];
        if (isMissingValue(v)) missing.push({ key: k, label: k });
      }
      return missing;
    };

    const judgeOneItem = (checkItem, engineItem, values) => {
      const ruleSet = engineItem?.rule_set || {};
      const defaultResult = normalizeStatus(ruleSet.default_result || "conditional");
      const defaultMessage = String(ruleSet.default_message || "⚠️ 추가 검토가 필요합니다.").trim();

      const needKeys = buildNeedKeys(checkItem, engineItem);
      const missing_inputs = computeMissingInputs(needKeys, values);

      const hit = evaluateAutoRules(engineItem, values);

      // 결과 결정:
      // - auto_rules hit가 있으면 그 결과 사용
      // - 없으면 rule_set default 사용
      // - 단, 결과가 need_input인데 실제로 missing이 없으면 conditional로 완화(데이터 실수 방어)
      let status = hit?.result ? normalizeStatus(hit.result) : defaultResult;
      let message = hit?.message ? String(hit.message).trim() : defaultMessage;

      if (status === "need_input" && missing_inputs.length === 0) {
        status = "conditional";
        message = message || defaultMessage;
      }

      return {
        id: checkItem.id,
        status,
        message,
        missing_inputs,
        judge: hit || null,
      };
    };

    /* =========================
       applies_to filtering
    ========================= */
    const includesStr = (arr, s) => {
      if (!Array.isArray(arr) || arr.length === 0) return true;
      return arr.map((x) => String(x).trim()).includes(String(s || "").trim());
    };

    const appliesToPass = (item, ctx) => {
      const a = item?.applies_to;
      if (!a) return true;

      // 문자열 컨텍스트
      if (Array.isArray(a.zoning_in) && a.zoning_in.length > 0) {
        if (!includesStr(a.zoning_in, ctx.zoning)) return false;
      }
      if (Array.isArray(a.use_in) && a.use_in.length > 0) {
        if (!includesStr(a.use_in, ctx.use)) return false;
      }
      if (Array.isArray(a.jurisdiction_in) && a.jurisdiction_in.length > 0) {
        if (!includesStr(a.jurisdiction_in, ctx.jurisdiction)) return false;
      }

      // 숫자 조건
      const curArea = toNum(ctx.gross_area_m2);
      const curFloors = toNum(ctx.floors);
      const curHeight = toNum(ctx.height_m);

      if (a.min_gross_area_m2 != null) {
        const th = toNum(a.min_gross_area_m2);
        if (th != null) {
          // 값이 없으면 "판단 불가" → 표시(UX상 입력 유도)
          if (curArea == null) return true;
          if (curArea < th) return false;
        }
      }
      if (a.min_floors != null) {
        const th = toNum(a.min_floors);
        if (th != null) {
          if (curFloors == null) return true;
          if (curFloors < th) return false;
        }
      }
      if (a.min_height_m != null) {
        const th = toNum(a.min_height_m);
        if (th != null) {
          if (curHeight == null) return true;
          if (curHeight < th) return false;
        }
      }

      return true;
    };

    /* =========================
       routes
    ========================= */

    // ---------- route: /api/calc ----------
    if (segs[0] === "calc" && method === "GET") {
      const url = new URL(request.url);
      const site = Number(url.searchParams.get("site"));
      const coverage = Number(url.searchParams.get("coverage"));
      const far = Number(url.searchParams.get("far"));
      const floor = Number(url.searchParams.get("floor") || 3.3);

      if (![site, coverage, far, floor].every((n) => Number.isFinite(n) && n > 0)) {
        return json({ ok: false, error: "invalid_params" }, 400);
      }

      const maxBuildingArea_m2 = (site * coverage) / 100;
      const maxTotalFloorArea_m2 = (site * far) / 100;
      const estFloors = Math.max(1, Math.floor(maxTotalFloorArea_m2 / Math.max(1, maxBuildingArea_m2)));
      const estHeight_m = estFloors * floor;

      return json({
        ok: true,
        result: { maxBuildingArea_m2, maxTotalFloorArea_m2, estFloors, estHeight_m },
        note: "단순 산정(간이)입니다. 실제는 도로·조례·심의·지구단위 등으로 달라질 수 있어요.",
      });
    }

    // ---------- route: /api/geocode ----------
    if (segs[0] === "geocode" && method === "GET") {
      const url = new URL(request.url);
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ ok: false, error: "missing_q" }, 400);

      // Nominatim (OSM) — User-Agent required
      const nomUrl = new URL("https://nominatim.openstreetmap.org/search");
      nomUrl.searchParams.set("q", q);
      nomUrl.searchParams.set("format", "json");
      nomUrl.searchParams.set("limit", "1");
      nomUrl.searchParams.set("addressdetails", "1");

      const r = await fetch(nomUrl.toString(), {
        headers: {
          "user-agent": "my-archi-2 (Cloudflare Pages Functions)",
          "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
        },
      });
      if (!r.ok) return json({ ok: false, error: "geocode_failed" }, 502);

      const arr = await r.json().catch(() => []);
      const hit = Array.isArray(arr) && arr.length ? arr[0] : null;

      if (!hit) return json({ ok: true, found: false, result: null });

      return json({
        ok: true,
        found: true,
        result: {
          lat: hit.lat,
          lon: hit.lon,
          display_name: hit.display_name,
          address: hit.address || null,
        },
      });
    }

    // ---------- route: /api/reverse ----------
    if (segs[0] === "reverse" && method === "GET") {
      const url = new URL(request.url);
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return json({ ok: false, error: "invalid_latlon" }, 400);
      }

      const nomUrl = new URL("https://nominatim.openstreetmap.org/reverse");
      nomUrl.searchParams.set("lat", String(lat));
      nomUrl.searchParams.set("lon", String(lon));
      nomUrl.searchParams.set("format", "json");
      nomUrl.searchParams.set("zoom", "12");
      nomUrl.searchParams.set("addressdetails", "1");

      const r = await fetch(nomUrl.toString(), {
        headers: { "user-agent": "my-archi-2 (Cloudflare Pages Functions)" },
      });
      if (!r.ok) return json({ ok: false, error: "reverse_failed" }, 502);

      const data = await r.json().catch(() => null);
      const addr = data?.address || {};
      const jurisdiction = addr.city || addr.county || addr.state || addr.region || addr.town || addr.village || "";

      return json({
        ok: true,
        found: true,
        jurisdiction: String(jurisdiction || "").trim(),
        raw: data,
      });
    }

    /* =========================
       VWorld helpers (그대로 유지)
    ========================= */

    const pickFirstZoningName = (feature) => {
      const p = feature?.properties || feature?.property || {};
      const cand =
        p.uname ||
        p.UNAME ||
        p.zonename ||
        p.ZONENAME ||
        p.zone_nm ||
        p.ZONE_NM ||
        p.name ||
        p.NAME ||
        p.dong_nm ||
        p.DONG_NM ||
        null;
      return cand ? String(cand).trim() : "";
    };

    const vworldGetFeatureAtPoint = async ({ lon, lat, dataId, columns }) => {
      const key = env?.VWORLD_KEY || env?.V_WORLD_KEY || env?.VWORLD_API_KEY;
      if (!key) return { ok: false, error: "missing_vworld_key" };

      const u = new URL("https://api.vworld.kr/req/data");
      u.searchParams.set("service", "data");
      u.searchParams.set("version", "2.0");
      u.searchParams.set("request", "GetFeature");
      u.searchParams.set("format", "json");
      u.searchParams.set("key", key);

      const domain = env?.VWORLD_DOMAIN || env?.V_WORLD_DOMAIN || env?.VWORLD_KEY_DOMAIN;
      if (domain) u.searchParams.set("domain", domain);

      u.searchParams.set("data", dataId);
      u.searchParams.set("geomFilter", `POINT(${lon} ${lat})`);
      u.searchParams.set("size", "10");
      u.searchParams.set("page", "1");
      u.searchParams.set("geometry", "false");
      u.searchParams.set("attribute", "true");

      const buf = Number(env?.VWORLD_BUFFER_M ?? 0);
      if (Number.isFinite(buf) && buf > 0) u.searchParams.set("buffer", String(buf));

      u.searchParams.set("crs", "EPSG:4326");
      if (columns) u.searchParams.set("columns", columns);

      const r = await fetch(u.toString(), {
        headers: {
          accept: "application/json",
          "user-agent": "my-archi-2 (Cloudflare Pages Functions)",
        },
      });

      const rawText = await r.text().catch(() => "");
      let parsed = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }

      if (!r.ok) {
        return {
          ok: false,
          error: "vworld_http_error",
          status: r.status,
          detail: parsed || rawText || null,
        };
      }

      const result = parsed?.response?.result || parsed?.result || parsed;

      const features =
        result?.features ||
        result?.featureCollection?.features ||
        result?.geojson?.features ||
        parsed?.response?.result?.featureCollection?.features ||
        [];

      const arr = Array.isArray(features) ? features : [];
      return { ok: true, features: arr, raw: parsed };
    };

    const stripParen = (s) => String(s || "").replace(/\([^)]*\)/g, "");
    const normalizeZoningKey = (s) =>
      stripParen(String(s || ""))
        .trim()
        .replace(/\s+/g, "")
        .replace(/[·ㆍ]/g, "")
        .toLowerCase();

    const resolveZoningToBase = (rawName, baseRulesArr) => {
      const raw = String(rawName || "").trim();
      if (!raw) return { matched: false, zoning: "", raw_name: "", normalized: "" };

      const nz = normalizeZoningKey(raw);

      const exact = baseRulesArr.find((r) => String(r?.zoning || "").trim() === raw);
      if (exact) return { matched: true, zoning: String(exact.zoning), raw_name: raw, normalized: nz };

      const hitNorm = baseRulesArr.find((r) => normalizeZoningKey(r?.zoning) === nz);
      if (hitNorm) return { matched: true, zoning: String(hitNorm.zoning), raw_name: raw, normalized: nz };

      const candidates = baseRulesArr
        .map((r) => String(r?.zoning || "").trim())
        .filter(Boolean)
        .filter((z) => {
          const nz2 = normalizeZoningKey(z);
          return nz.includes(nz2) || nz2.includes(nz);
        });

      const uniq = Array.from(new Set(candidates));
      if (uniq.length === 1) {
        return { matched: true, zoning: uniq[0], raw_name: raw, normalized: nz, candidates: uniq };
      }

      return { matched: false, zoning: "", raw_name: raw, normalized: nz, candidates: uniq };
    };

    // ---------- route: /api/zoning/by-coord ----------
    if (segs[0] === "zoning" && segs[1] === "by-coord" && method === "GET") {
      const url = new URL(request.url);
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return json({ ok: false, error: "invalid_latlon" }, 400);
      }

      const hasKey = !!(env?.VWORLD_KEY || env?.V_WORLD_KEY || env?.VWORLD_API_KEY);
      if (!hasKey) {
        return json({
          ok: true,
          found: false,
          zoning: "",
          note: "VWORLD_KEY 환경변수가 없어 자동 조회를 건너뛰었습니다. (수동 선택 가능)",
        });
      }

      const base = await loadBaseRules();
      const baseArr = getZoningRulesArray(base);

      const datasets = String(env?.VWORLD_ZONING_DATASETS || "LT_C_UQ111")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const tried = [];
      let lastError = null;

      for (const dataId of datasets) {
        tried.push(dataId);

        const res = await vworldGetFeatureAtPoint({
          lon,
          lat,
          dataId,
          columns: env?.VWORLD_COLUMNS ? String(env.VWORLD_COLUMNS) : "",
        });

        if (!res.ok) {
          lastError = res;
          continue;
        }

        const first = res.features?.[0] || null;
        const rawName = pickFirstZoningName(first);
        if (!rawName) continue;

        const mapped = resolveZoningToBase(rawName, baseArr);

        if (mapped.matched && mapped.zoning) {
          return json({
            ok: true,
            found: true,
            zoning: mapped.zoning,
            source: { provider: "vworld", data: dataId },
            raw_name: mapped.raw_name,
            note: "좌표 기반 자동 조회 결과(정규화 매칭)입니다. 실제 적용은 지구단위/조례 등 추가 검토 필요.",
          });
        }

        const tryAll = String(env?.VWORLD_TRY_ALL_DATASETS || "").toLowerCase() === "true";
        if (!tryAll) {
          return json({
            ok: true,
            found: false,
            zoning: "",
            source: { provider: "vworld", data: dataId, tried },
            raw_name: mapped.raw_name,
            normalized: mapped.normalized,
            candidates: mapped.candidates || [],
            note:
              "V월드에서 명칭은 찾았지만 base_rules.json의 용도지역명과 매칭되지 않아 자동 설정을 중단했습니다. (수동 선택 가능)",
            debug: env?.DEBUG_VWORLD
              ? { hint: "base_rules.json의 zoning 문자열과 VWorld 반환 문자열(공백/괄호/표기)이 다를 수 있어요." }
              : undefined,
          });
        }
      }

      return json({
        ok: true,
        found: false,
        zoning: "",
        source: { provider: "vworld", tried },
        note:
          "V월드 조회는 됐지만 해당 좌표에서 용도지역 명칭을 추출하지 못했습니다. (데이터셋/필드명이 다를 수 있어요)",
        debug: env?.DEBUG_VWORLD ? { lastError } : undefined,
      });
    }

    // ---------- route: /api/rules/zoning ----------
    if (segs[0] === "rules" && segs[1] === "zoning" && method === "GET") {
      const base = await loadBaseRules();
      const rulesArr = getZoningRulesArray(base);

      const list = rulesArr
        .map((x) => x?.zoning)
        .filter(Boolean)
        .map(String);

      const uniq = Array.from(new Set(list));
      return json({ ok: true, list: uniq });
    }

    // ---------- route: /api/rules/apply ----------
    if (segs[0] === "rules" && segs[1] === "apply" && method === "GET") {
      const url = new URL(request.url);
      const zoning = (url.searchParams.get("zoning") || "").trim();
      if (!zoning) return json({ ok: false, error: "missing_zoning" }, 400);

      const base = await loadBaseRules();
      const rulesArr = getZoningRulesArray(base);

      const zr = rulesArr.find((r) => String(r?.zoning || "") === zoning) || null;

      if (!zr) {
        return json({
          ok: true,
          rule: { zoning, bcr_max: null, far_max: null },
          note: "zoning rule not found",
        });
      }

      return json({
        ok: true,
        rule: {
          zoning,
          bcr_max: zr.bcr_max ?? zr.bcr ?? null,
          far_max: zr.far_max ?? zr.far ?? null,
        },
      });
    }

    // ---------- route: /api/uses ----------
    if (segs[0] === "uses" && segs.length === 1 && method === "GET") {
      const base = await loadBaseRules();
      const list = Array.isArray(base?.uses_catalog) ? base.uses_catalog : [];
      return json({ ok: true, list });
    }

    // ---------- route: /api/uses/check ----------
    if (segs[0] === "uses" && segs[1] === "check" && method === "GET") {
      const url = new URL(request.url);
      const zoning = (url.searchParams.get("zoning") || "").trim();
      const use = (url.searchParams.get("use") || "").trim();
      if (!zoning || !use) return json({ ok: false, error: "missing_zoning_or_use" }, 400);

      const engine = await loadRuleEngine();

      let status = "conditional";
      let message = "⚠️ 추가 검토가 필요합니다. 체크리스트를 확인해 주세요.";

      const map = engine?.use_matrix || engine?.use_rules || null;
      if (map && map[zoning] && map[zoning][use]) {
        const hit = map[zoning][use];
        status = hit.status || hit.result || status;
        message = hit.message || message;
      }

      return json({ ok: true, zoning, use, status, message });
    }

    /* =========================
       ✅ /api/checklists/enriched
       - applies_to 필터링
       - rule_engine merge
       - server_judge 사전 부착
    ========================= */
    if (segs[0] === "checklists" && segs[1] === "enriched" && method === "GET") {
      const url = new URL(request.url);
      const zoning = (url.searchParams.get("zoning") || "").trim();
      const use = (url.searchParams.get("use") || "").trim();
      const jurisdiction = (url.searchParams.get("jurisdiction") || "").trim();

      const floors = toNum(url.searchParams.get("floors"));
      const height_m = toNum(url.searchParams.get("height_m"));
      const gross_area_m2 = toNum(url.searchParams.get("gross_area_m2"));

      const ctx = { zoning, use, jurisdiction, floors, height_m, gross_area_m2 };

      const [rawChecklist, engine] = await Promise.all([loadChecklists(), loadRuleEngine()]);
      const baseItems = getChecklistArray(rawChecklist);

      const engineItems = Array.isArray(engine?.default_conditional) ? engine.default_conditional : [];
      const engineById = new Map(engineItems.map((x) => [String(x?.id || ""), x]).filter(([k]) => k));

      // judge에 쓰일 values: 쿼리스트링 값만(프론트가 calc 값을 넘겨줌)
      const values = {
        floors: floors ?? undefined,
        height_m: height_m ?? undefined,
        gross_area_m2: gross_area_m2 ?? undefined,
      };

      const enriched = baseItems
        .filter((it) => appliesToPass(it, ctx))
        .map((it) => {
          const id = String(it?.id || "");
          const eng = engineById.get(id) || null;

          // rule_engine에 없는 항목도 최소한 default judge를 달아줌
          const fallbackEngine = eng || {
            id,
            rule_set: { default_result: "conditional", default_message: "⚠️ 추가 검토가 필요합니다." },
            optional_inputs: [],
            auto_rules: [],
          };

          const judged = judgeOneItem(it, fallbackEngine, values);

          return {
            ...it,
            // server_judge는 프론트가 초기 배지 표시하는데 사용
            server_judge: { result: judged.status, message: judged.message, rule_id: judged.judge?.rule_id || null },
            missing_inputs: judged.missing_inputs || [],
          };
        });

      return json({
        ok: true,
        data: { default_conditional: enriched },
        meta: {
          zoning,
          use,
          jurisdiction,
          values,
          source: "checklists.json + rule_engine.json",
        },
      });
    }

    /* =========================
       ✅ /api/checklists/judge
       - rule_engine 기반 자동판정 + optional_inputs 반영
       - laws.json 미등록 refs 수집(meta.missing_refs)
    ========================= */
    if (segs[0] === "checklists" && segs[1] === "judge" && method === "POST") {
      const body = await readJson();
      const ctx = body?.context || {};
      const values = body?.values || {};

      const [rawChecklist, engine, laws] = await Promise.all([loadChecklists(), loadRuleEngine(), loadLaws()]);
      const items = getChecklistArray(rawChecklist);

      const engineItems = Array.isArray(engine?.default_conditional) ? engine.default_conditional : [];
      const engineById = new Map(engineItems.map((x) => [String(x?.id || ""), x]).filter(([k]) => k));

      const missingRefSet = new Set();
      const lawsMap = laws || {};

      const results = items.map((it) => {
        const id = String(it?.id || "");
        const eng = engineById.get(id) || null;

        const fallbackEngine = eng || {
          id,
          rule_set: { default_result: "conditional", default_message: "⚠️ 추가 검토가 필요합니다." },
          optional_inputs: [],
          auto_rules: [],
        };

        // refs 누락 수집
        const refs = Array.isArray(it?.refs) ? it.refs : [];
        refs.forEach((c) => {
          const code = String(c || "").trim();
          if (!code) return;
          if (!lawsMap[code]) missingRefSet.add(code);
        });

        const judged = judgeOneItem(it, fallbackEngine, values);

        return {
          id,
          status: judged.status,
          message: judged.message,
          missing_inputs: judged.missing_inputs,
          judge: judged.judge,
        };
      });

      return json({
        ok: true,
        data: { results },
        meta: {
          context: ctx,
          missing_refs: Array.from(missingRefSet),
          source: "rule_engine.json + checklists.json",
        },
      });
    }

    // ---------- route: /api/laws (bulk) ----------
    if (segs[0] === "laws" && segs.length === 1 && method === "GET") {
      const url = new URL(request.url);
      const codes = (url.searchParams.get("codes") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const laws = (await loadLaws()) || {};
      const list = {};
      const missing = [];

      for (const c of codes) {
        if (laws[c]) list[c] = laws[c];
        else missing.push(c);
      }

      return json({ ok: true, list, missing, source: "laws.json" });
    }

    // ---------- route: /api/laws/:code ----------
    if (segs[0] === "laws" && segs[1] && method === "GET") {
      const code = decodeURIComponent(segs[1]);
      const laws = (await loadLaws()) || {};
      const hit = laws[code] || null;

      return json({
        ok: true,
        found: !!hit,
        code,
        data: hit,
        source: "laws.json",
      });
    }

    // fallback
    return notFound("unknown_api_route");
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err || "internal_error") }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
