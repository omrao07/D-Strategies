import logging
from pathlib import Path
from typing import Optional


def setup_logging(
    name: str = "app",
    level: int = logging.INFO,
    log_dir: Optional[str | Path] = None,
) -> logging.Logger:

    logger = logging.getLogger(name)
    logger.setLevel(level)

    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    if not logger.handlers:
        sh = logging.StreamHandler()
        sh.setFormatter(formatter)
        logger.addHandler(sh)

        if log_dir:
            log_dir = Path(log_dir)
            log_dir.mkdir(parents=True, exist_ok=True)
            fh = logging.FileHandler(log_dir / f"{name}.log", mode="a")
            fh.setFormatter(formatter)
            logger.addHandler(fh)

    return logger