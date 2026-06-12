"""
Lazy Redis client factory. Import `get_redis` or use the `LazyRedis` proxy
so that module-level imports don't attempt a TCP connection at import time.
"""
from __future__ import annotations

import os
from typing import Optional

_REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
_REDIS_SSL = os.getenv("REDIS_SSL", "").lower() in ("1", "true", "yes")


class LazyRedis:
    """Proxy that defers redis.Redis() construction until the first method call."""

    def __init__(
        self,
        host: str = _REDIS_HOST,
        port: int = _REDIS_PORT,
        decode_responses: bool = True,
        ssl: Optional[bool] = None,
    ) -> None:
        self._host = host
        self._port = port
        self._decode_responses = decode_responses
        self._ssl = _REDIS_SSL if ssl is None else ssl
        self._client = None

    def _get(self):
        if self._client is None:
            import redis as _redis
            kwargs = dict(
                host=self._host,
                port=self._port,
                password=os.getenv("REDIS_PASSWORD") or None,
                decode_responses=self._decode_responses,
            )
            if self._ssl:
                kwargs["ssl"] = True
                ca = os.getenv("REDIS_SSL_CA_CERTS")
                if ca:
                    kwargs["ssl_ca_certs"] = ca
            self._client = _redis.Redis(**kwargs)
        return self._client

    def __getattr__(self, name: str):
        return getattr(self._get(), name)


def get_redis(
    host: Optional[str] = None,
    port: Optional[int] = None,
    decode_responses: bool = True,
    ssl: Optional[bool] = None,
) -> LazyRedis:
    return LazyRedis(
        host=host or _REDIS_HOST,
        port=port or _REDIS_PORT,
        decode_responses=decode_responses,
        ssl=ssl,
    )
