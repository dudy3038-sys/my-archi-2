// public/script.js
let map;
let marker;
let lastCalcResult = null;

// 체크리스트 캐시(불필요한 중복 fetch 방지)
let _defaultChecklistCache = null;

function fmt(x) {
  if (x == null || Number.isNaN(x)) return "-";
  return (Math.round(x * 100) / 100).toLocaleString("ko-KR");
}
function $(id) {
  return document.getElementById(id);
}

/* =========================
   체크리스트
========================= */
async function loadDefaultChecklist() {
  try {
    if (_defaultChecklistCache) return _defaultChecklistCache;

    const r = await fetch("/api/checklists");
    const data = await r.json();
    if (!r.ok || !data.ok) return [];
    _defaultChecklistCache = data.data?.default_conditional || [];
    return _defaultChecklistCache;
  } catch (e) {
    console.warn("checklists load failed:", e);
    return [];
  }
}

function evaluateAutoRules(it, values) {
  const rules = it.auto_rules || [];
  for (const rule of rules) {
    const cond = rule.when;
    if (!cond) continue;

    const v = Number(values[cond.key]);
    const target = Number(cond.value);

    if (!Number.isFinite(v) || !Number.isFinite(target)) continue;

    let ok = false;
    if (cond.op === "lt") ok = v < target;
    if (cond.op === "lte") ok = v <= target;
    if (cond.op === "gt") ok = v > target;
    if (cond.op === "gte") ok = v >= target;
    if (cond.op === "eq") ok = v === target;

    if (ok) return { result: rule.result, message: rule.message };
  }
  return null;
}

function escapeAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderChecklist(items) {
  const card = $("checklistCard");
  const list = $("checklistList");
  if (!card || !list) return;

  if (!items || items.length === 0) {
    card.style.display = "none";
    list.innerHTML = "";
    return;
  }

  card.style.display = "block";

  list.innerHTML = items
    .map((it) => {
      const inputs = Array.isArray(it.inputs) ? it.inputs : [];

      const inputHtml = inputs
        .map((inp) => {
          if (typeof inp === "string") {
            return `<div style="opacity:0.85; font-size:13px; margin-top:4px;">- 필요 입력: ${inp}</div>`;
          }

          const type = inp.type || "text";
          const key = inp.key || "";
          const label = inp.label || key;
          const placeholder = inp.placeholder || "";

          return `
            <label style="display:block; margin-top:8px; font-size:13px; opacity:.9;">
              <div style="margin-bottom:4px;">${label}</div>
              <input 
                data-checklist-id="${it.id}"
                data-input-key="${key}"
                type="${type}"
                placeholder="${placeholder}"
                style="width:100%; padding:8px; border-radius:8px; border:1px solid #333; background:#111; color:#eee;"
              />
            </label>
          `;
        })
        .join("");

      return `
        <div style="padding:10px 0; border-top:1px solid #333;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <div style="font-weight:700;">□ ${it.title}</div>
            <div id="judge_${it.id}"
              data-title="${escapeAttr(it.title)}"
              style="font-size:12px; opacity:.85;"></div>
          </div>

          <div style="opacity:0.85; font-size:13px; margin-top:4px;">- 왜 체크? ${it.why || ""}</div>
          ${inputHtml}
          <div style="opacity:0.75; font-size:12px; margin-top:8px;">- 근거: ${(it.refs || []).join(", ")}</div>
          <div id="judge_msg_${it.id}" style="font-size:12px; opacity:.85; margin-top:6px;"></div>
        </div>
      `;
    })
    .join("");

  // 입력값 변경 시 자동판정
  list.querySelectorAll("input[data-checklist-id]").forEach((el) => {
    el.addEventListener("input", () => {
      const checklistId = el.getAttribute("data-checklist-id");
      const inputEls = list.querySelectorAll(`input[data-checklist-id="${checklistId}"]`);

      const values = {};
      inputEls.forEach((ie) => {
        const k = ie.getAttribute("data-input-key");
        if (!k) return;
        values[k] = ie.value;
      });

      const item = items.find((x) => x.id === checklistId);
      if (!item) return;

      const judged = evaluateAutoRules(item, values);

      const judgeEl = $(`judge_${checklistId}`);
      const msgEl = $(`judge_msg_${checklistId}`);
      if (!judgeEl || !msgEl) return;

      if (!judged) {
        judgeEl.textContent = "";
        msgEl.textContent = "";
        return;
      }

      const badgeMap = { allow: "✅ 1차 통과", warn: "⚠️ 추가검토", deny: "❌ 주의" };
      judgeEl.textContent = badgeMap[judged.result] || judged.result;
      msgEl.textContent = judged.message || "";
    });
  });
}

/* =========================
   계산
========================= */
async function runCalc() {
  const landArea = parseFloat($("landArea")?.value);
  const bcr = parseFloat($("bcr")?.value);
  const far = parseFloat($("far")?.value);
  const floorHeight = parseFloat($("floorHeight")?.value) || 3.3;

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

    lastCalcResult = { input: { landArea, bcr, far, floorHeight }, result: res };

    resultEl.innerHTML = `
      <div><b>✅ 기본 산정 결과</b></div>
      <div>최대 건축면적(단순): <b>${fmt(res.maxBuildingArea_m2)} ㎡</b></div>
      <div>최대 연면적(단순): <b>${fmt(res.maxTotalFloorArea_m2)} ㎡</b></div>
      <div>예상 층수: <b>${fmt(res.estFloors)} 층</b></div>
      <div>예상 건물 높이: <b>${fmt(res.estHeight_m)} m</b></div>
      <div style="opacity:.85;margin-top:8px;">${res.note || ""}</div>
    `;

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

/* =========================
   리셋/복사
========================= */
function resetAll() {
  ["landArea", "bcr", "far", "floorHeight"].forEach((id) => {
    const el = $(id);
    if (el) el.value = "";
  });

  lastCalcResult = null;

  const resultEl = $("result");
  const talkEl = $("talkTrack");
  if (resultEl) resultEl.innerHTML = "";
  if (talkEl) talkEl.value = "검토 결과를 먼저 계산해 주세요.";

  const summaryBox = $("summaryBox");
  if (summaryBox) summaryBox.innerHTML = "";

  renderChecklist([]);

  ["addrResult", "ruleHint", "useResult"].forEach((id) => {
    const el = $(id);
    if (el) el.innerHTML = "";
  });

  if (marker && map) {
    try {
      map.removeLayer(marker);
    } catch {}
    marker = null;
  }
  if (map) map.setView([37.5665, 126.9780], 13);

  const addrInput = $("addr");
  if (addrInput) addrInput.value = "";

  const zoningSelect = $("zoning");
  if (zoningSelect) zoningSelect.value = "";

  const useSelect = $("useSelect");
  if (useSelect) useSelect.value = "";
}

async function copyTalk() {
  const talkEl = $("talkTrack");
  if (!talkEl) return;
  try {
    await navigator.clipboard.writeText(talkEl.value || "");
    alert("멘트를 복사했어요!");
  } catch {
    talkEl.select();
    document.execCommand("copy");
    alert("멘트를 복사했어요!");
  }
}

/* =========================
   요약
========================= */
function buildSummaryText() {
  const addr = ($("addr")?.value || "").trim();
  const zoning = ($("zoning")?.value || "").trim();

  const landArea = $("landArea")?.value || "";
  const bcr = $("bcr")?.value || "";
  const far = $("far")?.value || "";
  const floorH = $("floorHeight")?.value || "3.3";

  function readChecklistSummary() {
    const card = $("checklistCard");
    const list = $("checklistList");
    if (!card || !list || card.style.display === "none") return "";

    const judgeEls = list.querySelectorAll('div[id^="judge_"]:not([id^="judge_msg_"])');
    if (!judgeEls || judgeEls.length === 0) return "";

    const lines = [];
    lines.push("");
    lines.push("🧾 조건부 검토 체크리스트(자동/수동)");

    judgeEls.forEach((judgeEl) => {
      const id = judgeEl.id.replace("judge_", "");
      const title = (judgeEl.getAttribute("data-title") || id).trim();

      const badge = (judgeEl.textContent || "").trim();
      const msgEl = $(`judge_msg_${id}`);
      const msg = (msgEl?.textContent || "").trim();

      if (!badge && !msg) return;
      if (badge && msg) lines.push(`- ${title}: ${badge} / ${msg}`);
      else if (badge) lines.push(`- ${title}: ${badge}`);
      else lines.push(`- ${title}: ${msg}`);
    });

    return lines.join("\n");
  }

  const checklistSummary = readChecklistSummary();

  let calcSummary = "";
  if (lastCalcResult?.result) {
    const r = lastCalcResult.result;
    calcSummary = [
      "",
      "📐 기본 산정 결과(검토 결과 보기 기준)",
      `- 최대 건축면적(단순): ${fmt(r.maxBuildingArea_m2)} ㎡`,
      `- 최대 연면적(단순): ${fmt(r.maxTotalFloorArea_m2)} ㎡`,
      `- 예상 층수: ${fmt(r.estFloors)} 층`,
      `- 예상 건물 높이: ${fmt(r.estHeight_m)} m`,
    ].join("\n");
  }

  return [
    "📌 건축 기본 검토 요약",
    addr ? `- 주소: ${addr}` : "- 주소: (미입력)",
    zoning ? `- 용도지역(간이): ${zoning}` : "- 용도지역(간이): (미선택)",
    `- 대지면적: ${landArea || "-"} ㎡`,
    `- 건폐율(입력/상한): ${bcr || "-"} %`,
    `- 용적률(입력/상한): ${far || "-"} %`,
    `- 층고 가정: ${floorH || "3.3"} m`,
    "",
    "※ 본 요약은 간이 산정이며 실제 인허가/조례/심의 조건에 따라 달라질 수 있습니다.",
    calcSummary,
    checklistSummary,
  ].join("\n");
}

/* =========================
   DOMContentLoaded: 모든 UI 연결
========================= */
window.addEventListener("DOMContentLoaded", () => {
  // 지도
  if ($("map") && window.L) {
    map = L.map("map").setView([37.5665, 126.9780], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
    }).addTo(map);
  } else {
    console.warn("Leaflet(map) 초기화 실패: #map 또는 L 없음");
  }

  // 버튼들
  $("calcBtn")?.addEventListener("click", runCalc);
  $("resetBtn")?.addEventListener("click", resetAll);
  $("copyBtn")?.addEventListener("click", copyTalk);

  // 룰/용도 관련 엘리먼트(스코프 꼬임 방지: 여기서 한 번만 잡는다)
  const zoningSelect = $("zoning");
  const applyRuleBtn = $("applyRuleBtn");
  const ruleHint = $("ruleHint");

  const useSelect = $("useSelect");
  const checkUseBtn = $("checkUseBtn");
  const useResult = $("useResult");

  // 주소 검색
  const addrBtn = $("addrBtn");
  const addrInput = $("addr");
  const addrResult = $("addrResult");

  addrBtn?.addEventListener("click", async () => {
    const q = (addrInput?.value || "").trim();
    if (!q) {
      if (addrResult) addrResult.innerHTML = "주소를 입력해 주세요.";
      return;
    }
    if (addrResult) addrResult.innerHTML = "좌표 조회 중...";

    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await r.json();

      if (!data.ok) throw new Error(data.error || "unknown error");
      if (!data.found) {
        if (addrResult) addrResult.innerHTML = "검색 결과가 없습니다. 주소를 더 자세히 입력해 보세요.";
        return;
      }

      // lat/lon 문자열일 수 있어서 Number로 고정
      const lat = Number(data.result.lat);
      const lon = Number(data.result.lon);
      const display_name = data.result.display_name;

      if (addrResult) {
        addrResult.innerHTML = `
          <div>✅ 조회 성공</div>
          <div style="margin-top:6px; opacity:.9">${display_name}</div>
          <div style="margin-top:6px;"><b>위도</b> ${lat} / <b>경도</b> ${lon}</div>
        `;
      }

      if (map && Number.isFinite(lat) && Number.isFinite(lon)) {
        map.setView([lat, lon], 17);
        if (marker) marker.setLatLng([lat, lon]);
        else marker = L.marker([lat, lon]).addTo(map);
      }

      // 좌표 기반 자동 용도지역 판정
      try {
        const zr = await fetch(`/api/zoning/by-coord?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
        const zdata = await zr.json();

        if (zdata.ok && zdata.found) {
          if (zoningSelect) {
            zoningSelect.value = zdata.zoning;
            zoningSelect.dispatchEvent(new Event("change"));
          }
          if (ruleHint) {
            ruleHint.innerHTML = `
              <div>🧭 좌표 기반 추정 용도지역 자동 설정</div>
              <div style="margin-top:6px;"><b>${zdata.zoning}</b></div>
            `;
          }

          // 기본 용도 자동 판단
          try {
            const defaultUse = "RES_HOUSE";
            const ur = await fetch(
              `/api/uses/check?zoning=${encodeURIComponent(zdata.zoning)}&use=${encodeURIComponent(defaultUse)}`
            );
            const udata = await ur.json();

            if (udata.ok && udata.found) {
              if (useResult) {
                useResult.innerHTML = `
                  <div><b>기본용도(주거) 자동 판단</b></div>
                  <div style="margin-top:6px;">${udata.message}</div>
                `;
              }

              if (udata.status === "conditional") {
                const checklist = await loadDefaultChecklist();
                renderChecklist(checklist);
              } else {
                renderChecklist([]);
              }
            }
          } catch (e) {
            console.warn("auto use check failed:", e);
          }
        }
      } catch (e) {
        console.warn("auto zoning failed:", e);
      }

      // 체크리스트 미리 캐시
      loadDefaultChecklist().catch(() => {});
    } catch (e) {
      if (addrResult) addrResult.innerHTML = `❌ 오류: ${String(e)}`;
    }
  });

  // 용도지역 옵션 로드
  async function loadZoningOptions() {
    if (!zoningSelect) return;

    try {
      const r = await fetch("/api/rules/zoning");
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);

      zoningSelect.innerHTML = `<option value="">선택하세요</option>`;
      (data.list || []).forEach((z) => {
        const value = typeof z === "string" ? z : z.zoning;
        if (!value) return;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        zoningSelect.appendChild(opt);
      });

      if (ruleHint) ruleHint.innerHTML = "✅ 용도지역 목록을 불러왔어요.";
    } catch (e) {
      if (ruleHint) ruleHint.innerHTML = `❌ 용도지역 목록 로드 실패: ${String(e)}`;
    }
  }

  // 룰 적용 함수(버튼/자동공용)
  async function applyRuleByZoning(zoning) {
    if (!zoning) return;
    if (ruleHint) ruleHint.innerHTML = "룰 적용 중...";

    const r = await fetch(`/api/rules/apply?zoning=${encodeURIComponent(zoning)}`);
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);

    const rule = data.rule || data.result || {};
    const bcrEl = $("bcr");
    const farEl = $("far");
    if (bcrEl && rule.bcr_max != null) bcrEl.value = rule.bcr_max;
    if (farEl && rule.far_max != null) farEl.value = rule.far_max;

    if (ruleHint) {
      ruleHint.innerHTML = `
        <div>✅ <b>${zoning}</b> 룰 적용 완료</div>
        <div style="margin-top:6px; opacity:.9">
          건폐율(상한): ${rule.bcr_max ?? "-"}% /
          용적률(상한): ${rule.far_max ?? "-"}%
        </div>
      `;
    }
  }

  applyRuleBtn?.addEventListener("click", async () => {
    const zoning = zoningSelect?.value || "";
    if (!zoning) {
      if (ruleHint) ruleHint.innerHTML = "용도지역을 먼저 선택해 주세요.";
      return;
    }
    try {
      await applyRuleByZoning(zoning);
    } catch (e) {
      if (ruleHint) ruleHint.innerHTML = `❌ 룰 적용 실패: ${String(e)}`;
    }
  });

  zoningSelect?.addEventListener("change", async () => {
    const zoning = zoningSelect?.value || "";
    if (!zoning) return;
    try {
      await applyRuleByZoning(zoning);
    } catch (e) {
      if (ruleHint) ruleHint.innerHTML = `❌ 룰 자동 적용 실패: ${String(e)}`;
    }
  });

  // 용도 목록 로드
  async function loadUseOptions() {
    if (!useSelect) return;

    try {
      const r = await fetch("/api/uses");
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);

      useSelect.innerHTML = `<option value="">선택하세요</option>`;
      (data.list || []).forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.code;
        opt.textContent = u.label;
        useSelect.appendChild(opt);
      });

      if (useResult) useResult.innerHTML = "✅ 용도 목록을 불러왔어요.";
    } catch (e) {
      if (useResult) useResult.innerHTML = `❌ 용도 목록 로드 실패: ${String(e)}`;
    }
  }

  // 용도 가능여부 체크
  checkUseBtn?.addEventListener("click", async () => {
    const zoning = zoningSelect?.value || "";
    const use = useSelect?.value || "";

    if (!zoning) {
      if (useResult) useResult.innerHTML = "용도지역(간이)을 먼저 선택해 주세요.";
      return;
    }
    if (!use) {
      if (useResult) useResult.innerHTML = "건축 용도(간이)를 먼저 선택해 주세요.";
      return;
    }

    if (useResult) useResult.innerHTML = "용도 가능 여부 판단 중...";

    try {
      const r = await fetch(
        `/api/uses/check?zoning=${encodeURIComponent(zoning)}&use=${encodeURIComponent(use)}`
      );
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || r.statusText);

      if (useResult) {
        useResult.innerHTML = `
          <div><b>${data.message}</b></div>
          <div style="margin-top:6px; opacity:.9">용도지역: ${data.zoning}</div>
        `;
      }

      if (data.status === "conditional") {
        const checklist = await loadDefaultChecklist();
        renderChecklist(checklist);
      } else {
        renderChecklist([]);
      }
    } catch (e) {
      if (useResult) useResult.innerHTML = `❌ 용도 판단 실패: ${String(e)}`;
      renderChecklist([]);
    }
  });

  // 요약 버튼
  const summaryBox = $("summaryBox");
  const summaryBtn = $("summaryBtn");
  const copySummaryBtn = $("copySummaryBtn");

  summaryBtn?.addEventListener("click", () => {
    const text = buildSummaryText();
    if (summaryBox) summaryBox.innerHTML = `<pre style="white-space:pre-wrap; margin:0;">${text}</pre>`;
  });

  copySummaryBtn?.addEventListener("click", async () => {
    const text = buildSummaryText();
    try {
      await navigator.clipboard.writeText(text);
      alert("요약을 복사했어요!");
    } catch {
      alert("복사에 실패했어요. 브라우저 권한을 확인해 주세요.");
    }
  });

  // 초기 로드 실행
  loadZoningOptions();
  loadUseOptions();
  loadDefaultChecklist().catch(() => {});
});
