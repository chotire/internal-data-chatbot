// 챗봇 UI. 익스텐션 Side Panel 의 iframe 으로 로드된다.
// 화면 데이터는 익스텐션이 추출하므로, 부모(side panel)에게 postMessage 로 요청해서 받는다.

const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const history = []; // 멀티턴 대화 이력(텍스트 Q&A)
// 데모: 질문 간 독립(history off). 멀티턴 history를 평문으로 재구성하면 툴 활성 시 모델이
// 직전 과제에 anchor돼 새 질문을 무시·재실행하는 오염이 있어 데모에선 끈다(필요 시 true).
const SEND_HISTORY = false;

// v0.4 행동 모드: 켜지면 입력을 "질문"이 아니라 "작업 지시"로 다뤄 폼을 대신 채운다.
let actionMode = false;

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

  // 행동 모드면 질문 흐름 대신 "작업 지시" 흐름(폼 인식 → 계획 → 미리보기 → 실행)으로 분기.
  // 모드는 유지된다(토글로 끌 때까지) — 연속 지시 가능. 질문으로 돌아가려면 🤖 작업 을 다시 누른다.
  if (actionMode) return runActionFlow(question);

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

// === v0.4 행동(에이전트): 폼 인식 → 계획 → 미리보기 → 실행 ====================

// 부모(익스텐션)에게 현재 화면의 폼(FormContext) 요청.
function requestForm(timeout = 6000) {
  return new Promise((resolve, reject) => {
    const requestId = "f" + Date.now() + Math.random().toString(36).slice(2);
    function onMsg(e) {
      const m = e.data;
      if (!m || m.type !== "UDC_FORM" || m.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (m.ok && m.formContext) resolve(m.formContext);
      else reject(new Error(m.error || "폼을 인식하지 못했습니다."));
    }
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("익스텐션 응답 시간 초과 — Side Panel 에서 열었는지, 대상 폼 화면이 활성인지 확인하세요."));
    }, timeout);
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "UDC_REQUEST_FORM", requestId }, "*");
  });
}

// 부모(익스텐션)에게 fill-plan 실행 요청. commitSave=true 면 저장 확인까지 자동.
function runPlanRequest(plan, { commitSave = false, resolutions = {} } = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = "x" + Date.now() + Math.random().toString(36).slice(2);
    function onMsg(e) {
      const m = e.data;
      if (!m || m.type !== "UDC_RUN_RESULT" || m.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      // 실패해도 result 가 있으면 그대로 전달(어느 단계에서 왜 실패했는지 execPlan 이 보여준다).
      if (m.result) resolve(m.result);
      else reject(new Error(m.error || "계획 실행에 실패했습니다."));
    }
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("실행 응답 시간 초과"));
    }, timeout);
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "UDC_RUN_PLAN", requestId, plan, commitSave, resolutions }, "*");
  });
}

async function runActionFlow(intent) {
  addMessage(intent, "user");
  const loading = addMessage("폼 인식 중…", "bot", { extra: "loading" });
  try {
    setStatus("폼 인식 중…");
    // 현재 화면(FormContext)을 인식한다. 폼이 없어도(홈·목록 등) 에이전트가 그래프로 이동하므로 막지 않는다.
    const form = await requestForm();
    setStatus(`현재 화면=${form.screen_id || "?"} · ${(form.fields || []).length}필드`, "ok");

    loading.textContent = "계획 생성 중…";
    const resp = await fetch("/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent_text: intent, form_context: form }),
    });
    if (!resp.ok) throw new Error(`계획 생성 오류 HTTP ${resp.status}`);
    const plan = await resp.json();

    // 수행할 동작이 전혀 없으면 안내(지시가 모호하거나 대상 미지정).
    const empty = !(plan.nav || []).length && !(plan.items || []).length && !plan.read && !plan.save;
    if (empty) {
      loading.classList.remove("loading");
      loading.classList.add("error");
      loading.textContent = "수행할 동작을 찾지 못했습니다. 더 구체적으로 지시해 주세요(예: 'PR-2026-0041 삭제', '구매요청 목록 보여줘').";
      setStatus("동작 없음", "err");
      return;
    }

    loading.classList.remove("loading");
    // 게이트가 auto(되돌릴 수 있는 행동 — 조회·이동)면 확인 없이 바로 실행한다("잦은 확인" 마찰 제거, §2).
    // confirm(되돌릴 수 없는 등록·수정·삭제)일 때만 미리보기+승인을 받는다.
    if (plan.gate && plan.gate.mode === "auto") {
      loading.textContent = "실행 중…";
      const finish = (html, cls) => { loading.innerHTML = html; if (cls === "err") loading.classList.add("error"); };
      await execPlan(plan, true, finish, null);
      return;
    }
    loading.textContent = "";
    loading.appendChild(buildPlanPreview(plan));
    setStatus("계획 준비됨 — 승인 대기", "ok");
  } catch (err) {
    loading.classList.remove("loading");
    loading.classList.add("error");
    loading.textContent = err.message;
    setStatus("오류", "err");
  }
}

// 작업 계획 미리보기 카드 — 조회·등록·수정·삭제를 같은 틀로 보여주고, 행동 유형별 버튼을 단다.
const ACTION_NOUN = { create: "등록", update: "저장", delete: "삭제", query: "조회" };

function buildPlanPreview(plan) {
  const wrap = document.createElement("div");
  wrap.className = "plan-card";
  const action = (plan.intent && plan.intent.action) || "create";

  const navHtml = (plan.nav || []).length
    ? `<div class="plan-nav">📍 이동: ${plan.nav.map((s) => esc(s.label || s.target)).join(" → ")}</div>` : "";
  const itemsHtml = (plan.items || [])
    .map((it) => {
      if (it.op === "searchSelect")
        return `<li>🔎 <b>${esc(it.label || "품목")}</b>: "${esc(it.query || "")}" 검색 후 선택${it.needs_resolution ? ' <span class="flag">후보 고르기</span>' : ""}</li>`;
      if (it.op === "addRow") return `<li>➕ 라인 행 추가</li>`;
      if (it.op === "select") return `<li>▾ <b>${esc(it.label || it.field_key)}</b> = ${esc(it.value)}</li>`;
      return `<li>✏️ <b>${esc(it.label || it.field_key)}</b> = ${esc(it.value)}</li>`;
    })
    .join("");
  const itemsBlock = itemsHtml ? `<ul class="plan-items">${itemsHtml}</ul>` : "";
  const readHtml = plan.read ? `<div class="plan-read">🔎 도착한 화면을 읽어 보고합니다.</div>` : "";
  const missing = (plan.missing_required || []).length
    ? `<div class="plan-warn">⚠️ 필수 누락: ${plan.missing_required.map(esc).join(", ")}</div>` : "";
  const gate = plan.gate && plan.gate.mode === "confirm"
    ? `<div class="plan-gate">🔒 되돌릴 수 없는 행동이라 확인이 필요합니다(${esc(plan.gate.reason || "")}).</div>` : "";

  // 행동 유형별 버튼: 조회=조회 실행 / 삭제=삭제 실행 / 등록·수정=채우기만·채우고(등록/저장)
  let btns;
  if (plan.read) btns = `<button class="plan-btn commit">조회 실행</button><button class="plan-btn cancel">취소</button>`;
  else if (action === "delete") btns = `<button class="plan-btn commit danger">삭제 실행</button><button class="plan-btn cancel">취소</button>`;
  else btns = `<button class="plan-btn fill">채우기만</button><button class="plan-btn commit">채우고 ${ACTION_NOUN[action] || "등록"}</button><button class="plan-btn cancel">취소</button>`;

  wrap.innerHTML =
    `<div class="plan-title">🤖 작업 계획 미리보기 <span class="plan-kind">${ACTION_NOUN[action] || action}</span></div>` +
    navHtml + itemsBlock + readHtml + missing + gate +
    `<div class="plan-actions">${btns}</div>`;

  const finish = (html, cls) => {
    const acts = wrap.querySelector(".plan-actions");
    if (acts) acts.remove();
    const d = document.createElement("div");
    d.className = "plan-result " + (cls || "");
    d.innerHTML = html;
    wrap.appendChild(d);
  };
  wrap.querySelector(".cancel").addEventListener("click", () => finish("취소되었습니다.", ""));
  const fill = wrap.querySelector(".fill");
  if (fill) fill.addEventListener("click", () => execPlan(plan, false, finish, wrap));
  wrap.querySelector(".commit").addEventListener("click", () => execPlan(plan, true, finish, wrap));
  return wrap;
}

// 고른 품목(자연어→정식코드)을 메모리에 적재 → 다음 계획에서 자동 해소(HITL 감소).
function rememberPicks(plan, result) {
  const planSS = (plan.items || []).filter((i) => i.op === "searchSelect");
  const resSS = (result.results || []).filter((r) => r.op === "searchSelect");
  planSS.forEach((pi, idx) => {
    const code = resSS[idx] && (resSS[idx].picked || resSS[idx].autoPicked);
    if (pi.query && code) {
      fetch("/api/agent/memory", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: pi.query, code }),
      }).catch(() => {});
    }
  });
}

// 실행 단계 트레이스 — runPlan 이 돌려준 단계별 결과를 체크리스트로(클로드 인 크롬의 "단계"처럼).
function renderSteps(result) {
  const ICON = { nav: "📍", fill: "✏️", select: "▾", searchSelect: "🔎", addRow: "➕" };
  const items = (result.results || []).map((r) => {
    const mark = r.ok ? "✓" : "✗";
    let label;
    if (r.op === "nav") label = `이동 — ${esc(r.label || r.target)}`;
    else if (r.op === "searchSelect") label = `${esc(r.label || "품목")} → ${esc(r.picked || r.autoPicked || "?")}${r.autoPicked ? " (자동)" : ""}`;
    else label = `${esc(r.label || r.op)}${r.value != null ? " = " + esc(r.value) : ""}`;
    const err = r.ok ? "" : ` <span class="step-err">${esc(r.error || "")}</span>`;
    return `<li>${mark} ${ICON[r.op] || "•"} ${label}${err}</li>`;
  });
  if (result.saveClicked) items.push(`<li>✓ 💾 저장 클릭${result.committed ? " → 확인까지" : " (확인 대기)"}</li>`);
  if (!items.length) return "";
  return `<details class="plan-steps"><summary>실행 단계 ${items.length}</summary><ul>${items.join("")}</ul></details>`;
}

// 조회 결과 렌더(목록=표, 상세=라벨/값).
function renderRead(read) {
  if (!read) return "읽을 내용을 찾지 못했습니다.";
  if (read.kind === "list") {
    const head = `<tr>${(read.columns || []).map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
    const rows = (read.rows || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
    return `조회 결과 <b>${(read.rows || []).length}건</b><table class="read-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }
  if (read.kind === "detail")
    return "상세:<br/>" + (read.fields || []).map((f) => `${esc(f.key)}: <b>${esc(f.value)}</b>`).join("<br/>");
  return "읽을 내용을 찾지 못했습니다.";
}

// 계획 실행 + 결과 렌더. finish(html, cls) 로 결과를 그린다(미리보기 카드 또는 바로 메시지).
// wrap 은 미리보기 카드가 있을 때만(버튼 비활성화용). auto 실행 시엔 없다.
async function execPlan(plan, commitSave, finish, wrap) {
  if (wrap) wrap.querySelectorAll(".plan-btn").forEach((b) => (b.disabled = true));
  const action = (plan.intent && plan.intent.action) || "create";
  setStatus("실행 중…");
  try {
    const result = await runPlanRequest(plan, { commitSave });
    if (result.ok === false) {
      const at = result.failedAt ? ` (단계: ${esc(result.failedAt.label || result.failedAt.field_key || result.failedAt.op)})` : "";
      finish("실행 실패: " + esc(result.error || "알 수 없는 오류") + at, "err");
      setStatus("실행 실패", "err");
      return;
    }
    const steps = renderSteps(result);
    // 조회: 읽은 내용을 보고 + 단계.
    if (result.read) { finish(renderRead(result.read) + steps, "ok"); setStatus("조회 완료", "ok"); return; }
    // 삭제: 확인까지 했으면 완료, 아니면 페이지 확인 대기.
    if (action === "delete") {
      if (result.committed) { finish("✅ 삭제 완료 — 목록에서 제거되었습니다." + steps, "ok"); setStatus("삭제 완료", "ok"); }
      else { finish("삭제 확인창이 떴습니다. 페이지에서 <b>[확인]</b>을 누르면 삭제됩니다." + steps, "ok"); setStatus("삭제 확인 대기", "ok"); }
      return;
    }
    // 등록·수정: 고른 품목 + 결과. 고른 정식코드는 메모리에 적재해 다음엔 자동 해소되게 한다.
    rememberPicks(plan, result);
    const picks = (result.results || [])
      .filter((r) => r.op === "searchSelect")
      .map((r) => `${esc(r.label || "품목")} → ${esc(r.picked || r.autoPicked || "?")}${r.autoPicked ? " (자동선택)" : ""}`)
      .join("<br/>");
    let msg = picks ? `<div class="plan-picks">${picks}</div>` : "";
    if (result.committed && result.prNo) {
      msg += action === "update" ? `✅ 수정 완료 — <b>${esc(result.prNo)}</b>` : `✅ 등록 완료 — 요청번호 <b>${esc(result.prNo)}</b>`;
      setStatus(action === "update" ? "수정 완료" : "등록 완료", "ok");
    } else if (result.awaitingConfirm) {
      msg += `입력을 마쳤습니다. 페이지의 확인창에서 <b>[확인]</b>을 누르면 ${ACTION_NOUN[action] || "저장"}됩니다.`;
      setStatus("확인 대기", "ok");
    } else {
      msg += "실행을 마쳤습니다.";
      setStatus("완료", "ok");
    }
    finish(msg + steps, "ok");
  } catch (err) {
    finish("실행 실패: " + esc(err.message), "err");
    setStatus("오류", "err");
  }
}

// 🤖 작업 버튼: 행동 모드 토글.
const actBtn = document.getElementById("act-btn");
function setActionMode(on) {
  actionMode = on;
  if (actBtn) actBtn.classList.toggle("active", on);
  const input = document.getElementById("chat-input");
  if (on) {
    input.placeholder = "예: 제목: 사무용품 보충, 총무팀, 2026-07-15, 볼펜10·스테이플러2 구매신청";
    setStatus("작업 모드 — 지시를 입력하세요");
    input.focus();
  } else {
    input.placeholder = "예) 공정이 지연된 현장은? / 공공 발주 계약 합계는?";
  }
}
actBtn?.addEventListener("click", () => setActionMode(!actionMode));

// 🗺️ 매핑(관리자): 메뉴를 읽기전용으로 순회 → 그래프에 적재.
function requestMap(timeout = 12000) {
  return new Promise((resolve, reject) => {
    const requestId = "m" + Date.now() + Math.random().toString(36).slice(2);
    function onMsg(e) {
      const m = e.data;
      if (!m || m.type !== "UDC_MAP" || m.requestId !== requestId) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      if (m.ok && m.observations) resolve(m.observations);
      else reject(new Error(m.error || "매핑 순회 실패"));
    }
    const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("매핑 응답 시간 초과")); }, timeout);
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "UDC_REQUEST_MAP", requestId }, "*");
  });
}

document.getElementById("map-btn")?.addEventListener("click", async () => {
  const loading = addMessage("메뉴를 읽기전용으로 순회하는 중…(변이 버튼은 누르지 않습니다)", "bot", { extra: "loading" });
  try {
    setStatus("매핑 순회 중…");
    const observations = await requestMap();
    const resp = await fetch("/api/agent/map", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ observations }),
    });
    if (!resp.ok) throw new Error(`그래프 적재 오류 HTTP ${resp.status}`);
    const r = await resp.json();
    const screens = observations.map((o) => o.id).filter(Boolean).join(", ");
    loading.classList.remove("loading");
    loading.innerHTML =
      `🗺️ 매핑 완료 — 화면 ${r.nodes}개·이동 ${r.edges}개 적재(전체 노드 ${r.totalNodes}).` +
      (r.skippedMutateEdges ? ` 변이 버튼 ${r.skippedMutateEdges}건은 기록하지 않음.` : "") +
      `<div class="plan-picks">관찰: ${esc(screens)}</div>`;
    setStatus("매핑 완료", "ok");
  } catch (err) {
    loading.classList.remove("loading");
    loading.classList.add("error");
    loading.textContent = "매핑 실패: " + err.message;
    setStatus("매핑 실패", "err");
  }
});

addMessage(
  "현재 보고 있는 화면의 데이터에 대해 질문해 보세요. 폼을 대신 채우려면 🤖 작업 을 누르세요.",
  "bot"
);
