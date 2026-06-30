"""런타임 설정 — 타입 있는 단일 진입점 (pydantic-settings).

스프링의 `@ConfigurationProperties` 에 해당. 환경변수/`.env` 에서 읽어 타입·검증되며,
설정이 늘어나면 여기 필드만 추가하면 된다. (필요 시 YAML/TOML 소스도 얹기 쉬움)

  settings.dev_mode        UDC_DEV_MODE     개발/테스트 전용 기능 on/off (기본 off=프로덕션 안전)
  settings.openai_model    OPENAI_MODEL     사용할 OpenAI 모델
  settings.openai_api_key  OPENAI_API_KEY   OpenAI 키(서버 전용)

DEV_MODE 가 켜졌을 때만 노출/실행되는 것: 챗 UI "어떻게 답했나"·"추출 영역",
서버 응답의 trace(전체 프롬프트·페이로드), 에러 상세·트레이스백, no-store 캐시 무력화.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    dev_mode: bool = Field(default=True, validation_alias="UDC_DEV_MODE")
    openai_model: str = Field(default="gpt-4o", validation_alias="OPENAI_MODEL")
    openai_api_key: str | None = Field(default=None, validation_alias="OPENAI_API_KEY")

    # 생성 파라미터·재시도
    openai_temperature: float = Field(default=0.2, validation_alias="OPENAI_TEMPERATURE")
    max_retries: int = Field(default=2, validation_alias="UDC_MAX_RETRIES")  # 5xx 일시 오류 재시도 횟수

    # 네이티브 툴 on/off (디버깅·데모 때 개별로 끄기)
    enable_web_search: bool = Field(default=True, validation_alias="UDC_ENABLE_WEB_SEARCH")
    enable_code_interpreter: bool = Field(default=True, validation_alias="UDC_ENABLE_CODE_INTERPRETER")

    # 멀티턴 전송 시 보낼 최근 메시지 수(짝수 = N/2 쌍). 현재 chat.js SEND_HISTORY=false 라 미사용에 가까움
    history_turns: int = Field(default=8, validation_alias="UDC_HISTORY_TURNS")


# 단일 인스턴스. 코드는 `config.settings.<필드>` 로 접근(테스트는 런타임에 값 토글 가능).
settings = Settings()
