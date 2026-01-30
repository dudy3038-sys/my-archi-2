const express = require("express");
const cors = require("cors");

// ✅ v2 방식
const { onRequest } = require("firebase-functions/v2/https");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// 테스트: GET /api/ping
app.get("/api/ping", (req, res) => {
  res.status(200).json({ ok: true, msg: "pong" });
});

app.get("/api/worldbank/top5", async (req, res) => {
  try {
    const url =
      "https://api.worldbank.org/v2/country?format=json&per_page=5&page=1";

    const r = await fetch(url);
    const data = await r.json();

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 건축 기본 산정: GET /api/calc
// 예) /api/calc?site=200&coverage=60&far=200&floor=3.3
app.get("/api/calc", (req, res) => {
  const site = Number(req.query.site);       // 대지면적(m²)
  const coverage = Number(req.query.coverage); // 건폐율(%)
  const far = Number(req.query.far);           // 용적률(%)
  const floorH = Number(req.query.floor ?? 3.3); // 층고 가정(m)

  // 입력 검증
  if (!Number.isFinite(site) || site <= 0) {
    return res.status(400).json({ ok: false, error: "site(대지면적)를 올바르게 입력해줘" });
  }
  if (!Number.isFinite(coverage) || coverage <= 0) {
    return res.status(400).json({ ok: false, error: "coverage(건폐율)를 올바르게 입력해줘" });
  }
  if (!Number.isFinite(far) || far <= 0) {
    return res.status(400).json({ ok: false, error: "far(용적률)를 올바르게 입력해줘" });
  }
  if (!Number.isFinite(floorH) || floorH <= 0) {
    return res.status(400).json({ ok: false, error: "floor(층고)를 올바르게 입력해줘" });
  }

  // 산정
  const maxBuildingArea = site * (coverage / 100); // 최대 건축면적(=1층 바닥면적 가정)
  const maxTotalFloorArea = site * (far / 100);    // 최대 연면적
  const estFloors = maxBuildingArea > 0
    ? Math.max(1, Math.floor(maxTotalFloorArea / maxBuildingArea))
    : 0;

  const estHeight = estFloors * floorH;

  // 보기 좋게 반올림
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
    note: "※ 단순 산정(법규/용도지역/일조/주차/높이제한 등은 미반영)"
  });
});

// ✅ 주소 → 좌표(위도/경도) 변환: GET /api/geocode?q=...
app.get("/api/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q(query) is required" });

    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(q);

    const r = await fetch(url, {
      headers: {
        // Nominatim은 식별 가능한 User-Agent를 요구하는 경우가 많음
        "User-Agent": "my-archi-1 (Firebase Emulator)",
        "Accept": "application/json",
      },
    });

    if (!r.ok) throw new Error(`geocode fetch failed: ${r.status}`);
    const arr = await r.json();
    const hit = arr?.[0];

    if (!hit) return res.json({ ok: true, found: false, q });

    res.json({
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
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const fs = require("fs");
const path = require("path");

// 룰 파일 로드(캐싱)
let RULES_CACHE = null;
function loadRules() {
  if (RULES_CACHE) return RULES_CACHE;

  const filePath = path.join(__dirname, "rules", "base_rules.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  RULES_CACHE = JSON.parse(raw);
  return RULES_CACHE;
}

// 전체 용도지역 목록
app.get("/api/rules/zoning", (req, res) => {
  try {
    const rules = loadRules();
    const list = (rules.rules || []).map((r) => ({
      zoning: r.zoning,
      bcr_max: r.bcr_max,
      far_max: r.far_max,
    }));
    res.json({ ok: true, list });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 특정 용도지역 조회
app.get("/api/rules/zoning/one", (req, res) => {
  try {
    const z = String(req.query.z || "").trim();
    if (!z) return res.status(400).json({ ok: false, error: "z is required" });

    const rules = loadRules();
    const hit = (rules.rules || []).find((r) => r.zoning === z);

    if (!hit) return res.json({ ok: true, found: false, z });

    res.json({
      ok: true,
      found: true,
      result: hit,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ 룰 적용: 선택한 용도지역의 bcr/far 상한을 내려줌
// GET /api/rules/apply?zoning=제2종일반주거지역
app.get("/api/rules/apply", (req, res) => {
  try {
    const zoning = String(req.query.zoning || "").trim();
    if (!zoning) {
      return res.status(400).json({ ok: false, error: "zoning is required" });
    }

    const rules = loadRules();
    const hit = (rules.rules || []).find((r) => r.zoning === zoning);

    if (!hit) {
      return res.json({ ok: true, found: false, zoning });
    }

    // 프론트가 기대하는 키 이름: rule.bcr_max / rule.far_max
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
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ [용도] 카탈로그(용도 목록) 가져오기
app.get("/api/uses", (req, res) => {
  try {
    const rules = loadRules();
    res.json({ ok: true, list: rules.uses_catalog || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ [용도] zoning + useCode로 가능/불가 판단
// 예) /api/uses/check?zoning=제1종일반주거지역&use=NEIGHBOR_1
app.get("/api/uses/check", (req, res) => {
  try {
    const zoning = String(req.query.zoning || "").trim();
    const use = String(req.query.use || "").trim();

    if (!zoning) return res.status(400).json({ ok: false, error: "zoning is required" });
    if (!use) return res.status(400).json({ ok: false, error: "use is required" });

    const rules = loadRules();
    const zoneRule = (rules.rules || []).find((r) => r.zoning === zoning);

    if (!zoneRule) {
      return res.json({ ok: true, found: false, zoning, use, status: "unknown", message: "해당 용도지역 룰이 없습니다." });
    }

    const status = (zoneRule.uses && zoneRule.uses[use]) || "unknown";

    const msgMap = {
      allow: "✅ 가능(간이)",
      conditional: "⚠️ 조건부 가능(추가 검토 필요)",
      deny: "❌ 불가(간이)",
      unknown: "❓ 정보 없음(룰 추가 필요)"
    };

    res.json({
      ok: true,
      found: true,
      zoning,
      use,
      status,
      message: msgMap[status] || msgMap.unknown
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ 체크리스트 템플릿 내려주기: GET /api/checklists
app.get("/api/checklists", (req, res) => {
  try {
    const filePath = path.join(__dirname, "rules", "checklists.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ 좌표 기반 간이 용도지역 판정 (더미 로직)
// GET /api/zoning/by-coord?lat=..&lon=..
app.get("/api/zoning/by-coord", (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "lat/lon required" });
    }

    const rules = loadRules();

    // 🔥 여기 지금은 "서울이면 제2종일반주거지역" 같은 더미 로직
    // 나중에 GIS 붙이면 진짜 판정 가능
    let zoning = "제2종일반주거지역";

    // 아주 대충 위도 기준으로 다른 지역 흉내
    if (lat > 37.6) zoning = "제3종일반주거지역";
    if (lat < 37.5) zoning = "제1종일반주거지역";

    const hit = (rules.rules || []).find(r => r.zoning === zoning);

    if (!hit) {
      return res.json({ ok: true, found: false, zoning });
    }

    res.json({
      ok: true,
      found: true,
      zoning: hit.zoning,
      rule: {
        bcr_max: hit.bcr_max,
        far_max: hit.far_max
      }
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Hosting rewrite에서 function 이름을 "api"로 쓰고 있으니 exports.api 유지
exports.api = onRequest({ region: "us-central1" }, app);



