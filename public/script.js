// public/script.js
let map;
let marker;
let lastCalcResult = null;

// 현재 화면에 렌더된 체크리스트(요약 만들 때 refs 안정적으로 쓰기 위함)
let _renderedChecklist = [];

// 최신 컨텍스트(주소/좌표/지자체 등)
let _ctx = {
  addr: "",
  lat: null,
  lon: null,
  jurisdiction: "",
  zoning: "",
  use: "",
};

// renderChecklist에서 쓸 현재 아이템(이벤트 위임에서 참조)
let _currentChecklistItems = [];

// ✅ use code -> label 매핑(요약에서 사람이 읽는 라벨로 표기)
let _useLabelMap = {};

// ✅ geocode 중복/경합 방지
let _geocodeAbort = null;
let _lastGeocodeKey = "";

// ✅ UX 정책: allow여도 체크리스트는 "기본(권장)"으로 항상 보여주기
const ALWAYS_SHOW_CHECKLIST = true;

// ✅ 마지막 용도 판정 status 저장 (runCalc 이후 enriched 재로딩 시 헤더 유지)
let _lastUseStatus = "";

// ✅ calc 자동 입력 후 서버판정 재호출 중복 방지용 플래그
let _isAutoFillRunning = false;

/* =========================
   유틸
========================= */
function fmt(x) {
  if (x == null || Number.isNaN(x)) return "-";
  return (Math.round(x * 100) / 100).toLocaleString("ko-KR");
}
function $(id) {
  return document.getElementById(id);
}
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 쿼리스트링 구성
function buildQuery(params) {
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v == null) return;
    const s = String(v).trim();
    if (!s) return;
    sp.set(k, s);
  });
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

// 디바운스
function debounce(fn, wait = 450) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function isFiniteNumber(n) {
  return Number.isFinite(n) && !Number.isNaN(n);
}

function setText(el, html) {
  if (!el) return;
  el.innerHTML = html;
}

// fetch JSON helper
async function fetchJson(url, options) {
  const r = await fetch(url, options);
  let data = null;
  try {
    data = await r.json();
  } catch (e) {
    const txt = await r.text().catch(() => "");
    throw new Error(
      `응답 파싱 실패: ${r.status} ${r.statusText} ${txt ? `(${txt.slice(0, 120)}...)` : ""}`
    );
  }
  if (!r.ok || !data?.ok) {
    throw new Error(String(data?.error || r.statusText || "request failed"));
  }
  return data;
}

// ✅ 요약에는 HTML 배지 대신 "텍스트 배지"
function badgeText(state) {
  const map = { sure: "[확정]", guess: "[추정]", unsure: "[미확정]" };
  return map[state] || "";
}

// ✅ 서버/프론트 판정 status 정규화 (functions/index.js와 맞춤)
function normalizeStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (v === "allow") return "allow";
  if (v === "deny") return "deny";
  if (v === "conditional") return "conditional";
  if (v === "need_input") return "need_input";
  if (v === "unknown") return "unknown";
  // 과거 데이터 호환
  if (v === "warn") return "conditional";
  return "unknown";
}

// ✅ 배지(화면용) - inline style 제거: CSS class로 처리
function badgeHtml(statusRaw) {
  const status = normalizeStatus(statusRaw);

  const map = {
    allow: { label: "✅ 1차 통과", cls: "judgeBadge--allow" },
    conditional: { label: "⚠️ 추가검토", cls: "judgeBadge--conditional" },
    deny: { label: "❌ 주의", cls: "judgeBadge--deny" },
    need_input: { label: "❓ 입력필요", cls: "judgeBadge--need_input" },
    unknown: { label: "❓ 정보없음", cls: "judgeBadge--unknown" },
  };

  const hit = map[status];
  if (!hit) return "";
  return `<span class="judgeBadge ${escapeHtml(hit.cls)}">${escapeHtml(hit.label)}</span>`;
}

/* =========================
   ✅ 입력칸 누락 강조(need_input UX)
   - JS는 data-missing="1"만 세팅
   - 인라인 스타일은 사용하지 않음
========================= */
function clearMissingMarks(checklistId) {
  const list = $("checklistList");
  if (!list) return;

  const inputs = list.querySelectorAll(`input[data-checklist-id="${checklistId}"][data-input-key]`);
  inputs.forEach((el) => {
    // ✅ CSS용 플래그만 제거
    delete el.dataset.missing;

    // 안내문 제거
    const hintId = `missing_hint_${checklistId}_${el.getAttribute("data-input-key")}`;
    const hint = document.getElementById(hintId);
    if (hint) hint.remove();
  });
}

function markMissingInputs(checklistId, missingInputs) {
  const list = $("checklistList");
  if (!list) return;

  clearMissingMarks(checklistId);

  const miss = Array.isArray(missingInputs) ? missingInputs : [];
  miss.forEach((m) => {
    const key = String(m?.key || "").trim();
    if (!key) return;

    const inputEl = list.querySelector(
      `input[data-checklist-id="${checklistId}"][data-input-key="${key}"]`
    );
    if (!inputEl) return;

    // ✅ CSS가 처리하도록 data-missing만 세팅
    inputEl.dataset.missing = "1";

    const label = String(m?.label || key).trim();
    const hintId = `missing_hint_${checklistId}_${key}`;
    const existed = document.getElementById(hintId);
    if (existed) existed.remove();

    const hint = document.createElement("div");
    hint.id = hintId;
    hint.className = "missing-hint";
    hint.textContent = `❗ 입력 필요: ${label}`;

    // input 바로 다음에 삽입
    inputEl.insertAdjacentElement("afterend", hint);
  });
}

/* =========================
   ✅ calc -> 컨텍스트/입력 자동 채움 관련
========================= */
function buildEnrichedExtraFromCalc() {
  const extra = {};
  const r = lastCalcResult?.result;
  if (!r) return extra;

  // 서버 expects: floors, height_m, gross_area_m2
  if (Number.isFinite(Number(r.estFloors))) extra.floors = Number(r.estFloors);
  if (Number.isFinite(Number(r.estHeight_m))) extra.height_m = Number(r.estHeight_m);

  // NOTE: 실제 연면적 확정값이 아니라 참고용(단순 최대치)
  if (Number.isFinite(Number(r.maxTotalFloorArea_m2))) extra.gross_area_m2 = Number(r.maxTotalFloorArea_m2);

  return extra;
}

// ✅ checklist input에 calc 값을 자동 채움(비어있을 때만)
function autofillChecklistInputsFromCalc({ onlyEmpty = true } = {}) {
  const list = $("checklistList");
  const card = $("checklistCard");
  const r = lastCalcResult?.result;

  if (!list || !card || card.style.display === "none") return { changed: 0 };
  if (!r) return { changed: 0 };

  const map = {
    floors: r.estFloors,
    height_m: r.estHeight_m,
    gross_area_m2: r.maxTotalFloorArea_m2, // 참고용 최대치
  };

  let changed = 0;

  Object.entries(map).forEach(([key, val]) => {
    if (!Number.isFinite(Number(val))) return;

    const inputs = list.querySelectorAll(`input[data-input-key="${key}"]`);
    inputs.forEach((el) => {
      const cur = String(el.value ?? "").trim();
      if (onlyEmpty && cur) return;

      el.value = String(Number(val));
      changed += 1;

      // 입력 누락 강조가 남아있을 수 있어 제거
      const checklistId = el.getAttribute("data-checklist-id");
      if (checklistId) {
        // 해당 키에 대한 missing 힌트만 제거(전체 clear는 과할 수 있어 key 단위로만)
        delete el.dataset.missing;
        const hintId = `missing_hint_${checklistId}_${key}`;
        const hint = document.getElementById(hintId);
        if (hint) hint.remove();
      }
    });
  });

  return { changed };
}

/* =========================
   ✅ applies_to 힌트(프론트 표시용)
   - "왜 뜨지?"를 줄이기 위한 UX
========================= */
function toNumSafe(v) {
  if (v === "" || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getCurrentKnownValue(key) {
  // 우선: calc 결과 -> 입력값 -> ctx
  const r = lastCalcResult?.result || null;

  if (key === "floors") {
    const fromCalc = toNumSafe(r?.estFloors);
    if (fromCalc != null) return fromCalc;
  }
  if (key === "height_m") {
    const fromCalc = toNumSafe(r?.estHeight_m);
    if (fromCalc != null) return fromCalc;
  }
  if (key === "gross_area_m2") {
    const fromCalc = toNumSafe(r?.maxTotalFloorArea_m2);
    if (fromCalc != null) return fromCalc;
  }

  // 입력칸에 이미 들어간 값이 있으면 그걸 사용
  const list = $("checklistList");
  if (list) {
    const el = list.querySelector(`input[data-input-key="${key}"]`);
    if (el) {
      const n = toNumSafe(el.value);
      if (n != null) return n;
    }
  }

  // ctx fallback
  const v = _ctx?.[key];
  const n = toNumSafe(v);
  return n != null ? n : null;
}

function buildAppliesToHint(it) {
  const a = it?.applies_to;
  if (!a) return "";

  const parts = [];
  const needs = [];

  // zoning/use/jurisdiction 조건은 "표시 이유"가 아니라 "적용 범위" 설명이므로 간단히
  if (Array.isArray(a.zoning_in) && a.zoning_in.length > 0) {
    parts.push(`용도지역: ${a.zoning_in.join(" · ")}`);
  }
  if (Array.isArray(a.use_in) && a.use_in.length > 0) {
    parts.push(`용도: ${a.use_in.join(" · ")}`);
  }
  if (Array.isArray(a.jurisdiction_in) && a.jurisdiction_in.length > 0) {
    parts.push(`지자체: ${a.jurisdiction_in.join(" · ")}`);
  }

  // 숫자 조건은 "현재값" 표시
  if (a.min_gross_area_m2 != null) {
    const th = toNumSafe(a.min_gross_area_m2);
    const cur = getCurrentKnownValue("gross_area_m2");
    if (cur == null) needs.push("연면적(㎡)");
    else parts.push(`연면적 ≥ ${fmt(th)}㎡ (현재: ${fmt(cur)}㎡)`);
  }

  if (a.min_floors != null) {
    const th = toNumSafe(a.min_floors);
    const cur = getCurrentKnownValue("floors");
    if (cur == null) needs.push("층수");
    else parts.push(`층수 ≥ ${fmt(th)} (현재: ${fmt(cur)})`);
  }

  // 미래 확장 대비
  if (a.min_height_m != null) {
    const th = toNumSafe(a.min_height_m);
    const cur = getCurrentKnownValue("height_m");
    if (cur == null) needs.push("건물 높이(m)");
    else parts.push(`높이 ≥ ${fmt(th)}m (현재: ${fmt(cur)}m)`);
  }

  if (needs.length > 0) {
    return `조건 판단 필요: ${needs.join(", ")}` + (parts.length ? ` · 참고: ${parts.join(" / ")}` : "");
  }

  if (parts.length > 0) return `조건: ${parts.join(" / ")}`;
  return "";
}

/* =========================
   ✅ Enriched 체크리스트 로드(컨텍스트 기반)
========================= */
async function loadEnrichedChecklistWithContext(extra = {}) {
  try {
    const zoning = ($("zoning")?.value || "").trim();
    const use = ($("useSelect")?.value || "").trim();

    // ✅ calc 기반 컨텍스트를 기본으로 포함
    const calcExtra = buildEnrichedExtraFromCalc();

    const params = {
      zoning: zoning || _ctx.zoning || "",
      use: use || _ctx.use || "",
      jurisdiction: _ctx.jurisdiction || "",
      ...calcExtra,
      ...extra,
    };

    const data = await fetchJson(`/api/checklists/enriched${buildQuery(params)}`);
    const items = data.data?.default_conditional || [];
    return { items, meta: data.meta || null };
  } catch (e) {
    console.warn("checklists/enriched load failed:", e);
    return { items: [], meta: null };
  }
}

/* =========================
   ✅ 자동 판정(프론트 입력 기반)
========================= */

// 서버와 동일한 숫자 파서 느낌(빈값/NaN -> null)
function toNumFront(v) {
  if (v === "" || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function evalCondFront(cond, values) {
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

  const vNum = toNumFront(raw);
  const tNum = toNumFront(cond.value);

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

function ruleMatchesFront(rule, values) {
  if (!rule) return false;

  if (rule.when) return evalCondFront(rule.when, values);

  if (Array.isArray(rule.when_all) && rule.when_all.length > 0) {
    return rule.when_all.every((c) => evalCondFront(c, values));
  }

  if (Array.isArray(rule.when_any) && rule.when_any.length > 0) {
    return rule.when_any.some((c) => evalCondFront(c, values));
  }

  return false;
}

function evaluateAutoRules(it, values) {
  const rules = Array.isArray(it?.auto_rules) ? it.auto_rules : [];
  if (!rules.length) return null;

  // priority desc (서버와 일치)
  const sorted = rules
    .slice()
    .sort((a, b) => (toNumFront(b.priority) ?? 0) - (toNumFront(a.priority) ?? 0));

  for (const rule of sorted) {
    if (!ruleMatchesFront(rule, values)) continue;

    return {
      result: normalizeStatus(rule.result),
      message: rule.message,
      rule_id: rule.id || null,
      priority: toNumFront(rule.priority) ?? 0,
    };
  }

  return null;
}

/* =========================
   ✅ 서버 판정용: 체크리스트 입력값 수집
========================= */
function collectValuesForServerJudge() {
  const list = $("checklistList");
  const values = {};

  // 체크리스트 input들
  if (list) {
    const inputs = list.querySelectorAll("input[data-checklist-id][data-input-key]");
    inputs.forEach((el) => {
      const key = el.getAttribute("data-input-key");
      if (!key) return;
      const raw = String(el.value ?? "").trim();
      if (!raw) return;

      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "number") {
        const n = Number(raw);
        if (Number.isFinite(n)) values[key] = n;
        else values[key] = raw;
      } else {
        values[key] = raw;
      }
    });
  }

  // 계산결과에서 유용한 값 보강(있을 때만)
  if (lastCalcResult?.result) {
    const r = lastCalcResult.result;
    if (values.floors == null && Number.isFinite(Number(r.estFloors))) values.floors = Number(r.estFloors);
    if (values.height_m == null && Number.isFinite(Number(r.estHeight_m))) values.height_m = Number(r.estHeight_m);

    // NOTE: 실제 연면적 확정값이 아니라 참고용(단순 최대치)
    if (values.gross_area_m2 == null && Number.isFinite(Number(r.maxTotalFloorArea_m2))) {
      values.gross_area_m2 = Number(r.maxTotalFloorArea_m2);
    }
  }

  return values;
}

/* =========================
   ✅ 서버 판정 결과를 화면에 반영
========================= */
function applyServerJudgeResults(results) {
  const list = $("checklistList");
  if (!list) return;

  (results || []).forEach((row) => {
    const id = row.id;
    const judgeEl = $(`judge_${id}`);
    const msgEl = $(`judge_msg_${id}`);
    if (!judgeEl || !msgEl) return;

    const status = normalizeStatus(row.status ?? row?.judge?.result);
    const message = String(row.message ?? row?.judge?.message ?? "").trim();
    const missingInputs = row.missing_inputs || [];

    judgeEl.innerHTML = badgeHtml(status);
    msgEl.textContent = message || "";

    // ✅ need_input이면 누락 입력 강조
    if (status === "need_input") {
      markMissingInputs(id, missingInputs);
    } else {
      clearMissingMarks(id);
    }
  });
}

/* =========================
   ✅ 서버 전체 판정 실행 (공통 함수)
========================= */
async function runServerJudgeAndApply() {
  const judgeServerHint = $("judgeServerHint");

  if (!_renderedChecklist || _renderedChecklist.length === 0) {
    if (judgeServerHint) judgeServerHint.textContent = "체크리스트가 없어요. 먼저 용도 판정을 해주세요.";
    return { ok: false, reason: "no_checklist" };
  }

  const zoning = ($("zoning")?.value || "").trim();
  const use = ($("useSelect")?.value || "").trim();

  if (!zoning || !use) {
    if (judgeServerHint) judgeServerHint.textContent = "용도지역/용도를 먼저 선택해 주세요.";
    return { ok: false, reason: "missing_context" };
  }

  const values = collectValuesForServerJudge();

  const payload = {
    context: {
      zoning: zoning || _ctx.zoning || "",
      use: use || _ctx.use || "",
      jurisdiction: _ctx.jurisdiction || "",
    },
    values,
  };

  if (judgeServerHint) judgeServerHint.textContent = "서버 판정 중...";

  try {
    const data = await fetchJson("/api/checklists/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const results = data.data?.results || [];
    applyServerJudgeResults(results);

    const miss = data.meta?.missing_refs || [];
    if (judgeServerHint) {
      judgeServerHint.textContent =
        `✅ 서버 판정 완료 (${results.length}개)` + (miss.length ? ` · laws.json 미등록 refs: ${miss.join(", ")}` : "");
    }

    return { ok: true, results, meta: data.meta || null };
  } catch (e) {
    if (judgeServerHint) judgeServerHint.textContent = `❌ 서버 판정 실패: ${String(e)}`;
    return { ok: false, reason: "server_error" };
  }
}

// 체크리스트 입력이 바뀔 때마다 서버판정 과다 호출 방지
const debouncedServerJudge = debounce(async () => {
  const card = $("checklistCard");
  const hasChecklist = card && card.style.display !== "none" && (_renderedChecklist || []).length > 0;
  if (!hasChecklist) return;
  await runServerJudgeAndApply();
}, 650);

/* =========================
   ✅ 체크리스트 렌더링 + 토글
========================= */
function renderChecklist(items, opts = {}) {
  const card = $("checklistCard");
  const list = $("checklistList");
  if (!card || !list) return;

  const status = normalizeStatus(opts.status || "");

  _renderedChecklist = Array.isArray(items) ? items : [];
  _currentChecklistItems = _renderedChecklist;

  if (!items || items.length === 0) {
    // ✅ 숨김은 style + class 모두 정리 (HTML 초기 상태가 어떻든 안전)
    card.style.display = "none";
    card.classList.add("is-hidden");
    list.innerHTML = "";
    const hint = $("judgeServerHint");
    if (hint) hint.textContent = "";
    return;
  }

  // ✅ 표시 시에는 style + class 모두 정리 (예전 HTML의 is-hidden 잔존 대비)
  card.style.display = "block";
  card.classList.remove("is-hidden");

  // ✅ allow면 기본 접힘(요약), conditional/deny/need_input면 펼침
  const shouldCollapse = status === "allow";

  const headerTitle =
    status === "allow"
      ? "✅ 기본 체크리스트(권장)"
      : status === "conditional"
      ? "⚠️ 조건부 체크리스트(추가 검토 필요)"
      : status === "deny"
      ? "❌ 불가 판정이지만, 원인 점검용 체크리스트"
      : status === "need_input"
      ? "❓ 입력이 필요한 체크리스트"
      : "🧾 체크리스트";

  const headerHint =
    status === "allow"
      ? "가능 판정이어도 실무에서 자주 걸리는 항목을 빠르게 확인해요."
      : status === "conditional"
      ? "조건부로 판정되었어요. 아래 항목을 입력/검토하면 결론이 더 명확해집니다."
      : status === "deny"
      ? "불가로 나왔지만, 어떤 규제가 걸리는지 빠르게 확인해요."
      : status === "need_input"
      ? "입력값이 부족해요. 아래 항목을 입력하면 서버가 자동으로 판정해줘요."
      : "항목을 입력하면 자동/서버 판정이 반영됩니다.";

  // body 표시/숨김은 클래스 기반
  const bodyHiddenClass = shouldCollapse ? "is-hidden" : "";

  const headerHtml = `
    <div class="clHeader">
      <div class="clHeaderRow">
        <div class="clHeaderText">
          <div class="clHeaderTitle">${escapeHtml(headerTitle)}</div>
          <div class="clHeaderHint">${escapeHtml(headerHint)}</div>
        </div>
        <button type="button" class="ghost clToggleAllBtn" data-toggle-checklist="all">
          ${shouldCollapse ? "펼치기" : "접기"}
        </button>
      </div>
    </div>
  `;

  const bodyOpenHtmlStart = `<div id="checklistBody" class="clBody ${bodyHiddenClass}">`;
  const bodyOpenHtmlEnd = `</div>`;

  const itemsHtml = items
    .map((it) => {
      const inputs = Array.isArray(it.inputs) ? it.inputs : [];

      const appliesHint = buildAppliesToHint(it);
      const appliesHtml = appliesHint
        ? `<div class="clAppliesTo">🔎 ${escapeHtml(appliesHint)}</div>`
        : "";

      const inputHtml = inputs
        .map((inp) => {
          if (typeof inp === "string") {
            return `<div class="clNeedInputLine">- 필요 입력: ${escapeHtml(inp)}</div>`;
          }

          const type = inp.type || "text";
          const key = inp.key || "";
          const label = inp.label || key;
          const placeholder = inp.placeholder || "";

          return `
            <label class="clInputLabel">
              <span class="clInputCaption">${escapeHtml(label)}</span>
              <input
                class="clInput"
                data-checklist-id="${escapeHtml(it.id)}"
                data-input-key="${escapeHtml(key)}"
                type="${escapeHtml(type)}"
                placeholder="${escapeHtml(placeholder)}"
              />
            </label>
          `;
        })
        .join("");

      const refs = Array.isArray(it.refs) ? it.refs : [];
      const refsText = refs.join(", ");
      const lawMap = it?.laws || {};

      const refsCards = refs
        .map((code) => {
          const ref = lawMap?.[code];
          if (!ref) {
            return `
              <div class="lawCard">
                <div class="lawCardTitle">${escapeHtml(code)}</div>
                <div class="lawCardSub">(laws.json에 정보가 없어요)</div>
              </div>
            `;
          }

          const urlHtml = ref.url
            ? `<div class="lawCardLink"><a href="${escapeHtml(ref.url)}" target="_blank" rel="noopener">법령 링크 열기</a></div>`
            : "";

          return `
            <div class="lawCard">
              <div class="lawCardTop">
                <div class="lawCardTitle">${escapeHtml(code)} · ${escapeHtml(ref.title)}</div>
                <div class="lawCardDate">${escapeHtml(ref.updated_at || "")}</div>
              </div>
              <div class="lawCardMeta">${escapeHtml(ref.law_name || "")} ${escapeHtml(ref.article || "")}</div>
              <div class="lawCardSummary">${escapeHtml(ref.summary || "")}</div>
              ${urlHtml}
            </div>
          `;
        })
        .join("");

      const hasRefs = refs.length > 0;

      return `
        <div class="clItem">
          <div class="clItemTop">
            <div class="clItemTitle">□ ${escapeHtml(it.title)}</div>
            <div id="judge_${escapeHtml(it.id)}" class="clJudge" data-title="${escapeHtml(it.title)}"></div>
          </div>

          ${appliesHtml}

          <div class="clWhy">- 왜 체크? ${escapeHtml(it.why || "")}</div>
          ${inputHtml}

          <div class="clRefs">- 근거: ${escapeHtml(refsText || "-")}</div>

          ${
            hasRefs
              ? `
              <div class="clLaws">
                <button type="button" class="ghost clLawsBtn" data-toggle-laws="${escapeHtml(it.id)}">
                  📖 근거 법령 보기
                </button>
                <div id="laws_${escapeHtml(it.id)}" class="lawsPanel is-hidden">
                  ${refsCards}
                </div>
              </div>
            `
              : ""
          }

          <div id="judge_msg_${escapeHtml(it.id)}" class="clJudgeMsg"></div>
        </div>
      `;
    })
    .join("");

  list.innerHTML = `${headerHtml}${bodyOpenHtmlStart}${itemsHtml}${bodyOpenHtmlEnd}`;

  // 🔒 이벤트 중복 바인딩 방지
  if (!list._delegationBound) {
    list._delegationBound = true;

    list.addEventListener("click", (e) => {
      // (0) 전체 접기/펼치기
      const allBtn = e.target?.closest?.("button[data-toggle-checklist]");
      if (allBtn) {
        const body = $("checklistBody");
        if (!body) return;

        const isHidden = body.classList.contains("is-hidden");
        if (isHidden) body.classList.remove("is-hidden");
        else body.classList.add("is-hidden");

        // ✅ 토글 후 상태 기반으로 버튼 텍스트 동기화
        allBtn.textContent = body.classList.contains("is-hidden") ? "펼치기" : "접기";
        return;
      }

      // (1) 법령 토글
      const btn = e.target?.closest?.("button[data-toggle-laws]");
      if (!btn) return;

      const id = btn.getAttribute("data-toggle-laws");
      const panel = $(`laws_${id}`);
      if (!panel) return;

      panel.classList.toggle("is-hidden");
    });

    // (2) 입력 변경 시 자동판정(프론트) + 서버판정(디바운스)
    list.addEventListener("input", (e) => {
      const el = e.target;
      if (!el || el.tagName !== "INPUT") return;

      const checklistId = el.getAttribute("data-checklist-id");
      if (!checklistId) return;

      const inputEls = list.querySelectorAll(`input[data-checklist-id="${checklistId}"]`);

      const values = {};
      inputEls.forEach((ie) => {
        const k = ie.getAttribute("data-input-key");
        if (!k) return;
        values[k] = ie.value;
      });

      const item = (_currentChecklistItems || []).find((x) => x.id === checklistId);
      if (!item) return;

      const judged = evaluateAutoRules(item, values);

      const judgeEl = $(`judge_${checklistId}`);
      const msgEl = $(`judge_msg_${checklistId}`);
      if (!judgeEl || !msgEl) return;

      // 프론트 auto_rules는 "즉시 피드백" 용 (서버판정이 최종)
      if (judged) {
        judgeEl.innerHTML = badgeHtml(judged.result) || escapeHtml(judged.result);
        msgEl.textContent = judged.message || "";
      }

      // ✅ 서버판정은 디바운스로 따라오게
      debouncedServerJudge();
    });
  }

  // ✅ enriched에서 내려온 초기 server_judge + missing_inputs를 1회 반영
  items.forEach((it) => {
    const id = it.id;
    const judgeEl = $(`judge_${id}`);
    const msgEl = $(`judge_msg_${id}`);
    if (!judgeEl || !msgEl) return;

    const sj = it.server_judge;
    if (sj?.result) {
      judgeEl.innerHTML = badgeHtml(sj.result);
      if (sj.message) msgEl.textContent = sj.message;
    }

    const miss = it.missing_inputs || [];
    if (miss.length) markMissingInputs(id, miss);
  });

  // ✅ (핵심) calc 결과가 있으면 입력칸 자동 채우고, 즉시 서버판정 1회
  try {
    const { changed } = autofillChecklistInputsFromCalc({ onlyEmpty: true });
    if (changed > 0) {
      // 즉시 서버판정(디바운스 없이)
      if (!_isAutoFillRunning) {
        _isAutoFillRunning = true;
        Promise.resolve()
          .then(() => runServerJudgeAndApply())
          .finally(() => {
            _isAutoFillRunning = false;
          });
      }
      return;
    }
  } catch (e) {
    console.warn("autofill after render failed:", e);
  }

  // 체크리스트가 새로 뜨면 1회 서버판정(최종 갱신)
  debouncedServerJudge();
}

/* =========================
   계산
========================= */
async function runCalc() {
  const landArea = Number($("landArea")?.value);
  const bcr = Number($("bcr")?.value);
  const far = Number($("far")?.value);
  const floorHeight = Number($("floorHeight")?.value) || 3.3;

  const resultEl = $("result");
  const talkEl = $("talkTrack");

  if (!resultEl || !talkEl) {
    alert("index.html에 result 또는 talkTrack 영역이 없어요. id를 확인해줘요.");
    return;
  }

  if (
    !isFiniteNumber(landArea) ||
    landArea <= 0 ||
    !isFiniteNumber(bcr) ||
    bcr <= 0 ||
    !isFiniteNumber(far) ||
    far <= 0
  ) {
    resultEl.innerHTML = "대지면적(㎡), 건폐율(%), 용적률(%)을 0보다 크게 입력해 주세요.";
    talkEl.value = "검토 결과를 먼저 계산해 주세요.";
    return;
  }

  const url = `/api/calc?site=${encodeURIComponent(landArea)}&coverage=${encodeURIComponent(
    bcr
  )}&far=${encodeURIComponent(far)}&floor=${encodeURIComponent(floorHeight)}`;

  resultEl.innerHTML = "계산 중...";

  try {
    const data = await fetchJson(url);
    const res = data.result;

    lastCalcResult = { input: { landArea, bcr, far, floorHeight }, result: res };

    resultEl.innerHTML = `
      <div><b>✅ 기본 산정 결과</b></div>
      <div>최대 건축면적(단순): <b>${fmt(res.maxBuildingArea_m2)} ㎡</b></div>
      <div>최대 연면적(단순): <b>${fmt(res.maxTotalFloorArea_m2)} ㎡</b></div>
      <div>예상 층수: <b>${fmt(res.estFloors)} 층</b></div>
      <div>예상 건물 높이: <b>${fmt(res.estHeight_m)} m</b></div>
      <div class="calcNote">${escapeHtml(data.note || "")}</div>
    `;

    talkEl.value = [
      `대지면적 ${fmt(landArea)}㎡ 기준, 건폐율 ${fmt(bcr)}% 적용 시 1층 최대 약 ${fmt(res.maxBuildingArea_m2)}㎡까지 가능합니다.`,
      `용적률 ${fmt(far)}% 기준으로 총 연면적은 약 ${fmt(res.maxTotalFloorArea_m2)}㎡까지 가능합니다.`,
      `층고를 ${fmt(floorHeight)}m로 가정하면 약 ${fmt(res.estFloors)}층 규모(높이 약 ${fmt(res.estHeight_m)}m)가 예상됩니다.`,
      data.note ? `※ 참고: ${data.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    // ✅ (1) 계산값이 생기면 체크리스트 입력칸 자동 채움 + 서버판정 즉시 1회
    try {
      const { changed } = autofillChecklistInputsFromCalc({ onlyEmpty: true });
      if (changed > 0) {
        await runServerJudgeAndApply();
      } else {
        // 값이 안 들어갔어도 서버판정엔 도움 되므로 디바운스 호출
        debouncedServerJudge();
      }
    } catch (e) {
      console.warn("calc -> autofill failed:", e);
      debouncedServerJudge();
    }

    // ✅ (2) 계산값이 생기면 enriched를 재로딩해서 applies_to 관련 표시/힌트 업데이트
    try {
      const fn = window.__refreshChecklistByContext;
      if (typeof fn === "function") {
        const z = ($("zoning")?.value || "").trim();
        const u = ($("useSelect")?.value || "").trim();
        if (z && u) {
          await fn({ zoning: z, use: u, status: _lastUseStatus || "unknown", reason: "calc_reload" });
        }
      }
    } catch (e) {
      console.warn("calc -> checklist reload failed:", e);
    }
  } catch (e) {
    resultEl.innerHTML = `오류: ${escapeHtml(String(e))}`;
    talkEl.value = "오류가 발생했습니다. 입력값/서버 상태를 확인해 주세요.";
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
  _lastUseStatus = "";

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

  const judgeHint = $("judgeServerHint");
  if (judgeHint) judgeHint.textContent = "";

  if (marker && map) {
    try {
      map.removeLayer(marker);
    } catch {}
    marker = null;
  }
  if (map) map.setView([37.5665, 126.978], 13);

  const addrInput = $("addr");
  if (addrInput) addrInput.value = "";

  const zoningSelect = $("zoning");
  if (zoningSelect) zoningSelect.value = "";

  const useSelect = $("useSelect");
  if (useSelect) useSelect.value = "";

  _ctx = { addr: "", lat: null, lon: null, jurisdiction: "", zoning: "", use: "" };
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
   요약(법령 포함)
========================= */
function buildSummaryText() {
  const addr = ($("addr")?.value || "").trim();
  const zoning = ($("zoning")?.value || "").trim();
  const use = ($("useSelect")?.value || "").trim();

  const landArea = $("landArea")?.value || "";
  const bcr = $("bcr")?.value || "";
  const far = $("far")?.value || "";
  const floorH = $("floorHeight")?.value || "3.3";

  const useLabel = _useLabelMap[use] || "";
  const usePretty = use ? (useLabel ? `${useLabel} (${use})` : use) : "";

  const jurisdictionState = _ctx.jurisdiction ? "guess" : "unsure";
  const zoningState = zoning ? "guess" : "unsure";
  const useState = use ? "guess" : "unsure";
  const calcState = lastCalcResult?.result ? "sure" : "unsure";

  function readChecklistSummary() {
    const card = $("checklistCard");
    const list = $("checklistList");
    if (!card || !list || card.style.display === "none") return { text: "", usedRefs: [], missingCount: 0 };

    const lines = [];
    const usedRefCodes = new Set();

    lines.push("");
    lines.push("🧾 체크리스트(자동/수동)");

    const judgeEls = Array.from(list.querySelectorAll('div[id^="judge_"]')).filter(
      (el) => !String(el.id).startsWith("judge_msg_")
    );

    let missingCount = 0;

    judgeEls.forEach((judgeEl) => {
      const id = judgeEl.id.replace("judge_", "");
      const title = (judgeEl.getAttribute("data-title") || id).trim();

      const badge = (judgeEl.textContent || "").trim();
      const msgEl = $(`judge_msg_${id}`);
      const msg = (msgEl?.textContent || "").trim();

      const inputEls = list.querySelectorAll(`input[data-checklist-id="${id}"]`);
      let hasAnyInput = false;
      let hasAnyFilled = false;
      inputEls.forEach((ie) => {
        hasAnyInput = true;
        if (String(ie.value || "").trim()) hasAnyFilled = true;
      });

      if (!badge && !msg && !hasAnyFilled) {
        if (hasAnyInput) missingCount += 1;
        return;
      }

      if (badge && msg) lines.push(`- ${title}: ${badge} / ${msg}`);
      else if (badge) lines.push(`- ${title}: ${badge}`);
      else if (msg) lines.push(`- ${title}: ${msg}`);
      else lines.push(`- ${title}: (입력값 있음 · 수동 검토 필요)`);

      const item = (_renderedChecklist || []).find((x) => x.id === id);
      (item?.refs || []).forEach((c) => usedRefCodes.add(c));
    });

    if (missingCount > 0) lines.push(`- (값 부족) 입력이 필요한 항목 ${missingCount}개`);

    return { text: lines.join("\n"), usedRefs: Array.from(usedRefCodes), missingCount };
  }

  const { text: checklistText, usedRefs } = readChecklistSummary();

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

  let lawSummary = "";
  if (usedRefs.length > 0) {
    const lines = [];
    lines.push("");
    lines.push("📚 근거 법령(요약)");

    usedRefs.forEach((code) => {
      let ref = null;
      for (const it of _renderedChecklist || []) {
        if (it?.laws?.[code]) {
          ref = it.laws[code];
          break;
        }
      }
      if (!ref) lines.push(`- ${code}: (정보 없음)`);
      else lines.push(`- ${code}: ${ref.title} / ${ref.law_name} ${ref.article}`);
    });

    lawSummary = lines.join("\n");
  }

  return [
    "📌 건축 기본 검토 요약",
    addr ? `- 주소: ${addr}` : "- 주소: (미입력)",
    `- 지자체(추정): ${_ctx.jurisdiction || "(미확정)"} ${badgeText(jurisdictionState)}`,
    `- 용도지역(간이): ${zoning || "(미선택)"} ${badgeText(zoningState)}`,
    `- 용도(간이): ${usePretty || "(미선택)"} ${badgeText(useState)}`,
    `- 기본 산정: ${badgeText(calcState)}`,
    `- 대지면적: ${landArea || "-"} ㎡`,
    `- 건폐율(입력/상한): ${bcr || "-"} %`,
    `- 용적률(입력/상한): ${far || "-"} %`,
    `- 층고 가정: ${floorH || "3.3"} m`,
    "",
    "※ 본 요약은 간이 산정이며 실제 인허가/조례/심의 조건에 따라 달라질 수 있습니다.",
    calcSummary,
    checklistText,
    lawSummary,
  ]
    .filter(Boolean)
    .join("\n");
}

/* =========================
   DOMContentLoaded: UI 연결 + UX 자동화
========================= */
window.addEventListener("DOMContentLoaded", () => {
  // 지도
  if ($("map") && window.L) {
    map = L.map("map").setView([37.5665, 126.978], 13);
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

  // 룰/용도 관련 엘리먼트
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

  // 서버판정 버튼
  $("judgeServerBtn")?.addEventListener("click", async () => {
    await runServerJudgeAndApply();
  });

  // 초기 데이터 로드 상태
  let _usesLoaded = false;

  // 용도지역 옵션 로드
  async function loadZoningOptions() {
    if (!zoningSelect) return;

    try {
      const data = await fetchJson("/api/rules/zoning");

      zoningSelect.innerHTML = `<option value="">선택하세요</option>`;
      (data.list || []).forEach((z) => {
        const value = typeof z === "string" ? z : z.zoning;
        if (!value) return;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        zoningSelect.appendChild(opt);
      });

      setText(ruleHint, "✅ 용도지역 목록을 불러왔어요.");
    } catch (e) {
      setText(ruleHint, `❌ 용도지역 목록 로드 실패: ${escapeHtml(String(e))}`);
    }
  }

  // 룰 적용 함수
  async function applyRuleByZoning(zoning, { silent = false } = {}) {
    if (!zoning) return;
    if (!silent) setText(ruleHint, "룰 적용 중...");

    const data = await fetchJson(`/api/rules/apply?zoning=${encodeURIComponent(zoning)}`);

    const rule = data.rule || data.result || {};
    const bcrEl = $("bcr");
    const farEl = $("far");
    if (bcrEl && rule.bcr_max != null) bcrEl.value = rule.bcr_max;
    if (farEl && rule.far_max != null) farEl.value = rule.far_max;

    if (!silent) {
      setText(
        ruleHint,
        `
        <div>✅ <b>${escapeHtml(zoning)}</b> 룰 적용 완료</div>
        <div class="ruleAppliedMeta">
          건폐율(상한): ${rule.bcr_max ?? "-"}% /
          용적률(상한): ${rule.far_max ?? "-"}%
        </div>
      `
      );
    }
  }

  applyRuleBtn?.addEventListener("click", async () => {
    const zoning = zoningSelect?.value || "";
    if (!zoning) {
      setText(ruleHint, "용도지역을 먼저 선택해 주세요.");
      return;
    }
    try {
      _ctx.zoning = zoning;
      await applyRuleByZoning(zoning);
    } catch (e) {
      setText(ruleHint, `❌ 룰 적용 실패: ${escapeHtml(String(e))}`);
    }
  });

  zoningSelect?.addEventListener("change", async () => {
    const zoning = zoningSelect?.value || "";
    if (!zoning) return;
    try {
      _ctx.zoning = zoning;
      await applyRuleByZoning(zoning, { silent: false });

      const use = useSelect?.value || "";
      if (use) debouncedAutoUseCheck();
    } catch (e) {
      setText(ruleHint, `❌ 룰 자동 적용 실패: ${escapeHtml(String(e))}`);
    }
  });

  // 용도 목록 로드
  async function loadUseOptions() {
    if (!useSelect) return;

    try {
      const data = await fetchJson("/api/uses");

      useSelect.innerHTML = `<option value="">선택하세요</option>`;
      _useLabelMap = {};

      (data.list || []).forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.code;
        opt.textContent = u.label;
        useSelect.appendChild(opt);

        if (u.code) _useLabelMap[u.code] = u.label || u.code;
      });

      _usesLoaded = true;
      setText(useResult, "✅ 용도 목록을 불러왔어요.");
    } catch (e) {
      setText(useResult, `❌ 용도 목록 로드 실패: ${escapeHtml(String(e))}`);
    }
  }

  // ✅ status와 무관하게 체크리스트를 로드/렌더하는 함수
  async function refreshChecklistByContext({ zoning, use, status, reason = "" } = {}) {
    const z = (zoning ?? zoningSelect?.value ?? "").trim();
    const u = (use ?? useSelect?.value ?? "").trim();

    if (!z || !u) {
      renderChecklist([]);
      return;
    }

    if (!ALWAYS_SHOW_CHECKLIST && normalizeStatus(status) !== "conditional") {
      renderChecklist([]);
      return;
    }

    const { items } = await loadEnrichedChecklistWithContext({
      zoning: z,
      use: u,
      jurisdiction: _ctx.jurisdiction || "",
      ...buildEnrichedExtraFromCalc(),
    });

    renderChecklist(items, { status });
  }

  // ✅ runCalc에서 재사용할 수 있게 전역으로 노출
  window.__refreshChecklistByContext = refreshChecklistByContext;

  // 용도 가능여부 체크
  async function checkUseAndMaybeChecklist({ zoning, use, reason = "" } = {}) {
    const z = (zoning ?? zoningSelect?.value ?? "").trim();
    const u = (use ?? useSelect?.value ?? "").trim();

    if (!z) {
      setText(useResult, "용도지역(간이)을 먼저 선택해 주세요.");
      renderChecklist([]);
      return;
    }
    if (!u) {
      setText(useResult, "건축 용도(간이)를 먼저 선택해 주세요.");
      renderChecklist([]);
      return;
    }

    setText(
      useResult,
      `용도 가능 여부 판단 중... ${reason ? `<span class="inlineDim">(${escapeHtml(reason)})</span>` : ""}`
    );

    try {
      _ctx.zoning = z;
      _ctx.use = u;

      const data = await fetchJson(`/api/uses/check?zoning=${encodeURIComponent(z)}&use=${encodeURIComponent(u)}`);
      const useLabel = _useLabelMap[u] || u;

      // ✅ 마지막 status 저장
      _lastUseStatus = data.status || "";

      setText(
        useResult,
        `
          <div><b>${escapeHtml(data.message)}</b></div>
          <div class="useRow">용도지역: ${escapeHtml(data.zoning)}</div>
          <div class="useRow">용도: ${escapeHtml(useLabel)} (${escapeHtml(u)})</div>
          ${
            _ctx.jurisdiction
              ? `<div class="useRow">지자체(추정): ${escapeHtml(_ctx.jurisdiction)}</div>`
              : ""
          }
        `
      );

      await refreshChecklistByContext({ zoning: z, use: u, status: data.status });
    } catch (e) {
      setText(useResult, `❌ 용도 판단 실패: ${escapeHtml(String(e))}`);
      renderChecklist([]);
    }
  }

  // 수동 버튼
  checkUseBtn?.addEventListener("click", async () => {
    await checkUseAndMaybeChecklist({ reason: "수동 실행" });
  });

  // 자동 판정(디바운스)
  const debouncedAutoUseCheck = debounce(async () => {
    await checkUseAndMaybeChecklist({ reason: "자동" });
  }, 380);

  useSelect?.addEventListener("change", () => {
    const z = (zoningSelect?.value || "").trim();
    const u = (useSelect?.value || "").trim();
    if (!z || !u) return;
    debouncedAutoUseCheck();
  });

  // 요약 버튼
  const summaryBox = $("summaryBox");
  $("summaryBtn")?.addEventListener("click", async () => {
    const card = $("checklistCard");
    const hasChecklist = card && card.style.display !== "none" && (_renderedChecklist || []).length > 0;
    if (hasChecklist) await runServerJudgeAndApply();

    const text = buildSummaryText();
    if (summaryBox) {
      summaryBox.innerHTML = `<pre class="summaryPre">${escapeHtml(text)}</pre>`;
    }
  });

  $("copySummaryBtn")?.addEventListener("click", async () => {
    const card = $("checklistCard");
    const hasChecklist = card && card.style.display !== "none" && (_renderedChecklist || []).length > 0;
    if (hasChecklist) await runServerJudgeAndApply();

    const text = buildSummaryText();
    try {
      await navigator.clipboard.writeText(text);
      alert("요약을 복사했어요!");
    } catch {
      alert("복사에 실패했어요. 브라우저 권한을 확인해 주세요.");
    }
  });

  /* =========================
     ✅ 주소 → 자동 파이프라인
  ========================= */
  async function runGeocodeFlow(q, { reason = "" } = {}) {
    const query = (q || "").trim();
    if (!query) {
      setText(addrResult, "주소를 입력해 주세요.");
      return;
    }

    // ✅ 같은 값 반복 호출 방지
    const key = query;
    if (_lastGeocodeKey === key && reason === "자동") return;
    _lastGeocodeKey = key;

    // ✅ 이전 요청 취소
    if (_geocodeAbort) {
      try {
        _geocodeAbort.abort();
      } catch {}
    }
    _geocodeAbort = new AbortController();

    setText(
      addrResult,
      `좌표 조회 중... ${reason ? `<span class="inlineDim">(${escapeHtml(reason)})</span>` : ""}`
    );

    try {
      const data = await fetchJson(`/api/geocode?q=${encodeURIComponent(query)}`, {
        signal: _geocodeAbort.signal,
      });

      if (!data.found) {
        setText(addrResult, "검색 결과가 없습니다. 주소를 더 자세히 입력해 보세요.");
        return;
      }

      const lat = Number(data.result.lat);
      const lon = Number(data.result.lon);
      const display_name = data.result.display_name;

      _ctx.addr = query;
      _ctx.lat = lat;
      _ctx.lon = lon;

      setText(
        addrResult,
        `
          <div>✅ 조회 성공</div>
          <div class="geoName">${escapeHtml(display_name)}</div>
          <div class="geoCoord"><b>위도</b> ${lat} / <b>경도</b> ${lon}</div>
        `
      );

      if (map && Number.isFinite(lat) && Number.isFinite(lon)) {
        map.setView([lat, lon], 17);
        if (marker) marker.setLatLng([lat, lon]);
        else marker = L.marker([lat, lon]).addTo(map);
      }

      // reverse로 지자체 추정
      try {
        const rdata = await fetchJson(`/api/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, {
          signal: _geocodeAbort.signal,
        });
        if (rdata.found) _ctx.jurisdiction = (rdata.jurisdiction || "").trim();
      } catch (e) {
        console.warn("reverse failed:", e);
      }

      // 좌표 기반 자동 용도지역 판정 → 룰 적용
      try {
        const zdata = await fetchJson(
          `/api/zoning/by-coord?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
          { signal: _geocodeAbort.signal }
        );

        if (zdata.found) {
          if (zoningSelect) zoningSelect.value = zdata.zoning;
          _ctx.zoning = zdata.zoning;

          try {
            await applyRuleByZoning(zdata.zoning, { silent: true });
            setText(
              ruleHint,
              `
                <div>🧭 좌표 기반 추정 용도지역 자동 설정</div>
                <div class="ruleAutoZoning"><b>${escapeHtml(zdata.zoning)}</b> [추정]</div>
                <div class="ruleAutoDone">룰(건폐율/용적률) 자동 적용 완료</div>
                ${
                  _ctx.jurisdiction
                    ? `<div class="ruleAutoJuris">지자체(추정): ${escapeHtml(_ctx.jurisdiction)}</div>`
                    : ""
                }
              `
            );
          } catch (e) {
            setText(ruleHint, `❌ 룰 자동 적용 실패: ${escapeHtml(String(e))}`);
          }

          // 기본 용도 자동 세팅 + 자동 판정
          const defaultUse = "RES_HOUSE";
          if (_usesLoaded && useSelect) {
            useSelect.value = defaultUse;
            await checkUseAndMaybeChecklist({
              zoning: zdata.zoning,
              use: defaultUse,
              reason: "기본용도(주거) 자동",
            });
          } else {
            const retryOnce = async () => {
              if (!_usesLoaded) return;
              if (useSelect) useSelect.value = defaultUse;
              await checkUseAndMaybeChecklist({
                zoning: zdata.zoning,
                use: defaultUse,
                reason: "기본용도(주거) 자동",
              });
            };
            setTimeout(retryOnce, 250);
            setTimeout(retryOnce, 800);
          }
        }
      } catch (e) {
        console.warn("auto zoning failed:", e);
      }
    } catch (e) {
      if (String(e).includes("AbortError")) return;
      setText(addrResult, `❌ 오류: ${escapeHtml(String(e))}`);
    }
  }

  // 버튼 클릭
  addrBtn?.addEventListener("click", async () => {
    await runGeocodeFlow(addrInput?.value || "", { reason: "수동" });
  });

  // 엔터 실행
  addrInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runGeocodeFlow(addrInput?.value || "", { reason: "엔터" });
    }
  });

  // 입력 후 멈추면 자동 실행
  const debouncedAddrAuto = debounce(() => {
    const q = (addrInput?.value || "").trim();
    if (q.length < 6) return;
    runGeocodeFlow(q, { reason: "자동" });
  }, 650);

  addrInput?.addEventListener("input", () => {
    debouncedAddrAuto();
  });

  /* =========================
     초기 로드
  ========================= */
  loadZoningOptions();
  loadUseOptions();
});
