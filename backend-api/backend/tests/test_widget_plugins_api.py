import asyncio
import hashlib
import json
import warnings
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, select

from api import models
from api.widget_plugins import service
from tests.fixtures.base import _SECOND_USER, settings
from tests.fixtures.plugin_backends import backend_manifest
from tests.fixtures.widget_plugins import (
    approve,
    enable,
    grant,
    manifest,
    plugin_view,
    rescan,
    user_listing,
    version_view,
    write_package,
)


def _tree_hashes(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


class TestFeatureSwitch:
    @pytest.mark.asyncio
    async def test_off_without_a_plugins_directory(self, superuser, monkeypatch):
        monkeypatch.setattr(settings, "WIDGET_PLUGINS_DIR", None)
        assert (await user_listing(superuser)) == {"enabled": False, "etag": "off", "plugins": []}
        assert (await superuser.post("/plugins/rescan")).status_code == 409


class TestSuperuserReview:
    @pytest.mark.asyncio
    async def test_only_superusers_review(self, admin_client, plugins_dir):
        for method, path in [("get", "/plugins"), ("post", "/plugins/rescan")]:
            response = await getattr(admin_client, method)(path)
            assert response.status_code in {401, 403}, response.text

    @pytest.mark.asyncio
    async def test_discovered_plugins_are_disabled(self, superuser, plugins_dir):
        write_package(plugins_dir)
        summary = await rescan(superuser)
        assert summary["discovered"] == ["test-chart@1.0.0"]
        plugin = await plugin_view(superuser)
        assert plugin["status"] == "disabled"
        assert plugin["active_version"] is None
        view = version_view(plugin)
        assert view["state"] == "discovered"
        assert {i["family"] for i in view["review"]} == {"widgets", "permissions", "code"}

    @pytest.mark.asyncio
    async def test_approval_needs_every_added_request_acknowledged(self, superuser, plugins_dir):
        write_package(plugins_dir, manifest(csp={"img-src": ["https://tiles.example.com"]}))
        await rescan(superuser)
        view = version_view(await plugin_view(superuser))
        response = await superuser.post(
            "/plugins/test-chart/versions/1.0.0/approve",
            json={"digest": view["digest"], "acknowledged": []},
        )
        assert response.status_code == 422
        assert "csp:img-src:https://tiles.example.com" in response.json()["detail"]["missing"]

    @pytest.mark.asyncio
    async def test_approval_binds_to_the_reviewed_digest(self, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        response = await superuser.post(
            "/plugins/test-chart/versions/1.0.0/approve",
            json={"digest": "sha256-" + "D" * 43, "acknowledged": []},
        )
        assert response.status_code == 409

    @pytest.mark.asyncio
    async def test_files_changed_before_approval_block_the_version(self, superuser, plugins_dir):
        directory = write_package(plugins_dir)
        await rescan(superuser)
        view = version_view(await plugin_view(superuser))
        (directory / "entry.js").write_bytes(b"export default {};")
        response = await superuser.post(
            "/plugins/test-chart/versions/1.0.0/approve",
            json={"digest": view["digest"], "acknowledged": [i["key"] for i in view["review"]]},
        )
        assert response.status_code == 409
        assert version_view(await plugin_view(superuser))["state"] == "blocked"

    @pytest.mark.asyncio
    async def test_a_blocked_package_cannot_be_approved(self, superuser, plugins_dir):
        write_package(plugins_dir, checksum="sha256-" + "E" * 43)
        summary = await rescan(superuser)
        assert summary["blocked"] == ["test-chart@1.0.0"]
        view = version_view(await plugin_view(superuser))
        response = await superuser.post(
            "/plugins/test-chart/versions/1.0.0/approve",
            json={"digest": view["digest"] or "", "acknowledged": []},
        )
        assert response.status_code == 409


class TestConcurrentSaves:
    @pytest.mark.asyncio
    async def test_a_row_another_save_created_first_is_updated(
        self, member, superuser, plugins_dir, db_session, monkeypatch
    ):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)

        async def not_there_yet(*_args):
            return None

        with monkeypatch.context() as patch:
            patch.setattr(service, "_entity_row", not_there_yet)
            response = await superuser.put(
                "/admin/plugins/test-chart", json={"narrowed_permissions": ["core:params:write"]}
            )
        assert response.status_code == 200, response.text
        rows = (await db_session.execute(select(models.EntityWidgetPlugin.narrowed_permissions))).scalars().all()
        assert rows == [["core:params:write"]]
        assert len((await user_listing(member))["plugins"]) == 1

    @pytest.mark.asyncio
    async def test_a_secret_another_superuser_set_first_is_replaced(
        self, superuser, plugins_dir, db_session, monkeypatch
    ):
        write_package(plugins_dir, backend_manifest())
        await rescan(superuser)
        first = await superuser.put("/plugins/test-chart/secrets/api_key", json={"value": "first-value"})
        assert first.status_code == 200, first.text

        async def nothing_stored(*_args):
            return {}

        with monkeypatch.context() as patch:
            patch.setattr(service.secret_values, "stored", nothing_stored)
            second = await superuser.put("/plugins/test-chart/secrets/api_key", json={"value": "second-value"})
        assert second.status_code == 200, second.text
        [row] = (await db_session.execute(select(models.WidgetPluginSecret))).scalars().all()
        assert row.value == {"value": "second-value"}


class TestAvailability:
    @pytest.mark.asyncio
    async def test_nothing_is_available_until_approved_and_enabled(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        assert (await user_listing(member))["plugins"] == []
        await approve(superuser)
        assert (await user_listing(member))["plugins"] == []
        await enable(superuser)
        assert (await user_listing(member))["plugins"] == []
        await grant(superuser)
        assert len((await user_listing(member))["plugins"]) == 1

    @pytest.mark.asyncio
    async def test_roles_grant_the_widgets(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)

        analysts = await member.role("Analysts")
        response = await superuser.put(
            f"/admin/role/{analysts}/plugin-access",
            json={"grants": [{"plugin_id": "test-chart", "widget_id": "chart"}]},
        )
        assert response.status_code == 200, response.text
        listing = await user_listing(member)
        [plugin] = listing["plugins"]
        assert [w["id"] for w in plugin["widgets"]] == ["chart"]
        assert listing["vizHandlers"] == {"test_chart": {"plugin": "test-chart", "widget": "chart"}}
        assert plugin["widgets"][0]["permissions"] == ["core:data:read", "core:default", "core:params:write"]

        await superuser.put(f"/admin/role/{analysts}/plugin-access", json={"grants": []})
        assert (await user_listing(member))["plugins"] == []

    @pytest.mark.asyncio
    async def test_a_role_the_user_does_not_hold_grants_nothing(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        other = await member.role("Others", assign=False)
        await superuser.put(f"/admin/role/{other}/plugin-access", json={"grants": [{"plugin_id": "test-chart"}]})
        assert (await user_listing(member))["plugins"] == []

    @pytest.mark.asyncio
    async def test_other_entities_see_nothing(self, superuser, second_user_client, second_user_grant, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        await second_user_grant()
        assert (await user_listing(second_user_client))["plugins"] == []

    @pytest.mark.asyncio
    async def test_admins_grant_only_their_own_roles(self, superuser, second_user_client, db_session, plugins_dir):
        foreign = models.Role(uuid=uuid4(), name="Foreign", description="", entity_uuid=UUID(_SECOND_USER["entity_uuid"]))
        db_session.add(foreign)
        await db_session.commit()
        try:
            response = await superuser.put(f"/admin/role/{foreign.uuid}/plugin-access", json={"grants": []})
            assert response.status_code == 404
        finally:
            await db_session.execute(delete(models.Role).where(models.Role.uuid == foreign.uuid))
            await db_session.commit()

    @pytest.mark.asyncio
    async def test_revoke_is_a_kill_switch(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        assert (await superuser.post("/plugins/test-chart/revoke")).status_code == 200
        assert (await user_listing(member))["plugins"] == []
        assert (await superuser.post("/plugins/test-chart/restore")).status_code == 200
        assert len((await user_listing(member))["plugins"]) == 1


class TestSuperuserEntities:
    @pytest.mark.asyncio
    async def test_the_detail_shows_every_entity_and_the_events(
        self, superuser, second_user_client, second_user_grant, plugins_dir
    ):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await second_user_grant()
        assert (await second_user_client.get("/plugins/test-chart")).status_code in {401, 403}

        response = await superuser.get("/plugins/test-chart")
        assert response.status_code == 200, response.text
        detail = response.json()
        assert detail["active_version"] == "1.0.0"
        entities = {e["entity_uuid"]: e for e in detail["entities"]}
        second = _SECOND_USER["entity_uuid"]
        assert entities[second] == {**entities[second], "enabled": False}
        assert "approved" in [e["action"] for e in detail["events"]]

        response = await superuser.put(f"/plugins/test-chart/entities/{second}", json={"enabled": True})
        assert response.status_code == 200, response.text
        assert len((await user_listing(second_user_client))["plugins"]) == 1
        detail = (await superuser.get("/plugins/test-chart")).json()
        assert {e["entity_uuid"]: e["enabled"] for e in detail["entities"]}[second] is True
        assert (await plugin_view(superuser))["enabled_for"] == [{"entity_uuid": second}]
        assert (await superuser.get("/plugins/not-a-plugin")).status_code == 404

    @pytest.mark.asyncio
    async def test_enable_for_every_entity(self, member, superuser, second_user_client, second_user_grant, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await grant(superuser)
        await second_user_grant()

        response = await superuser.put("/plugins/test-chart/entities", json={"enabled": True})
        assert response.status_code == 200, response.text
        assert response.json()["entities"] >= 2
        assert len((await user_listing(member))["plugins"]) == 1
        assert len((await user_listing(second_user_client))["plugins"]) == 1

        response = await superuser.put("/plugins/test-chart/entities", json={"enabled": False})
        assert response.status_code == 200, response.text
        assert (await user_listing(member))["plugins"] == []
        assert (await user_listing(second_user_client))["plugins"] == []


class TestPolicy:
    @pytest.mark.asyncio
    async def test_override_and_narrowing(self, member, superuser, plugins_dir):
        write_package(
            plugins_dir, manifest(csp={"img-src": ["https://tiles.example.com"]}, cspNotes={"img-src": "map tiles"})
        )
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        [plugin] = (await user_listing(member))["plugins"]
        assert plugin["csp"]["img-src"] == ["data:", "blob:", "https://tiles.example.com"]
        assert plugin["csp"]["connect-src"] == ["'none'"]

        bad = await superuser.put(
            "/plugins/test-chart/overrides", json={"csp": {"connect-src": ["http://api.example.com"]}}
        )
        assert bad.status_code == 422
        good = await superuser.put(
            "/plugins/test-chart/overrides",
            json={"csp": {"connect-src": ["http://api.example.com"]}, "confirmations": ["insecure-scheme"]},
        )
        assert good.status_code == 200, good.text
        [plugin] = (await user_listing(member))["plugins"]
        assert plugin["csp"]["connect-src"] == ["http://api.example.com"]

        widen = await superuser.put(
            "/admin/plugins/test-chart", json={"csp_narrow": {"img-src": ["https://other.example.com"]}}
        )
        assert widen.status_code == 422
        await enable(superuser, csp_narrow={"img-src": []})
        [plugin] = (await user_listing(member))["plugins"]
        assert plugin["csp"]["img-src"] == ["data:", "blob:"]

    @pytest.mark.asyncio
    async def test_narrowed_permissions(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser, narrowed_permissions=["core:params:write"])
        await grant(superuser)
        [plugin] = (await user_listing(member))["plugins"]
        assert plugin["widgets"][0]["permissions"] == ["core:data:read", "core:default"]

    @pytest.mark.asyncio
    async def test_the_listing_carries_the_actions_that_the_permissions_allow(self, member, superuser, plugins_dir):
        data = manifest()
        button = {"id": "zoom", "label": "Zoom in", "icon": "zoom-in", "placement": "navbar"}
        item = {"id": "reset", "label": "Reset view", "icon": "refresh", "placement": "menu"}
        data["contributes"]["widgets"][0].update(
            {"permissions": ["core:data:read", "core:ui:button", "core:ui:menu"], "actions": [button, item]}
        )
        write_package(plugins_dir, data)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        [plugin] = (await user_listing(member))["plugins"]
        assert plugin["widgets"][0]["actions"] == [button, item]

        await enable(superuser, narrowed_permissions=["core:ui:menu"])
        [plugin] = (await user_listing(member))["plugins"]
        assert plugin["widgets"][0]["actions"] == [button]


class TestFiles:
    async def _ready(self, member, superuser, plugins_dir):
        directory = write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        [plugin] = (await user_listing(member))["plugins"]
        return directory, plugin

    @pytest.mark.asyncio
    async def test_files_are_served_as_verified_bytes(self, member, superuser, plugins_dir):
        directory, plugin = await self._ready(member, superuser, plugins_dir)
        response = await member.get(f"/app/widget-plugins/test-chart/{plugin['digest']}/files/entry.js")
        assert response.status_code == 200
        assert response.content == (directory / "entry.js").read_bytes()
        assert response.headers["content-type"] == "application/octet-stream"
        assert response.headers["content-disposition"] == "attachment"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert hashlib.sha256(response.content).hexdigest() == plugin["files"]["entry.js"]["sha256"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("path", ["plugin.json", "../1.0.0/entry.js", "assets/../plugin.json", "missing.js"])
    async def test_only_served_files(self, member, superuser, plugins_dir, path):
        _, plugin = await self._ready(member, superuser, plugins_dir)
        response = await member.get(f"/app/widget-plugins/test-chart/{plugin['digest']}/files/{path}")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_only_the_active_digest(self, member, superuser, plugins_dir):
        await self._ready(member, superuser, plugins_dir)
        response = await member.get(f"/app/widget-plugins/test-chart/sha256-{'F' * 43}/files/entry.js")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_a_file_edited_in_place_blocks_the_version(self, member, superuser, plugins_dir):
        directory, plugin = await self._ready(member, superuser, plugins_dir)
        (directory / "entry.js").write_bytes(b"export default { render() { /* changed */ } };")
        response = await member.get(f"/app/widget-plugins/test-chart/{plugin['digest']}/files/entry.js")
        assert response.status_code == 409
        assert (await user_listing(member))["plugins"] == []
        assert version_view(await plugin_view(superuser))["state"] == "blocked"

    @pytest.mark.asyncio
    async def test_users_without_access_get_nothing(self, superuser, second_user_client, second_user_grant, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        view = await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        await second_user_grant()
        response = await second_user_client.get(f"/app/widget-plugins/test-chart/{view['digest']}/files/entry.js")
        assert response.status_code == 404


class TestVersions:
    @pytest.mark.asyncio
    async def test_a_new_version_waits_for_approval(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)

        write_package(plugins_dir, manifest(version="1.1.0", csp={"connect-src": ["https://api.example.com"]}))
        summary = await rescan(superuser)
        assert summary["discovered"] == ["test-chart@1.1.0"]
        plugin = await plugin_view(superuser)
        assert plugin["active_version"] == "1.0.0"
        assert plugin["update_available"] == "1.1.0"
        assert (await user_listing(member))["plugins"][0]["version"] == "1.0.0"

        added = {i["key"] for i in version_view(plugin, "1.1.0")["review"] if i["added"]}
        assert "csp:connect-src:https://api.example.com" in added
        assert not any(k.startswith("permission:") for k in added)
        await approve(superuser, version="1.1.0")
        plugin = await plugin_view(superuser)
        assert plugin["active_version"] == "1.1.0"
        assert version_view(plugin, "1.0.0")["state"] == "retired"
        assert (await user_listing(member))["plugins"][0]["version"] == "1.1.0"

    @pytest.mark.asyncio
    async def test_rescan_marks_changed_and_missing_versions(self, member, superuser, plugins_dir):
        directory = write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)

        moved = plugins_dir.parent / "moved"
        directory.rename(moved)
        assert (await rescan(superuser))["missing"] == ["test-chart@1.0.0"]
        assert (await user_listing(member))["plugins"] == []

        moved.rename(directory)
        assert (await rescan(superuser))["restored"] == ["test-chart@1.0.0"]
        assert len((await user_listing(member))["plugins"]) == 1

        write_package(plugins_dir, manifest(description="changed in place"))
        assert (await rescan(superuser))["blocked"] == ["test-chart@1.0.0"]
        assert (await user_listing(member))["plugins"] == []
        await rescan(superuser)
        assert version_view(await plugin_view(superuser))["state"] == "blocked"


@pytest.fixture
async def plugin_audit_listeners():
    from sqlalchemy import event  # noqa: PLC0415

    from api.events import role_permission_events as events  # noqa: PLC0415

    from unittest.mock import patch  # noqa: PLC0415

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: PLC0415

    from tests.fixtures.base import _get_test_db_url_async  # noqa: PLC0415
    from tests.fixtures.db import TestAsyncSessionLocal  # noqa: PLC0415

    engine = create_async_engine(_get_test_db_url_async(), pool_pre_ping=True)
    sessions = TestAsyncSessionLocal(async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False))
    pairs = [
        ("after_insert", events.track_role_widget_plugin_insert),
        ("after_delete", events.track_role_widget_plugin_delete),
    ]
    for name, listener in pairs:
        event.listen(models.RoleWidgetPlugin, name, listener)
    with patch.object(events, "AsyncWriteSessionLocal", sessions):
        yield
        await asyncio.sleep(0.2)
    for name, listener in pairs:
        event.remove(models.RoleWidgetPlugin, name, listener)
    await engine.dispose()


class TestAudit:
    @pytest.mark.asyncio
    async def test_role_grants_reach_the_activity_log(
        self, member, superuser, db_session, plugins_dir, plugin_audit_listeners
    ):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        analysts = await member.role("Auditors")

        async def entries(action: str) -> list:
            for _ in range(40):
                await db_session.commit()
                rows = (
                    (
                        await db_session.execute(
                            select(models.AuditEntityRolesPermissions).where(
                                models.AuditEntityRolesPermissions.role_uuid == analysts,
                                models.AuditEntityRolesPermissions.resource_type == "widget_plugin",
                                models.AuditEntityRolesPermissions.action == action,
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if rows:
                    return rows
                await asyncio.sleep(0.05)
            return []

        async def messages() -> list:
            response = await superuser.get("/admin/role-permissions-audit-logs", params={"role_uuid": str(analysts)})
            assert response.status_code == 200, response.text
            return [e["details_msg"] for e in response.json() if e["resource_type"] == "widget_plugin"]

        await superuser.put(f"/admin/role/{analysts}/plugin-access", json={"grants": [{"plugin_id": "test-chart"}]})
        assert await entries("assign")
        assert await messages() == ["Granted every widget of plugin 'test-chart'."]
        await superuser.put(f"/admin/role/{analysts}/plugin-access", json={"grants": []})
        assert await entries("remove")
        assert "Stopped granting every widget of plugin 'test-chart'." in await messages()
        await db_session.execute(
            delete(models.AuditEntityRolesPermissions).where(models.AuditEntityRolesPermissions.role_uuid == analysts)
        )
        await db_session.commit()


class TestHandlers:
    @pytest.mark.asyncio
    async def test_the_entity_chooses_between_two_handlers(self, member, superuser, plugins_dir):
        for plugin_id in ("b-chart", "a-chart"):
            write_package(plugins_dir, manifest(plugin_id=plugin_id))
        await rescan(superuser)
        for plugin_id in ("a-chart", "b-chart"):
            await approve(superuser, plugin_id)
            await enable(superuser, plugin_id)
            await grant(superuser, plugin_id)
        assert (await user_listing(member))["vizHandlers"]["test_chart"]["plugin"] == "a-chart"
        await enable(superuser, "b-chart", handlers={"test_chart": "chart"})
        assert (await user_listing(member))["vizHandlers"]["test_chart"]["plugin"] == "b-chart"


class TestReports:
    @pytest.mark.asyncio
    async def test_blocked_requests_are_counted_and_cleaned(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        await rescan(superuser)
        await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        response = await member.post(
            "/app/widget-plugins/report",
            json={
                "plugin_id": "test-chart",
                "version": "1.0.0",
                "reports": [
                    {"directive": "connect-src", "origin": "https://evil.example.com"},
                    {"directive": "connect-src", "origin": "https://evil.example.com"},
                    {"directive": "img-src", "origin": "<script>alert(1)</script>"},
                    {"directive": "default-src", "origin": "inline"},
                ],
            },
        )
        assert response.json() == {"stored": 3}
        reports = (await superuser.get("/plugins/test-chart/csp-reports")).json()
        assert {(r["directive"], r["origin"], r["count"]) for r in reports} == {
            ("connect-src", "https://evil.example.com", 2),
            ("default-src", "inline", 1),
        }


class TestNoInstallPath:
    def test_no_route_accepts_a_file_upload(self):
        from main import app  # noqa: PLC0415

        from fastapi.openapi.utils import get_openapi  # noqa: PLC0415

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            schema = get_openapi(title="x", version="1", routes=app.routes)
        for path, operations in schema["paths"].items():
            if "plugin" not in path:
                continue
            for operation in operations.values():
                content = (operation.get("requestBody") or {}).get("content", {})
                assert "multipart/form-data" not in content, path
                assert "application/octet-stream" not in content, path

    @pytest.mark.asyncio
    async def test_no_route_writes_to_the_plugins_directory(self, member, superuser, plugins_dir):
        write_package(plugins_dir)
        before = _tree_hashes(plugins_dir)
        await rescan(superuser)
        view = await approve(superuser)
        await enable(superuser)
        await grant(superuser)
        await superuser.put("/plugins/test-chart/overrides", json={"csp": {"img-src": ["data:"]}})
        await member.get(f"/app/widget-plugins/test-chart/{view['digest']}/files/entry.js")
        refused = await superuser.post("/plugins/test-chart/versions/1.0.0/develop", json={"bump": "patch"})
        assert refused.status_code == 409
        assert "local" in refused.json()["detail"]
        await superuser.post("/plugins/test-chart/revoke")
        await superuser.get("/plugins/test-chart/events")
        assert _tree_hashes(plugins_dir) == before
        events = [e["action"] for e in (await superuser.get("/plugins/test-chart/events")).json()]
        assert {"discovered", "approved", "entity-updated", "overrides", "revoked"} <= set(events)

    def test_manifest_round_trips_as_json(self):
        assert json.loads(json.dumps(manifest()))["id"] == "test-chart"
