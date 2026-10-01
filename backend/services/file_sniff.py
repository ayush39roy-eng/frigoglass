"""Upload type checks for Project Workspace files (P9-T03, docs/API_CONTRACT_P9.md §7).

An upload is accepted only when all three agree:

1. the original filename's **extension** is on the allowlist;
2. the **bytes** look like that type. Magic numbers are checked for
   PDF/PNG/JPEG, the ZIP container is checked for zip/xlsx/docx/pptx (for
   the Office formats the part that identifies the format must exist), and
   the text formats (csv/txt/step/stp/dxf) must decode as UTF-8 with no NUL
   bytes;
3. the stored `content_type` is **ours**, derived from the extension. The
   client-supplied `Content-Type` header is ignored, so a browser never gets
   a type the server did not choose.

No external `libmagic` dependency: the allowlist is small and closed, so a
few explicit checks are more predictable than a general-purpose sniffer.
"""

from __future__ import annotations

import zipfile
from typing import IO

#: extension → content type served on download.
ALLOWED_TYPES: dict[str, str] = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "csv": "text/csv",
    "txt": "text/plain",
    "zip": "application/zip",
    "step": "application/step",
    "stp": "application/step",
    "dxf": "image/vnd.dxf",
}

#: content type → extension used for the download filename.
EXTENSION_FOR_CONTENT_TYPE: dict[str, str] = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    ALLOWED_TYPES["xlsx"]: "xlsx",
    ALLOWED_TYPES["docx"]: "docx",
    ALLOWED_TYPES["pptx"]: "pptx",
    "text/csv": "csv",
    "text/plain": "txt",
    "application/zip": "zip",
    "application/step": "step",
    "image/vnd.dxf": "dxf",
}

_OFFICE_MARKER: dict[str, str] = {
    "xlsx": "xl/workbook.xml",
    "docx": "word/document.xml",
    "pptx": "ppt/presentation.xml",
}
_TEXT_EXTENSIONS = frozenset({"csv", "txt", "step", "stp", "dxf"})
_SNIFF_BYTES = 8192


class UploadRejected(Exception):
    """The file is not an allowed type, or its bytes do not match its extension."""


def extension_of(filename: str | None) -> str:
    if not filename or "." not in filename:
        raise UploadRejected("The file has no extension.")
    ext = filename.rsplit(".", 1)[1].strip().lower()
    if ext not in ALLOWED_TYPES:
        raise UploadRejected(
            f"File type .{ext} is not allowed. Allowed: {', '.join(sorted(ALLOWED_TYPES))}."
        )
    return ext


def _looks_like_text(head: bytes) -> bool:
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as exc:
        # A multi-byte character cut at the sniff boundary is still text.
        return exc.start >= len(head) - 3
    return True


def sniff(ext: str, fileobj: IO[bytes]) -> str:
    """Check the bytes of a seekable file against `ext`. Returns the content
    type to store. Leaves the file positioned at 0.
    """

    fileobj.seek(0)
    head = fileobj.read(_SNIFF_BYTES)
    fileobj.seek(0)
    ok: bool
    if ext == "pdf":
        ok = head.startswith(b"%PDF-")
    elif ext == "png":
        ok = head.startswith(b"\x89PNG\r\n\x1a\n")
    elif ext in ("jpg", "jpeg"):
        ok = head.startswith(b"\xff\xd8\xff")
    elif ext in ("zip", "xlsx", "docx", "pptx"):
        ok = head.startswith(b"PK\x03\x04")
        if ok and ext in _OFFICE_MARKER:
            try:
                with zipfile.ZipFile(fileobj) as zf:
                    ok = _OFFICE_MARKER[ext] in zf.namelist()
            except zipfile.BadZipFile:
                ok = False
            fileobj.seek(0)
    elif ext in _TEXT_EXTENSIONS:
        ok = _looks_like_text(head)
    else:  # pragma: no cover - extension_of() already restricts ext
        ok = False
    if not ok:
        raise UploadRejected(f"The file content does not match its .{ext} extension.")
    return ALLOWED_TYPES[ext]
