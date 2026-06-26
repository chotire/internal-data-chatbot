// table 어댑터: HTML <table> 표. thead/th → 컬럼(라벨+단위), tbody/tr → 행.
// 협업: 이미 점유(claimed)된 표는 건너뛴다. 차트는 오케스트레이터가 공용 추출.

(function () {
  function pickTable(doc, claimed) {
    const tables = [...doc.querySelectorAll("table")].filter((t) => !UDC.overlaps(t, claimed) && UDC.isVisible(t));
    if (!tables.length) return null;
    return tables.sort(
      (a, b) =>
        b.querySelectorAll("tbody tr").length - a.querySelectorAll("tbody tr").length
    )[0];
  }

  UDC.register({
    name: "table",
    priority: 0,
    detect(doc) {
      const t = pickTable(doc, []);
      return !!(t && t.querySelectorAll("tbody tr").length);
    },
    extract(doc, claimed) {
      claimed = claimed || [];
      const table = pickTable(doc, claimed);
      if (!table) return { tables: [], sections: [], claimed: [] };

      let headerCells = [...table.querySelectorAll("thead th")];
      if (!headerCells.length) {
        const firstRow = table.querySelector("tr");
        headerCells = firstRow ? [...firstRow.children] : [];
      }
      const columns = headerCells.map((th, i) => {
        const { label, unit } = UDC.splitLabelUnit(th.textContent || "");
        return { key: "c" + i, label, type: "string", unit };
      });

      const bodyRows = [...table.querySelectorAll("tbody tr")];
      const rows = bodyRows.map((tr) => {
        const cells = [...tr.children];
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
        const numCount = vals.filter((v) => typeof v === "number").length;
        c.type = numCount > vals.length / 2 ? "number" : "string";
      });

      return { tables: [{ title: null, columns, rows, filters: {} }], sections: [], claimed: [table] };
    },
  });
})();
