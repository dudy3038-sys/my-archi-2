/**
 * functions/scripts/seed_laws.js
 *
 * ✅ laws.json -> Firestore(laws 컬렉션) 시드 스크립트
 *
 * 사용 예)
 * 1) (에뮬레이터에 넣기) 터미널에서:
 *    cd functions
 *    node scripts/seed_laws.js --target emulator
 *
 * 2) (운영/실서버에 넣기) 매우 주의:
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
 *   "projects": {
 *     "default": "my-archi-1-39535368"
 *   }
 * }
 */
function resolveProjectIdFromFirebaserc() {
  // scripts/seed_laws.js -> functions/scripts
  // functions 폴더 기준: ../.firebaserc (프로젝트 루트)
  const candidates = [
    path.join(__dirname, "..", "..", ".firebaserc"), // repo root
    path.join(process.cwd(), "..", ".firebaserc"),   // when cwd=functions
    path.join(process.cwd(), ".firebaserc"),         // when cwd=repo root
  ];

  for (const p of candidates) {
    const j = readJsonIfExists(p);
    const proj = j?.projects?.default;
    if (proj && String(proj).trim()) return String(proj).trim();
  }
  return null;
}

function resolveProjectId(explicit) {
  // 1) CLI 인자
  if (explicit && String(explicit).trim()) return String(explicit).trim();

  // 2) .firebaserc
  const rc = resolveProjectIdFromFirebaserc();
  if (rc) return rc;

  // 3) 환경변수
  const env =
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT ||
    "";

  return String(env || "").trim() || null;
}

function readLawsJson() {
  const filePath = path.join(__dirname, "..", "rules", "laws.json");
  if (!fs.existsSync(filePath)) throw new Error(`laws.json을 찾을 수 없음: ${filePath}`);
  const raw = fs.readFileSync(filePath, "utf-8");
  const json = JSON.parse(raw);
  return { filePath, json };
}

function ensureEmulatorHost() {
  // Firestore Emulator 기본: 127.0.0.1:8080
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

  // init
  if (!admin.apps.length) {
    // projectId를 명시해두면 emulator에서도 안정적으로 동작
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
    const sample = entries.slice(0, 5).map(([code, doc]) => ({
      code,
      title: doc?.title,
      law_name: doc?.law_name,
      article: doc?.article,
    }));
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
      const code = String(codeRaw || "").trim();
      if (!code) continue;

      const doc = { ...(docRaw || {}) };
      if (!doc.code) doc.code = code;
      doc._source = "seed_laws.js";
      doc._seeded_at = new Date().toISOString();

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
  console.log("  - /api/laws/BLD-ACT-44");
  console.log("  - /api/laws?codes=BLD-ACT-44,PARK-ORD-01");
  console.log("  - /api/laws?all=1");
}

main().catch((err) => {
  console.error("[seed] ERROR:", err?.message || err);
  process.exit(1);
});
