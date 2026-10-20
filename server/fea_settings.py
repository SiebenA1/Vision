"""Numerical resource settings shared by the service and isolated worker."""
import json
import os
from pathlib import Path

LOCAL_SETTINGS = Path(__file__).resolve().parent / "fea_settings.local.json"


def validate_max_elements(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("max_elements / VISION_FEA_MAX_ELEMENTS 必须是正整数")
    try:
        limit = int(value)
    except ValueError as exc:
        raise ValueError("max_elements / VISION_FEA_MAX_ELEMENTS 必须是正整数") from exc
    if limit <= 0:
        raise ValueError("max_elements / VISION_FEA_MAX_ELEMENTS 必须是正整数")
    return limit


def get_max_elements():
    value = os.environ.get("VISION_FEA_MAX_ELEMENTS")
    if value is None:
        settings = json.loads(LOCAL_SETTINGS.read_text(encoding="utf-8-sig")) if LOCAL_SETTINGS.exists() else {}
        if not isinstance(settings, dict):
            raise ValueError("fea_settings.local.json 必须是 JSON 对象")
        value = settings.get("max_elements", 1_000_000)
    return validate_max_elements(value)
