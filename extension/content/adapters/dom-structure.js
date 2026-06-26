// domStructure 어댑터 (항상 동작하는 폴백/협업자).
// <table> 이 아닌 div 구조를: ARIA/role 없어도 "반복 구조"로 데이터 영역을 찾고, "헤더행/라벨-값"으로 라벨 매핑.
//   - 자식이 동일한 열 수로 반복되는 컨테이너 → 레코드 목록
//       · 열 수 >= 3 → 데이터 표.  헤더행이 있으면 그 텍스트를 컬럼 라벨로 매핑(없으면 label:null)
//       · 열 수 == 2 → 라벨-값 카드(인사카드 등)
// 협업: 이미 레시피/다른 어댑터가 점유(claimed)했거나 <table> 내부인 영역은 건너뛴다.

(function () {
  function childEls(el) {
    return [...el.children];
  }
  function cellTexts(el) {
    return childEls(el).map((c) => (c.textContent || "").trim());
  }

  // 컨테이너의 제목(라벨) 추정: 내부 헤딩 → 앞 형제 헤딩 → 부모 안 앞쪽 헤딩
  function findTitle(el) {
    const inner = el.querySelector && el.querySelector("h1,h2,h3,h4");
    if (inner) return (inner.textContent || "").trim() || null;
    const prev = el.previousElementSibling;
    if (prev && /^H[1-4]$/.test(prev.tagName)) return (prev.textContent || "").trim() || null;
    if (el.parentElement) {
      const kids = [...el.parentElement.children];
      for (let i = kids.indexOf(el) - 1; i >= 0; i--)
        if (/^H[1-4]$/.test(kids[i].tagName)) return (kids[i].textContent || "").trim() || null;
    }
    return null;
  }

  function findRepeated(root, claimed) {
    const candidates = [];
    const all = [root, ...root.querySelectorAll("*")];
    for (const el of all) {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "CANVAS") continue;
      if (el.closest && el.closest("table")) continue;
      if (UDC.overlaps(el, claimed)) continue;
      if (!UDC.isVisible(el)) continue; // 숨겨진 영역(비활성 탭/슬라이드 등)은 추출 제외
      const kids = childEls(el);
      if (kids.length < 3) continue;
      const counts = kids.map((k) => k.children.length);
      const freq = {};
      counts.forEach((c) => (freq[c] = (freq[c] || 0) + 1));
      let bestC = -1, bestN = 0;
      for (const c in freq) if (freq[c] > bestN) { bestN = freq[c]; bestC = +c; }
      if (bestC >= 2 && bestN >= 3 && bestN >= kids.length * 0.6) {
        candidates.push({ el, cols: bestC, rowEls: kids.filter((k) => k.children.length === bestC) });
      }
    }
    return candidates.filter((c) => !candidates.some((o) => o !== c && c.el.contains(o.el)));
  }

  // 헤더(라벨) 추정: ① 행들 중 첫 행이 전부 비숫자 텍스트이고 나머지에 숫자 컬럼이 있으면 첫 행=헤더
  //               ② 컨테이너의 앞 형제(.thead/.ghead 등)가 같은 열 수의 텍스트면 헤더
  function resolveHeader(cand) {
    const rowEls = cand.rowEls.slice();
    if (rowEls.length >= 2) {
      const first = cellTexts(rowEls[0]);
      const firstAllText = first.length === cand.cols && first.every((t) => t !== "" && UDC.parseNumber(t) === null);
      const restHasNumber = rowEls.slice(1).some((r) => cellTexts(r).some((t) => UDC.parseNumber(t) !== null));
      if (firstAllText && restHasNumber) return { labels: first, dataRows: rowEls.slice(1) };
    }
    const prev = cand.el.previousElementSibling;
    if (prev && prev.children.length === cand.cols) {
      const t = cellTexts(prev);
      if (t.every((x) => x !== "" && UDC.parseNumber(x) === null)) return { labels: t, dataRows: rowEls };
    }
    return { labels: null, dataRows: rowEls };
  }

  function buildTable(cand) {
    const { labels, dataRows } = resolveHeader(cand);
    const columns = Array.from({ length: cand.cols }, (_, i) => {
      if (labels) {
        const { label, unit } = UDC.splitLabelUnit(labels[i]);
        return { key: "c" + i, label, type: "string", unit };
      }
      return { key: "c" + i, label: null, type: "string", unit: null };
    });
    const rows = dataRows.map((r) => {
      const cells = childEls(r);
      const obj = {};
      columns.forEach((c, i) => {
        const txt = ((cells[i] && cells[i].textContent) || "").trim();
        const num = UDC.parseNumber(txt);
        obj[c.key] = num !== null && txt !== "" ? num : txt;
      });
      return obj;
    });
    columns.forEach((c) => {
      const vals = rows.map((r) => r[c.key]);
      const n = vals.filter((v) => typeof v === "number").length;
      if (c.type !== "number") c.type = n > vals.length / 2 ? "number" : "string";
    });
    return { title: findTitle(cand.el), columns, rows, filters: {} };
  }

  function buildCard(cand) {
    const fields = cand.rowEls.map((r) => {
      const kv = childEls(r);
      return {
        label: ((kv[0] && kv[0].textContent) || "").trim() || null,
        value: ((kv[1] && kv[1].textContent) || "").trim(),
      };
    });
    return { kind: "card", title: findTitle(cand.el), fields, text: null };
  }

  // 임의 영역(root) 스코프 추출 — 어댑터와 picker(사용자 지정 영역)가 공용으로 쓴다.
  UDC.domExtract = function (root, claimed) {
    claimed = claimed || [];
    if (!root) return { tables: [], sections: [], claimed: [] };
    const cands = findRepeated(root, claimed);
    const tables = [];
    const sections = [];
    const used = [];
    for (const c of cands) {
      if (c.cols >= 3) { tables.push(buildTable(c)); used.push(c.el); }
      else if (c.cols === 2) { sections.push(buildCard(c)); used.push(c.el); }
    }
    return { tables, sections, claimed: used };
  };

  UDC.register({
    name: "domStructure",
    priority: -10,
    detect() {
      return true;
    },
    extract(doc, claimed) {
      // doc 은 document 또는 scope 루트(element). element 면 body/documentElement 가 없으므로 그대로 사용.
      return UDC.domExtract(doc.body || doc.documentElement || doc, claimed);
    },
  });
})();
