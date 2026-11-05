import pytest

from tests.fixtures.base import _SECOND_USER
from tests.fixtures.widget_plugins import approve, enable, grant, manifest, rescan, write_package

URL = "/app/widget-plugins/test-chart/widgets/chart/presets"
ADMIN_URL = "/admin/plugins/test-chart/widgets/chart/presets"
SETTINGS = {
    "schema": {
        "type": "object",
        "properties": {"title": {"type": "string", "maxLength": 40}, "bars": {"type": "boolean"}},
    }
}


def _manifest() -> dict:
    data = manifest()
    chart = data["contributes"]["widgets"][0]
    table = {**chart, "id": "table", "name": "Table", "handles": [{**chart["handles"][0], "type": "test_table"}]}
    data["contributes"] = {"widgets": [{**chart, "settings": SETTINGS}, table]}
    return data


async def _ready(superuser, plugins_dir, widget_id="*"):
    write_package(plugins_dir, _manifest())
    await rescan(superuser)
    await approve(superuser)
    await enable(superuser)
    await grant(superuser, widget_id=widget_id)


async def _create(client, url=URL, **body):
    response = await client.post(url, json={"name": "Preset", **body})
    assert response.status_code == 200, response.text
    return response.json()


async def _listing(client, url=URL):
    response = await client.get(url)
    assert response.status_code == 200, response.text
    return response.json()


class TestUserPresets:
    @pytest.mark.asyncio
    async def test_own_presets_are_created_listed_changed_and_deleted(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        created = await _create(member, name="  Dark bars ", config={"bars": True}, state={"zoom": 2})
        assert created["name"] == "Dark bars"
        assert created["scope"] == "user"
        assert created["is_default"] is False
        assert created["config"] == {"bars": True}
        assert created["state"] == {"zoom": 2}
        assert created["updated_at"]
        await _create(member, name="Alpha")

        listing = await _listing(member)
        assert listing["limit"] == 100
        assert [p["name"] for p in listing["presets"]] == ["Alpha", "Dark bars"]

        response = await member.patch(f"{URL}/{created['id']}", json={"name": "Light", "state": None})
        assert response.status_code == 200, response.text
        assert response.json()["name"] == "Light"
        assert response.json()["state"] is None
        assert response.json()["config"] == {"bars": True}

        response = await member.delete(f"{URL}/{created['id']}")
        assert response.status_code == 200, response.text
        assert [p["name"] for p in (await _listing(member))["presets"]] == ["Alpha"]
        assert (await member.delete(f"{URL}/{created['id']}")).status_code == 404

    @pytest.mark.asyncio
    async def test_another_user_neither_sees_nor_changes_them(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        created = await _create(member)
        assert (await _listing(superuser))["presets"] == []
        assert (await superuser.patch(f"{URL}/{created['id']}", json={"name": "Mine"})).status_code == 404
        assert (await superuser.delete(f"{URL}/{created['id']}")).status_code == 404
        assert (await superuser.patch(f"{ADMIN_URL}/{created['id']}", json={"name": "Mine"})).status_code == 404
        assert (await superuser.delete(f"{ADMIN_URL}/{created['id']}")).status_code == 404
        assert (await _listing(superuser, ADMIN_URL))["presets"] == []
        assert [p["name"] for p in (await _listing(member))["presets"]] == ["Preset"]

    @pytest.mark.asyncio
    async def test_a_default_is_exclusive_per_owner(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        first = await _create(member, name="A", is_default=True)
        second = await _create(member, name="B", is_default=True)
        org = await _create(superuser, ADMIN_URL, name="Org", is_default=True)
        defaults = {p["name"]: p["is_default"] for p in (await _listing(member))["presets"]}
        assert defaults == {"A": False, "B": True, "Org": True}

        response = await member.patch(f"{URL}/{first['id']}", json={"is_default": True})
        assert response.status_code == 200, response.text
        defaults = {p["id"]: p["is_default"] for p in (await _listing(member))["presets"]}
        assert defaults == {first["id"]: True, second["id"]: False, org["id"]: True}

    @pytest.mark.asyncio
    async def test_config_satisfies_the_settings_schema(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        for config in ({"color": "red"}, {"bars": "yes"}, {"title": "x" * 41}, []):
            response = await member.post(URL, json={"name": "Bad", "config": config})
            assert response.status_code == 422, (config, response.text)
        table = "/app/widget-plugins/test-chart/widgets/table/presets"
        assert (await member.post(table, json={"name": "Bad", "config": {"bars": True}})).status_code == 422
        assert (await _create(member, table, config={}))["config"] == {}
        assert (await _create(member, table, config=None))["config"] is None
        created = await _create(member, config={"title": "Sales"})
        response = await member.patch(f"{URL}/{created['id']}", json={"config": {"bars": 1}})
        assert response.status_code == 422, response.text

    @pytest.mark.asyncio
    async def test_the_name_has_1_to_80_characters(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        for name in ("", "   ", "x" * 81):
            assert (await member.post(URL, json={"name": name})).status_code == 422, name
        assert (await _create(member, name="x" * 80))["name"] == "x" * 80
        created = await _create(member)
        assert (await member.patch(f"{URL}/{created['id']}", json={"name": " "})).status_code == 422

    @pytest.mark.asyncio
    async def test_the_state_holds_at_most_64_kib(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        response = await member.post(URL, json={"name": "Big", "state": "x" * (64 * 1024)})
        assert response.status_code == 413, response.text
        assert (await _create(member, state="x" * (64 * 1024 - 2)))["state"] == "x" * (64 * 1024 - 2)
        created = await _create(member, state=[1, 2])
        response = await member.patch(f"{URL}/{created['id']}", json={"state": {"rows": "x" * (64 * 1024)}})
        assert response.status_code == 413, response.text

    @pytest.mark.asyncio
    async def test_the_organization_limits_how_many_a_user_keeps(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        entry = next(
            p for p in (await _listing(superuser, "/admin/plugins"))["plugins"] if p["plugin_id"] == "test-chart"
        )
        assert entry["preset_limit"] == 100
        assert (await superuser.put("/admin/plugins/test-chart", json={"preset_limit": 0})).status_code == 422
        response = await superuser.put("/admin/plugins/test-chart", json={"preset_limit": 2})
        assert response.status_code == 200, response.text
        entry = next(
            p for p in (await _listing(superuser, "/admin/plugins"))["plugins"] if p["plugin_id"] == "test-chart"
        )
        assert entry["preset_limit"] == 2
        assert (await _listing(member))["limit"] == 2

        await _create(member, name="One")
        await _create(member, name="Two")
        response = await member.post(URL, json={"name": "Three"})
        assert response.status_code == 409, response.text
        assert "2 presets" in response.json()["detail"]
        await _create(superuser, name="Admin's own")
        for name in ("Org one", "Org two", "Org three"):
            await _create(superuser, ADMIN_URL, name=name)

        response = await superuser.put("/admin/plugins/test-chart", json={"preset_limit": None})
        assert response.status_code == 200, response.text
        assert (await _listing(member))["limit"] == 100
        await _create(member, name="Three")

    @pytest.mark.asyncio
    async def test_a_widget_the_user_may_not_use_has_no_presets(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir, widget_id="chart")
        table = "/app/widget-plugins/test-chart/widgets/table/presets"
        assert (await member.get(table)).status_code == 404
        assert (await member.post(table, json={"name": "No"})).status_code == 404
        assert (await member.get("/app/widget-plugins/other-chart/widgets/chart/presets")).status_code == 404
        assert (await member.get("/app/widget-plugins/test-chart/widgets/missing/presets")).status_code == 404
        assert (await _listing(member))["presets"] == []

    @pytest.mark.asyncio
    async def test_another_organization_neither_sees_nor_changes_them(
        self, member, superuser, second_user_client, second_user_grant, plugins_dir
    ):
        await _ready(superuser, plugins_dir)
        response = await superuser.put(
            f"/plugins/test-chart/entities/{_SECOND_USER['entity_uuid']}", json={"enabled": True}
        )
        assert response.status_code == 200, response.text
        await second_user_grant()
        own = await _create(member, name="Mine")
        org = await _create(superuser, ADMIN_URL, name="House")

        assert (await _listing(second_user_client))["presets"] == []
        for preset in (own, org):
            assert (await second_user_client.patch(f"{URL}/{preset['id']}", json={"name": "X"})).status_code == 404
            assert (await second_user_client.delete(f"{URL}/{preset['id']}")).status_code == 404
        theirs = await _create(second_user_client, name="Theirs")
        assert [p["id"] for p in (await _listing(member))["presets"]] == [own["id"], org["id"]]
        assert (await superuser.patch(f"{ADMIN_URL}/{theirs['id']}", json={"name": "X"})).status_code == 404


class TestOrgPresets:
    @pytest.mark.asyncio
    async def test_users_apply_org_presets_that_only_admins_change(self, member, superuser, plugins_dir):
        await _ready(superuser, plugins_dir)
        org = await _create(superuser, ADMIN_URL, name="House style", config={"title": "Q3"}, state={"zoom": 1})
        assert org["scope"] == "org"
        own = await _create(member, name="Zed")

        presets = (await _listing(member))["presets"]
        assert [(p["id"], p["scope"]) for p in presets] == [(own["id"], "user"), (org["id"], "org")]
        assert presets[1]["config"] == {"title": "Q3"}
        assert presets[1]["state"] == {"zoom": 1}
        assert [p["id"] for p in (await _listing(superuser, ADMIN_URL))["presets"]] == [org["id"]]

        assert (await member.patch(f"{URL}/{org['id']}", json={"name": "Mine"})).status_code == 404
        assert (await member.delete(f"{URL}/{org['id']}")).status_code == 404
        assert (await member.get(ADMIN_URL)).status_code == 403
        assert (await member.post(ADMIN_URL, json={"name": "Mine"})).status_code == 403
        assert (await member.patch(f"{ADMIN_URL}/{org['id']}", json={"name": "Mine"})).status_code == 403
        assert (await member.delete(f"{ADMIN_URL}/{org['id']}")).status_code == 403
        assert (await superuser.patch(f"{ADMIN_URL}/{own['id']}", json={"name": "Mine"})).status_code == 404

        response = await superuser.patch(f"{ADMIN_URL}/{org['id']}", json={"name": "House", "config": {"bars": 3}})
        assert response.status_code == 422, response.text
        response = await superuser.patch(f"{ADMIN_URL}/{org['id']}", json={"name": "House"})
        assert response.status_code == 200, response.text
        assert [p["name"] for p in (await _listing(member))["presets"]] == ["Zed", "House"]
        assert (await superuser.delete(f"{ADMIN_URL}/{org['id']}")).status_code == 200
        assert [p["name"] for p in (await _listing(member))["presets"]] == ["Zed"]

    @pytest.mark.asyncio
    async def test_the_widget_is_in_the_approved_manifest(self, superuser, plugins_dir):
        assert (await superuser.get(ADMIN_URL)).status_code == 404
        await _ready(superuser, plugins_dir)
        assert (await superuser.get("/admin/plugins/test-chart/widgets/missing/presets")).status_code == 404
        assert (
            await superuser.post("/admin/plugins/test-chart/widgets/missing/presets", json={"name": "X"})
        ).status_code == 404
        assert (await _listing(superuser, "/admin/plugins/test-chart/widgets/table/presets"))["presets"] == []
