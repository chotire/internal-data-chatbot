# LLM 데이터 수집 구조에 대한 검토

## 요약
현재 구조의 방향은 맞습니다. 특히 ISOLATED DOM 추출과 MAIN world 데이터레이어 읽기를 분리한 점은 적절합니다. 이 프로젝트의 본질이 "렌더링된 화면에서 LLM이 활용할 수 있는 데이터를 얼마나 안정적으로 수집하느냐"에 있다면, 현재 중심 축인 [extension/background.js](extension/background.js), [extension/content/base.js](extension/content/base.js), [server/schemas.py](server/schemas.py)는 올바른 출발점 위에 있습니다.

다만 WebSquare, React, Vue 같은 여러 환경에서 더 강한 구조가 되려면, "어댑터가 데이터를 직접 추출한다"는 관점보다 "어댑터가 여러 신호를 수집하고, 이를 공통 정규화 계층에서 결합한다"는 관점이 더 명확해져야 합니다. 지금 [extension/content/adapters/websquare.js](extension/content/adapters/websquare.js)가 스텁으로 남아 있는 점도 이 문제를 잘 보여줍니다. 실제 난점은 프레임워크 감지 자체가 아니라, 각 프레임워크의 데이터 모델과 DOM 라벨을 얼마나 안정적으로 결합하느냐에 있습니다.
## 핵심 판단

LLM은 주 추출기가 아니라 보조 해석기로 두는 것이 맞습니다.
그 이유는 다음과 같습니다.

1. 원시 데이터 추출은 가능한 한 결정적이어야 합니다.
2. 렌더링된 화면 데이터는 누락이나 오인식이 발생하면 답변 전체의 신뢰도가 무너집니다.
3. LLM은 라벨 정리, 약한 시맨틱 보강, fallback 분류에는 유용하지만, 라이브 DOM이나 프레임워크 내부 상태를 정확하게 읽는 엔진으로 사용하기에는 비용과 불안정성이 큽니다.

즉, 데이터 추출 실패를 LLM으로 메우는 방향보다는, 이미 추출된 데이터를 더 잘 정리하고 해석하는 방향으로 LLM을 사용하는 편이 훨씬 안정적입니다.
## 권장 아키텍처

현재 구조를 확장하려면 수집 과정을 다음 네 계층으로 나누는 것이 좋습니다.
### 1. 수집 계층

각 프레임워크에서 가능한 한 먼저 데이터 모델을 읽어야 합니다.
- WebSquare: 데이터셋, 그리드 모델, 전역 객체
- React: 컴포넌트 props 자체보다는 실제 그리드 라이브러리 API나 페이지 모델
- Vue: 컴포넌트 state 자체보다는 바인딩된 데이터나 위젯 API
여기서 중요한 점은 React나 Vue 자체를 읽는 것이 아니라, 그 위에 올라간 실제 위젯이나 페이지 모델을 읽는 것입니다. React Fiber를 범용 해법처럼 사용하는 접근은 장기적으로 불안정합니다.

### 2. 의미 계층
DOM에서 헤더, 라벨, aria 정보, 주변 제목, 카드형 key-value 구조를 읽어 "이 값이 무엇인지"를 붙여야 합니다. 현재 [extension/content/base.js](extension/content/base.js)와 [extension/content/adapters/dom-structure.js](extension/content/adapters/dom-structure.js)는 이 계층의 출발점으로 볼 수 있습니다.

### 3. 정규화 계층
수집한 값들을 ScreenContext로 바꿀 때는 값만 넣는 구조보다, 출처와 신뢰도를 함께 넣는 구조가 더 좋습니다. 예를 들어 아래와 같은 메타데이터가 있으면 LLM 활용성과 디버깅 가능성이 모두 좋아집니다.

```text
sourceKind: dataLayer | domHeader | aria | inferred
sourcePath: window.GRID.rows[3].contract
sourceSelector: .summary-table th:nth-child(2)
confidence: 0.95
```

### 4. LLM 보조 계층
LLM은 이 단계에서만 사용하는 것이 바람직합니다. 역할은 추출이 아니라 정리입니다. 예를 들면 다음과 같은 작업이 적합합니다.

- 다소 불규칙한 컬럼명을 표준화
- 카드와 표를 묶어 화면의 핵심 엔터티를 요약
- 차트 시리즈 이름 보정
- 신규 도메인 화면에 대한 recipe 초안 제안

## 프레임워크별 판단
### WebSquare

가장 유망한 대상입니다. 일반적으로 데이터 모델이 비교적 명시적이기 때문입니다. DOM만 스크래핑하지 말고, MAIN world에서 데이터셋과 그리드 정의를 직접 읽는 방향이 적합합니다. 이 프로젝트에서 가장 먼저 실전 성과를 낼 가능성이 높은 환경입니다.
### React

주의가 필요합니다. "React 앱이니 React에서 읽자"는 접근은 자주 실패합니다. 실제 현장에서는 React 위에 AG Grid, MUI DataGrid, TanStack Table, 사내 커스텀 그리드가 올라가는 경우가 많습니다. 따라서 React 공통 어댑터보다 위젯 어댑터가 더 중요합니다. React Fiber는 보조 신호 정도로만 사용하는 것이 적절합니다.
### Vue

React와 유사합니다. Vue 자체보다 실제 그리드와 차트 컴포넌트가 더 중요합니다. Vue 인스턴스 내부를 범용적으로 읽으려 하기보다, 페이지 전역 데이터나 위젯 API를 찾는 쪽이 유지보수성이 높습니다.

## 범용성의 실제 단위
실제로 범용성을 결정하는 축은 프레임워크보다 위젯 유형에 가깝습니다.

### 표 계열
- HTML table
- AG Grid
- Handsontable
- 커스텀 div grid

### 카드 계열
- label-value 반복 블록
- 상세 패널
- 요약 KPI

### 차트 계열
- Chart.js
- ECharts
- Highcharts
- SVG 기반 차트

이 관점에서 보면 "React 어댑터"보다 "AG Grid 리더", "Chart.js 리더", "ARIA grid 리더", "key-value card 리더"가 더 강한 설계 단위가 됩니다.

## 고려할 오픈 소스
이 문제를 통째로 해결해 주는 라이브러리는 사실상 없습니다. 다만 부분적으로 유용한 도구는 있습니다.

### Mozilla Readability
텍스트 본문형 화면에는 유용합니다. 게시판, 공지, 문서, 보고서 본문 추출 fallback 용도로 적합합니다. 다만 표나 대시보드의 구조화 추출에는 맞지 않습니다. 따라서 현재 구조에서는 text fallback 보강용 후보로 보는 것이 적절합니다.

### dom-accessibility-api
상당히 유용한 후보입니다. `aria-label`, accessible name, description 계산에 강점이 있습니다. 헤더가 약한 커스텀 UI나 버튼형 필터, 라벨이 시각적으로 흩어진 화면에서 시맨틱 이름을 복원하는 데 도움이 됩니다. generic extractor를 더 똑똑하게 만드는 방향과 잘 맞습니다.

### JSONPath Plus
recipe나 dataLayer 힌트와 잘 맞습니다. MAIN world에서 전역 객체나 상태 객체를 확보한 뒤, 그 안에서 선언적으로 값을 찾는 용도로 유용합니다. 특히 recipe의 `dataLayer.path`가 더 복잡해지면 단순 점 표기보다 유연하게 사용할 수 있습니다. 다만 이것은 객체를 찾은 뒤에 활용하는 도구이지, 객체 자체를 찾아주는 도구는 아닙니다.

## 과도한 기대를 피해야 할 대상
### React DevTools 내부 훅 의존

가능은 하지만 안정성이 약합니다. 제품의 핵심 추출 경로로 삼기에는 위험합니다.
### 범용 DOM-to-JSON 라이브러리

대부분 시맨틱을 충분히 만들지 못합니다. 결국 라벨-값 관계와 표 구조를 다시 해석해야 하므로, 근본적인 해결책이 되기 어렵습니다.

### LLM으로 DOM 전체 해석
비용, 속도, 개인정보, 재현성 측면에서 주 경로로 사용하기에 부적합합니다.

## 다음 단계에서 중요한 개선점
### 1. 공통 계약 강화

현재 [server/schemas.py](server/schemas.py)는 깔끔하지만, LLM 친화성과 운영성을 함께 높이려면 provenance와 confidence 같은 메타데이터가 추가되는 편이 좋습니다. 이 변화는 모델 성능 자체보다 운영 안정성에 더 크게 기여할 가능성이 큽니다.
### 2. 프레임워크 어댑터보다 위젯 어댑터 우선

WebSquare, React, Vue를 1차 축으로 보기보다 아래와 같은 리더를 우선 구조화하는 편이 더 적합합니다.
- dataLayer global reader
- grid reader
- chart reader
- card reader
- article/text reader

각 프레임워크는 이 리더들이 동작할 수 있도록 힌트를 제공하는 역할에 가까워야 합니다.
## 결론

현재 구조는 확장 가능한 출발점입니다. 다만 진짜 범용성을 얻으려면 "프레임워크 어댑터" 중심 사고에서 "데이터 위젯 + 의미 정규화 + provenance" 중심 사고로 이동해야 합니다. LLM은 그 위에서 시맨틱 보정과 운영 보조를 맡는 편이 가장 효율적입니다.

## 후속 논의 후보
다음 단계로는 아래 세 가지 중 하나를 구체화하는 것이 좋습니다.

1. ScreenContext를 LLM 친화적으로 확장하는 스키마 초안 만들기
2. WebSquare, React, Vue를 공통으로 다루는 위젯 중심 어댑터 설계안 만들기
3. 실제 도입할 오픈 소스 후보를 선정하고, 어디에 어떻게 붙일지 기술 검토안 만들기
제 판단은 이렇습니다. 현재 구조는 방향이 맞습니다. 특히 ISOLATED DOM 추출과 MAIN world 데이터레이어 읽기를 분리한 점은 좋습니다. 이 프로젝트의 본질이 “렌더된 화면에서 LLM이 쓸 수 있는 데이터를 얼마나 안정적으로 회수하느냐”라면, 지금 구조의 중심인 [extension/background.js](extension/background.js), [extension/content/base.js](extension/content/base.js), [server/schemas.py](server/schemas.py)는 올바른 축 위에 있습니다.

다만 WebSquare, React, Vue 같은 여러 환경에서 정말 강해지려면, “어댑터가 데이터를 직접 추출한다”보다 “어댑터가 여러 신호를 수집하고, 그걸 공통 정규화 계층이 합친다”로 한 단계 더 명확해져야 합니다. 지금 [extension/content/adapters/websquare.js](extension/content/adapters/websquare.js)가 스텁인 것도 그 지점을 잘 보여줍니다. 진짜 어려운 건 프레임워크 감지가 아니라, 각 프레임워크의 데이터 모델과 DOM 라벨을 어떻게 안정적으로 결합하느냐입니다.

핵심 판단을 먼저 말하면, LLM은 주 추출기가 아니라 보조 해석기로 두는 게 맞습니다.
이유는 간단합니다.

1. 원시 추출은 결정적이어야 합니다.
2. 렌더된 화면 데이터는 누락이나 오인식이 생기면 답변 전체가 무너집니다.
3. LLM은 라벨 정리, 약한 시맨틱 보강, fallback 분류에는 좋지만, 라이브 DOM과 프레임워크 내부 상태를 정확하게 읽는 엔진으로 쓰기엔 비싸고 불안정합니다.

그래서 추천 구조는 아래처럼 4층으로 보는 게 좋습니다.

1. 수집 계층
각 프레임워크에서 가능한 한 “데이터 모델”을 우선 읽습니다.
WebSquare면 데이터셋, 그리드 모델, 전역 객체.
React면 컴포넌트 props나 실제 그리드 라이브러리 API.
Vue면 컴포넌트 state나 바인딩된 데이터.
여기서 중요한 건 React나 Vue 자체를 읽는 게 아니라, 그 위에 올라간 실제 위젯이나 페이지 모델을 읽는 겁니다. React Fiber를 범용 해법처럼 쓰는 건 장기적으로 불안정합니다.

2. 의미 계층
DOM에서 헤더, 라벨, aria 정보, 주변 제목, 카드 키-값 구조를 읽어 “이 값이 무엇인지”를 붙입니다.
지금 [extension/content/base.js](extension/content/base.js)와 [extension/content/adapters/dom-structure.js](extension/content/adapters/dom-structure.js)가 이 역할의 씨앗입니다.

3. 정규화 계층
수집한 값들을 ScreenContext로 바꾸되, 단순히 값만 넣지 말고 출처와 신뢰도를 같이 넣는 쪽이 좋습니다.
예를 들면 이런 메타가 있으면 좋습니다.

sourceKind: dataLayer, domHeader, aria, inferred
sourcePath: window.GRID.rows[3].contract
sourceSelector: .summary-table th:nth-child(2)
confidence: 0.95

이게 있으면 LLM도 더 잘 쓰고, 디버깅도 쉬워집니다.

4. LLM 보조 계층
여기서만 LLM을 씁니다.
역할은 추출이 아니라 정리입니다.
예를 들면:
- label이 약간 불규칙한 컬럼명 표준화
- 카드와 표를 묶어 “이 화면의 주요 엔터티” 요약
- 차트 시리즈 이름 보정
- 신규 도메인 화면에 대한 recipe 초안 제안

이 방향이 좋은 이유는, 추출 실패를 LLM으로 메우지 않고, 추출 결과의 의미를 LLM으로 강화하기 때문입니다.

프레임워크별로 보면 난이도와 전략이 다릅니다.

WebSquare
가장 유망합니다. 이유는 보통 데이터모델이 비교적 명시적이기 때문입니다. DOM만 긁지 말고 MAIN world에서 데이터셋과 그리드 정의를 읽는 쪽이 맞습니다. 이 프로젝트에서 제일 먼저 실전 성과가 나기 쉬운 대상입니다.

React
주의가 필요합니다. “React 앱이니까 React에서 읽자”는 접근은 흔히 실패합니다. 실제로는 React 위에 AG Grid, MUI DataGrid, TanStack Table, 사내 커스텀 그리드가 올라갑니다. 즉 React 공통 어댑터보다 “위젯 어댑터”가 더 중요합니다. React Fiber는 보조 신호 정도로만 쓰는 게 좋습니다.

Vue
React와 비슷합니다. Vue 자체보다 실제 그리드와 차트 컴포넌트가 더 중요합니다. Vue 인스턴스 내부를 일반화해서 읽는 것보다, 페이지 전역이나 위젯 API를 찾는 쪽이 유지보수성이 낫습니다.

그래서 범용성의 진짜 단위는 프레임워크가 아니라 아래 셋입니다.

1. 표 계열
HTML table, AG Grid, Handsontable, 커스텀 div grid
2. 카드 계열
label-value 반복 블록, 상세 패널, 요약 KPI
3. 차트 계열
Chart.js, ECharts, Highcharts, SVG 기반 차트

이렇게 보면 “React 어댑터”보다 “AG Grid 리더”, “Chart.js 리더”, “ARIA grid 리더”, “key-value card 리더”가 더 강한 설계가 됩니다.

오픈 소스는 과장 없이 말하면 “이 문제를 통째로 해결하는 라이브러리”는 없습니다. 대신 부분적으로 아주 유용한 것들은 있습니다.

1. Mozilla Readability
텍스트 본문형 화면에는 좋습니다. 게시판, 공지, 문서, 보고서 본문 추출 fallback으로 유효합니다.
하지만 표나 대시보드 구조화 추출용은 아닙니다.
즉 현재 text fallback 보강용 후보입니다.

2. dom-accessibility-api
이건 꽤 좋습니다. aria-label, accessible name, description 계산에 강합니다.
헤더가 약한 커스텀 UI나 버튼형 필터, 라벨이 시각적으로만 흩어진 UI에서 시맨틱 이름을 복원하는 데 도움이 됩니다.
generic extractor를 더 똑똑하게 만드는 데 잘 맞습니다.

3. JSONPath Plus
이건 recipe나 dataLayer 힌트와 잘 맞습니다.
일단 MAIN world에서 어떤 전역 객체나 상태 객체를 확보한 뒤, 그 안에서 선언적으로 값을 찾는 데 좋습니다.
특히 recipe의 dataLayer.path가 커지면 단순 점 표기보다 JSONPath가 더 유연해질 수 있습니다.
다만 이것도 “객체를 찾은 뒤”에 유용한 도구입니다. 객체를 찾아주는 건 아닙니다.

반대로 너무 기대하지 않는 게 좋은 것도 있습니다.

1. React DevTools 내부 훅 의존
가능은 하지만 안정성이 약합니다. 제품 핵심 추출 경로로 삼기엔 위험합니다.

2. 범용 DOM-to-JSON 라이브러리
대부분 시맨틱을 잘 못 만듭니다. 결국 라벨-값 관계와 표 구조를 다시 해석해야 합니다.

3. LLM으로 DOM 전체 해석
비용, 속도, 개인정보, 재현성 면에서 주 경로로는 부적합합니다.

제가 보기에 이 프로젝트의 다음 수준을 만들려면 가장 중요한 개선은 두 가지입니다.

1. 공통 계약을 조금 더 풍부하게 만들기
지금 [server/schemas.py](server/schemas.py)는 깔끔하지만, LLM 친화성까지 고려하면 provenance와 confidence가 추가되면 좋습니다.
이건 모델 성능보다 운영 안정성에 더 크게 기여합니다.

2. 프레임워크 어댑터보다 위젯 어댑터 우선순위로 재편하기
WebSquare, React, Vue를 1차 축으로 보지 말고:
- dataLayer global reader
- grid reader
- chart reader
- card reader
- article/text reader
이렇게 두고, 각 프레임워크는 그 리더에 힌트를 주는 방식이 더 맞습니다.

제 결론은 명확합니다.
현재 구조는 확장 가능한 출발점입니다. 하지만 진짜 범용성을 얻으려면 “프레임워크 어댑터” 중심 사고에서 “데이터 위젯 + 의미 정규화 + provenance” 중심 사고로 옮겨가야 합니다. LLM은 그 위에서 시맨틱 보정과 운영 보조를 맡는 게 가장 효율적입니다.

같이 다음 단계로 논의한다면, 저는 이 셋 중 하나를 바로 구체화하는 게 좋다고 봅니다.

1. ScreenContext를 LLM 친화적으로 확장하는 스키마 초안 만들기
2. WebSquare, React, Vue를 공통으로 다루는 위젯 중심 어댑터 설계안 만들기
3. 실제 도입할 오픈 소스 후보를 선정하고, 무엇을 어디에 붙일지 기술 검토안 만들기