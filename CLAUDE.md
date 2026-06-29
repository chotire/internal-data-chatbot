# CLAUDE.md

Claude Code가 이 저장소에서 작업할 때 항상 지켜야 할 **규칙·컨벤션 + 문서 진입점**.
상세 아키텍처는 아래 링크 문서를 **필요할 때 읽는다**(이 파일은 얇게 유지).

---

## 0. 한 줄 정체성

웹 화면의 **비즈니스 데이터(표·차트·카드)를 근거로 답하는 화면-인지형 챗봇** PoC.
- **핵심 고객 제약:** "레거시 코드를 수정하지 않고" 챗봇을 붙인다 → 그래서 **크롬 익스텐션**이 화면을 인식·추출한다(데이터 주입 방식 금지).
- 챗봇은 **"지금 그 화면에 떠 있는 데이터"만 근거로** 답한다.
- 향후: 익스텐션은 **채널**, 답변은 **AI 서비스(LangGraph 두뇌)**가 담당 → 지금은 임시 서버로 연출. ([v0.3](docs/architecture/v0.3-direction.md))

## 1. 아키텍처 문서 (상세는 여기)

| 문서 | 내용 |
|---|---|
| [docs/architecture/README.md](docs/architecture/README.md) | 버전 인덱스 |
| [docs/architecture/v0.2-current-build.md](docs/architecture/v0.2-current-build.md) | **현재 구현(as-built)** — 어댑터·MAIN world·recipe·테스트·배포 상세 |
| [docs/architecture/v0.3-direction.md](docs/architecture/v0.3-direction.md) | **향후 방향 + PoC 데모** — 채널/AI 서비스 분리, 3툴 확장성, 라우팅·출처·스트리밍 |
| [docs/architecture/v0.4-action-agent.md](docs/architecture/v0.4-action-agent.md) | **행동 에이전트(김반장)** — UI 운전·HITL·게이트·지식그래프·지속 업데이트 |
| [docs/glossary.md](docs/glossary.md) | 용어집(MV3·a11y·LangGraph·MCP·그래프DB 등) |

> 작업 전 관련 버전 문서를 먼저 확인할 것. v0.2 = 지금 동작하는 것, v0.3 = 지향점.

## 2. 기술 스택 (요약)

- **언어/런타임**: Python 3.12, **uv**(`pyproject.toml`+`uv.lock`, pip 미사용)
- **서버**: FastAPI(챗봇 UI 제공 + `/api/chat` LLM 프록시)
- **LLM**: OpenAI(`.env`로 키/모델 주입, **하드코딩 금지**)
- **익스텐션**: Manifest V3(service worker, content scripts, Side Panel) — Chrome·Edge 호환
- **테스트**: Node + Playwright + 파이썬 (`node tests/run.mjs` → `tests/RESULTS.md`)

## 3. 디렉터리 (요약)

```
server/    main.py · llm.py · schemas.py · recipes.py · recipes.jsonc · web/
extension/ manifest.json · background.js · sidepanel.* · content/(base.js · adapters/)
tests/     run.mjs · suites/ · server/ → RESULTS.md
docs/      architecture/(버전 문서) · 01-plan/ · 02-design/
deploy/    엔터프라이즈 배포 템플릿(.crx/update.xml/ForceList)
```

## 4. 코딩 컨벤션 (규칙)

- **Python**: PEP8·타입힌트·작은 함수, FastAPI 관용구 우선. **프롬프트는 `llm.py` 한곳**. 비밀키·모델명은 **환경변수**.
- **JS(익스텐션)**: 빌드 도구 없이 순수 JS. 어댑터는 공통 인터페이스(`detect`/`extract`).
- **PoC 원칙**: 과한 추상화 금지, **"동작하는 가장 단순한 형태" 우선**, 주변 코드 스타일에 맞춤.
- **한국어 글쓰기(문서·슬라이드·UI·주석)**: 사람이 읽는 산문은 **주어·서술어가 있는 완결된 문장**으로 쓴다. 명사로 끊는 **개조식·전보체 단편 나열 금지**(예: "직접 소유", "에너지는 무기에"). 표·불릿의 *항목*은 짧은 구 OK, 하지만 **콜아웃·설명 문장**은 자연스러운 문장으로. 영어/전문용어를 한국어 문장에 억지로 끼우지 말 것(예: commodity를 "상품"으로) — 쉬운 말 + 필요한 정밀 용어는 괄호 병기. **작성 후 소리 내어 읽어 어색하면 고친다.**

## 5. 보안·거버넌스 (필수)

- OpenAI 키는 **서버(프록시)에만**. 익스텐션/클라이언트에 두지 않는다.
- 내부 데이터가 외부(OpenAI 등)로 나가는 건 거버넌스 대상 → recipe `mask`/`deny`로 통제. **마스킹은 데이터가 익스텐션(채널)을 떠나기 전에** 적용.
- iframe ↔ side panel `postMessage`는 **origin 검증 필수**.
- 서명키/패키지(`*.pem`, `*.crx`)·`.env`는 **커밋 금지**.

## 6. 작업 규칙

- 아키텍처를 바꾸는 변경은 해당 버전 문서(`docs/architecture/`)도 같이 갱신. 새 방향은 `v0.4-*.md`로 추가하고 README 인덱스 갱신.
- recipe·프롬프트·챗봇 UI 변경은 **서버 파일 저장만으로 반영**(익스텐션 재로드 불필요). 어댑터 추출 *로직*(content/*) 변경만 익스텐션 재로드 필요.
- **테스트 규칙 — "자동화 가능한 부분은 반드시 케이스를 추가한다."** 새 기능에서 LLM/브라우저 없이 **결정론적으로 검증 가능한 로직**(서버 파싱·이벤트 매핑·SSE 프레이밍·추출 파이프라인 등)은 `tests/`에 스위트 케이스를 추가한다(`node tests/run.mjs` → `tests/RESULTS.md`). 외부 의존은 **스텁/주입**으로 결정론화(예: OpenAI Responses 스트림을 fake 로 주입 → `tests/server/test_stream.py`).
- **자동화 불가한 끝단만 수동**: 실제 OpenAI 호출(툴 라우팅 정확도·이벤트 타입명·모델 지원)과 브라우저 내 익스텐션 동작(주입·side panel·postMessage). 그 외(추출 로직·서버 로직)는 `tests/`로 검증.

## 7. TODO / 메모

- **멀티턴 후속 질문 — `previous_response_id`로 재구현 후 재활성화.** 현재 `chat.js`의 `SEND_HISTORY=false`로 멀티턴을 꺼둠. 이유: 이전 Q&A를 *평문 메시지로 재구성*해 보내면, 툴(code_interpreter 등) 활성 상태에서 모델이 직전 과제에 anchor돼 **새 질문을 무시·재실행**하는 오염이 있었음(Q6에 Q4 답이 나온 사례). "그중 가장 큰 곳은?" 같은 후속 질문이 필요해지면, 평문 history 대신 **OpenAI Responses API의 `previous_response_id`**(직전 응답 ID로 대화 상태·툴 호출 내역까지 서버측에서 이어줌)로 바꿔 켤 것. 관련: [v0.3-direction.md](docs/architecture/v0.3-direction.md) §4(멀티스텝·상태).
