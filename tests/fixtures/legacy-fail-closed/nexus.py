# Regression fixture: exact immediate fail-closed guard extracted from the archived reviewed source.
def _live_dispatch(wire_execute, grant: dict, action_id: str, payload: dict, wasm_bytes: bytes, entry: str, token: dict) -> dict:
    """Never retry/fallback through an uncertain legacy transport."""
    raise RuntimeError('Legacy live dispatch disabled pending qualified Effect Controller migration')
