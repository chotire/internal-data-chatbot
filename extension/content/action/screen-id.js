// 화면 식별(도착 감지) — 딥링크가 없으니 URL 이 아니라 "DOM 시그니처"로 지금 어느 화면인지 판정한다.
// v0.2 읽기(recipe)와 섞지 않는 별도 모듈(UDCA = UDC-Action 네임스페이스). 저수준은 base.js(UDC) 공유.

globalThis.UDCA = globalThis.UDCA || {};

// 현재 화면의 거친 지문. data-screen(목업이 화면마다 세팅) + 제목 + 폼 구조 단서.
UDCA.signature = function (doc) {
  doc = doc || document;
  const main = doc.querySelector("[data-screen]") || doc.querySelector("#content, main") || doc.body;
  const screen = main && main.getAttribute ? main.getAttribute("data-screen") : null;
  const h = doc.querySelector("h1[data-title], h1");
  const title = h ? (h.getAttribute("data-title") || h.textContent || "").trim() : null;
  const scope = doc.querySelector("#content") || doc.body;
  return {
    screen: screen || null,
    title: title || null,
    hasSave: !!doc.querySelector("#save-btn, button[type=submit]"),
    hasGrid: !!doc.querySelector("#line-grid, table.lines"),
    fields: scope ? scope.querySelectorAll("input, select, textarea").length : 0,
  };
};

// 기대 시그니처(부분집합)와 "도착"이 맞는지. 명시한 키만 비교한다.
UDCA.matches = function (sig, expected) {
  if (!sig || !expected) return false;
  return Object.keys(expected).every((k) => sig[k] === expected[k]);
};

// 도착 대기 — 액션(이동/클릭) 후 화면이 바뀔 때까지 폴링. cond(sig)->bool.
UDCA.waitForScreen = function (cond, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 4000;
  const interval = opts.interval || 80;
  const doc = opts.doc;
  return new Promise((resolve) => {
    const t0 = (globalThis.performance && performance.now) ? performance.now() : 0;
    const elapsed = () => ((globalThis.performance && performance.now) ? performance.now() : 0) - t0;
    const tick = () => {
      let sig = null;
      try { sig = UDCA.signature(doc); } catch (e) {}
      if (sig && cond(sig)) return resolve({ ok: true, signature: sig });
      if (elapsed() >= timeout) return resolve({ ok: false, signature: sig });
      setTimeout(tick, interval);
    };
    tick();
  });
};
