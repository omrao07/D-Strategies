# backend/core/config.py
"""
Pydantic-based settings loaded from environment variables.
All config should be accessed via `settings` singleton.
"""
from __future__ import annotations

import os
from typing import List, Optional

try:
    from pydantic import Field
    from pydantic_settings import BaseSettings  # pydantic v2
    _HAVE_PYDANTIC = True
except ImportError:
    try:
        from pydantic import BaseSettings, Field  # pydantic v1
        _HAVE_PYDANTIC = True
    except ImportError:
        _HAVE_PYDANTIC = False


if _HAVE_PYDANTIC:
    class Settings(BaseSettings):
        # App
        app_name: str = Field("D-Strategies", env="APP_NAME")
        app_env: str = Field("development", env="APP_ENV")
        debug: bool = Field(False, env="DEBUG")
        log_level: str = Field("INFO", env="LOG_LEVEL")

        # Redis
        redis_host: str = Field("localhost", env="REDIS_HOST")
        redis_port: int = Field(6379, env="REDIS_PORT")
        redis_db: int = Field(0, env="REDIS_DB")
        redis_password: Optional[str] = Field(None, env="REDIS_PASSWORD")

        # TimescaleDB / Postgres
        db_host: str = Field("localhost", env="DB_HOST")
        db_port: int = Field(5432, env="DB_PORT")
        db_name: str = Field("dstrategies", env="DB_NAME")
        db_user: str = Field("postgres", env="DB_USER")
        db_password: str = Field("", env="DB_PASSWORD")

        # FastAPI
        api_host: str = Field("0.0.0.0", env="API_HOST")
        api_port: int = Field(8000, env="API_PORT")
        api_secret_key: str = Field("changeme", env="API_SECRET_KEY")
        allowed_origins: List[str] = Field(default_factory=lambda: ["http://localhost:3000"], env="ALLOWED_ORIGINS")

        # Broker credentials
        zerodha_api_key: Optional[str] = Field(None, env="ZERODHA_API_KEY")
        zerodha_api_secret: Optional[str] = Field(None, env="ZERODHA_API_SECRET")
        ibkr_host: str = Field("127.0.0.1", env="IBKR_HOST")
        ibkr_port: int = Field(7497, env="IBKR_PORT")
        paper_mode: bool = Field(True, env="PAPER_MODE")

        # Risk
        capital_base: float = Field(1_000_000.0, env="CAPITAL_BASE")
        daily_loss_limit_pct: float = Field(2.0, env="DAILY_LOSS_LIMIT_PCT")
        drawdown_limit_pct: float = Field(10.0, env="DRAWDOWN_LIMIT_PCT")
        max_position_pct: float = Field(5.0, env="MAX_POSITION_PCT")
        vix_halt_threshold: float = Field(30.0, env="VIX_HALT_THRESHOLD")

        # Notifications
        telegram_bot_token: Optional[str] = Field(None, env="TELEGRAM_BOT_TOKEN")
        telegram_chat_id: Optional[str] = Field(None, env="TELEGRAM_CHAT_ID")
        smtp_host: str = Field("smtp.gmail.com", env="SMTP_HOST")
        smtp_port: int = Field(587, env="SMTP_PORT")
        smtp_user: Optional[str] = Field(None, env="SMTP_USER")
        smtp_pass: Optional[str] = Field(None, env="SMTP_PASS")
        report_to: Optional[str] = Field(None, env="REPORT_TO")
        slack_webhook_url: Optional[str] = Field(None, env="SLACK_WEBHOOK_URL")

        # Data feeds
        alpha_vantage_key: Optional[str] = Field(None, env="ALPHA_VANTAGE_KEY")
        polygon_key: Optional[str] = Field(None, env="POLYGON_KEY")
        nse_data_path: str = Field("/data/nse", env="NSE_DATA_PATH")

        class Config:
            env_file = ".env"
            env_file_encoding = "utf-8"
            case_sensitive = False

    settings = Settings()

else:
    # Fallback: plain dict-like object reading from env directly
    class _FallbackSettings:
        def __getattr__(self, name: str):
            return os.getenv(name.upper(), "")

    settings = _FallbackSettings()  # type: ignore
