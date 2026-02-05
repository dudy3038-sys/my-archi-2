// public/functions/api/[[path]].js
// Cloudflare Pages Functions catch-all API router
// - Frontend calls /api/*
// - This file must live under: public/functions/api/[[path]].js

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
    // ---------- helpers ----------
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

    const notFound = (msg = "not_found") =>
      json({ ok: false, error: msg, path: pathname }, 404);

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
        result: {
          maxBuildingArea_m2,
          maxTotalFloorArea_m2,
          estFloors,
          estHeight_m,
        },
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
      const jurisdiction =
        addr.city || addr.county || addr.state || addr.region || addr.town || addr.village || "";

      return json({
        ok: true,
        found: true,
        jurisdiction: String(jurisdiction || "").trim(),
        raw: data,
      });
    }

    // ---------- route: /api/zoning/by-coord ----------
    // (지금은 “추정 불가”로 두고, 나중에 실제 데이터 연동)
    if (segs[0] === "zoning" && segs[1] === "by-coord" && method === "GET") {
      return json({
        ok: true,
        found: false,
        zoning: "",
        note: "좌표 기반 용도지역 자동추정은 아직 데이터 연동 전입니다. (수동 선택 가능)",
      });
    }

    // ---------- rules json loaders ----------
    const loadBaseRules = async () =>
      (await assetJson("/rules/base_rules.json")) ||
      (await assetJson("/public/rules/base_rules.json"));

    const loadRuleEngine = async () =>
      (await assetJson("/rules/rule_engine.json")) ||
      (await assetJson("/public/rules/rule_engine.json"));

    const loadChecklists = async () =>
      (await assetJson("/rules/checklists.json")) ||
      (await assetJson("/public/rules/checklists.json"));

    const loadLaws = async () =>
      (await assetJson("/rules/laws.json")) ||
      (await assetJson("/public/rules/laws.json"));

    // ---------- route: /api/rules/zoning ----------
    if (segs[0] === "rules" && segs[1] === "zoning" && method === "GET") {
      const base = await loadBaseRules();
      const list =
        base?.zoning_rules?.map?.((x) => x?.zoning).filter(Boolean) ||
        base?.zoning_list ||
        base?.zonings ||
        [];
      const uniq = Array.from(new Set(list.map(String)));
      return json({ ok: true, list: uniq });
    }

    // ---------- route: /api/rules/apply ----------
    if (segs[0] === "rules" && segs[1] === "apply" && method === "GET") {
      const url = new URL(request.url);
      const zoning = (url.searchParams.get("zoning") || "").trim();
      if (!zoning) return json({ ok: false, error: "missing_zoning" }, 400);

      const base = await loadBaseRules();
      const zr =
        (base?.zoning_rules || []).find((r) => String(r?.zoning || "") === zoning) ||
        null;

      if (!zr) {
        return json({ ok: true, rule: { zoning, bcr_max: null, far_max: null }, note: "zoning rule not found" });
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

      // 매우 관대한(안전한) 기본 동작:
      // - rule_engine.json에 매핑이 있으면 그것 사용
      // - 없으면 conditional(추가검토)로 두고 체크리스트를 보여주도록 유도
      let status = "conditional";
      let message = "⚠️ 추가 검토가 필요합니다. 체크리스트를 확인해 주세요.";

      const map = engine?.use_matrix || engine?.use_rules || null;
      if (map && map[zoning] && map[zoning][use]) {
        const hit = map[zoning][use];
        status = hit.status || hit.result || status;
        message = hit.message || message;
      }

      return json({
        ok: true,
        zoning,
        use,
        status,
        message,
      });
    }

    // ---------- route: /api/checklists/enriched ----------
    if (segs[0] === "checklists" && segs[1] === "enriched" && method === "GET") {
      const url = new URL(request.url);
      const zoning = (url.searchParams.get("zoning") || "").trim();
      const use = (url.searchParams.get("use") || "").trim();

      const raw = await loadChecklists();
      // 다양한 포맷 대응: raw.default_conditional / raw.items / raw.checklists 등
      const items =
        raw?.default_conditional ||
        raw?.items ||
        raw?.checklists ||
        [];

      return json({
        ok: true,
        data: {
          default_conditional: Array.isArray(items) ? items : [],
        },
        meta: { zoning, use, source: "checklists.json" },
      });
    }

    // ---------- route: /api/checklists/judge ----------
    if (segs[0] === "checklists" && segs[1] === "judge" && method === "POST") {
      const body = await readJson();
      const ctx = body?.context || {};
      const values = body?.values || {};

      const raw = await loadChecklists();
      const items =
        raw?.default_conditional ||
        raw?.items ||
        raw?.checklists ||
        [];

      // simple judge: mark need_input if required keys missing
      const results = (Array.isArray(items) ? items : []).map((it) => {
        const inputs = Array.isArray(it?.inputs) ? it.inputs : [];
        const needKeys = inputs
          .map((x) => (typeof x === "string" ? x : x?.key))
          .filter(Boolean)
          .map(String);

        const missing_inputs = [];
        for (const k of needKeys) {
          const v = values?.[k];
          const miss =
            v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (typeof v === "number" && !Number.isFinite(v));
          if (miss) missing_inputs.push({ key: k, label: k });
        }

        const status = missing_inputs.length ? "need_input" : "conditional";
        const message = missing_inputs.length
          ? "입력값이 부족해요. 필요한 값을 채우면 자동으로 더 정확히 판정됩니다."
          : "입력값 기준으로 추가 검토 항목입니다.";

        return { id: it.id, status, message, missing_inputs };
      });

      return json({
        ok: true,
        data: { results },
        meta: { context: ctx },
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
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message || err || "internal_error") }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}
