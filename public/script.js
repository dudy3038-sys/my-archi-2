function fmt(x){ return (Math.round(x * 100) / 100).toLocaleString("ko-KR"); }

function calc(){
  const landArea = parseFloat(document.getElementById("landArea").value);
  const bcr = parseFloat(document.getElementById("bcr").value);
  const far = parseFloat(document.getElementById("far").value);
  const floorHeight = parseFloat(document.getElementById("floorHeight").value || "3.3");

  const resultEl = document.getElementById("result");
  const talkEl = document.getElementById("talkTrack");

  if(!landArea || !bcr || !far){
    resultEl.innerHTML = "대지면적, 건폐율, 용적률을 입력해 주세요.";
    talkEl.value = "검토 결과를 먼저 계산해 주세요.";
    return;
  }

  const maxFootprint = landArea * (bcr/100);   // 최대 건축면적(단순)
  const maxGFA = landArea * (far/100);         // 최대 연면적(단순)
  const floorsGuide = Math.max(1, Math.round(maxGFA / Math.max(1, maxFootprint)));
  const heightGuide = floorsGuide * floorHeight;

  resultEl.innerHTML = `
    <div>✅ <b>기본 산정 결과</b></div>
    <ul>
      <li>대지면적: <b>${fmt(landArea)}㎡</b></li>
      <li>최대 건축면적(건폐율 기준): <b>${fmt(maxFootprint)}㎡</b></li>
      <li>최대 연면적(용적률 기준): <b>${fmt(maxGFA)}㎡</b></li>
      <li>단순 층수 가이드: <b>${floorsGuide}층 내외</b> (가정 층고 ${fmt(floorHeight)}m → 약 ${fmt(heightGuide)}m)</li>
    </ul>
    <div style="opacity:.85; font-size:13px;">
      ※ 실제 가능 층수/형태는 높이제한·사선·주차·도로조건·지구단위 등 추가 규정에 따라 달라집니다.
    </div>
  `;

  talkEl.value =
`[건축 법규 검토(1차 빠른 산정)]
- 대지면적 ${fmt(landArea)}㎡ 기준으로,
- 건폐율 ${fmt(bcr)}% 적용 시 1층 기준 최대 건축면적은 약 ${fmt(maxFootprint)}㎡까지 가능합니다.
- 용적률 ${fmt(far)}% 적용 시 총 연면적은 약 ${fmt(maxGFA)}㎡ 수준까지 산정됩니다.

[설계 방향(가이드)]
- 단순 환산 기준으로는 ${floorsGuide}층 내외 구성이 합리적으로 보입니다.
- 다만 최종 가능 규모는 도로 조건, 주차대수, 높이 제한, 일조/사선, 지구단위계획 등 추가 검토 후 확정됩니다.`;
}

function resetAll(){
  ["landArea","bcr","far","floorHeight"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("result").innerHTML = "대지 정보를 입력하면 결과가 여기 표시됩니다.";
  document.getElementById("talkTrack").value = "검토 결과를 먼저 계산해 주세요.";
}

function copyTalk(){
  const t = document.getElementById("talkTrack").value;
  if(!t) return;
  navigator.clipboard.writeText(t);
}

document.getElementById("calcBtn").addEventListener("click", calc);
document.getElementById("resetBtn").addEventListener("click", resetAll);
document.getElementById("copyBtn").addEventListener("click", copyTalk);

resetAll();
