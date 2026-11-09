"""Minimal Deepdock /v1 client. Depends on httpx only (Python 3.9+).

It does the four things the OpenAPI document cannot tell you: the bearer header, the envelope
unwrap, the Idempotency-Key header with replay detection, and a typed error carrying the code.
Everything action-specific (fields, types, patterns) comes from the live OpenAPI document.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, TypeVar, Union
from urllib.parse import quote, unquote

import httpx

# A flat JSON value as the action's schema declares it: a number is a number, never its text.
InputValue = Union[str, int, float, bool]
T = TypeVar("T")


class DeepdockError(Exception):
    """Deepdock answered `{ "error": { "code", ... } }`. Switch on `code`, never on `message`."""

    def __init__(self, status: int, code: str, message: str, request_id: Optional[str] = None,
                 systems: Optional[List[str]] = None, created: Optional[Dict[str, Any]] = None,
                 uncertain: Optional[bool] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.systems = systems
        self.created = created  # applied_unverified, outcome_unknown with no rollback: {"chartId"} or None
        self.retry_after: Optional[str] = None  # the Retry-After header as sent (seconds), when the answer carried one
        self.uncertain = uncertain  # outcome_unknown: True when the write may or may not have landed


MAX_RETRY_WAIT = 15.0  # longest wait between two attempts, whatever Retry-After asks for
DEFAULT_RETRY_WAIT = 1.0


def _retry_wait(header: Optional[str]) -> float:
    try:
        seconds = float(header) if header is not None else -1.0
    except ValueError:
        seconds = -1.0
    return min(seconds, MAX_RETRY_WAIT) if seconds >= 0 else DEFAULT_RETRY_WAIT


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


@dataclass
class Download:
    """A file action's answer: the bytes, the type the action declares, and the name to save it under."""
    content: bytes
    content_type: str
    filename: Optional[str]


def _filename(disposition: Optional[str]) -> Optional[str]:
    # Deepdock sends filename* (UTF-8) beside an ASCII filename; the name is already safe to save on
    # Windows, and can carry personal data (a person's name in a document title).
    if disposition is None:
        return None
    extended = re.search(r"filename\*=UTF-8''([^;]+)", disposition, re.IGNORECASE)
    if extended:
        try:
            return unquote(extended.group(1).strip(), errors="strict")
        except UnicodeDecodeError:
            pass  # a malformed escape: fall back to the ASCII name
    plain = re.search(r'filename="([^"]*)"', disposition, re.IGNORECASE)
    return plain.group(1) if plain else None


def _unwrap(r: httpx.Response) -> Tuple[Any, Optional[str]]:
    try:
        body = r.json()
    except ValueError:
        raise DeepdockTransportError(f"non-JSON answer with status {r.status_code}")
    if isinstance(body, dict) and "error" in body:
        e = body["error"]
        err = DeepdockError(r.status_code, e["code"], e["message"], e.get("requestId"), e.get("systems"),
                            e.get("created"), e.get("uncertain"))
        err.retry_after = r.headers.get("retry-after")
        raise err
    if not isinstance(body, dict) or "data" not in body:
        raise DeepdockTransportError(f"unexpected body with status {r.status_code}")
    return body["data"], body.get("nextCursor")


class Deepdock:
    def __init__(self, api_key: str, base: Optional[str] = None, timeout: float = 35.0,
                 client: Optional[httpx.Client] = None, max_attempts: int = 3, sleep=time.sleep):
        # 35 s is above the worst answer (up to 10 s for the device's slot, then up to 20 s on the
        # device), so the error code arrives before a client timeout.
        # max_attempts: attempts per call on 503 target_busy (1 turns the retry off). The same
        # request is sent again, so a write keeps its idempotency key.
        self.max_attempts = max(1, int(max_attempts))
        self._sleep = sleep
        # Default: DEEPDOCK_BASE_URL from the environment (the CLI's own variable), else production.
        base = base or os.environ.get("DEEPDOCK_BASE_URL") or "https://api.deepdock.ai"
        self.c = client or httpx.Client(base_url=base.rstrip("/"), timeout=timeout)
        self.c.headers["Authorization"] = f"Bearer {api_key}"

    def _retrying(self, once: Callable[[], T]) -> T:
        attempt = 1
        while True:
            try:
                return once()
            except DeepdockError as e:
                if attempt >= self.max_attempts or e.status != 503 or e.code != "target_busy":
                    raise
                self._sleep(_retry_wait(e.retry_after))
                attempt += 1

    def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        try:
            return self.c.request(method, path, **kw)
        except httpx.HTTPError as e:  # timeouts, network errors, and a body cut off mid-way
            raise DeepdockTransportError(f"no answer from Deepdock: {type(e).__name__}") from e

    def _send(self, method: str, path: str, **kw: Any) -> Tuple[Any, httpx.Headers, Optional[str]]:
        def once() -> Tuple[Any, httpx.Headers, Optional[str]]:
            r = self._request(method, path, **kw)
            data, next_cursor = _unwrap(r)
            return data, r.headers, next_cursor
        return self._retrying(once)

    def _download_once(self, path: str, params: Dict[str, InputValue]) -> Download:
        r = self._request("POST", path, json=params)
        if not 200 <= r.status_code < 300:
            _unwrap(r)
            raise DeepdockTransportError(f"unexpected body with status {r.status_code}")
        # Once the bytes flow, a failure can only end the body early. Content-Length counts encoded
        # bytes, so it is compared only on a body sent as is.
        declared = r.headers.get("content-length")
        encoded = r.headers.get("content-encoding", "identity") != "identity"
        if declared is not None and not encoded and int(declared) != len(r.content):
            raise DeepdockTransportError(f"download ended at {len(r.content)} of {declared} bytes")
        return Download(content=r.content,
                        content_type=r.headers.get("content-type", "application/octet-stream"),
                        filename=_filename(r.headers.get("content-disposition")))

    @staticmethod
    def _action_path(device_id: str, system: str, action: str) -> str:
        return f"/v1/devices/{quote(device_id, safe='')}/systems/{quote(system, safe='')}/actions/{quote(action, safe='')}"

    def read(self, device_id: str, system: str, action: str, params: Dict[str, InputValue],
             limit: Optional[int] = None, cursor: Optional[str] = None) -> Page:
        """Runs a read action with `cardinality: many`: a POST whose JSON body holds the inputs and the paging fields, no
        Idempotency-Key. Pass `next_cursor` back as `cursor` for the next page."""
        body: Dict[str, InputValue] = dict(params)
        if limit is not None:
            body["limit"] = limit
        if cursor is not None:
            body["cursor"] = cursor
        data, _, next_cursor = self._send("POST", self._action_path(device_id, system, action), json=body)
        return Page(items=data, next_cursor=next_cursor)

    def read_one(self, device_id: str, system: str, action: str, params: Dict[str, InputValue]) -> Dict[str, Any]:
        """Runs a single-record read (`cardinality: one`): the answer's `data` is the record itself.
        A record that does not exist raises DeepdockError with status 404 and code "not_found"."""
        data, _, _ = self._send("POST", self._action_path(device_id, system, action), json=params)
        return data

    def read_all(self, device_id: str, system: str, action: str, params: Dict[str, InputValue],
                 limit: Optional[int] = None) -> Iterator[Dict[str, Any]]:
        """Reads every page of a read action, in order."""
        cursor: Optional[str] = None
        while True:
            page = self.read(device_id, system, action, params, limit=limit, cursor=cursor)
            yield from page.items
            if page.next_cursor is None:
                return
            cursor = page.next_cursor

    def download(self, device_id: str, system: str, action: str, params: Dict[str, InputValue]) -> Download:
        """Runs a file action (`file: true` in the action index): a POST like a read, answered with the file's
        bytes instead of JSON. A refusal raises DeepdockError as for any action; a body that ends short of its
        Content-Length raises DeepdockTransportError, and the download can be run again. The client's timeout
        applies between bytes, so a large file streams as long as it keeps moving."""
        return self._retrying(lambda: self._download_once(self._action_path(device_id, system, action), params))

    def write(self, device_id: str, system: str, action: str, operation: str, idempotency_key: str,
              body: Dict[str, InputValue]) -> WriteResult:
        """Runs a write action: POST for operation "create", PATCH for "update" (from the action index; any
        other method answers 405 with `Allow` naming the right one). `body` values are typed as the
        action's schema declares. Any other `operation` raises ValueError before anything is sent."""
        if operation not in ("create", "update"):
            raise ValueError(f"operation must be 'create' or 'update', got {operation!r}")
        data, headers, _ = self._send("PATCH" if operation == "update" else "POST",
                                   self._action_path(device_id, system, action), json=body,
                                   headers={"Idempotency-Key": idempotency_key})
        return WriteResult(data=data, replayed=headers.get("Idempotent-Replayed") == "true")

    def systems(self, device_id: str) -> List[Dict[str, Any]]:
        """The device's systems and each action's state. A live call: can answer device_offline."""
        data, _, _ = self._send("GET", f"/v1/devices/{quote(device_id, safe='')}/systems")
        return data

    def pair(self, code: str, label: Optional[str] = None) -> Dict[str, Any]:
        """Pairs a device by the pairing code it shows. Keep the returned `id`."""
        body: Dict[str, str] = {"code": code}
        if label is not None:
            body["label"] = label
        data, _, _ = self._send("POST", "/v1/devices", json=body)
        return data

    def release(self, device_id: str) -> None:
        self._send("DELETE", f"/v1/devices/{quote(device_id, safe='')}")


# --------------------------------------------------------------------------------------------------
# Pending writes: one attempt against persisted state. Persist the row BEFORE the first send, so a
# crash between send and answer cannot produce a second record under a new key. A job retries rows
# left in "sent" with backoff (seconds, then minutes, for hours if the device stays offline).
# For device_outdated, poll the device's `outdated` and `blockedActions` before retrying: it takes longer than minutes.
# version_not_covered is not retried: Deepdock has to approve the installed version first.
# --------------------------------------------------------------------------------------------------

CONFLICT_RETRIES = 5  # a running write finishes within seconds; beyond this, treat it as unknown

RETRY_SAME_KEY = {"device_offline", "device_syncing", "device_outdated",
                  "target_busy", "temporarily_unavailable", "internal_error", "action_paused",
                  "system_unavailable"}


@dataclass
class PendingWrite:
    key: str  # 8 to 128 chars of A-Z a-z 0-9 _ -, stable per business event
    device_id: str
    system: str
    action: str
    operation: str  # create | update, from the action index
    input: Dict[str, InputValue]
    status: str = "pending"  # pending | sent | done | unknown | refused
    conflict_retries: int = 0
    result: Optional[Dict[str, Any]] = field(default=None)
    request_id: Optional[str] = None
    refused_code: Optional[str] = None


def attempt(dd: Deepdock, row: PendingWrite) -> PendingWrite:
    """One attempt; returns the row with its new status. The caller persists it."""
    try:
        res = dd.write(row.device_id, row.system, row.action, row.operation, row.key, row.input)
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
        # applied_unverified: the entry exists but was not verified; never write it again under a new
        # key. result["created"] names it for the check.
        if e.code in ("outcome_unknown", "applied_unverified"):
            return replace(row, status="unknown", request_id=e.request_id,
                           result={"created": e.created, "uncertain": e.uncertain})
        # invalid_input, target_rejected, action-specific 422s, not_found, readback_failed, auth and
        # resolution codes: nothing was written. Fix the cause; a changed input gets a new key.
        return replace(row, status="refused", refused_code=e.code, result={"message": str(e)})
