# backend/ingestion/__init__.py
# Streaming adapters are instantiated individually — no top-level re-exports
# to avoid pulling in heavy websocket dependencies at import time.
# Import directly from backend.ingestion.adapters.<name> as needed.
