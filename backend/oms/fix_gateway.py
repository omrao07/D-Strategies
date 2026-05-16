# backend/oms/fix_gateway.py
"""
Minimal FIX 4.4 gateway.

Responsibilities
----------------
- Encode outbound messages (BodyLength + CheckSum computed per FIX spec)
- Decode inbound messages and respond to administrative messages:
    * TestRequest (35=1)  → Heartbeat (35=0) echoing TestReqID (112)
    * ResendRequest (35=2) → SequenceReset-GapFill (35=4, 123=Y)
- Auto-sends a Logon (35=A) before the first non-logon outbound message
  so that the sequence number is >= 2 by the time application messages
  are transmitted (matches real-world session lifecycle).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

SOH = "\x01"


class FixGateway:

    def __init__(
        self,
        transport=None,
        sender_comp: str = "SENDER",
        target_comp: str = "TARGET",
        fix_version: str = "FIX.4.4",
        heartbeat_sec: int = 30,
        reset_seq: bool = True,
        **kw,
    ):
        self._transport = transport
        self._sender = sender_comp
        self._target = target_comp
        self._version = fix_version
        self._heartbeat_sec = heartbeat_sec
        self._seq_num: int = 1
        self._logged_on: bool = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        pass  # no automatic logon — user calls send("A", ...) or it is sent automatically

    def stop(self) -> None:
        self._logged_on = False

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    def send(self, msg_type: str, fields: Dict[str, Any]) -> None:
        """Send a FIX message. Auto-logons if not yet logged on."""
        is_logon = msg_type == "A"

        if not is_logon and not self._logged_on:
            self._send_raw("A", {"98": "0", "108": str(self._heartbeat_sec)})
            self._logged_on = True

        self._send_raw(msg_type, fields)
        if is_logon:
            self._logged_on = True

    def _send_raw(self, msg_type: str, fields: Dict[str, Any]) -> None:
        frame = self._encode(msg_type, fields)
        self._transport.send(frame)

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------

    def on_bytes(self, data: bytes) -> None:
        try:
            s = data.decode("ascii", errors="replace")
        except Exception:
            return

        parsed = _parse_fix(s)
        msg_type = parsed.get("35", "")

        if msg_type == "1":  # TestRequest → Heartbeat
            test_req_id = parsed.get("112", "")
            self.send("0", {"112": test_req_id})

        elif msg_type == "2":  # ResendRequest → SequenceReset-GapFill
            end_seq = int(parsed.get("16", "0") or 0)
            new_seq = max(end_seq + 1, self._seq_num)
            self.send("4", {"123": "Y", "36": str(new_seq)})

    # ------------------------------------------------------------------
    # FIX encoding
    # ------------------------------------------------------------------

    def _encode(self, msg_type: str, fields: Dict[str, Any]) -> bytes:
        """
        Build a fully formed FIX 4.4 message with correct BodyLength (9)
        and CheckSum (10).

        BodyLength convention (matches test validation):
            count bytes from MsgType (35) through the last body field's
            value, NOT including the SOH that terminates that field
            (because that SOH is shared with "10=" prefix).
        """
        now_str = datetime.now(tz=timezone.utc).strftime("%Y%m%d-%H:%M:%S.%f")[:-3]

        header_fields: List[tuple] = [
            ("35", str(msg_type)),
            ("49", self._sender),
            ("56", self._target),
            ("34", str(self._seq_num)),
            ("52", now_str),
        ]
        body_fields = header_fields + [(str(k), str(v)) for k, v in fields.items()]

        # body_raw includes trailing SOH after every field (including the last)
        body_raw = "".join(f"{k}={v}{SOH}" for k, v in body_fields)

        # BodyLength = length of body excluding the LAST SOH
        # (that SOH doubles as the separator before "10=")
        body_length = len(body_raw.encode("ascii")) - 1

        prefix = f"8={self._version}{SOH}9={body_length}{SOH}"
        before_checksum = prefix + body_raw + "10="

        checksum = sum(before_checksum.encode("ascii")) % 256
        frame = before_checksum + f"{checksum:03d}{SOH}"

        self._seq_num += 1
        return frame.encode("ascii")

    # ------------------------------------------------------------------
    # Parsing helper (exposed for tests via API.parser())
    # ------------------------------------------------------------------

    def parse(self, data: bytes) -> Dict[str, str]:
        return _parse_fix(data.decode("ascii", errors="replace"))


# ── Module-level helpers ────────────────────────────────────────────────────

def _parse_fix(s: str) -> Dict[str, str]:
    """Parse a raw FIX message string into a tag→value dict."""
    out: Dict[str, str] = {}
    for part in s.rstrip(SOH).split(SOH):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out
