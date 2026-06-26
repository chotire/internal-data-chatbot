// service worker:
//  (A) 지원 도메인 탭에서만 Side Panel/아이콘을 활성화 (탭별 제어)
//  (B) 요청 시 "사이드패널이 속한 탭"에서 chrome.scripting 으로 데이터 추출
//  (C) 지원 도메인 탭에 "설치 표식" 주입 (페이지의 설치 감지 배너용)
//
// ★ 지원 도메인 목록의 단일 출처(single source)는 manifest.json 의 host_permissions 이다.
//   도메인을 추가/변경하려면 host_permissions 한 곳만 수정하면 된다.

// ── host_permissions → 허용 URL 판별기 ──────────────────────────────────
function patternToRegExp(pattern) {
  // 예: "http://localhost:8000/*", "*://*.example.com/*"
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!m) return null;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let [, scheme, host, path] = m;
  scheme = scheme === "*" ? "https?" : scheme;
  let hostRe;
  if (host === "*") hostRe = "[^/]+";
  else if (host.startsWith("*.")) hostRe = "(?:[^/]+\\.)?" + esc(host.slice(2));
  else hostRe = esc(host);
  const pathRe = esc(path).replace(/\*/g, ".*");
  return new RegExp("^" + scheme + "://" + hostRe + pathRe + "$");
}

const ALLOWED = (chrome.runtime.getManifest().host_permissions || [])
  .map(patternToRegExp)
  .filter(Boolean);

function isAllowed(url) {
  return !!url && ALLOWED.some((re) => re.test(url));
}

const ADAPTER_FILES = [
  "content/base.js",
  "content/adapters/table.js",
  "content/adapters/dom-structure.js",
  "content/adapters/websquare.js",
];

// MAIN world 리더: 페이지의 JS 데이터레이어를 직접 읽는다(전체 데이터 + 컬럼정의 라벨 + 차트 인스턴스).
// 자기완결 함수여야 함(외부 참조 금지) — executeScript({world:"MAIN"}) 로 페이지 세계에서 실행.
function readDataLayer(hint, scope) {
  const out = { tables: [], charts: [], source: "dataLayer" };
  const CT = ["bar", "grouped_bar", "line"];
  scope = scope || {};
  const inc = scope.include || [];
  const exc = scope.exclude || [];
  // 요소가 scope 안인가: exclude 밖 + (include 지정 시) include 안. DOM 없는 데이터는 include 지정 시 제외.
  const inScope = (el) => {
    try {
      if (!el) return inc.length === 0;
      if (exc.some((s) => { try { return el.closest && el.closest(s); } catch (e) { return false; } })) return false;
      if (inc.length) return inc.some((s) => { try { return [...document.querySelectorAll(s)].some((r) => r.contains(el)); } catch (e) { return false; } });
      return true;
    } catch (e) { return true; }
  };
  // 1) 데이터모델(그리드): hint.path 있으면 그 경로(명시 opt-in). 없고 include 지정되면 전역 그리드 제외(영역 밖).
  try {
    let G = null;
    if (hint && hint.path) {
      const p = String(hint.path).replace(/^window\./, "");
      G = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), window);
    } else if (!inc.length) {
      G = window.GRID; // include 미지정 시에만 전역 기본 읽기(회귀 동작)
    }
    if (G && Array.isArray(G.rows) && Array.isArray(G.columns)) {
      const columns = G.columns.map((c, i) => ({
        key: c.field || "c" + i,
        label: c.headerName || c.field || null, // 의미(라벨) = 컬럼정의에서
        type: c.type || "string",
        unit: c.unit || null,
      }));
      const rows = G.rows.map((r) => {
        const o = {};
        G.columns.forEach((c, i) => { o[columns[i].key] = r[c.field]; });
        return o;
      });
      out.tables.push({ title: G.title || null, columns, rows, filters: {} }); // 가상스크롤이어도 전체
    }
  } catch (e) {}
  // 2) 차트: Chart.js 인스턴스. canvas DOM 위치로 scope 필터. 폴백: window.GRID_CHART(DOM 없음→include 시 제외)
  try {
    const seen = [];
    if (window.Chart && window.Chart.instances) {
      Object.values(window.Chart.instances).forEach((ch, i) => {
        const d = (ch.config && ch.config.data) || ch.data;
        if (!d || !Array.isArray(d.labels)) return;
        const canvas = ch.canvas || (ch.ctx && ch.ctx.canvas) || null;
        if (!inScope(canvas)) return; // scope 밖 차트 제외
        const type = (ch.config && ch.config.type) || "line";
        seen.push({
          id: "chart" + i,
          title: (ch.options && ch.options.plugins && ch.options.plugins.title && ch.options.plugins.title.text) || "chart" + i,
          type: CT.indexOf(type) >= 0 ? type : "bar",
          labels: d.labels,
          series: (d.datasets || []).map((ds) => ({ name: ds.label || "", data: ds.data || [] })),
        });
      });
    }
    if (!seen.length && !inc.length) {
      const list = Array.isArray(window.GRID_CHARTS)
        ? window.GRID_CHARTS
        : (window.GRID_CHART ? [window.GRID_CHART] : []);
      list.forEach((g, i) => {
        if (g && Array.isArray(g.labels))
          seen.push({ id: g.id || "chart" + i, title: g.title || "", type: CT.indexOf(g.type) >= 0 ? g.type : "bar",
                      labels: g.labels, series: g.series || [] });
      });
    }
    out.charts = seen;
  } catch (e) {}
  return out;
}

// picker 오버레이: 페이지에 주입되어 마우스로 요소를 하이라이트하고, 클릭한 요소의 CSS 셀렉터를 반환.
// 자기완결 함수(외부 참조 금지). executeScript 가 반환 Promise 를 await → 클릭/ESC 까지 대기.
function PICKER_FUNC() {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;z-index:2147483647;background:rgba(59,130,246,.25);border:2px solid #3b82f6;pointer-events:none;";
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed;z-index:2147483647;background:#111;color:#fff;font:12px sans-serif;padding:2px 6px;border-radius:4px;pointer-events:none;";
    tip.textContent = "데이터 영역을 클릭하세요 (ESC=취소)";
    document.body.appendChild(box);
    document.body.appendChild(tip);
    let cur = null;

    function selectorOf(el) {
      if (el.id) return "#" + (window.CSS ? CSS.escape(el.id) : el.id);
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.body) {
        let s = el.tagName.toLowerCase();
        const cls = [...el.classList].filter((x) => !/[0-9]/.test(x)).slice(0, 2);
        if (cls.length) s += "." + cls.map((c) => (window.CSS ? CSS.escape(c) : c)).join(".");
        const p = el.parentElement;
        if (p) {
          const sib = [...p.children].filter((x) => x.tagName === el.tagName);
          if (sib.length > 1) s += ":nth-child(" + ([...p.children].indexOf(el) + 1) + ")";
        }
        parts.unshift(s);
        el = el.parentElement;
      }
      return parts.join(" > ");
    }
    function move(e) {
      const el = e.target;
      if (!el || el === box || el === tip) return;
      cur = el;
      const r = el.getBoundingClientRect();
      box.style.left = r.left + "px"; box.style.top = r.top + "px";
      box.style.width = r.width + "px"; box.style.height = r.height + "px";
      tip.style.left = r.left + "px"; tip.style.top = Math.max(0, r.top - 22) + "px";
    }
    function cleanup() {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      box.remove(); tip.remove();
    }
    function click(e) {
      e.preventDefault(); e.stopPropagation();
      const sel = cur ? selectorOf(cur) : null;
      cleanup(); resolve(sel);
    }
    function key(e) { if (e.key === "Escape") { cleanup(); resolve(null); } }
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
  });
}

// 추출 영역 오버레이: UDC.run 이 기록한 __UDC_REGIONS(요소+라벨)에 박스를 그린다.
// 자기완결 함수(외부 참조 금지). ADAPTER_FILES 주입 후 실행.
function HIGHLIGHT_FUNC() {
  try { if (globalThis.UDC) globalThis.UDC.run(document); } catch (e) {} // 최신 영역 기록
  const regions = globalThis.__UDC_REGIONS || [];
  document.querySelectorAll(".__udc_hl").forEach((n) => n.remove());
  let n = 0;
  regions.forEach((r, i) => {
    const el = r && r.el;
    if (!el || !el.getBoundingClientRect) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const box = document.createElement("div");
    box.className = "__udc_hl";
    box.style.cssText =
      "position:fixed;z-index:2147483646;border:2px solid #10b981;background:rgba(16,185,129,.12);pointer-events:none;border-radius:4px;";
    box.style.left = rect.left + "px"; box.style.top = rect.top + "px";
    box.style.width = rect.width + "px"; box.style.height = rect.height + "px";
    const tag = document.createElement("div");
    tag.className = "__udc_hl";
    tag.style.cssText =
      "position:fixed;z-index:2147483646;background:#10b981;color:#06281e;font:11px sans-serif;padding:1px 5px;border-radius:3px;pointer-events:none;";
    tag.textContent = r.label || ("영역" + i);
    tag.style.left = rect.left + "px"; tag.style.top = Math.max(0, rect.top - 16) + "px";
    document.body.appendChild(box);
    document.body.appendChild(tag);
    n++;
  });
  function cleanup() {
    document.querySelectorAll(".__udc_hl").forEach((x) => x.remove());
    document.removeEventListener("click", cleanup, true);
    document.removeEventListener("keydown", key, true);
  }
  function key(e) { if (e.key === "Escape") cleanup(); }
  setTimeout(cleanup, 6000);
  document.addEventListener("click", cleanup, true);
  document.addEventListener("keydown", key, true);
  return n;
}

// 탭별 사용자 지정 영역(picker 결과 셀렉터)
const pickedRegions = new Map();

// 현재 URL 에 맞는 추출 레시피를 서버에서 가져온다 (없으면 null → 제네릭/어댑터 폴백)
async function fetchRecipe(url) {
  try {
    const origin = new URL(url).origin;
    const r = await fetch(origin + "/api/recipe?url=" + encodeURIComponent(url));
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.recipe ? j.recipe : null;
  } catch (e) {
    return null;
  }
}

// ── (A)+(C) 탭별 활성/비활성 + 설치 표식 주입 ───────────────────────────
async function updateForTab(tabId, url) {
  const enabled = isAllowed(url);
  try {
    if (enabled) {
      await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
    } else {
      // 비지원 탭: 패널 비활성 → 열려 있던 패널도 이 탭에선 닫힘 (전역 default_path 없음)
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch (e) {
    /* 탭이 닫혔을 수 있음 */
  }
  try {
    if (enabled) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId); // 비지원 탭은 아이콘 비활성
  } catch (e) {
    /* noop */
  }
  if (enabled) {
    // 설치 표식 주입 → 페이지의 설치 감지 배너가 "설치됨"으로 전환
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (ver) => {
          try {
            document.documentElement.setAttribute("data-udc-extension", ver);
            window.postMessage({ type: "UDC_PRESENT", version: ver }, "*");
          } catch (e) {}
        },
        args: [chrome.runtime.getManifest().version],
      });
    } catch (e) {
      /* 페이지가 아직 준비 안 됐을 수 있음(다음 이벤트에서 재시도) */
    }
  }
}

async function refreshAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (t.id != null) await updateForTab(t.id, t.url);
  } catch (e) {
    /* noop */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  refreshAllTabs();
});
chrome.runtime.onStartup.addListener(refreshAllTabs);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "complete") updateForTab(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateForTab(tabId, tab.url);
  } catch (e) {
    /* noop */
  }
});

// ── (B) 데이터 추출 ─────────────────────────────────────────────────────
// 두 표가 '같은 데이터'인가(키 이름 무관, 행의 값 집합으로 비교).
// MAIN(전체 50행)과 generic(가상스크롤 보이는 8행)은 같은 그리드 → 중복 제거용.
function sameData(a, b) {
  if (!a.rows || !a.rows.length || !b.rows || !b.rows.length) return false;
  const key = (r) => Object.values(r).map((v) => String(v)).sort().join("|");
  const bset = new Set(b.rows.map(key));
  const hit = a.rows.filter((r) => bset.has(key(r))).length;
  return hit >= a.rows.length * 0.6;
}

async function extractFromTab(tabId, useRecipe) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return { ok: false, error: "대상 탭을 찾을 수 없습니다." };
  }
  if (!isAllowed(tab.url || "")) {
    return {
      ok: false,
      error: "이 익스텐션이 지원하지 않는 페이지입니다. 현재 탭: " + (tab.url || "알 수 없음"),
    };
  }
  try {
    const t0 = Date.now();
    const recipe = useRecipe ? await fetchRecipe(tab.url) : null;
    const picked = pickedRegions.get(tabId) || null; // 사용자가 지정한 영역(있으면)
    // 1) ISOLATED 추출 (DOM 기반: picked/html/generic/recipe) — 가상스크롤이면 보이는 행만
    await chrome.scripting.executeScript({ target: { tabId }, files: ADAPTER_FILES });
    const isoRes = await chrome.scripting.executeScript({
      target: { tabId },
      func: (r, p) => (globalThis.UDC ? globalThis.UDC.run(document, r, p) : null),
      args: [recipe, picked],
    });
    const iso = (isoRes && isoRes[0] && isoRes[0].result) || { tables: [], sections: [], charts: [], source: "none" };

    // 2) MAIN world 리더 (페이지 JS 데이터레이어: 전체 데이터 + 컬럼정의 라벨 + 차트 인스턴스)
    //    domWhen 게이트 통과 후의 실효 레시피(scope/dataLayer)를 MAIN 리더에도 적용 → include/exclude 가 그리드·차트에도 반영
    const eff = (iso && iso.appliedRecipe) || null;
    let main = { tables: [], charts: [] };
    try {
      const mainRes = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN", func: readDataLayer,
        args: [eff && eff.dataLayer ? eff.dataLayer : null, eff && eff.scope ? eff.scope : null],
      });
      main = (mainRes && mainRes[0] && mainRes[0].result) || main;
    } catch (e) { /* MAIN 접근 불가 시 ISOLATED 만 사용 */ }

    // 3) 병합: MAIN 표/차트 우선 + ISOLATED 의 '다른' 표(요약표 등)만 추가(같은 그리드면 MAIN 우선),
    //    카드(sections)는 ISOLATED. source 합산.
    const hasMain = (main.tables && main.tables.length) || (main.charts && main.charts.length);
    const tables = [...(main.tables || [])];
    let dropped = 0;
    for (const t of iso.tables || []) {
      if (!tables.some((m) => sameData(t, m))) tables.push(t);
      else dropped++;
    }
    const snapshot = {
      source: [hasMain ? "dataLayer" : null, iso.source !== "none" ? iso.source : null].filter(Boolean).join("+") || "none",
      tables,
      sections: iso.sections,
      charts: main.charts && main.charts.length ? main.charts : iso.charts,
    };
    if (!snapshot.tables.length && !snapshot.sections.length && !snapshot.charts.length) {
      return { ok: false, error: "이 화면에서 데이터를 추출하지 못했습니다." };
    }
    // 추적: ISOLATED steps + MAIN/병합 step + 타이밍
    const steps = (iso.trace && iso.trace.steps) || [];
    if (hasMain) steps.push(`MAIN world(데이터레이어): 표 ${main.tables.length}개(전체 ${main.tables[0] ? main.tables[0].rows.length : 0}행)·차트 ${main.charts.length}개`);
    if (dropped) steps.push(`병합 dedup: ISOLATED 표 ${dropped}개를 MAIN과 같은 그리드로 보고 제거`);
    steps.push(`최종: source=${snapshot.source} · 표 ${snapshot.tables.length}·카드 ${snapshot.sections.length}·차트 ${snapshot.charts.length}`);
    snapshot.trace = { steps, source: snapshot.source, timingMs: Date.now() - t0, picked };
    return { ok: true, snapshot };
  } catch (e) {
    return { ok: false, error: "추출 실패: " + (e && e.message ? e.message : String(e)) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // picker: 활성 탭에 오버레이 주입 → 사용자가 클릭한 영역 셀렉터 저장
  if (msg && msg.type === "UDC_PICK") {
    (async () => {
      const tabId = msg.tabId;
      if (tabId == null) return sendResponse({ ok: false, error: "대상 탭 없음" });
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId }, func: PICKER_FUNC });
        const sel = res && res[0] && res[0].result;
        if (sel) { pickedRegions.set(tabId, sel); sendResponse({ ok: true, selector: sel }); }
        else sendResponse({ ok: false, error: "취소됨" });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }
  if (msg && msg.type === "UDC_PICK_CLEAR") {
    if (msg.tabId != null) pickedRegions.delete(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }
  // 추출 영역 오버레이: 화면에 "우리가 읽은 영역" 박스 표시
  if (msg && msg.type === "UDC_HIGHLIGHT") {
    (async () => {
      const tabId = msg.tabId;
      if (tabId == null) return sendResponse({ ok: false, error: "대상 탭 없음" });
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ADAPTER_FILES });
        const res = await chrome.scripting.executeScript({ target: { tabId }, func: HIGHLIGHT_FUNC });
        sendResponse({ ok: true, count: res && res[0] && res[0].result });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "UDC_GET_SNAPSHOT") {
    const run = async () => {
      let tabId = msg.tabId;
      if (tabId == null) {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tabs && tabs[0] && tabs[0].id;
      }
      if (tabId == null) return { ok: false, error: "대상 탭을 찾을 수 없습니다." };
      return extractFromTab(tabId, msg.useRecipe !== false); // 기본 true

    };
    run().then(sendResponse);
    return true; // 비동기 응답
  }
});
