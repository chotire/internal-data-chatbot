// 챗봇 UI. 익스텐션 Side Panel 의 iframe 으로 로드된다.
// 화면 데이터는 익스텐션이 추출하므로, 부모(side panel)에게 postMessage 로 요청해서 받는다.

const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const history = []; // 멀티턴 대화 이력(텍스트 Q&A)
// 데모: 질문 간 독립(history off). 멀티턴 history를 평문으로 재구성하면 툴 활성 시 모델이
// 직전 과제에 anchor돼 새 질문을 무시·재실행하는 오염이 있어 데모에선 끈다(필요 시 true).
const SEND_HISTORY = false;

// 개발 전용 기능("어떻게 답했나" trace · "추출 영역" 버튼)은 서버 설정(UDC_DEV_MODE)으로 on/off.
// 기본 false(프로덕션 안전). 서버에서 받아 갱신.
let DEV_MODE = false;
fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    DEV_MODE = !!c.devMode;
    if (!DEV_MODE) document.getElementById("hl-btn")?.classList.add("hidden");
  })
  .catch(() => {});

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
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, screen_context: sc, history: SEND_HISTORY ? history.slice(-8) : [] }),
    });
    if (!res.ok || !res.body) throw new Error(`서버 오류 HTTP ${res.status}`);

    // 스트리밍 답변 컨테이너: 툴 진행 칩(라우팅 가시화) + 답변 본문
    loading.classList.remove("loading");
    loading.textContent = "";
    const stepsEl = document.createElement("div");
    stepsEl.className = "tool-steps";
    const ansEl = document.createElement("div");
    ansEl.className = "answer";
    loading.append(stepsEl, ansEl);

    let answerText = "";
    let final = null;
    await readSSE(res, (ev) => {
      if (ev.type === "tool_start") {
        addToolChip(stepsEl, ev.tool);
      } else if (ev.type === "token") {
        answerText += ev.text || "";
        ansEl.innerHTML = marked.parse(answerText);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (ev.type === "final") {
        final = ev;
      } else if (ev.type === "error") {
        throw new Error(ev.message || "스트리밍 오류");
      }
    });

    ansEl.innerHTML = marked.parse(answerText || "(빈 응답)");
    renderCharts(ansEl); // 답변 속 ```chart 블록 → 실제 Chart.js 차트
    stepsEl.querySelectorAll(".tool-chip.running").forEach((c) => {
      c.classList.remove("running");
      c.textContent = TOOL_LABEL[c.dataset.tool] || c.dataset.tool;
    });
    if (final) {
      loading.appendChild(buildBadges(final.tools_used, final.citations)); // 출처(기계적 추적)
      if (DEV_MODE && final.trace) loading.appendChild(buildTrace(sc, final.trace)); // "어떻게 답했나"는 개발 전용
    }
    setStatus("완료", "ok");
    // 멀티턴: 이번 Q&A 를 이력에 누적 (텍스트만)
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: answerText });
  } catch (err) {
    loading.classList.remove("loading");
    loading.classList.add("error");
    loading.textContent = err.message;
    setStatus("오류", "err");
  }
});

// --- 툴-콜링 스트리밍(SSE) -------------------------------------------------
// 출처/툴 라벨. screen_data 는 호출형 툴이 아니라 '화면만으로 답함'을 뜻함.
const TOOL_LABEL = {
  screen_data: "📊 화면 데이터",
  code_interpreter: "🧮 데이터 분석",
  web_search: "🌐 웹 검색",
};

// SSE(text/event-stream) 본문을 읽어 "data: {json}" 블록마다 onEvent 호출.
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      onEvent(ev); // throw 하면 호출부 catch 로 전파(error 이벤트 처리)
    }
  }
}

// 진행 중 툴 칩(라우팅을 눈에 보이게). 같은 툴은 한 번만.
function addToolChip(stepsEl, tool) {
  if (stepsEl.querySelector(`.tool-chip[data-tool="${tool}"]`)) return;
  const chip = document.createElement("span");
  chip.className = "tool-chip running";
  chip.dataset.tool = tool;
  chip.textContent = (TOOL_LABEL[tool] || tool) + " …";
  stepsEl.appendChild(chip);
}

// 한 배지 요소.
function badgeEl(t) {
  const b = document.createElement("span");
  b.className = "badge badge-" + t;
  b.textContent = TOOL_LABEL[t] || t;
  return b;
}

// 라벨 + 배지들을 한 줄 그룹으로.
function badgeGroup(label, items) {
  const row = document.createElement("div");
  row.className = "badge-row";
  const lbl = document.createElement("span");
  lbl.className = "src-label";
  lbl.textContent = label;
  row.appendChild(lbl);
  items.forEach((it) => row.appendChild(it));
  return row;
}

// 출처 vs 도구를 구분해 표기.
//  - 도구 : 호출한 것(🧮 데이터 분석 · 🌐 웹 검색)
//  - 출처 : 답의 근거 데이터(📊 화면 데이터 + 🌐 웹 결과의 인용 URL)
function buildBadges(tools, citations) {
  const wrap = document.createElement("div");
  wrap.className = "source-badges";
  const used = tools || [];
  const toolsUsed = used.filter((t) => t !== "screen_data"); // 호출 툴
  const hasScreen = used.includes("screen_data");
  const hasCites = !!(citations && citations.length);

  // 도구 그룹
  if (toolsUsed.length) {
    wrap.appendChild(badgeGroup("도구", toolsUsed.map(badgeEl)));
  }
  // 출처 그룹 (화면 데이터 배지 + 웹 인용 URL)
  if (hasScreen || hasCites) {
    const srcItems = hasScreen ? [badgeEl("screen_data")] : [];
    const group = badgeGroup("출처", srcItems);
    if (hasCites) {
      const cites = document.createElement("span");
      cites.className = "citations";
      cites.innerHTML = citations
        .map((c, i) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">[${i + 1}] ${esc(c.title || c.url)}</a>`)
        .join(" ");
      group.appendChild(cites);
    }
    wrap.appendChild(group);
  }
  return wrap;
}

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
