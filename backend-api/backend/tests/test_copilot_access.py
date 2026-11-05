import os
import sys
from unittest.mock import patch
from uuid import UUID, uuid4

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)


import pytest
from fastapi import HTTPException
from sqlalchemy import delete, update

from api import models

from routers.app.index import MCPProxyRequest, check_mcp_tool_calls
from scripts.create_metering_token import create_metering_token
from tests.fixtures.base import (
    _ADMIN_USER,
    _AUTH_USER,
    settings,
)
from utilities.config import DefaultMCPServer
from tests.fixtures.organization import MEMBER_UUID

ADMIN_ENTITY = _ADMIN_USER["entity_uuid"]
METERING = {"X-Metering-Authorization": "Bearer " + create_metering_token()[0]}

MCP_URL = "https://mcp.example.com/mcp"
OTHER_MCP_URL = "https://tools.example.com/mcp"

WEB_OFF = ["SEARCH_WEB", "FETCH_FROM_WEB"]
WEB_SEARCH = {"url": MCP_URL, "tool_name": "web_search"}
FETCH_PAGE = {"url": MCP_URL, "tool_name": "fetch_webpage"}
OTHER_TOOL = {"url": MCP_URL, "tool_name": "execute_sql"}


def _grants(models_=(), mcp=()):
    return {
        "models": [{"agent_id": a, "model_id": m} for a, m in models_],
        "mcp": [{"server_url": u, "tool_name": t} for u, t in mcp],
    }


async def _authorize(client, **request):
    return await client.post("/app/copilot/authorize", json=request, headers=METERING)


class TestNothingWithoutAGrant:
    @pytest.mark.asyncio
    async def test_a_user_without_roles_may_use_nothing(self, organization, auth_client):
        access = (await auth_client.get("/app/copilot/access")).json()
        assert access == {"models": [], "mcp": [], "disabled_capabilities": WEB_OFF}

        result = await _authorize(
            auth_client,
            agent_id="default-copilot",
            model="any-model",
            tools=[{"url": MCP_URL, "tool_name": "any_tool"}],
        )
        assert result.status_code == 200
        assert result.json() == {
            "allowed": False,
            "denied_model": "any-model",
            "denied_tools": [{"url": MCP_URL, "tool_name": "any_tool"}],
            "disabled_capabilities": WEB_OFF,
        }

        result = await _authorize(auth_client, agent_id="default-copilot")
        assert result.json()["allowed"] is False

    @pytest.mark.asyncio
    async def test_a_role_without_grants_grants_nothing(self, organization, auth_client):
        await organization.role(MEMBER_UUID)

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access == {"models": [], "mcp": [], "disabled_capabilities": []}
        result = await _authorize(auth_client, agent_id="default-copilot", model="fast")
        assert result.json()["allowed"] is False


class TestAdminAssignsAccess:
    @pytest.mark.asyncio
    async def test_admin_sets_and_reads_a_roles_grants(self, organization, admin_client):
        role = await organization.role()
        grants = _grants(
            models_=[("default-copilot", "fast"), ("default-copilot", "smart")],
            mcp=[("https://MCP.example.com/mcp/", "*"), (OTHER_MCP_URL, "search")],
        )

        response = await admin_client.put(f"/admin/role/{role}/copilot-access", json=grants)
        assert response.status_code == 200

        stored = (await admin_client.get(f"/admin/role/{role}/copilot-access")).json()
        assert {(m["agent_id"], m["model_id"]) for m in stored["models"]} == {
            ("default-copilot", "fast"),
            ("default-copilot", "smart"),
        }
        assert {(m["server_url"], m["tool_name"]) for m in stored["mcp"]} == {
            (MCP_URL, "*"),
            (OTHER_MCP_URL, "search"),
        }

    @pytest.mark.asyncio
    async def test_putting_replaces_the_grants(self, organization, admin_client):
        role = await organization.role()
        path = f"/admin/role/{role}/copilot-access"
        await admin_client.put(path, json=_grants(models_=[("a", "one")], mcp=[(MCP_URL, "*")]))

        await admin_client.put(path, json=_grants(models_=[("a", "two")]))

        stored = (await admin_client.get(path)).json()
        assert stored["models"] == [{"agent_id": "a", "model_id": "two"}]
        assert stored["mcp"] == []

    @pytest.mark.asyncio
    async def test_grants_are_validated(self, organization, admin_client):
        role = await organization.role()

        response = await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(models_=[("default-copilot", "")]),
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_only_admins_set_grants(self, organization, auth_client):
        role = await organization.role()

        response = await auth_client.put(f"/admin/role/{role}/copilot-access", json=_grants(models_=[("a", "m")]))
        assert response.status_code in {401, 403}

    @pytest.mark.asyncio
    async def test_admins_only_set_grants_of_their_own_roles(self, organization, admin_client):
        outside = await organization.role(entity_uuid=_AUTH_USER["entity_uuid"])

        path = f"/admin/role/{outside}/copilot-access"
        response = await admin_client.put(path, json=_grants(models_=[("a", "m")]))
        assert response.status_code == 404
        assert (await admin_client.get(path)).status_code == 404


class TestUsersGetWhatTheirRolesGrant:
    @pytest.mark.asyncio
    async def test_models_are_limited_to_the_granted_ones(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(models_=[("default-copilot", "fast")]),
        )

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access == {
            "models": [{"agent_id": "default-copilot", "model_id": "fast"}],
            "mcp": [],
            "disabled_capabilities": [],
        }

        allowed = await _authorize(auth_client, agent_id="default-copilot", model="fast")
        assert allowed.json()["allowed"] is True

        denied = await _authorize(auth_client, agent_id="default-copilot", model="smart")
        assert denied.json() == {
            "allowed": False,
            "denied_model": "smart",
            "denied_tools": [],
            "disabled_capabilities": [],
        }

        other_agent = await _authorize(auth_client, agent_id="custom", model="fast")
        assert other_agent.json()["allowed"] is False

    @pytest.mark.asyncio
    async def test_a_request_without_a_model_needs_a_grant_for_its_agent(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(models_=[("default-copilot", "fast")]),
        )

        granted_agent = await _authorize(auth_client, agent_id="default-copilot")
        assert granted_agent.json() == {
            "allowed": True,
            "denied_model": None,
            "denied_tools": [],
            "disabled_capabilities": [],
        }

        other_agent = await _authorize(auth_client, agent_id="custom")
        assert other_agent.json() == {
            "allowed": False,
            "denied_model": None,
            "denied_tools": [],
            "disabled_capabilities": [],
        }

    @pytest.mark.asyncio
    async def test_tools_are_limited_to_the_granted_servers_and_tools(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(
                models_=[("default-copilot", "fast")],
                mcp=[(MCP_URL, "*"), (OTHER_MCP_URL, "search")],
            ),
        )

        granted = await _authorize(
            auth_client,
            agent_id="default-copilot",
            model="fast",
            tools=[
                {"url": MCP_URL, "tool_name": "anything"},
                {"url": "https://MCP.example.com/mcp/", "tool_name": "other"},
                {"url": OTHER_MCP_URL, "tool_name": "search"},
            ],
        )
        assert granted.json()["allowed"] is True

        result = await _authorize(
            auth_client,
            agent_id="default-copilot",
            model="fast",
            tools=[
                {"url": MCP_URL, "tool_name": "anything"},
                {"url": OTHER_MCP_URL, "tool_name": "search"},
                {"url": OTHER_MCP_URL, "tool_name": "delete"},
                {"url": "https://elsewhere.example.com/mcp", "tool_name": "search"},
            ],
        )

        body = result.json()
        assert body["allowed"] is False
        assert body["denied_model"] is None
        assert body["denied_tools"] == [
            {"url": OTHER_MCP_URL, "tool_name": "delete"},
            {"url": "https://elsewhere.example.com/mcp", "tool_name": "search"},
        ]

    @pytest.mark.asyncio
    async def test_roles_add_up(self, organization, admin_client, auth_client):
        first = await organization.role(MEMBER_UUID)
        second = await organization.role(MEMBER_UUID)
        await admin_client.put(f"/admin/role/{first}/copilot-access", json=_grants(models_=[("a", "fast")]))
        await admin_client.put(f"/admin/role/{second}/copilot-access", json=_grants(models_=[("a", "smart")]))

        for model in ("fast", "smart"):
            result = await _authorize(auth_client, agent_id="a", model=model)
            assert result.json()["allowed"] is True
        assert (await _authorize(auth_client, agent_id="a", model="huge")).json()["allowed"] is False

    @pytest.mark.asyncio
    async def test_grants_of_other_users_roles_give_nothing(self, organization, admin_client, auth_client):
        role = await organization.role()
        await admin_client.put(f"/admin/role/{role}/copilot-access", json=_grants(models_=[("a", "fast")]))

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["models"] == []
        result = await _authorize(auth_client, agent_id="a", model="fast")
        assert result.json()["allowed"] is False

    @pytest.mark.asyncio
    async def test_deleted_roles_grant_nothing(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(f"/admin/role/{role}/copilot-access", json=_grants(models_=[("a", "fast")]))
        assert (await _authorize(auth_client, agent_id="a")).json()["allowed"] is True
        assert (await admin_client.delete(f"/admin/role/{role}")).status_code == 200

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["models"] == []
        assert (await _authorize(auth_client, agent_id="a")).json()["allowed"] is False


class TestSync:
    @pytest.mark.asyncio
    async def test_the_sync_carries_what_the_user_may_use(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(models_=[("default-copilot", "fast")]),
        )

        response = await auth_client.get("/app/dash/validate-and-sync")

        assert response.status_code == 200
        assert response.json()["copilot_access"] == {
            "models": [{"agent_id": "default-copilot", "model_id": "fast"}],
            "mcp": [],
            "disabled_capabilities": [],
        }


class TestEnforcement:
    @pytest.mark.asyncio
    async def test_users_cannot_authorize_themselves(self, organization, auth_client):
        response = await auth_client.post("/app/copilot/authorize", json={"agent_id": "a", "model": "m"})
        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_the_proxy_refuses_tool_calls_that_are_not_granted(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(mcp=[(MCP_URL, "search")]),
        )

        response = await auth_client.post(
            "/app/mcp-proxy",
            json={
                "server_url": MCP_URL,
                "url": MCP_URL,
                "method": "POST",
                "body": {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": "delete", "arguments": {}},
                },
            },
        )
        assert response.status_code == 403
        assert "delete" in response.json()["detail"]

        batch = await auth_client.post(
            "/app/mcp-proxy",
            json={
                "server_url": MCP_URL,
                "url": MCP_URL,
                "method": "POST",
                "body": [
                    {"method": "tools/call", "params": {"name": "search"}},
                    {"method": "tools/call", "params": {"name": "delete"}},
                ],
            },
        )
        assert batch.status_code == 403

    @pytest.mark.asyncio
    async def test_the_proxy_refuses_every_tool_call_without_a_grant(self, organization, db_session):
        call = MCPProxyRequest(
            server_url=MCP_URL,
            url=MCP_URL,
            method="POST",
            body={"method": "tools/call", "params": {"name": "search"}},
        )
        with pytest.raises(HTTPException) as refused:
            await check_mcp_tool_calls(db_session, MEMBER_UUID, call)
        assert refused.value.status_code == 403

    @pytest.mark.asyncio
    async def test_the_proxy_check_lets_granted_calls_and_other_requests_through(
        self, organization, admin_client, db_session
    ):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(mcp=[(MCP_URL, "search")]),
        )

        def request(body):
            return MCPProxyRequest(server_url=MCP_URL, url=MCP_URL, method="POST", body=body)

        calls = [
            request({"method": "tools/call", "params": {"name": "search"}}),
            request({"method": "tools/list"}),
            request({"method": "initialize", "params": {}}),
            request(None),
        ]
        for call in calls:
            await check_mcp_tool_calls(db_session, MEMBER_UUID, call)

        with pytest.raises(HTTPException) as refused:
            await check_mcp_tool_calls(
                db_session,
                MEMBER_UUID,
                request({"method": "tools/call", "params": {"name": "delete"}}),
            )
        assert refused.value.status_code == 403


class TestWebToolsOfTheCopilot:
    @pytest.mark.asyncio
    async def test_a_new_role_allows_both(self, organization, admin_client, auth_client):
        response = await admin_client.post("/admin/role", json={"name": "Web tools", "description": ""})
        assert response.status_code == 200
        roles = (await admin_client.get("/admin/role")).json()
        role = next(r for r in roles if r["name"] == "Web tools")
        role_uuid = UUID(role["uuid"])
        organization.roles.append(role_uuid)
        assert (role["search_web"], role["fetch_from_web"]) == (True, True)

        await organization.assign(role_uuid, MEMBER_UUID)
        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["disabled_capabilities"] == []

    @pytest.mark.asyncio
    async def test_an_admin_switches_one_off_on_a_role_and_the_other_stays(self, organization, admin_client, auth_client):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(models_=[("a", "m")], mcp=[(MCP_URL, "*")]),
        )
        response = await admin_client.patch(f"/admin/role/{role}", json={"search_web": False})
        assert response.status_code == 200

        stored = (await admin_client.get(f"/admin/role/{role}")).json()
        assert (stored["search_web"], stored["fetch_from_web"]) == (False, True)
        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["disabled_capabilities"] == ["SEARCH_WEB"]

        result = (await _authorize(auth_client, agent_id="a", tools=[WEB_SEARCH, FETCH_PAGE, OTHER_TOOL])).json()
        assert result["allowed"] is False
        assert result["denied_tools"] == [WEB_SEARCH]
        assert result["disabled_capabilities"] == ["SEARCH_WEB"]

        await admin_client.patch(f"/admin/role/{role}", json={"search_web": True})
        result = (await _authorize(auth_client, agent_id="a", tools=[WEB_SEARCH, FETCH_PAGE])).json()
        assert result["allowed"] is True
        assert result["disabled_capabilities"] == []

    @pytest.mark.asyncio
    async def test_one_role_that_allows_it_is_enough(self, organization, auth_client):
        await organization.role(MEMBER_UUID, search_web=False, fetch_from_web=False)
        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["disabled_capabilities"] == WEB_OFF

        await organization.role(MEMBER_UUID, fetch_from_web=False)
        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["disabled_capabilities"] == ["FETCH_FROM_WEB"]

    @pytest.mark.asyncio
    async def test_a_patch_of_something_else_leaves_them_as_they_are(self, organization, admin_client):
        role = await organization.role(fetch_from_web=False)
        await admin_client.patch(f"/admin/role/{role}", json={"copilot_calls_day": 5})
        stored = (await admin_client.get(f"/admin/role/{role}")).json()
        assert (stored["search_web"], stored["fetch_from_web"]) == (True, False)
        assert stored["copilot_calls_day"] == 5

    @pytest.mark.asyncio
    async def test_switched_off_beats_what_roles_grant_and_whichever_server_has_the_tool(
        self, organization, admin_client, auth_client
    ):
        role = await organization.role(MEMBER_UUID, search_web=False)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(mcp=[(MCP_URL, "*"), (OTHER_MCP_URL, "*")]),
        )
        elsewhere = {"url": OTHER_MCP_URL, "tool_name": "web_search"}

        result = (await _authorize(auth_client, tools=[WEB_SEARCH, elsewhere, OTHER_TOOL])).json()
        assert result["denied_tools"] == [WEB_SEARCH, elsewhere]

    @pytest.mark.asyncio
    async def test_on_changes_nothing_a_role_that_does_not_grant_the_tool_still_refuses_it(
        self, organization, admin_client, auth_client
    ):
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(mcp=[(MCP_URL, "execute_sql")]),
        )
        result = (await _authorize(auth_client, tools=[WEB_SEARCH, OTHER_TOOL])).json()
        assert result["denied_tools"] == [WEB_SEARCH]
        assert result["disabled_capabilities"] == []

    @pytest.mark.asyncio
    async def test_the_proxy_refuses_a_call_of_a_tool_that_is_switched_off(self, organization, admin_client, db_session):
        role = await organization.role(MEMBER_UUID, fetch_from_web=False)
        await admin_client.put(
            f"/admin/role/{role}/copilot-access",
            json=_grants(mcp=[(MCP_URL, "*"), (OTHER_MCP_URL, "*")]),
        )

        def call(name, url=MCP_URL):
            return MCPProxyRequest(
                server_url=url,
                url=url,
                method="POST",
                body={"method": "tools/call", "params": {"name": name}},
            )

        for url in (MCP_URL, OTHER_MCP_URL):
            for name in ("fetch_webpage", "inspect_webpage"):
                with pytest.raises(HTTPException) as refused:
                    await check_mcp_tool_calls(db_session, MEMBER_UUID, call(name, url))
                assert refused.value.status_code == 403
        await check_mcp_tool_calls(db_session, MEMBER_UUID, call("web_search"))
        await check_mcp_tool_calls(db_session, MEMBER_UUID, call("execute_sql"))

    @pytest.mark.asyncio
    async def test_a_user_cannot_switch_it_back_on_themselves(self, organization, auth_client):
        role = await organization.role(MEMBER_UUID, search_web=False)
        response = await auth_client.patch(f"/admin/role/{role}", json={"search_web": True})
        assert response.status_code == 403
        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["disabled_capabilities"] == ["SEARCH_WEB"]

    @pytest.mark.asyncio
    async def test_the_sync_carries_what_is_switched_off(self, organization, auth_client):
        await organization.role(MEMBER_UUID, search_web=False)
        response = await auth_client.get("/app/dash/validate-and-sync")
        assert response.status_code == 200
        assert response.json()["copilot_access"]["disabled_capabilities"] == ["SEARCH_WEB"]


SOURCES = "/app/data-connectors/api-source"
TUNNEL_URL = "https://tunnel.example.com/mcp"


def _servers(access):
    return {(g["server_url"], g["tool_name"]) for g in access["mcp"]}


class TestBackendsGrantTheServersTheyDeclare:
    @pytest.mark.asyncio
    async def test_a_developers_own_backend_grants_its_servers(self, organization, auth_client):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        source = uuid4()
        created = await auth_client.post(
            f"{SOURCES}/{source}", json={"name": "Hurricane", "url": "https://hurricane.example.com"}
        )
        assert created.status_code == 200

        reported = await auth_client.put(
            f"{SOURCES}/{source}/mcp-servers", json={"servers": ["https://Tunnel.example.com/mcp/", MCP_URL]}
        )
        assert reported.status_code == 200

        access = (await auth_client.get("/app/copilot/access")).json()
        assert _servers(access) == {(TUNNEL_URL, "*"), (MCP_URL, "*")}
        result = await _authorize(auth_client, tools=[{"url": TUNNEL_URL, "tool_name": "query_sql"}])
        assert result.json()["denied_tools"] == []
        listed = (await auth_client.get(SOURCES)).json()
        assert next(s for s in listed if s["id"] == str(source))["mcpServers"] == [MCP_URL, TUNNEL_URL]

    @pytest.mark.asyncio
    async def test_a_new_report_replaces_the_old_one(self, organization, auth_client):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        source = uuid4()
        await auth_client.post(f"{SOURCES}/{source}", json={"name": "Hurricane", "url": "https://hurricane.example.com"})
        await auth_client.put(f"{SOURCES}/{source}/mcp-servers", json={"servers": [TUNNEL_URL]})

        await auth_client.put(f"{SOURCES}/{source}/mcp-servers", json={"servers": [MCP_URL]})

        access = (await auth_client.get("/app/copilot/access")).json()
        assert _servers(access) == {(MCP_URL, "*")}

    @pytest.mark.asyncio
    async def test_a_backend_nobody_approved_grants_nothing(self, organization, auth_client):
        owner = await organization.add_user(models.DEVELOPER_TYPE)
        source = uuid4()
        organization.db.add(
            models.ApiSource(
                uuid=source,
                name="Someone's backend",
                url="https://other.example.com",
                user_uuid=owner.uuid,
                mcp_servers=[TUNNEL_URL],
            )
        )
        await organization.db.commit()

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["mcp"] == []
        refused = await auth_client.put(f"{SOURCES}/{source}/mcp-servers", json={"servers": [MCP_URL]})
        assert refused.status_code == 404

    @pytest.mark.asyncio
    async def test_approving_the_backend_for_a_role_grants_its_servers(self, organization, auth_client):
        owner = await organization.add_user(models.DEVELOPER_TYPE)
        source = uuid4()
        organization.db.add(
            models.ApiSource(
                uuid=source,
                name="Shared backend",
                url="https://shared.example.com",
                user_uuid=owner.uuid,
                mcp_servers=[TUNNEL_URL],
            )
        )
        await organization.db.commit()
        role = await organization.role(MEMBER_UUID)

        organization.db.add(models.RoleBackend(role_uuid=role, backend_uuid=source, access="no-access"))
        await organization.db.commit()
        assert (await auth_client.get("/app/copilot/access")).json()["mcp"] == []

        await organization.db.execute(
            update(models.RoleBackend).where(models.RoleBackend.role_uuid == role).values(access="access")
        )
        await organization.db.commit()
        access = (await auth_client.get("/app/copilot/access")).json()
        assert _servers(access) == {(TUNNEL_URL, "*")}

    @pytest.mark.asyncio
    async def test_an_entity_backend_grants_its_servers_only_through_a_role(self, organization, auth_client):
        source = uuid4()
        organization.db.add(
            models.ApiSource(
                uuid=source,
                name="Entity backend",
                url="https://entity.example.com",
                entity_uuid=UUID(ADMIN_ENTITY),
                mcp_servers=[TUNNEL_URL],
            )
        )
        await organization.db.commit()
        try:
            assert (await auth_client.get("/app/copilot/access")).json()["mcp"] == []
            role = await organization.role(MEMBER_UUID)
            organization.db.add(models.RoleBackend(role_uuid=role, backend_uuid=source, access="access"))
            await organization.db.commit()
            access = (await auth_client.get("/app/copilot/access")).json()
            assert _servers(access) == {(TUNNEL_URL, "*")}
        finally:
            await organization.db.execute(delete(models.RoleBackend).where(models.RoleBackend.backend_uuid == source))
            await organization.db.execute(delete(models.ApiSource).where(models.ApiSource.uuid == source))
            await organization.db.commit()

    @pytest.mark.asyncio
    async def test_the_reported_servers_are_validated(self, organization, auth_client):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        source = uuid4()
        await auth_client.post(f"{SOURCES}/{source}", json={"name": "Hurricane", "url": "https://hurricane.example.com"})

        for servers in (["ftp://tunnel.example.com/mcp"], ["https://user:pass@tunnel.example.com/mcp"]):
            response = await auth_client.put(f"{SOURCES}/{source}/mcp-servers", json={"servers": servers})
            assert response.status_code == 422


def _own_servers(*urls):
    servers = [{"id": f"own-{i}", "name": f"Own {i}", "url": url, "enabled": True} for i, url in enumerate(urls)]
    return {"servers": servers}


class TestUsersOwnServersAreTheirs:
    @pytest.mark.asyncio
    async def test_a_developers_own_server_grants_all_its_tools(self, organization, auth_client):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)

        saved = await auth_client.post("/app/mcp-servers", json=_own_servers("https://Tunnel.example.com/mcp/"))
        assert saved.status_code == 200

        access = (await auth_client.get("/app/copilot/access")).json()
        assert _servers(access) == {(TUNNEL_URL, "*")}
        result = await _authorize(auth_client, tools=[{"url": TUNNEL_URL, "tool_name": "search_markets"}])
        assert result.json()["denied_tools"] == []

    @pytest.mark.asyncio
    async def test_the_proxy_lets_the_owner_call_its_tools(self, organization, auth_client, db_session):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        await auth_client.post("/app/mcp-servers", json=_own_servers(TUNNEL_URL))

        call = MCPProxyRequest(
            server_url=TUNNEL_URL,
            url=TUNNEL_URL,
            method="POST",
            body={"method": "tools/call", "params": {"name": "search_markets"}},
        )
        await check_mcp_tool_calls(db_session, MEMBER_UUID, call)

    @pytest.mark.asyncio
    async def test_removing_the_server_removes_the_grant(self, organization, auth_client):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        await auth_client.post("/app/mcp-servers", json=_own_servers(TUNNEL_URL, MCP_URL))

        await auth_client.post("/app/mcp-servers", json=_own_servers(MCP_URL))

        access = (await auth_client.get("/app/copilot/access")).json()
        assert _servers(access) == {(MCP_URL, "*")}

    @pytest.mark.asyncio
    async def test_a_user_who_may_not_add_connections_gets_no_grant(self, organization, auth_client):
        organization.db.add(models.MCPServers(user_uuid=MEMBER_UUID, servers=_own_servers(TUNNEL_URL)["servers"]))
        await organization.db.commit()

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["mcp"] == []
        result = await _authorize(auth_client, tools=[{"url": TUNNEL_URL, "tool_name": "search_markets"}])
        assert result.json()["denied_tools"] == [{"url": TUNNEL_URL, "tool_name": "search_markets"}]

    @pytest.mark.asyncio
    async def test_a_saved_default_server_keeps_the_roles_limits(self, organization, auth_client, admin_client):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        role = await organization.role(MEMBER_UUID)
        await admin_client.put(f"/admin/role/{role}/copilot-access", json=_grants(mcp=[(OTHER_MCP_URL, "search")]))

        default = DefaultMCPServer(id="tools", name="Tools", url=OTHER_MCP_URL)
        with patch.object(settings, "DEFAULT_MCP_SERVERS", [default]):
            await auth_client.post("/app/mcp-servers", json=_own_servers(OTHER_MCP_URL, TUNNEL_URL))
            access = (await auth_client.get("/app/copilot/access")).json()

        assert _servers(access) == {(OTHER_MCP_URL, "search"), (TUNNEL_URL, "*")}

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "spelling",
        [
            "https://tools.example.com:443/mcp",
            "https://tools.example.com./mcp",
            "HTTPS://Tools.Example.com.:443/mcp/",
            "https://x@tools.example.com/mcp",
            "https://tools.example.com/mcp/.",
            "https://tools.example.com/./mcp",
            "https://tools.example.com/%6Dcp",
            "https://tools.example.com//mcp",
            "https://tools.example.com/MCP",
            "https://tools.example.com/other",
        ],
    )
    async def test_a_default_server_saved_under_another_spelling_keeps_the_roles_limits(
        self, organization, auth_client, spelling
    ):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        default = DefaultMCPServer(id="tools", name="Tools", url=OTHER_MCP_URL)
        with patch.object(settings, "DEFAULT_MCP_SERVERS", [default]):
            await auth_client.post("/app/mcp-servers", json=_own_servers(spelling))
            access = (await auth_client.get("/app/copilot/access")).json()

        assert access["mcp"] == []

    @pytest.mark.asyncio
    async def test_a_server_on_another_port_of_a_default_servers_host_grants_all_its_tools(
        self, organization, auth_client
    ):
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)
        default = DefaultMCPServer(id="tools", name="Tools", url=OTHER_MCP_URL)
        with patch.object(settings, "DEFAULT_MCP_SERVERS", [default]):
            await auth_client.post("/app/mcp-servers", json=_own_servers("https://tools.example.com:8443/mcp"))
            access = (await auth_client.get("/app/copilot/access")).json()

        assert _servers(access) == {("https://tools.example.com:8443/mcp", "*")}

    @pytest.mark.asyncio
    async def test_another_users_server_grants_nothing(self, organization, auth_client):
        other = await organization.add_user(models.DEVELOPER_TYPE)
        organization.db.add(models.MCPServers(user_uuid=other.uuid, servers=_own_servers(TUNNEL_URL)["servers"]))
        await organization.db.commit()
        await organization.set_type(MEMBER_UUID, models.DEVELOPER_TYPE)

        access = (await auth_client.get("/app/copilot/access")).json()
        assert access["mcp"] == []
