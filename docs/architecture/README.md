# 아키텍처 문서 — 버전 인덱스

이 폴더는 아키텍처 상세 스펙을 **버전별 문서**로 관리한다.
항상 지켜야 할 규칙·컨벤션 요약과 진입점은 루트 [`CLAUDE.md`](../../CLAUDE.md).

| 버전 | 문서 | 성격 | 상태 |
|---|---|---|---|
| **v0.2** | [v0.2-current-build.md](v0.2-current-build.md) | 현재 구현된 시스템(as-built) 상세 | ✅ 구현됨 |
| **v0.3** | [v0.3-direction.md](v0.3-direction.md) | 향후 방향(채널/AI 서비스) + PoC 데모 범위 | 🧭 방향·일부 미구현 |

- **v0.2 = "지금 무엇이 동작하나"** — 익스텐션 + 플러그러블 어댑터 + MAIN world + recipe + 테스트.
- **v0.3 = "어디로 가나"** — 익스텐션은 채널, AI 서비스(LangGraph)가 두뇌. 이번 PoC는 3개 툴(screen_data/code_interpreter/web_search)로 확장성 데모.

> 명명 규칙: `v<major>.<minor>-<slug>.md` (버전 앞·의미 슬러그 뒤). 다음 방향은 `v0.4-*.md`로 추가하고 이 표를 갱신한다.
