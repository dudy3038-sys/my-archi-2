/**
 * functions/scripts/seed_laws.js
 *
 * ✅ laws.json -> Firestore(laws 컬렉션) 시드 스크립트 (보정/검증 강화)
 *
 * 사용 예)
 * 1) (에뮬레이터)
 *    cd functions
 *    node scripts/seed_laws.js --target emulator
 *
 * 2) (운영/실서버) 매우 주의:
 *    cd functions
 *    node scripts/seed_laws.js --target prod --force
 *
 * 옵션:
 *   --project <projectId>   (없으면 .firebaserc / 환경변수에서 추론)
 *   --dry-run               (실제 쓰기 없이 출력만)
 *   --force                 (prod 실행 안전장치 해제)
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    target: null, // emulator | prod
    project: null,
    dryRun: false,
    force: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") {
      args.target = String(argv[i + 1] || "").trim();
      i++;
      continue;
    }
    if (a === "--project") {
      args.project = String(argv[i + 1] || "").trim();
      i++;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--force") {
      args.force = true;
      continue;
    }
  }

  return args;
}

function requireTarget(t) {
  const v = String(t || "").trim().toLowerCase();
  if (v !== "emulator" && v !== "prod") {
    throw new Error('필수 인자 누락: --target emulator 또는 --target prod 를 지정해줘');
  }
  return v;
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * .firebaserc 예시:
 * {
 *   "projects": { "default": "my-archi-1-39535368" }
 * }
 */
function resolveProjectIdFromFirebaserc() {
  const candidates = [
    path.join(__dirname, "..", "..", ".firebaserc"), // repo root
    path.join(process.cwd(), "..", ".firebaserc"), // when cwd=functions
    path.join(process.cwd(), ".firebaserc"), // when cwd=repo root
  ];

  for (const p of candidates) {
    const j = readJsonIfExists(p);
    const proj = j?.projects?.default;
    if (proj && String(proj).trim()) return String(proj).trim();
  }
  return null;
}

function resolveProjectId(explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();

  const rc = resolveProjectIdFromFirebaserc();
  if (rc) return rc;

  const env =
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT ||
    "";

  return String(env || "").trim() || null;
}

function readLawsJson() {
  // functions/scripts/seed_laws.js 기준 -> functions/rules/laws.json
  const filePath = path.join(__dirname, "..", "rules", "laws.json");
  if (!fs.existsSync(filePath)) throw new Error(`laws.json을 찾을 수 없음: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const json = JSON.parse(raw);
  return { filePath, json };
}

function ensureEmulatorHost() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  }
}

function assertProdGuard(force) {
  if (!force) {
    throw new Error(
      "prod 타겟은 기본적으로 차단돼. 정말 실서버에 쓰려면 --force 를 추가해줘.\n" +
        "예) node scripts/seed_laws.js --target prod --force"
    );
  }
}

/* =========================
   ✅ 보정/검증 유틸
========================= */

function nowIso() {
  return new Date().toISOString();
}

function toStr(v) {
  return String(v ?? "").trim();
}

// Firestore에 넣기 전 최소 규격 보정(프론트 호환은 Cloudflare 쪽이지만, DB도 동일 스키마로 관리)
function normalizeLawDoc(codeRaw, docRaw) {
  const code = toStr(codeRaw);
  const d = docRaw && typeof docRaw === "object" ? { ...docRaw } : {};

  // code/id 필수 보강
  if (!d.code) d.code = code;
  if (!d.id) d.id = code;

  // 문자열 필드 정리
  if (d.title != null) d.title = toStr(d.title);
  if (d.law_name != null) d.law_name = toStr(d.law_name);
  if (d.article != null) d.article = toStr(d.article);
  if (d.summary != null) d.summary = toStr(d.summary);

  // 프론트가 기대하는 필드(호환을 위해 항상 존재하도록)
  if (d.url == null) d.url = "";
  if (!d.display_mode) d.display_mode = d.url ? "link" : "placeholder_link";

  // tags/notes/checkpoints 배열 보정
  if (d.tags && !Array.isArray(d.tags)) d.tags = [toStr(d.tags)].filter(Boolean);
  if (!Array.isArray(d.tags)) d.tags = Array.isArray(d.tags) ? d.tags : d.tags || [];
  d.tags = (d.tags || []).map((x) => toStr(x)).filter(Boolean);

  if (d.practical_notes && !Array.isArray(d.practical_notes)) d.practical_notes = [toStr(d.practical_notes)];
  d.practical_notes = (d.practical_notes || []).map((x) => toStr(x)).filter(Boolean);

  if (d.designer_checkpoints && !Array.isArray(d.designer_checkpoints)) d.designer_checkpoints = [toStr(d.designer_checkpoints)];
  d.designer_checkpoints = (d.designer_checkpoints || []).map((x) => toStr(x)).filter(Boolean);

  // updated_at 없으면 seed 시점으로 넣어둠(정렬/추적에 유용)
  if (!d.updated_at) d.updated_at = nowIso().slice(0, 10);

  // source는 object 유지(있으면 문자열 trim)
  if (d.source && typeof d.source === "object") {
    if (d.source.provider != null) d.source.provider = toStr(d.source.provider);
    if (d.source.type != null) d.source.type = toStr(d.source.type);
    if (d.source.jurisdiction != null) d.source.jurisdiction = toStr(d.source.jurisdiction);
    if (d.source.article_hint != null) d.source.article_hint = toStr(d.source.article_hint);
  }

  // 내부 메타
  d._source = "seed_laws.js";
  d._seeded_at = nowIso();

  return d;
}

// 최소 품질 체크(경고만 출력하고 계속 진행)
function validateLawDoc(code, doc) {
  const warn = [];
  if (!toStr(doc.title)) warn.push("title 없음");
  if (!toStr(doc.law_name)) warn.push("law_name 없음");
  if (!toStr(doc.article)) warn.push("article 없음");
  // url은 placeholder 가능
  if (!toStr(doc.updated_at)) warn.push("updated_at 없음");
  if (warn.length) {
    console.log(`[seed][WARN] ${code}: ${warn.join(", ")}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const target = requireTarget(args.target);
  const projectId = resolveProjectId(args.project);

  if (!projectId) {
    throw new Error(
      "projectId를 알 수 없어. --project <프로젝트ID> 를 붙이거나 .firebaserc의 projects.default를 확인해줘.\n" +
        "예) node scripts/seed_laws.js --target emulator --project my-archi-1-39535368"
    );
  }

  if (target === "emulator") {
    ensureEmulatorHost();
    console.log(`[seed] target=emulator`);
    console.log(`[seed] projectId=${projectId}`);
    console.log(`[seed] FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST}`);
  } else {
    assertProdGuard(args.force);
    console.log(`[seed] target=prod (⚠️ 실서버에 기록합니다. 정말 주의!)`);
    console.log(`[seed] projectId=${projectId}`);
  }

  if (!admin.apps.length) {
    admin.initializeApp({ projectId });
  }

  const db = admin.firestore();

  const { filePath, json } = readLawsJson();
  const entries = Object.entries(json || {});
  console.log(`[seed] laws.json loaded: ${filePath}`);
  console.log(`[seed] records: ${entries.length}`);

  if (entries.length === 0) {
    console.log("[seed] nothing to write.");
    return;
  }

  // 미리보기
  if (args.dryRun) {
    console.log("[seed] --dry-run: 실제 쓰기 없이 종료합니다.");

    const sample = entries.slice(0, 8).map(([code, doc]) => {
      const nd = normalizeLawDoc(code, doc);
      return {
        code,
        title: nd.title,
        law_name: nd.law_name,
        article: nd.article,
        display_mode: nd.display_mode,
        updated_at: nd.updated_at,
      };
    });

    console.log("[seed] sample:", sample);
    return;
  }

  // Firestore batch는 500개 제한
  const BATCH_LIMIT = 450; // 여유
  let totalWritten = 0;
  let batchCount = 0;

  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const chunk = entries.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();

    let actual = 0;
    for (const [codeRaw, docRaw] of chunk) {
      const code = toStr(codeRaw);
      if (!code) continue;

      const doc = normalizeLawDoc(code, docRaw);
      validateLawDoc(code, doc);

      const ref = db.collection("laws").doc(code);
      batch.set(ref, doc, { merge: true });
      actual++;
    }

    await batch.commit();
    batchCount++;
    totalWritten += actual;
    console.log(`[seed] committed batch #${batchCount} (+${actual})`);
  }

  console.log(`[seed] ✅ done. written=${totalWritten}, target=${target}, project=${projectId}`);
  console.log("[seed] 확인 예:");
  console.log("  - Firestore laws/<CODE> 문서 확인");
}

main().catch((err) => {
  console.error("[seed] ERROR:", err?.message || err);
  process.exit(1);
});
