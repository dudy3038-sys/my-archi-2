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


// Hosting rewrite에서 function 이름을 "api"로 쓰고 있으니 exports.api 유지
exports.api = onRequest({ region: "us-central1" }, app);



