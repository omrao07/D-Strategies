"""
registrybridge.py

Registry bridge for external data features.
Registers datasets, features, schemas, and lineage metadata
produced by the preprocessor into a central registry.

Design goals:
- Deterministic IDs
- Idempotent registration
- Pluggable backend (file / HTTP / DB)
- No engine coupling
"""

from __future__ import annotations

import json
import hashlib
import os
from typing import Dict, List, Any, Iterable, Optional
from datetime import datetime, timezone


# ============================
# Types
# ============================

FeatureRow = Dict[str, Any]
RegistryObject = Dict[str, Any]


# ============================
# Utilities
# ============================

def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def stable_id(*parts: str) -> str:
    """
    Deterministic hash-based ID.
    """
    h = hashlib.sha256("::".join(parts).encode("utf-8")).hexdigest()
    return h[:32]


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


# ============================
# Registry Backend
# ============================

class RegistryBackend:
    """
    Abstract registry backend.
    """

    def upsert(self, kind: str, obj: RegistryObject) -> None:
        raise NotImplementedError

    def exists(self, kind: str, obj_id: str) -> bool:
        raise NotImplementedError


class FileRegistryBackend(RegistryBackend):
    """
    Simple file-backed registry (JSON).
    """

    def __init__(self, root: str = "registry"):
        self.root = root
        ensure_dir(root)

    def _path(self, kind: str, obj_id: str) -> str:
        return os.path.join(self.root, kind, f"{obj_id}.json")

    def exists(self, kind: str, obj_id: str) -> bool:
        return os.path.exists(self._path(kind, obj_id))

    def upsert(self, kind: str, obj: RegistryObject) -> None:
        ensure_dir(os.path.join(self.root, kind))
        path = self._path(kind, obj["id"])
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, sort_keys=True)


# ============================
# Registry Bridge
# ============================

class RegistryBridge:
    """
    Registers features and datasets into the registry.
    """

    def __init__(self, backend: RegistryBackend):
        self.backend = backend

    # ------------------------
    # Dataset Registration
    # ------------------------

    def register_dataset(
        self,
        *,
        region: str,
        source: str,
        metric: str,
    ) -> str:
        dataset_id = stable_id("dataset", region, source, metric)

        if self.backend.exists("datasets", dataset_id):
            return dataset_id

        obj = {
            "id": dataset_id,
            "type": "dataset",
            "region": region,
            "source": source,
            "metric": metric,
            "created_at": utc_now(),
        }

        self.backend.upsert("datasets", obj)
        return dataset_id

    # ------------------------
    # Feature Registration
    # ------------------------

    def register_feature(self, row: FeatureRow) -> str:
        """
        Register a single feature definition (not the value).
        """
        region = row["region"]
        metric = row["metric"]
        window = str(row.get("window", "raw"))
        source = row["source"]

        feature_id = stable_id("feature", region, metric, window, source)

        if self.backend.exists("features", feature_id):
            return feature_id

        obj = {
            "id": feature_id,
            "type": "feature",
            "name": f"{metric}_w{window}",
            "region": region,
            "metric": metric,
            "window": window,
            "source": source,
            "schema": {
                "value": "float",
                "mean": "float",
                "std": "float",
                "z": "float",
                "diff": "float",
                "ts": "int",
            },
            "created_at": utc_now(),
        }

        self.backend.upsert("features", obj)
        return feature_id

    # ------------------------
    # Lineage Registration
    # ------------------------

    def register_lineage(
        self,
        *,
        dataset_id: str,
        feature_id: str,
    ) -> None:
        lineage_id = stable_id("lineage", dataset_id, feature_id)

        if self.backend.exists("lineage", lineage_id):
            return

        obj = {
            "id": lineage_id,
            "type": "lineage",
            "dataset_id": dataset_id,
            "feature_id": feature_id,
            "created_at": utc_now(),
        }

        self.backend.upsert("lineage", obj)

    # ------------------------
    # Bulk Registration
    # ------------------------

    def register_features_from_rows(
        self,
        rows: Iterable[FeatureRow],
    ) -> None:
        """
        Idempotent bulk registration from preprocessor output.
        """
        for r in rows:
            dataset_id = self.register_dataset(
                region=r["region"],
                source=r["source"],
                metric=r["metric"],
            )
            feature_id = self.register_feature(r)
            self.register_lineage(
                dataset_id=dataset_id,
                feature_id=feature_id,
            )


# ============================
# Example Usage
# ============================

if __name__ == "__main__":
    backend = FileRegistryBackend(root="registry")
    bridge = RegistryBridge(backend)

    sample_features = [
        {
            "region": "US",
            "metric": "CPI",
            "window": 12,
            "value": 305.6,
            "mean": 304.9,
            "std": 0.42,
            "z": 1.66,
            "diff": 0.5,
            "ts": 1700086400000,
            "source": "fred",
        },
        {
            "region": "CNHK",
            "metric": "FX_USD_CNY",
            "window": 5,
            "value": 7.12,
            "mean": 7.10,
            "std": 0.02,
            "z": 1.0,
            "diff": 0.01,
            "ts": 1700086400000,
            "source": "fx",
        },
    ]

    bridge.register_features_from_rows(sample_features)