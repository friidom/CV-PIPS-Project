"""The demo rejects clips longer than DEMO_MAX_DURATION_SEC; 0 turns the limit off."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_duration_limit_and_zero_disables_it(monkeypatch):
    from fastapi import HTTPException

    import server.app as demo

    monkeypatch.setattr(demo, "MAX_DURATION_SEC", 120.0)
    demo._check_duration(120.0)
    with pytest.raises(HTTPException) as err:
        demo._check_duration(121.0)
    assert err.value.status_code == 413 and "up to 120 s" in err.value.detail

    monkeypatch.setattr(demo, "MAX_DURATION_SEC", 0.0)
    demo._check_duration(10_000.0)
