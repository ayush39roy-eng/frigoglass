"""P9-T03: Project Workspace files against a REAL MinIO (testcontainers), same
container pattern as `tests/test_export_worker_task.py`.

Upload → server-generated object key (never derived from the display name),
content type chosen by the server, display-name versioning, streamed download
with a sanitised `Content-Disposition`, 415 for a disallowed extension or
mismatched bytes, 413 over the size cap, rename across versions, RBAC and hub
scoping.
"""

from __future__ import annotations

import io
import uuid
import zipfile

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from testcontainers.core.container import DockerContainer
from testcontainers.core.waiting_utils import wait_for_logs

import api.routers.workspace as workspace_router
import core.minio_config as minio_config_module
from api.db import get_db
from api.main import app
from core.minio_config import get_minio_client, get_minio_settings
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, RoleName
from models.workspace import ProjectFile
from services.file_sniff import UploadRejected, extension_of, sniff
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user

_ACCESS = "rpdtestaccess"
_SECRET = "rpdtestsecret123"
PDF = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"


def _office(kind: str) -> bytes:
    marker = {"xlsx": "xl/workbook.xml", "docx": "word/document.xml"}[kind]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr(marker, "<x/>")
    return buf.getvalue()


# --- Pure sniffing ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,data,content_type",
    [
        ("a.pdf", PDF, "application/pdf"),
        ("a.PNG", b"\x89PNG\r\n\x1a\n" + b"0" * 10, "image/png"),
        ("a.jpeg", b"\xff\xd8\xff\xe0" + b"0" * 10, "image/jpeg"),
        ("a.xlsx", _office("xlsx"), "application/vnd.openxmlformats-officedocument."
                                    "spreadsheetml.sheet"),
        ("a.csv", b"name,wk\nPDD,31\n", "text/csv"),
        ("a.stp", b"ISO-10303-21;\nHEADER;", "application/step"),
        ("a.txt", "Grüße ✓".encode(), "text/plain"),
    ],
)
def test_sniff_accepts_matching_content(name, data, content_type):
    assert sniff(extension_of(name), io.BytesIO(data)) == content_type


@pytest.mark.parametrize(
    "name,data",
    [
        ("a.pdf", b"<html>not a pdf</html>"),
        ("a.png", PDF),
        ("a.docx", _office("xlsx")),  # a zip, but not a Word document
        ("a.xlsx", b"PK\x03\x04garbage"),
        ("a.csv", b"\x00\x01binary"),
        ("a.txt", b"\xff\xfe\xfa bad utf8 \xff" + b"x" * 20),
    ],
)
def test_sniff_rejects_mismatched_content(name, data):
    with pytest.raises(UploadRejected):
        sniff(extension_of(name), io.BytesIO(data))


@pytest.mark.parametrize("name", ["a.exe", "a.html", "noext", "", None, "a.svg"])
def test_extension_allowlist(name):
    with pytest.raises(UploadRejected):
        extension_of(name)


# --- Real MinIO -----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def minio_endpoint():
    container = (
        DockerContainer("minio/minio")
        .with_exposed_ports(9000)
        .with_env("MINIO_ROOT_USER", _ACCESS)
        .with_env("MINIO_ROOT_PASSWORD", _SECRET)
        .with_command("server /data")
    )
    container.start()
    try:
        wait_for_logs(container, "API:", timeout=30)
        yield f"{container.get_container_host_ip()}:{container.get_exposed_port(9000)}"
    finally:
        container.stop()


@pytest.fixture(autouse=True)
def _real_minio(minio_endpoint, monkeypatch):
    monkeypatch.setenv("RPD_MINIO_ENDPOINT", minio_endpoint)
    monkeypatch.setenv("RPD_MINIO_ACCESS_KEY", _ACCESS)
    monkeypatch.setenv("RPD_MINIO_SECRET_KEY", _SECRET)
    monkeypatch.setenv("RPD_MINIO_SECURE", "false")
    get_minio_settings.cache_clear()
    minio_config_module._minio_client = None
    yield
    minio_config_module._minio_client = None
    get_minio_settings.cache_clear()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup(db_session, *roles, scoped=False):
    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await make_project(db_session, hub)
    user = await make_user(db_session, *roles, hub_scope_all=not scoped,
                           hub_ids=[hub.id] if scoped else [])
    override_current_principal(
        make_principal(*roles, user_id=user.id, hub_scope_all=not scoped,
                       hub_ids=[hub.id] if scoped else [])
    )
    return hub, project, user


def _upload(name, data, display, category="Certification", description=None):
    form = {"display_name": display, "category": category}
    if description is not None:
        form["description"] = description
    return {"files": {"file": (name, data, "application/octet-stream")}, "data": form}


async def test_upload_version_download_roundtrip(db_session):
    _, project, user = await _setup(db_session, RoleName.HUB_PLANNER, scoped=True)
    url = f"/projects/{project.id}/files"
    async with _client(db_session) as client:
        v1 = await client.post(url, **_upload("../../etc/passwd.pdf", PDF, "Cert report"))
        v2 = await client.post(
            url, **_upload("x.pdf", PDF + b"v2", "Cert report", description="second")
        )
        listed = await client.get(url)
        download = await client.get(f"{url}/{v2.json()['id']}/download")
    assert v1.status_code == 201, v1.text
    assert v1.json()["version"] == 1 and v2.json()["version"] == 2
    assert v2.json()["content_type"] == "application/pdf"
    assert v2.json()["size_bytes"] == len(PDF) + 2
    assert v2.json()["uploaded_by_name"] == "Test User"  # the caller's own upload
    assert [f["version"] for f in listed.json()] == [2, 1]
    assert download.status_code == 200
    assert download.content == PDF + b"v2"
    assert download.headers["content-type"] == "application/pdf"
    assert download.headers["x-content-type-options"] == "nosniff"
    assert download.headers["content-disposition"].startswith(
        'attachment; filename="Cert report.pdf"'
    )

    rows = (
        await db_session.execute(select(ProjectFile).where(ProjectFile.project_id == project.id))
    ).scalars().all()
    for row in rows:
        # Server-generated key: no trace of the filename or display name.
        assert row.minio_object_key.startswith(f"projects/{project.id}/files/")
        tail = row.minio_object_key.rsplit("/", 1)[1]
        assert len(tail) == 32 and uuid.UUID(tail)
        assert "passwd" not in row.minio_object_key and "Cert" not in row.minio_object_key
    stored = get_minio_client().get_object(
        get_minio_settings().attachments_bucket, rows[0].minio_object_key
    )
    try:
        assert stored.read() in (PDF, PDF + b"v2")
    finally:
        stored.close()
        stored.release_conn()
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project_file.upload")
        )
    ).scalars().all()
    assert len(audit) == 2 and audit[0].actor_user_id == user.id
    assert audit[0].after_state["project_id"] == str(project.id)


async def test_upload_rejections(db_session, monkeypatch):
    _, project, _ = await _setup(db_session, RoleName.ADMIN)
    url = f"/projects/{project.id}/files"
    async with _client(db_session) as client:
        exe = await client.post(url, **_upload("tool.exe", b"MZ....", "Tool"))
        fake_pdf = await client.post(url, **_upload("fake.pdf", b"<html>", "Fake"))
        empty = await client.post(url, **_upload("e.pdf", b"", "Empty"))
        blank = await client.post(url, **_upload("a.pdf", PDF, "   "))
        bad_cat = await client.post(url, **_upload("a.pdf", PDF, "A", category="Secret"))
        monkeypatch.setattr(workspace_router, "MAX_UPLOAD_BYTES", 10)
        big = await client.post(url, **_upload("big.pdf", PDF, "Big"))
    assert exe.status_code == 415 and exe.json()["code"] == "UNSUPPORTED_FILE_TYPE"
    assert fake_pdf.status_code == 415
    assert empty.status_code == 422 and empty.json()["code"] == "EMPTY_FILE"
    assert blank.status_code == 422 and blank.json()["code"] == "BAD_DISPLAY_NAME"
    assert bad_cat.status_code == 422
    assert big.status_code == 413 and big.json()["code"] == "FILE_TOO_LARGE"
    count = (
        await db_session.execute(select(ProjectFile).where(ProjectFile.project_id == project.id))
    ).scalars().all()
    assert count == []


async def test_rename_moves_every_version_and_detects_conflicts(db_session):
    _, project, _ = await _setup(db_session, RoleName.PORTFOLIO_MANAGER)
    url = f"/projects/{project.id}/files"
    async with _client(db_session) as client:
        a1 = (await client.post(url, **_upload("a.pdf", PDF, "Drawing A", "Drawing"))).json()
        await client.post(url, **_upload("a.pdf", PDF, "Drawing A", "Drawing"))
        b = (await client.post(url, **_upload("b.xlsx", _office("xlsx"), "Costing", "Costing")))
        renamed = await client.patch(
            f"{url}/{a1['id']}", json={"display_name": "Drawing A (rev)", "description": "d"}
        )
        conflict = await client.patch(f"{url}/{a1['id']}", json={"display_name": "Costing"})
        null_cat = await client.patch(f"{url}/{a1['id']}", json={"category": None})
        listed = (await client.get(url)).json()
    assert b.status_code == 201, b.text
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["display_name"] == "Drawing A (rev)"
    assert renamed.json()["description"] == "d"
    names = sorted({f["display_name"] for f in listed})
    assert names == ["Costing", "Drawing A (rev)"]
    assert conflict.status_code == 409 and conflict.json()["code"] == "DISPLAY_NAME_TAKEN"
    assert null_cat.status_code == 422


async def test_files_rbac_and_scope(db_session):
    hub, project, _ = await _setup(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        f = (await client.post(f"/projects/{project.id}/files",
                               **_upload("a.pdf", PDF, "Doc"))).json()
    # Executive Viewer: may list and download, not upload or edit.
    viewer = await make_user(db_session, RoleName.EXECUTIVE_VIEWER)
    override_current_principal(make_principal(RoleName.EXECUTIVE_VIEWER, user_id=viewer.id))
    async with _client(db_session) as client:
        listed = await client.get(f"/projects/{project.id}/files")
        dl = await client.get(f"/projects/{project.id}/files/{f['id']}/download")
        up = await client.post(f"/projects/{project.id}/files", **_upload("a.pdf", PDF, "D2"))
        patch = await client.patch(
            f"/projects/{project.id}/files/{f['id']}", json={"description": "x"}
        )
    assert listed.status_code == 200 and listed.json()[0]["uploaded_by_name"] is None
    assert dl.status_code == 200
    assert up.status_code == 403 and patch.status_code == 403
    # Hub Planner of another hub: 404, and a file id of another project: 404.
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    other_project = await make_project(db_session, other, name="Other")
    planner = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                              hub_ids=[other.id])
    override_current_principal(
        make_principal(RoleName.HUB_PLANNER, user_id=planner.id, hub_scope_all=False,
                       hub_ids=[other.id])
    )
    async with _client(db_session) as client:
        foreign = await client.get(f"/projects/{project.id}/files/{f['id']}/download")
        cross = await client.get(f"/projects/{other_project.id}/files/{f['id']}/download")
    assert foreign.status_code == 404
    assert cross.status_code == 404
    assert hub.id != other.id


def test_content_disposition_is_sanitised():
    header = workspace_router._content_disposition('evil"\r\nX-Injected: 1/../ü', "application/pdf")
    assert "\r" not in header and "\n" not in header
    ascii_part = header.split("filename*=")[0]
    assert '"evil_' in ascii_part and "/" not in ascii_part.split('filename="')[1]
    assert header.endswith(".pdf")
    assert "filename*=UTF-8''" in header
