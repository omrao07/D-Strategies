# backend/core/retry.py
"""
Exponential backoff retry decorator and async variant.
"""
from __future__ import annotations

import functools
import logging
import time
from typing import Callable, Optional, Tuple, Type, TypeVar

log = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable)


def retry(
    max_attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,),
    on_retry: Optional[Callable[[int, Exception], None]] = None,
) -> Callable[[F], F]:
    """
    Synchronous retry decorator with exponential backoff.

    Usage:
        @retry(max_attempts=5, delay=0.5, exceptions=(ConnectionError,))
        def fetch_data(): ...
    """
    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            wait = delay
            last_exc: Optional[Exception] = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt == max_attempts:
                        raise
                    if on_retry:
                        on_retry(attempt, exc)
                    else:
                        log.warning(
                            "%s attempt %d/%d failed (%s); retrying in %.1fs",
                            fn.__name__, attempt, max_attempts, exc, wait,
                        )
                    time.sleep(wait)
                    wait = min(wait * backoff, 60.0)
            raise last_exc  # type: ignore
        return wrapper  # type: ignore
    return decorator


def retry_async(
    max_attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,),
) -> Callable[[F], F]:
    """
    Async retry decorator with exponential backoff.

    Usage:
        @retry_async(max_attempts=3)
        async def fetch_price(): ...
    """
    import asyncio

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            wait = delay
            last_exc: Optional[Exception] = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return await fn(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt == max_attempts:
                        raise
                    log.warning(
                        "%s async attempt %d/%d failed (%s); retrying in %.1fs",
                        fn.__name__, attempt, max_attempts, exc, wait,
                    )
                    await asyncio.sleep(wait)
                    wait = min(wait * backoff, 60.0)
            raise last_exc  # type: ignore
        return wrapper  # type: ignore
    return decorator


def with_timeout(seconds: float) -> Callable[[F], F]:
    """
    Decorator that raises TimeoutError if function takes longer than `seconds`.
    Uses threading for synchronous functions.
    """
    import threading

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            result = [None]
            exc_holder = [None]

            def target():
                try:
                    result[0] = fn(*args, **kwargs)
                except Exception as e:
                    exc_holder[0] = e

            t = threading.Thread(target=target, daemon=True)
            t.start()
            t.join(timeout=seconds)
            if t.is_alive():
                raise TimeoutError(f"{fn.__name__} timed out after {seconds}s")
            if exc_holder[0]:
                raise exc_holder[0]
            return result[0]
        return wrapper  # type: ignore
    return decorator
