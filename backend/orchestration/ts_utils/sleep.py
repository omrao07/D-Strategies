import time
from typing import Union


def sleep_secs(seconds: Union[int, float]) -> None:
    """
    Sleep for the given number of seconds.

    Accepts int or float.
    Guards against negative values.
    """
    if seconds <= 0:
        return

    time.sleep(seconds)