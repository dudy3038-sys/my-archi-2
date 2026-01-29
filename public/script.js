// public/script.js
let map;
let marker;

function fmt(x) {
  if (x == null || Number.isNaN(x)) return "-";
  return (Math.round(x * 100) / 100).toLocaleString("ko-KR");
}

function $(id) {
  return document.getElementById(id);
}

async function runCalc() {
  const landArea = parseFloat($("landArea")?.value);
  const bcr = parseFloat($("bcr")?.value);
  const far = parseFloat($("far")?.value);
  const floorHeightRaw = $("floorHeight")?.value;
  const floorHeight = floorHeightRaw ? parseFloat(floorHeightRaw) : 3.3;

  const resultEl = $("result");
  const talkEl = $("talkTrack");

  if (!resultEl || !talkEl) {
    alert("index.html에 result 또는 talkTrack 영역이 없어요. id를 확인해줘요.");
    return;
  }

  if (!landArea || !bcr || !far) {
    resultEl.innerHTML = "대지면적, 건폐율, 용적률을 입력해 주세요.";
    talkEl.value = "검토 결과를 먼저 계산해 주세요.";
    return;
  }

  // ✅ 백엔드가 /api/calc 를 지원한다고 했으니 여기로 호출
  const url = `/api/calc?site=${encodeURIComponent(landArea)}&coverage=${encodeURIComponent(
    bcr
  )}&far=${encodeURIComponent(far)}&floor=${encodeURIComponent(floorHeight)}`;

  resultEl.innerHTML = "계산 중...";

  try {
    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok || !data.ok) {
      resultEl.innerHTML = `오류: ${data.error || r.statusText}`;
      talkEl.value = "오류가 발생했습니다. 입력값/서버 상태를 확인해 주세요.";
      return;
    }

    const res = data.result;

    // 화면 표시
    resultEl.innerHTML = `
      <div><b>✅ 기본 산정 결과</b></div>
      <div>최대 건축면적(단순): <b>${fmt(res.maxBuildingArea_m2)} ㎡</b></div>
      <div>최대 연면적(단순): <b>${fmt(res.maxTotalFloorArea_m2)} ㎡</b></div>
      <div>예상 층수: <b>${fmt(res.estFloors)} 층</b></div>
      <div>예상 건물 높이: <b>${fmt(res.estHeight_m)} m</b></div>
      <div style="opacity:.85;margin-top:8px;">${res.note || ""}</div>
    `;

    // 상담 멘트 생성
    talkEl.value = [
      `대지면적 ${fmt(landArea)}㎡ 기준, 건폐율 ${fmt(bcr)}% 적용 시 1층 최대 약 ${fmt(
        res.maxBuildingArea_m2
      )}㎡까지 가능합니다.`,
      `용적률 ${fmt(far)}% 기준으로 총 연면적은 약 ${fmt(res.maxTotalFloorArea_m2)}㎡까지 가능합니다.`,
      `층고를 ${fmt(floorHeight)}m로 가정하면 약 ${fmt(res.estFloors)}층 규모(높이 약 ${fmt(
        res.estHeight_m
      )}m)가 예상됩니다.`,
      res.note ? `※ 참고: ${res.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    resultEl.innerHTML = `오류: ${String(e)}`;
    talkEl.value = "네트워크 오류가 발생했습니다. 다시 시도해 주세요.";
  }
}

function resetAll() {
  ["landArea", "bcr", "far", "floorHeight"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });
  const resultEl = $("result");
  const talkEl = $("talkTrack");
  if (resultEl) resultEl.innerHTML = "";
  if (talkEl) talkEl.value = "검토 결과를 먼저 계산해 주세요.";
}

async function copyTalk() {
  const talkEl = $("talkTrack");
  if (!talkEl) return;
  try {
    await navigator.clipboard.writeText(talkEl.value || "");
    alert("멘트를 복사했어요!");
  } catch {
    // fallback
    talkEl.select();
    document.execCommand("copy");
    alert("멘트를 복사했어요!");
  }
}

// ✅ 페이지 로드 시 버튼 이벤트 연결
window.addEventListener("DOMContentLoaded", () => {

  // 🌍 지도 기본 생성 (서울)
map = L.map("map").setView([37.5665, 126.9780], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
}).addTo(map);

  const calcBtn = $("calcBtn");
  const resetBtn = $("resetBtn");
  const copyBtn = $("copyBtn");

  if (calcBtn) calcBtn.addEventListener("click", runCalc);
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
  if (copyBtn) copyBtn.addEventListener("click", copyTalk);

  const addrBtn = document.getElementById("addrBtn");
  const addrInput = document.getElementById("addr");
  const addrResult = document.getElementById("addrResult");
  
  addrBtn?.addEventListener("click", async () => {
    const q = (addrInput?.value || "").trim();
    if (!q) {
      addrResult.innerHTML = "주소를 입력해 주세요.";
      return;
    }
  
    addrResult.innerHTML = "좌표 조회 중...";
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await r.json();
  
      if (!data.ok) throw new Error(data.error || "unknown error");
      if (!data.found) {
        addrResult.innerHTML = "검색 결과가 없습니다. 주소를 더 자세히 입력해 보세요.";
        return;
      }
  
      const { display_name, lat, lon } = data.result;
      addrResult.innerHTML = `
        <div>✅ 조회 성공</div>
        <div style="margin-top:6px; opacity:.9">${display_name}</div>
        <div style="margin-top:6px;"><b>위도</b> ${lat} / <b>경도</b> ${lon}</div>
      `;
      // 🗺 지도 이동 + 핀 표시
map.setView([lat, lon], 17);

if (marker) {
  marker.setLatLng([lat, lon]);
} else {
  marker = L.marker([lat, lon]).addTo(map);
}

    } catch (e) {
      addrResult.innerHTML = `❌ 오류: ${String(e)}`;
    }
  });
  

  // 혹시 버튼이 안 잡히면 바로 경고
  if (!calcBtn) console.warn("calcBtn을 찾지 못함. index.html의 id='calcBtn' 확인");
  if (!resetBtn) console.warn("resetBtn을 찾지 못함. index.html의 id='resetBtn' 확인");
  if (!copyBtn) console.warn("copyBtn을 찾지 못함. index.html의 id='copyBtn' 확인");
});
