import json
from pathlib import Path
from typing import Any, Dict


def load_yaml_or_json(path: str | Path) -> Dict[str, Any]:
    path = Path(path)

    if not path.exists():
        return {}

    if path.suffix.lower() in {".yaml", ".yml"}:
        import yaml
        with path.open("r") as f:
            return yaml.safe_load(f) or {}

    if path.suffix.lower() == ".json":
        with path.open("r") as f:
            return json.load(f)

    raise ValueError(f"Unsupported config format: {path}")