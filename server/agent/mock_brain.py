"""MockBrain — 규칙기반 두뇌(LLM 미사용). FormContext + 의도 → fill-plan.

PoC 원칙: 과한 추상화 금지, 동작하는 가장 단순한 형태. 결정론적이라 브라우저 없이 단위테스트 가능.
나중에 이 어댑터를 LangGraph 두뇌로 교체한다(Brain 포트는 그대로).
"""

from __future__ import annotations

import re

from server.agent.ports import Brain, GraphStore
from server.agent.schemas import (
    ActionStep,
    ButtonSpec,
    FillPlan,
    FillPlanItem,
    FormContext,
    GateDecision,
    Intent,
    IntentLine,
    PlannedAction,
)

# 자연어에서 떼어낼 동작/장식어(라인 파싱 전 제거).
_ACTION_WORDS = ["구매신청", "구매요청", "신청해줘", "신청", "요청", "등록해줘", "등록", "해줘", "해주세요", "추가", "주세요"]
_DELETE_WORDS = ["삭제", "지워"]
_UPDATE_WORDS = ["수정", "변경", "고쳐"]
_QUERY_WORDS = ["조회", "목록", "보여", "확인"]
# 등록 의도를 가리키는 *동사*(목적 명사 "구매요청"과 구분 — 그 명사는 조회문에도 나온다).
_CREATE_VERBS = ["신청", "등록", "추가"]
# 품목명이 아닌 분류/잡음어(라인 파싱 시 제거) — 예: "MRO 볼펜" → 검색어 "볼펜".
_NOISE_WORDS = ["MRO"]


class MockBrain(Brain):
    # ── parse_intent ─────────────────────────────────────────────────────
    def parse_intent(self, text: str) -> Intent:
        text = text or ""
        action = "create"
        if any(w in text for w in _DELETE_WORDS):
            action = "delete"
        elif any(w in text for w in _UPDATE_WORDS):
            action = "update"
        elif any(w in text for w in _QUERY_WORDS) and not any(w in text for w in _CREATE_VERBS):
            action = "query"

        # 헤더 값(제목·부서·납기)을 자연어에서 떼어낸다. 떼어낸 부분은 rest 에서 제거해
        # 라인 파싱(품목+수량)이 오염되지 않게 한다(예: "총무팀 볼펜10" → 부서=총무팀, 라인=볼펜10).
        rest = text
        params: dict[str, str] = {}

        def _cut(m):  # 매치 구간을 rest 에서 공백으로 치환
            nonlocal rest
            rest = rest[: m.start()] + " " + rest[m.end():]

        m = re.search(r"PR-\d{4}-\d{4}", rest)  # 대상 요청번호(조회/수정/삭제). 먼저 떼어 라인 오염 방지.
        if m:
            params["pr"] = m.group(0); _cut(m)
        m = re.search(r"\d{4}-\d{2}-\d{2}", rest)  # 납기: ISO 날짜만(결정론). 한국어 날짜는 미지원.
        if m:
            params["due"] = m.group(0); _cut(m)
        m = re.search(r"(?:제목|건명|건)\s*[:：]\s*([^,，·/、]+)", rest)  # 제목: '제목:' 마커
        if m:
            params["title"] = m.group(1).strip(); _cut(m)
        m = re.search(r"[가-힣]+팀", rest)  # 부서: '…팀'(총무팀 등). 품목명엔 '팀'이 없어 안전.
        if m:
            params["dept"] = m.group(0); _cut(m)

        cleaned = rest
        for w in _ACTION_WORDS + _NOISE_WORDS:
            cleaned = cleaned.replace(w, " ")
        lines: list[IntentLine] = []
        for seg in re.split(r"[·,/、]+", cleaned):
            seg = seg.strip()
            if not seg:
                continue
            qty, span = _extract_qty(seg)
            if qty is None:
                continue
            name = (seg[: span[0]] + seg[span[1]:]).strip()
            name = re.sub(r"\s+", " ", name).strip(" .-")
            if name:
                lines.append(IntentLine(item=name, qty=qty))

        target = "구매요청" if ("구매" in text or lines) else None
        return Intent(action=action, target=target, lines=lines, params=params)

    # ── plan ─────────────────────────────────────────────────────────────
    # 조회·수정·등록·삭제가 *같은 루프*(이동 → 인식 → 행동 → 필요시 확인)로 흐른다(§5).
    # 다른 건 어떤 기본동작을 쓰나와 마지막에 저장/삭제가 있나뿐.
    _MENU = {"pr-list": '[data-nav="pr-list"]', "pr-form": '[data-nav="pr-form"]'}

    def plan(self, intent: Intent, form: FormContext, graph: "GraphStore | None" = None,
             memory=None) -> FillPlan:
        current = (form.signature or {}).get("screen") or form.screen_id
        pr = (intent.params or {}).get("pr")
        action = intent.action
        self._memory = memory  # _line_items 가 참조(기억된 정식코드로 자동 해소)

        # 조회: 목록(또는 특정 PR 상세)으로 이동 후 화면을 읽어 보고. 되돌릴 일 없음 → 자율.
        if action == "query":
            nav = self._nav(graph, current, "pr-list")
            if pr:
                nav = nav + [ActionStep(op="click", target=f'.row-detail[data-pr="{pr}"]', label="상세 열기")]
            return FillPlan(intent=intent, nav=nav, items=[], read=True,
                            gate=GateDecision(mode="auto", reason="조회 — 다시 하면 되는 행동"))

        # 삭제: 목록으로 이동 → 행 삭제(되돌릴 수 없음 → 확인). 대상 PR 없으면 검사가능성으로 드러냄.
        if action == "delete":
            nav = self._nav(graph, current, "pr-list")
            if not pr:
                return FillPlan(intent=intent, nav=nav, items=[], missing_required=["대상 요청번호(PR-…)"],
                                gate=GateDecision(mode="confirm", reason="삭제 대상 미지정"))
            primary = PlannedAction(op="click", target=f'.row-delete[data-pr="{pr}"]', irreversible=True)
            primary.gate = self.decide_gate(primary)
            return FillPlan(intent=intent, nav=nav, items=[], save=primary, gate=primary.gate)

        # 수정: 상세→수정으로 이동 후 지정한 헤더/라인만 채우고(diff) 저장(되돌릴 수 없음 → 확인).
        if action == "update":
            tform = self._form_for(form, graph, "pr-form")  # 폼 스키마(현재 화면이 폼이 아니면 그래프에서)
            nav = self._nav(graph, current, "pr-list")
            if pr:
                nav = nav + [
                    ActionStep(op="click", target=f'.row-detail[data-pr="{pr}"]', label="상세 열기"),
                    ActionStep(op="click", target="#edit-pr", label="수정 진입"),
                ]
            items = self._header_items(intent, tform) + self._line_items(intent, tform)
            save, gate = self._save_action(tform)
            return FillPlan(intent=intent, nav=nav, items=items, save=save, gate=gate)

        # 등록(기본): 등록 폼으로 이동 → 헤더+라인 채움 → 저장. 못 채운 필수는 미리 드러낸다.
        tform = self._form_for(form, graph, "pr-form")
        nav = self._nav(graph, current, "pr-form")
        header = self._header_items(intent, tform)
        items = header + self._line_items(intent, tform)
        covered = {it.field_key for it in header}
        missing = [(f.label or f.key) for f in tform.fields if f.required and f.key not in covered]
        save, gate = self._save_action(tform)
        return FillPlan(intent=intent, nav=nav, items=items, missing_required=missing, save=save, gate=gate)

    # ── plan 보조 ─────────────────────────────────────────────────────────
    def _nav(self, graph: "GraphStore | None", current, target) -> list[ActionStep]:
        """현재→목표 이동 경로. 그래프가 알면 그 경로, 없으면 메뉴 화면은 직접 클릭(메뉴는 늘 떠 있음)."""
        if current == target:
            return []
        steps: list[ActionStep] = []
        if graph and current:
            steps = list(graph.find_path(current, target) or [])
        if not steps and target in self._MENU:
            steps = [ActionStep(op="click", target=self._MENU[target], label="메뉴 이동")]
        return steps

    def _form_for(self, form: FormContext, graph: "GraphStore | None", target_screen: str) -> FormContext:
        """계획에 쓸 폼 스키마. 현재 화면이 그 폼이면 그대로, 아니면 그래프 폼스키마로 보완."""
        if form and (form.fields or form.save_button):
            return form
        if graph:
            sch = graph.get_form_schema(target_screen)
            if sch:
                return FormContext(screen_id=target_screen, fields=sch.fields, line_grid=sch.line_grid,
                                   save_button=ButtonSpec(key="#save-btn", label="저장"))
        return form

    def _save_action(self, form: FormContext) -> tuple[PlannedAction | None, GateDecision]:
        if not form.save_button:
            return None, GateDecision(mode="auto")
        save = PlannedAction(op="click", target=form.save_button.key, irreversible=True)
        save.gate = self.decide_gate(save)
        return save, save.gate

    def _header_items(self, intent: Intent, form: FormContext) -> list[FillPlanItem]:
        items: list[FillPlanItem] = []
        for canon, value in (intent.params or {}).items():
            if canon not in ("title", "dept", "due"):  # pr 등은 헤더 필드가 아님
                continue
            fld = _field_for(form, canon)
            if fld and value not in (None, ""):
                op = "select" if fld.role == "select" else "fill"
                items.append(FillPlanItem(op=op, field_key=fld.key, label=fld.label, value=value))
        return items

    def _line_items(self, intent: Intent, form: FormContext) -> list[FillPlanItem]:
        memory = getattr(self, "_memory", None)
        items: list[FillPlanItem] = []
        for i, ln in enumerate(intent.lines):
            if i > 0 and form.line_grid and form.line_grid.addRowBtn:
                items.append(FillPlanItem(op="addRow", field_key=form.line_grid.addRowBtn, label="행추가", row=i))
            # 메모리에 정식코드가 있으면 자동 해소 → 후보 고르기(HITL) 생략.
            remembered = memory.resolve(ln.item) if memory else None
            items.append(FillPlanItem(
                op="searchSelect", field_key=f'.item-search[data-row="{i}"]', label="품목",
                query=ln.item, row=i,
                value=remembered,  # 있으면 runPlan 이 그 코드를 바로 고른다
                needs_resolution=bool(form.line_grid and form.line_grid.itemSearch) and not remembered,
                note=(f'기억에서 자동 해소: {remembered}' if remembered else f'"{ln.item}" 검색 후 후보 선택'),
            ))
            items.append(FillPlanItem(op="fill", field_key=f'[data-line-qty="{i}"]', label="수량", value=ln.qty, row=i))
        return items

    # ── decide_gate ──────────────────────────────────────────────────────
    def decide_gate(self, action: PlannedAction, ctx: dict | None = None) -> GateDecision:
        # "다시 하면 되는" 행동은 자율, "한 번 하면 끝(저장·삭제)"은 사람 확인.
        # (신뢰도/모드는 메모리가 쌓이는 5단계에서 가중 — 지금은 위험등급만으로 결정.)
        if action.irreversible:
            return GateDecision(mode="confirm", reason="되돌릴 수 없는 행동(저장/삭제) — 실행 전 사람 확인")
        return GateDecision(mode="auto", reason="다시 하면 되는 행동 — 자율")


# ── 보조 ──────────────────────────────────────────────────────────────────
def _extract_qty(seg: str) -> tuple[int | None, tuple[int, int]]:
    """세그먼트에서 수량 추출. '개' 붙은 수를 우선, 없으면 마지막 숫자(품목명 속 숫자 회피)."""
    m = re.search(r"(\d+)\s*개", seg)
    if m:
        return int(m.group(1)), (m.start(), m.end())
    nums = list(re.finditer(r"\d+", seg))
    if nums:
        last = nums[-1]
        return int(last.group(0)), (last.start(), last.end())
    return None, (0, 0)


# 의도 키(canon) → 폼 필드. 라벨 키워드로 거칠게 매칭.
_FIELD_KEYWORDS = {
    "title": ["제목"],
    "dept": ["부서"],
    "due": ["납기", "기한"],
}


def _field_for(form: FormContext, canon: str):
    keys = _FIELD_KEYWORDS.get(canon, [canon])
    for f in form.fields:
        lab = f.label or ""
        if any(k in lab for k in keys):
            return f
    # 납기는 라벨이 애매하면 date 역할로도 매칭
    if canon == "due":
        for f in form.fields:
            if f.role == "date":
                return f
    return None
