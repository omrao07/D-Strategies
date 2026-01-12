import time


def utc_now_ts() -> int:
    """
    Return the current UTC timestamp in seconds (Unix epoch).
    """
    return int(time.time())