#!/usr/bin/env python3
"""texflow native messaging host.

Chrome extensions cannot write outside ~/Downloads. This host receives PDF bytes
from the texflow extension over Chrome's native messaging protocol and writes
them to the requested path.

Guard rails:
  * only absolute (or ~-prefixed) paths inside the user's home directory
  * only files ending in .pdf whose bytes start with the %PDF- magic
  * the destination folder must already exist (typos never create folders)
  * writes are atomic (temp file + rename), so a half-written PDF never appears

Protocol: each message is a 4-byte little-endian length followed by UTF-8 JSON.
Requests carry an "id" that is echoed in the response.
"""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile

VERSION = "1.0.0"
MAX_PDF_BYTES = 50 * 1024 * 1024


class HostError(Exception):
    pass


def read_message(stream):
    raw_len = stream.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    body = stream.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


def write_message(stream, obj):
    body = json.dumps(obj).encode("utf-8")
    stream.write(struct.pack("<I", len(body)))
    stream.write(body)
    stream.flush()


def resolve_path(path, home=None):
    """Expand ~ and normalise; reject anything outside the home directory."""
    if not isinstance(path, str) or not path.strip():
        raise HostError("No path given.")
    home = os.path.realpath(home or os.path.expanduser("~"))
    path = path.strip()
    if path.startswith("~"):
        path = home + path[1:]
    if not os.path.isabs(path):
        raise HostError(f"Path must be absolute or start with ~: {path}")
    resolved = os.path.realpath(path)
    if os.path.commonpath([resolved, home]) != home:
        raise HostError(f"Refusing to write outside your home folder: {resolved}")
    return resolved


def check_dir(path, home=None):
    resolved = resolve_path(path, home)
    return {"path": resolved, "exists": os.path.isdir(resolved)}


def save_pdf(path, data_b64, overwrite=True, home=None):
    target = resolve_path(path, home)
    if not target.lower().endswith(".pdf"):
        raise HostError(f"File name must end in .pdf: {target}")
    folder = os.path.dirname(target)
    if not os.path.isdir(folder):
        raise HostError(f"Folder does not exist: {folder}")
    try:
        data = base64.b64decode(data_b64 or "", validate=True)
    except (ValueError, TypeError) as exc:
        raise HostError(f"PDF data was not valid base64: {exc}")
    if not data.startswith(b"%PDF-"):
        raise HostError("Data is not a PDF.")
    if len(data) > MAX_PDF_BYTES:
        raise HostError("PDF is larger than 50 MB.")
    if os.path.exists(target) and not overwrite:
        raise HostError(f"File already exists: {target}")

    fd, tmp = tempfile.mkstemp(prefix=".texflow-", suffix=".pdf", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return {"path": target, "bytes": len(data)}


def _applescript_string(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def choose_folder(start=None, home=None, run=subprocess.run):
    """Show the macOS folder picker. Returns {"path": "~/..."} or {"cancelled": True}."""
    home = os.path.realpath(home or os.path.expanduser("~"))
    script = ["tell me to activate"]
    prompt = "Choose where texflow should save this PDF"
    location = ""
    if start:
        try:
            resolved = resolve_path(start, home)
            if os.path.isdir(resolved):
                location = f" default location (POSIX file {_applescript_string(resolved)})"
        except HostError:
            pass
    script.append(f"POSIX path of (choose folder with prompt {_applescript_string(prompt)}{location})")
    args = ["osascript"]
    for line in script:
        args += ["-e", line]
    proc = run(args, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        if "-128" in proc.stderr or "canceled" in proc.stderr.lower():
            return {"cancelled": True}
        raise HostError(f"Folder picker failed: {proc.stderr.strip()}")
    path = os.path.realpath(proc.stdout.strip())
    if os.path.commonpath([path, home]) == home:
        path = "~" + path[len(home):]
    return {"path": path}


def handle(msg, home=None):
    kind = msg.get("type")
    if kind == "ping":
        return {"version": VERSION, "home": os.path.expanduser("~")}
    if kind == "checkDir":
        return check_dir(msg.get("path"), home)
    if kind == "chooseFolder":
        return choose_folder(msg.get("start"), home)
    if kind == "save":
        return save_pdf(msg.get("path"), msg.get("data"), msg.get("overwrite", True), home)
    raise HostError(f"Unknown request type: {kind!r}")


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        msg = read_message(stdin)
        if msg is None:
            return
        reply = {"id": msg.get("id")}
        try:
            reply.update(handle(msg))
            reply["ok"] = True
        except HostError as exc:
            reply.update(ok=False, error=str(exc))
        except Exception as exc:  # never crash the pipe; report instead
            reply.update(ok=False, error=f"{type(exc).__name__}: {exc}")
        write_message(stdout, reply)


if __name__ == "__main__":
    main()
