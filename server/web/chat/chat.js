// 챗봇 UI. 익스텐션 Side Panel 의 iframe 으로 로드된다.
// 화면 데이터는 익스텐션이 추출하므로, 부모(side panel)에게 postMessage 로 요청해서 받는다.

const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const history = []; // 멀티턴 대화 이력(텍스트 Q&A)

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + cls;
}

function addMessage(html, who, { markdown = false, extra = "" } = {}) {
  const el = document.createElement("div");
  el.className = `msg ${who} ${extra}`.trim();
  if (markdown) el.innerHTML = marked.parse(html || "");
  else el.textContent = html;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

// 부모(익스텐션 side panel)에게 현재 화면 데이터 요청 → Promise<ScreenContext>
function requestScreen(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const requestId = "r" + Date.now() + Math.random().toString(36).slice(2);
    function onMsg(e) {
      const m = e.data;
      if (!m || m.type !== "UDC_SCREEN" || m.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (m.ok && m.snapshot) resolve(m.snapshot);
      else reject(new Error(m.error || "화면 데이터를 가져오지 못했습니다."));
    }
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error(
        "익스텐션 응답 시간 초과입니다. (1) 익스텐션 Side Panel 에서 열었는지, " +
        "(2) 대상 페이지(/demo) 탭이 활성인지 확인하세요."
      ));
    }, timeout);
    window.addEventListener("message", onMsg);
    // 부모 origin 을 모르므로 '*' 로 보냄(요청은 비밀이 아님). 응답은 requestId 로 검증.
    // 레시피는 도메인에 등록돼 있으면 자동 적용(제네릭과 협업) → 사용자 토글 불필요.
    window.parent.postMessage({ type: "UDC_REQUEST_SCREEN", requestId }, "*");
  });
}

document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";

  addMessage(question, "user");
  const loading = addMessage("화면 데이터 읽는 중…", "bot", { extra: "loading" });

  try {
    setStatus("화면 추출 중…");
    const sc = await requestScreen();
    const t = sc?.tables?.length ?? 0;
    const s = sc?.sections?.length ?? 0;
    const ch = sc?.charts?.length ?? 0;
    setStatus(`추출: ${sc.source || "?"} · 표 ${t} · 카드 ${s} · 차트 ${ch}`, "ok");

    loading.textContent = "답변 생성 중…";
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, screen_context: sc, history: history.slice(-8) }),
    });
    if (!res.ok) throw new Error(`서버 오류 HTTP ${res.status}`);
    const data = await res.json();
    loading.classList.remove("loading");
    loading.innerHTML = marked.parse(data.answer || "");
    renderCharts(loading); // 답변 속 ```chart 블록 → 실제 Chart.js 차트
    loading.appendChild(buildTrace(sc, data.trace));
    // 멀티턴: 이번 Q&A 를 이력에 누적 (텍스트만)
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: data.answer || "" });
  } catch (err) {
    loading.classList.remove("loading");
    loading.classList.add("error");
    loading.textContent = err.message;
    setStatus("오류", "err");
  }
});

// --- 답변 속 ```chart 블록을 실제 차트로 렌더링 ------------------------------
const CHART_PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"];
if (window.Chart) {
  Chart.defaults.color = "#c7cdd6";
  Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
}
function renderCharts(container) {
  if (!window.Chart) return;
  // marked 는 ```chart 를 <code class="language-chart"> 로 만든다
  container.querySelectorAll("code.language-chart").forEach((code) => {
    let spec;
    try {
      spec = JSON.parse(code.textContent);
    } catch (e) {
      return; // JSON 깨지면 코드블록 그대로 둠
    }
    const box = document.createElement("div");
    box.className = "chat-chart";
    const canvas = document.createElement("canvas");
    box.appendChild(canvas);
    (code.closest("pre") || code).replaceWith(box);
    try {
      const series = spec.series || [];
      // 계열별 type 지원(혼합 차트). 하나라도 bar 면 베이스를 bar 로(라인 dataset 이 override).
      const seriesType = (s) => (s.type === "line" || s.type === "bar" ? s.type : spec.type === "line" ? "line" : "bar");
      const baseType = series.some((s) => seriesType(s) === "bar") ? "bar" : "line";
      const useY1 = series.some((s) => s.axis === "y1");
      new Chart(canvas, {
        type: baseType,
        data: {
          labels: spec.labels || [],
          datasets: series.map((s, i) => ({
            type: seriesType(s),
            label: s.name || "",
            data: s.data || [],
            backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
            borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
            fill: false,
            tension: 0.3,
            yAxisID: s.axis === "y1" ? "y1" : "y",
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: !!spec.title, text: spec.title || "" },
            legend: { display: series.length > 1 },
          },
          scales: useY1
            ? { x: { ticks: { maxRotation: 45 } }, y: { position: "left" }, y1: { position: "right", grid: { drawOnChartArea: false } } }
            : { x: { ticks: { maxRotation: 45, minRotation: 0 } } },
        },
      });
    } catch (e) {
      box.textContent = "차트 렌더 실패: " + (e && e.message);
    }
  });
}

// --- 추적 패널: 어떻게 DOM 을 탐색·게더링하고 LLM 에 보냈는지 ----------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
// 직전 추출 지문 — 같으면 ①(화면 추출)을 반복 출력하지 않는다(질문에 무관·화면상태에만 의존).
let lastTraceKey = null;
function buildTrace(sc, llm) {
  const ex = (sc && sc.trace) || {};
  const src = ex.source || (sc && sc.source) || "?";
  const key = src + "|" + (ex.steps || []).join("||") + "|" + (ex.picked || "");
  const changed = key !== lastTraceKey;
  lastTraceKey = key;

  // ① 화면 추출: 바뀐 경우에만 전체 step, 아니면 "변동 없음" 한 줄
  let exHtml;
  if (changed) {
    const steps = (ex.steps || []).map((s) => `<li>${esc(s)}</li>`).join("") || "<li>(없음)</li>";
    exHtml =
      `<div class="trace-h">① 화면 추출 <span class="chg">갱신됨</span> <span>source=${esc(src)} · ${ex.timingMs != null ? ex.timingMs + "ms" : "?"}${ex.picked ? " · 지정영역=" + esc(ex.picked) : ""}</span></div>` +
      `<ol>${steps}</ol>`;
  } else {
    exHtml = `<div class="trace-h">① 화면 추출 <span>변동 없음 · source=${esc(src)}</span></div>`;
  }

  // ② LLM 요청·응답: 매 질문마다 (핵심)
  const u = llm && llm.usage;
  const tok = u ? `${u.prompt_tokens}+${u.completion_tokens}=${u.total_tokens} 토큰` : "토큰 정보 없음";
  const payload = llm ? esc(llm.system + "\n\n" + llm.user) : "(없음)";

  const det = document.createElement("details");
  det.className = "trace";
  det.innerHTML =
    `<summary>🔍 어떻게 답했나</summary>` +
    `<div class="trace-body">` +
      exHtml +
      `<div class="trace-h">② LLM 요청·응답  <span>${esc(llm && llm.model)} · ${llm ? llm.latencyMs + "ms" : "?"} · ${tok}</span></div>` +
      `<details class="trace-payload"><summary>LLM 에 보낸 페이로드 보기 (${llm ? llm.payloadChars : 0}자)</summary><pre>${payload}</pre></details>` +
      `<button class="trace-dl">⬇ trace JSON 내보내기</button>` +
    `</div>`;
  det.querySelector(".trace-dl").addEventListener("click", () => {
    const data = { source: src, extraction: ex, llm };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "udc-trace.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  return det;
}

// --- picker: 답변이 부정확할 때 화면에서 데이터 영역 직접 지정 ---------------
const pickBtn = document.getElementById("pick-btn");
const pickClear = document.getElementById("pick-clear");
pickBtn.addEventListener("click", () => {
  setStatus("페이지에서 데이터 영역을 클릭하세요…");
  window.parent.postMessage({ type: "UDC_PICK" }, "*");
});
pickClear.addEventListener("click", () => {
  window.parent.postMessage({ type: "UDC_PICK_CLEAR" }, "*");
  pickClear.classList.add("hidden");
  setStatus("영역 지정 해제됨");
});
document.getElementById("hl-btn").addEventListener("click", () => {
  setStatus("화면에 추출 영역 표시 중…");
  window.parent.postMessage({ type: "UDC_HIGHLIGHT" }, "*");
});
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m) return;
  if (m.type === "UDC_PICK_DONE") {
    if (m.ok) {
      setStatus("✅ 영역 지정됨", "ok");
      pickClear.classList.remove("hidden");
      addMessage("데이터 영역을 지정했습니다. 이제 그 영역을 우선해서 답합니다. 다시 질문해 보세요.", "bot");
    } else {
      setStatus(m.error === "취소됨" ? "영역 지정 취소" : "영역 지정 실패", "err");
    }
  } else if (m.type === "UDC_HIGHLIGHT_DONE") {
    setStatus(m.ok ? `화면에 추출 영역 ${m.count ?? 0}개 표시(6초)` : "영역 표시 실패", m.ok ? "ok" : "err");
  }
});

// 대화 초기화: 이력 + 메시지 비우기
document.getElementById("reset-btn").addEventListener("click", () => {
  history.length = 0;
  lastTraceKey = null;
  messagesEl.innerHTML = "";
  setStatus("대화 초기화됨");
  addMessage("새 대화를 시작합니다. 무엇이든 물어보세요.", "bot");
});

addMessage(
  "현재 보고 있는 화면의 데이터에 대해 질문해 보세요.",
  "bot"
);
