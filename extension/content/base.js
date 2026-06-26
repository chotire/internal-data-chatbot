// 어댑터 레지스트리 + 협업(merge) 오케스트레이션 + 공용 유틸.
// content_scripts 의 여러 js 는 같은 isolated world 전역을 공유하므로 globalThis 에 붙인다.

globalThis.UDC = globalThis.UDC || { adapters: [] };

// 어댑터 인터페이스: { name, priority, detect(doc)->bool, extract(doc, claimed)->{tables,sections,claimed} }
UDC.register = function (adapter) {
  if (UDC.adapters.some((a) => a.name === adapter.name)) return; // 재주입 중복 방지
  UDC.adapters.push(adapter);
};

// el 이 claimed(이미 다른 추출기가 점유한 DOM 영역들) 와 겹치는가
UDC.overlaps = function (el, claimed) {
  return claimed.some((c) => c === el || c.contains(el) || el.contains(c));
};

// el 이 사용자에게 실제로 보이는가 (제품 전제: "화면에 떠 있는 데이터"만 추출).
// display:none / visibility:hidden / opacity:0 (조상 포함) / 크기 0 영역은 숨김으로 본다.
// getComputedStyle 이 없는 환경(linkedom 등 테스트)에서는 판단을 보류하고 true(추출 허용).
UDC.isVisible = function (el) {
  const gcs = typeof getComputedStyle === "function" ? getComputedStyle : null;
  if (!gcs || !el || el.nodeType !== 1) return true;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    let s;
    try { s = gcs(node); } catch (e) { return true; }
    if (!s) return true;
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    if (parseFloat(s.opacity) === 0) return false;
  }
  if (el.getBoundingClientRect) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
  }
  return true;
};

// 구조화로 점유되지 않은 '보이는 텍스트'를 모은다 (폴백 — 구조화는 안 됐어도 정보 가치).
// ★ textContent 는 CSS 가시성을 무시(숨은 자식 포함)하므로 쓰지 않는다 — 텍스트 노드까지
//   재귀하며 '보이는' 것만 모은다. 숨김(비활성 탭/슬라이드)·점유(claimed)·스크립트류는 제외.
// 블록 요소는 줄바꿈으로 구분, 인라인은 붙여 자연스러운 텍스트로. 반환: 줄(문자열) 배열.
UDC.collectVisibleText = function (root, claimed) {
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1 };
  const BLOCK = {
    DIV: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, MAIN: 1, ASIDE: 1, NAV: 1,
    P: 1, UL: 1, OL: 1, LI: 1, TABLE: 1, TR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, PRE: 1, DL: 1, DT: 1, DD: 1, FIGURE: 1, FIGCAPTION: 1, BR: 1,
  };
  const isClaimed = (el) => claimed.some((c) => c === el || c.contains(el));
  const collect = (el) => {
    let s = "";
    for (const node of el.childNodes || []) {
      if (node.nodeType === 3) { s += node.textContent || ""; continue; } // 텍스트 노드
      if (node.nodeType !== 1) continue; // 요소만
      const tag = node.tagName;
      if (SKIP[tag]) continue;
      if (!UDC.isVisible(node)) continue; // 숨은 subtree 전체 제외(핵심)
      if (isClaimed(node)) continue; // 이미 구조화로 추출된 영역 제외
      const inner = collect(node);
      s += BLOCK[tag] ? "\n" + inner + "\n" : inner;
    }
    return s;
  };
  const raw = root ? collect(root) : "";
  return raw.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
};

// 협업 추출:
//  1) 추출 레시피가 있으면 먼저 적용(정확·라벨) → 점유 영역 기록
//  2) 어댑터들이 priority 순으로, '점유되지 않은 나머지'만 추가 (replace 아님, merge)
//  3) 차트는 공용으로 한 번만 추출
UDC.run = function (doc, recipe, pickedSelector) {
  doc = doc || document;
  const result = { source: null, tables: [], sections: [], charts: [] };
  const claimed = [];
  const sources = [];
  const steps = []; // 추적 로그(어떻게 탐색·게더링했나)
  const regions = []; // 추출 영역(오버레이 시각화용) {label, el}
  const claim = (arr, label) =>
    (arr || []).forEach((e) => { if (e) { claimed.push(e); regions.push({ label, el: e }); } });
  const desc = (part) => {
    const t = (part.tables || []).map((x) => `표 '${x.title || "?"}'(${x.columns.length}열·${x.rows.length}행)`);
    const s = (part.sections || []).map((x) => `카드 '${x.title || "?"}'(${x.fields.length}필드)`);
    return [...t, ...s].join(", ") || "없음";
  };

  // 0) 사용자가 picker 로 지정한 영역이 있으면 최우선 추출(점유)
  if (pickedSelector && UDC.domExtract) {
    try {
      const el = doc.querySelector(pickedSelector);
      if (el) {
        const part = UDC.domExtract(el, claimed);
        result.tables.push(...part.tables);
        result.sections.push(...part.sections);
        claim(part.claimed, "picked");
        if (part.tables.length || part.sections.length) sources.push("picked");
        steps.push(`지정영역 '${pickedSelector}' 스코프 추출 → ${desc(part)}`);
      } else {
        steps.push(`지정영역 '${pickedSelector}' 미발견 → 건너뜀`);
      }
    } catch (e) {
      console.warn("[UDC] 지정 영역 추출 실패", e);
    }
  }

  // 레시피 scope: include(스캔 루트 제한) / exclude·deny(claimed 선점) + domWhen 게이트
  let scope = (recipe && recipe.scope) || {};
  if (recipe && recipe.match && recipe.match.domWhen) {
    let ok = false;
    try { ok = !!doc.querySelector(recipe.match.domWhen); } catch (e) {}
    if (!ok) { steps.push(`레시피 '${recipe.name || ""}' domWhen 불일치 → 미적용`); recipe = null; scope = {}; }
  }
  if (recipe) { sources.push("recipe:" + (recipe.name || "")); steps.push(`레시피 '${recipe.name || ""}' 적용(scope)`); }

  // exclude/deny → claimed 선점(모든 어댑터·텍스트 폴백이 건너뜀). 기존 overlaps 재사용.
  const seedSkip = (sels, label) => {
    (sels || []).forEach((sel) => {
      try { doc.querySelectorAll(sel).forEach((e) => claim([e], label)); } catch (ex) {}
    });
  };
  seedSkip(scope.exclude, "exclude");
  if (recipe) seedSkip(recipe.deny, "deny");

  // include → 스캔 루트(보이는 것). 없으면 body 전체(= 기존 동작과 동일, 회귀 안전)
  let roots = [];
  (scope.include || []).forEach((sel) => {
    try { doc.querySelectorAll(sel).forEach((e) => { if (UDC.isVisible(e)) roots.push(e); }); } catch (ex) {}
  });
  if (!roots.length) roots = [doc.body || doc.documentElement];
  if (scope.include && scope.include.length) steps.push(`scope include → 루트 ${roots.length}개`);

  // 어댑터 파이프라인: 각 root × priority 순, 점유 안 된 나머지만 추출(merge)
  const sorted = [...UDC.adapters].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const root of roots) {
    for (const a of sorted) {
      let matched = false;
      try { matched = a.detect(root); } catch (e) { console.warn(`[UDC] '${a.name}' detect 실패`, e); }
      if (!matched) continue;
      try {
        const part = a.extract(root, claimed) || {};
        const t = part.tables || [];
        const s = part.sections || [];
        if (t.length || s.length) {
          result.tables.push(...t);
          result.sections.push(...s);
          claim(part.claimed, a.name);
          sources.push(a.name);
          steps.push(`어댑터 '${a.name}' → ${desc(part)}`);
        }
      } catch (e) {
        console.warn(`[UDC] '${a.name}' extract 실패`, e);
      }
    }
  }

  // 차트(데이터 아일랜드)는 페이지 전역 — 한 번만
  result.charts = UDC.extractChartIsland(doc);
  if (result.charts.length) steps.push(`차트(데이터 아일랜드) → ${result.charts.length}개`);

  // 폴백: 점유되지 않은 '보이는 텍스트'를 text 섹션으로(각 root 기준). 정보 가치 + "추출 못함" 방지.
  // CAP 은 무한스크롤 피드 등 비정상적으로 큰 화면을 막는 런어웨이 안전장치(일반 게시글은 통째로).
  try {
    const CAP = 30000;
    let lines = [];
    for (const root of roots) lines.push(...UDC.collectVisibleText(root, claimed));
    let text = lines.join("\n").trim();
    if (text) {
      const truncated = text.length > CAP;
      if (truncated) text = text.slice(0, CAP);
      result.sections.push({ kind: "text", title: null, fields: [], text });
      sources.push("text");
      steps.push(`보이는 텍스트 폴백 → ${text.length}자${truncated ? "(상한 도달)" : ""} 캡처`);
    }
  } catch (e) {
    console.warn("[UDC] text 폴백 실패", e);
  }

  // 거버넌스: mask — 매칭 요소 텍스트를 결과에서 가림(best-effort). 완전 차단은 deny 사용.
  if (recipe && recipe.mask && recipe.mask.length) {
    try {
      const secrets = [];
      recipe.mask.forEach((sel) => {
        try { doc.querySelectorAll(sel).forEach((e) => { const t = (e.textContent || "").trim(); if (t) secrets.push(t); }); } catch (ex) {}
      });
      if (secrets.length) {
        const redact = (s) => { let v = String(s); secrets.forEach((sec) => { if (sec) v = v.split(sec).join("***"); }); return v; };
        result.tables.forEach((tb) => (tb.rows || []).forEach((r) => Object.keys(r).forEach((k) => { if (typeof r[k] === "string") r[k] = redact(r[k]); })));
        result.sections.forEach((sc) => {
          if (sc.text) sc.text = redact(sc.text);
          (sc.fields || []).forEach((f) => { if (typeof f.value === "string") f.value = redact(f.value); });
        });
        steps.push(`mask 적용 → ${secrets.length}건 가림`);
      }
    } catch (e) {
      console.warn("[UDC] mask 실패", e);
    }
  }

  result.source = sources.length ? sources.join("+") : "none";
  // domWhen 게이트 통과 후의 '실효' 레시피 — background 가 MAIN world 리더에 scope/dataLayer 를 적용하도록 노출
  result.appliedRecipe = recipe ? { scope: scope, dataLayer: recipe.dataLayer || null } : null;
  result.trace = { steps, source: result.source };
  try { globalThis.__UDC_REGIONS = regions; } catch (e) {} // 오버레이 시각화용(요소 참조)
  return result;
};

// "84,000" -> 84000, "62" -> 62. 단 문자열 '전체'가 숫자일 때만(부분 추출 금지).
//  "현장-01" -> null, "010-9876-5432" -> null, "토목" -> null  (문자열 유지)
UDC.parseNumber = function (s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, "");
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return null;
};

// "계약금액(백만원)" -> { label:"계약금액", unit:"백만원" }
UDC.splitLabelUnit = function (raw) {
  const r = (raw || "").trim();
  const m = r.match(/[(（]([^)）]+)[)）]\s*$/);
  if (!m) return { label: r, unit: null };
  return { label: r.replace(/[(（]([^)）]+)[)）]\s*$/, "").trim(), unit: m[1].trim() };
};

// 차트 데이터 아일랜드: <script type="application/json" data-udc-charts>
UDC.CHART_TYPES = ["bar", "grouped_bar", "line"];
UDC.extractChartIsland = function (doc) {
  const el = doc.querySelector("script[data-udc-charts]");
  if (!el) return [];
  let arr;
  try {
    arr = JSON.parse(el.textContent || "[]");
  } catch (e) {
    console.warn("[UDC] 차트 데이터 파싱 실패", e);
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && Array.isArray(c.labels) && Array.isArray(c.series))
    .map((c) => ({
      id: String(c.id || ""),
      title: String(c.title || ""),
      type: UDC.CHART_TYPES.includes(c.type) ? c.type : "bar",
      labels: c.labels,
      series: c.series,
    }));
};
