"""Minimal Deepdock /v1 client. Depends on httpx only (Python 3.9+).

It does the four things the OpenAPI document cannot tell you: the bearer header, the envelope
unwrap, the Idempotency-Key header with replay detection, and a typed error carrying the code.
Everything action-specific (paths, fields, methods) comes from the live OpenAPI document.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Any, Dict, Iterator, List, Optional, Tuple
from urllib.parse import quote

import httpx


class DeepdockError(Exception):
    """Deepdock answered `{ "error": { "code", ... } }`. Switch on `code`, never on `message`."""

    def __init__(self, status: int, code: str, message: str, request_id: Optional[str] = None,
                 systems: Optional[List[str]] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.systems = systems


class DeepdockTransportError(Exception):
    """No answer, or not Deepdock's envelope (timeout, network, a proxy page): a write may still have landed."""


@dataclass
class Page:
    items: List[Dict[str, Any]]
    next_cursor: Optional[str]


@dataclass
class WriteResult:
    data: Dict[str, Any]
    replayed: bool


class Deepdock:
    def __init__(self, api_key: str, base: Optional[str] = None, timeout: float = 30.0,
                 client: Optional[httpx.Client] = None):
        # 30 s is above Deepdock's 20 s device wait, so device_offline arrives before a client timeout.
        # Default: DEEPDOCK_BASE_URL from the environment (the CLI's own variable), else production.
        base = base or os.environ.get("DEEPDOCK_BASE_URL") or "https://api.deepdock.ai"
        self.c = client or httpx.Client(base_url=base.rstrip("/"), timeout=timeout)
        self.c.headers["Authorization"] = f"Bearer {api_key}"

    def _send(self, method: str, path: str, **kw: Any) -> Tuple[Any, httpx.Headers]:
        try:
            r = self.c.request(method, path, **kw)
        except httpx.HTTPError as e:  # timeouts and network errors
            raise DeepdockTransportError(f"no answer from Deepdock: {type(e).__name__}") from e
        try:
            body = r.json()
        except ValueError:
            raise DeepdockTransportError(f"non-JSON answer with status {r.status_code}")
        if isinstance(body, dict) and "error" in body:
            e = body["error"]
            raise DeepdockError(r.status_code, e["code"], e["message"], e.get("requestId"), e.get("systems"))
        if not isinstance(body, dict) or "data" not in body:
            raise DeepdockTransportError(f"unexpected body with status {r.status_code}")
        return body["data"], r.headers

    @staticmethod
    def _action_path(device_id: str, system: str, action: str) -> str:
        return f"/v1/devices/{quote(device_id, safe='')}/systems/{quote(system, safe='')}/actions/{quote(action, safe='')}"

    def read(self, device_id: str, system: str, action: str, params: Dict[str, str],
             limit: Optional[int] = None, cursor: Optional[str] = None) -> Page:
        """Runs a read action. Pass `next_cursor` back as `cursor` for the next page."""
        query: Dict[str, str] = dict(params)
        if limit is not None:
            query["limit"] = str(limit)
        if cursor is not None:
            query["cursor"] = cursor
        data, _ = self._send("GET", self._action_path(device_id, system, action), params=query)
        return Page(items=data["items"], next_cursor=data.get("nextCursor"))

    def read_all(self, device_id: str, system: str, action: str, params: Dict[str, str],
                 limit: Optional[int] = None) -> Iterator[Dict[str, Any]]:
        """Reads every page of a read action, in order."""
        cursor: Optional[str] = None
        while True:
            page = self.read(device_id, system, action, params, limit=limit, cursor=cursor)
            yield from page.items
            if page.next_cursor is None:
                return
            cursor = page.next_cursor

    def write(self, device_id: str, system: str, action: str, method: str, idempotency_key: str,
              body: Dict[str, str]) -> WriteResult:
        """Runs a write action. `method` is POST or PATCH from the action index; `body` values are all strings."""
        data, headers = self._send(method, self._action_path(device_id, system, action), json=body,
                                   headers={"Idempotency-Key": idempotency_key})
        return WriteResult(data=data, replayed=headers.get("Idempotent-Replayed") == "true")

    def systems(self, device_id: str) -> List[Dict[str, Any]]:
        """The device's systems and each action's state. A live call: can answer device_offline."""
        data, _ = self._send("GET", f"/v1/devices/{quote(device_id, safe='')}/systems")
        return data

    def pair(self, code: str, label: Optional[str] = None) -> Dict[str, Any]:
        """Claims a device by the pairing code it shows. Keep the returned `id`."""
        body: Dict[str, str] = {"code": code}
        if label is not None:
            body["label"] = label
        data, _ = self._send("POST", "/v1/devices", json=body)
        return data

    def release(self, device_id: str) -> None:
        self._send("DELETE", f"/v1/devices/{quote(device_id, safe='')}")


# --------------------------------------------------------------------------------------------------
# Pending writes: one attempt against persisted state. Persist the row BEFORE the first send, so a
# crash between send and answer cannot produce a second record under a new key. A job retries rows
# left in "sent" with backoff (seconds, then minutes, for hours if the device stays offline).
# --------------------------------------------------------------------------------------------------

CONFLICT_RETRIES = 5  # a running write finishes within seconds; beyond this, treat it as unknown

RETRY_SAME_KEY = {"device_offline", "target_busy", "temporarily_unavailable", "internal_error",
                  "action_paused", "system_unavailable"}


@dataclass
class PendingWrite:
    key: str  # 8 to 128 chars of A-Z a-z 0-9 _ -, stable per business event
    device_id: str
    system: str
    action: str
    method: str
    input: Dict[str, str]
    status: str = "pending"  # pending | sent | done | unknown | refused
    conflict_retries: int = 0
    result: Optional[Dict[str, Any]] = field(default=None)
    request_id: Optional[str] = None
    refused_code: Optional[str] = None


def attempt(dd: Deepdock, row: PendingWrite) -> PendingWrite:
    """One attempt; returns the row with its new status. The caller persists it."""
    try:
        res = dd.write(row.device_id, row.system, row.action, row.method, row.key, row.input)
        return replace(row, status="done", result=res.data)
    except DeepdockTransportError:
        return replace(row, status="sent")
    except DeepdockError as e:
        if e.code in RETRY_SAME_KEY:
            return replace(row, status="sent", request_id=e.request_id)
        if e.code == "idempotency_conflict":
            if row.conflict_retries < CONFLICT_RETRIES:
                return replace(row, status="sent", conflict_retries=row.conflict_retries + 1)
            return replace(row, status="unknown")
        if e.code == "outcome_unknown":
            return replace(row, status="unknown", request_id=e.request_id)
        # invalid_input, target_rejected, action-specific 422s, not_found, check_failed, auth and
        # resolution codes: nothing was written. Fix the cause; a changed input gets a new key.
        return replace(row, status="refused", refused_code=e.code, result={"message": str(e)})
