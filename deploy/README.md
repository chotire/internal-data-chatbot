# 사내 자동 배포 가이드 (크롬/사내 스토어 없이)

엔터프라이즈 정책 + 자체 호스팅으로 익스텐션을 **사용자 동작 없이 자동 설치**하는 절차.
관리 대상(GPO/MDM 등록) 크롬에서 동작한다.

```
extension/  --(pack)-->  udc-x.y.z.crx (+ udc.pem 서명키)
                              │ 사내 HTTPS 업로드
                              ▼
   https://intranet/udc/udc-x.y.z.crx   +   update.xml
                              │ 정책으로 가리킴
                              ▼
   ExtensionInstallForcelist = "<ID>;https://intranet/udc/update.xml"
                              ▼
   관리 대상 크롬이 자동 다운로드·설치 (삭제 불가, 자동 업데이트)
```

## 1. 익스텐션 ID 고정 (선택이지만 권장)
ID는 서명키에서 결정된다. dev(압축해제)와 배포(.crx) ID를 일치시키려면 `manifest.json` 에 공개키를 박는다.

```bash
# 1) 키쌍 생성 (이 .pem 은 서명키 — 절대 커밋/유출 금지, 안전 보관)
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out udc.pem

# 2) manifest 에 넣을 base64 공개키 추출
openssl rsa -in udc.pem -pubout -outform DER 2>/dev/null | openssl base64 -A; echo

# 3) manifest.json 에 "key": "<위 base64>" 추가
# 4) ID 계산(참고): 공개키 DER 의 SHA256 앞 16바이트를 a~p 로 매핑한 32자
```
> `.pem` 은 .gitignore 에 포함되어 있다(서명·ID의 신뢰 기반). **분실 시 동일 ID로 업데이트 불가**하므로 안전하게 백업.

## 2. .crx 패키징
- GUI: `chrome://extensions` → "확장 프로그램 패키징" → 루트=`extension/`, 키=`udc.pem`(2회차부터)
- CLI:
  ```bash
  google-chrome --pack-extension="$(pwd)/extension" --pack-extension-key="$(pwd)/udc.pem"
  # → extension.crx 생성 → udc-0.2.0.crx 로 리네임
  ```

## 3. 사내 HTTPS 호스팅
`udc-0.2.0.crx` 와 `update.xml`(이 폴더의 템플릿) 을 인트라넷 HTTPS 에 올린다.
`update.xml` 의 `appid`(=ID), `codebase`(=.crx URL), `version`(=manifest version) 을 실제 값으로 채운다.
> 정적 파일 서버면 충분. `.crx` 의 MIME 은 `application/x-chrome-extension` 권장(아니어도 대개 동작).

## 4. 정책 배포 (`ExtensionInstallForcelist`)
값 형식: `"<EXTENSION_ID>;<update.xml 의 절대 URL>"`

| 플랫폼 | 방법 |
|---|---|
| **Windows** | GPO: 컴퓨터 구성 → 관리 템플릿 → Google Chrome → 확장 프로그램 → "강제 설치 목록". 또는 `policies/windows/udc.reg` |
| **Linux** | `policies/linux/udc.json` → `/etc/opt/chrome/policies/managed/` 에 배치 |
| **macOS** | MDM 구성 프로파일에서 `com.google.Chrome` 의 `ExtensionInstallForcelist`(배열)에 동일 문자열 |
| **Google 관리콘솔** | (Chrome Browser Cloud Management 등록 시) 앱·확장 → ID 추가 → "강제 설치" + "맞춤 URL에서 설치" |

적용 확인: 크롬에서 `chrome://policy` → `ExtensionInstallForcelist` 값 확인 → `chrome://extensions` 에
"관리자에 의해 설치됨"으로 표시되면 성공.

## 5. 업데이트
`extension/manifest.json` 의 `version` 올리고 → 새 `.crx` 빌드·업로드 → `update.xml` 의 `version`/`codebase` 갱신.
크롬이 주기적으로 `update.xml` 을 확인해 자동 업데이트한다(사용자 동작 없음).

## 주의
- 위 자동 설치는 **관리 대상(정책이 적용되는) 크롬**에서만 동작한다. 개인 크롬은 정책이 없으므로 수동 로드.
- 익스텐션이 사내 서버(`server/`)와 통신하므로 `manifest.json` 의 `host_permissions` 를 실제 사내 도메인으로 맞춘다.
