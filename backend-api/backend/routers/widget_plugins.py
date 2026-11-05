import json
import re
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import Row
from sqlalchemy.ext.asyncio import AsyncSession

from api import auth_helpers, models
from api.database import aget_read_db, aget_write_db
from api.models.widget_plugin_models import DEFAULT_PRESET_LIMIT
from api.rate_limit import LIMIT_DEFAULT, limiter
from api.widget_plugins import backends, broker, calls, presets, service, widgets_schema
from api.widget_plugins.manifest import PLUGIN_ID_PATTERN, VERSION_PATTERN, WIDGET_ID_PATTERN
from api.widget_plugins.proxy import NAME_PATTERN, PROXY_ID_PATTERN, CallError
from api.widget_plugins.secrets import MAX_SECRET_LENGTH
from routers import app_helpers

TAGS: list[str | Any] = ["widget-plugins"]
PluginId = Annotated[str, StringConstraints(pattern=PLUGIN_ID_PATTERN)]
WidgetId = Annotated[str, StringConstraints(pattern=WIDGET_ID_PATTERN), Path(description="The id of the widget.")]
PresetId = Annotated[UUID, Path(description="The id of the preset.")]
DATA_SOURCE_PATTERN = r"^[a-z][a-z0-9_-]{0,63}$"

platform_router = APIRouter(prefix="/plugins", tags=TAGS)
admin_router = APIRouter(prefix="/admin", tags=TAGS)
app_router = APIRouter(prefix="/app/widget-plugins", tags=TAGS)
broker_router = APIRouter(prefix="/internal/plugin-broker", tags=TAGS)

closed = ConfigDict(extra="forbid")
MAX_CALL_BODY = 96 * 1024
MAX_INSTANCE_ID = 64


def _checked(value: str, pattern: str, what: str) -> str:
    if not re.fullmatch(pattern, value):
        raise HTTPException(404, detail=f"No such {what}")
    return value


async def _json_object(request: Request, limit: int) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(413, detail="The body is too large")
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(422, detail="The body is not JSON") from None
    if not isinstance(data, dict):
        raise HTTPException(422, detail="The body is a JSON object")
    return data


class ApproveBody(BaseModel):
    model_config = closed

    digest: Annotated[str, StringConstraints(max_length=80)] = Field(
        description=(
            "The digest of the version as the superuser reviewed it. The approval fails when the digest has changed."
        ),
    )
    acknowledged: list[Annotated[str, StringConstraints(max_length=400)]] = Field(
        default_factory=list,
        max_length=500,
        description="The requests of the version that the superuser acknowledges.",
    )


class DevelopBody(BaseModel):
    model_config = closed

    bump: Literal["patch", "minor", "major"] = Field(
        description="Which part of the version number to raise: `patch`, `minor` or `major`."
    )


class OverridesBody(BaseModel):
    model_config = closed

    csp: dict[str, list[str]] | None = Field(
        None,
        description="The override of the frame policy, as the sources that each directive allows.",
    )
    server_network: list[Annotated[str, StringConstraints(max_length=255)]] | None = Field(
        default=None,
        max_length=32,
        description="The override of the server network: the hosts that the plugin's server side may reach.",
    )
    confirmations: list[Literal["insecure-scheme", "private-host", "remote-script"]] = Field(
        default_factory=list,
        description=(
            "The risky choices that the superuser confirms: `insecure-scheme`, `private-host` or `remote-script`."
        ),
    )


class EntityChanges(BaseModel):
    model_config = closed

    enabled: bool | None = Field(None, description="Whether the organization enables the plugin.")
    narrowed_permissions: list[str] | None = Field(
        default=None,
        max_length=32,
        description="The permissions that the organization removes from what the plugin may do.",
    )
    csp_narrow: dict[str, list[str]] | None = Field(
        None,
        description="The frame sources that the organization removes, by directive.",
    )
    server_network_narrow: list[Annotated[str, StringConstraints(max_length=255)]] | None = Field(
        default=None,
        max_length=32,
        description="The server hosts that the organization removes.",
    )
    data_sources: dict[Annotated[str, StringConstraints(max_length=64)], UUID | None] | None = Field(
        default=None,
        max_length=16,
        description=(
            "The organization's backend for each data source that the plugin declares, by data source id. A null "
            "value clears the mapping."
        ),
    )
    settings: dict[str, Any] | None = Field(None, description="The values of the plugin's settings.")
    handlers: dict[str, Annotated[str, StringConstraints(pattern=WIDGET_ID_PATTERN)] | None] | None = Field(
        None,
        description=(
            "For each widget type that the plugin handles, the id of the plugin widget that renders it for the "
            "organization, or null to clear the choice."
        ),
    )
    preset_limit: int | None = Field(
        None,
        ge=1,
        le=100000,
        description=(
            "How many presets each user may keep of each of the plugin's widgets, or null for the default of "
            f"{DEFAULT_PRESET_LIMIT}."
        ),
    )


class PresetBody(BaseModel):
    model_config = closed

    name: Annotated[str, StringConstraints(max_length=200)] = Field(
        description="The name of the preset, 1 to 80 characters once trimmed."
    )
    config: dict[str, Any] | None = Field(
        None, description="The values of the widget's settings. They must satisfy the widget's settings schema."
    )
    state: Any = Field(None, description="The plugin's own state of the widget, at most 64 KiB of JSON.")
    is_default: bool = Field(
        False, description="Whether the preset is the default, which a new card of the widget starts from."
    )


class PresetChanges(BaseModel):
    model_config = closed

    name: Annotated[str, StringConstraints(max_length=200)] | None = Field(
        None, description="The new name of the preset, 1 to 80 characters once trimmed."
    )
    config: dict[str, Any] | None = Field(
        None,
        description="The new values of the widget's settings, or null to clear them. They must satisfy the widget's "
        "settings schema.",
    )
    state: Any = Field(None, description="The plugin's new state of the widget, at most 64 KiB of JSON.")
    is_default: bool | None = Field(
        None, description="Whether the preset is the default, which a new card of the widget starts from."
    )


class AllEntitiesChanges(BaseModel):
    model_config = closed

    enabled: bool = Field(description="Whether the plugin is enabled for every organization.")


class RoleGrant(BaseModel):
    model_config = closed

    plugin_id: PluginId = Field(description="The id of the plugin.")
    widget_id: Annotated[str, StringConstraints(pattern=r"^(\*|[a-z][a-z0-9_-]{0,47})$")] = Field(
        "*",
        description="The id of the widget, or `*` for every widget of the plugin.",
    )


class RoleGrants(BaseModel):
    model_config = closed

    grants: list[RoleGrant] = Field(
        default_factory=list,
        max_length=500,
        description="The plugin widgets that the role grants.",
    )


class Report(BaseModel):
    model_config = closed

    directive: Annotated[str, StringConstraints(max_length=32)] = Field(
        description="The directive of the frame policy that refused the request.",
    )
    origin: Annotated[str, StringConstraints(max_length=255)] = Field(description="The origin that the policy refused.")


FrameFailure = Literal["sandbox-failed", "integrity-failed", "load-failed", "plugin-error", "unresponsive", "ended"]


class ReportBody(BaseModel):
    model_config = closed

    plugin_id: PluginId = Field(description="The id of the plugin.")
    version: Annotated[str, StringConstraints(pattern=VERSION_PATTERN)] = Field(description="The version of the plugin.")
    reports: list[Report] = Field(
        default_factory=list,
        max_length=50,
        description="The requests that the frame policy refused.",
    )
    failure: FrameFailure | None = Field(
        None,
        description=(
            "How the frame failed, if it did: `sandbox-failed`, `integrity-failed`, `load-failed`, `plugin-error`, "
            "`unresponsive` or `ended`."
        ),
    )


@platform_router.get(
    "",
    summary="List the plugins at the deployment",
    description=(
        "Returns every plugin that a rescan has found, ordered by id. Each entry has the plugin's status, its active "
        "version, the newer version that waits for approval, its overrides, the organizations that enabled it, its "
        "versions with their reviews, the state of its secrets and the state of its backend. The field `enabled` says "
        "whether the deployment has the plugin feature turned on. Only a superuser can call it."
    ),
)
async def list_plugins(
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    _: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.platform_listing(db)


@platform_router.get(
    "/{plugin_id}",
    summary="Get a plugin",
    description=(
        "Returns one plugin with the same detail as the listing, and adds every organization with whether the plugin is "
        "enabled for it, and the plugin's latest events. Answers 404 when no plugin has that id. Only a superuser can "
        "call it."
    ),
)
async def get_plugin(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    _: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.platform_plugin(db, plugin_id)


@platform_router.post(
    "/rescan",
    summary="Rescan the plugin directory",
    description=(
        "Reads every version directory of the plugins directory, validates the manifests, hashes the files, and records "
        "each version as discovered, or as blocked with the reason. The API scans only when someone asks, and never at "
        "startup. Only a superuser can call it."
    ),
)
async def rescan_plugins(
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.rescan(db, superuser.uuid)


@platform_router.post(
    "/{plugin_id}/versions/{version}/approve",
    summary="Approve a plugin version",
    description=(
        "Approves a version that the superuser reviewed. The request's `digest` must be the digest that the version has "
        "now, and `acknowledged` lists every request that the version adds to what the active version asked for. The "
        "first approval enables the plugin at the deployment, and approving a newer version retires the active one. "
        "Answers 404 when the version does not exist, and 409 when the version cannot be approved in its state or its "
        "files changed since the review. Only a superuser can call it."
    ),
)
async def approve_version(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    version: Annotated[
        str,
        StringConstraints(pattern=VERSION_PATTERN),
        Path(description="The version of the plugin, as `major.minor.patch`."),
    ],
    body: ApproveBody,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.approve(
        db,
        plugin_id,
        version,
        digest=body.digest,
        acknowledged=body.acknowledged,
        actor_uuid=superuser.uuid,
    )


@platform_router.post(
    "/{plugin_id}/versions/{version}/develop",
    summary="Start the next version of a plugin",
    description=(
        "Copies an approved version of the plugin to the next patch, minor or major number, rewrites the version and the "
        "checksum in the copy's manifest, and records the copy as a version in development. The API serves the copy "
        "from its files as they change until a superuser approves it. Only one version of a plugin is in development at "
        "a time. Answers the plugin id, the new version and its path. Answers 404 when the plugin or the version does "
        "not exist, and 409 when the deployment is not a local stack, where `MODE` is `local`, when the version is not "
        "approved, when another version is in development, or when the plugins directory cannot be written. Only a "
        "superuser can call it."
    ),
)
async def develop_version(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    version: Annotated[
        str,
        StringConstraints(pattern=VERSION_PATTERN),
        Path(description="The approved version, as `major.minor.patch`, that the new version starts from."),
    ],
    body: DevelopBody,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.start_development(db, plugin_id, version, body.bump, superuser.uuid)


@platform_router.post(
    "/{plugin_id}/revoke",
    summary="Revoke a plugin",
    description=(
        "Marks the plugin as revoked, so that it stops serving its widgets until a superuser restores it. The versions "
        "and the settings stay. Answers 404 when no plugin has that id. Only a superuser can call it."
    ),
)
async def revoke_plugin(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.set_status(db, plugin_id, True, superuser.uuid)


@platform_router.post(
    "/{plugin_id}/restore",
    summary="Restore a revoked plugin",
    description=(
        "Marks the plugin as enabled again when it has an active version, and as disabled when it has none, and resets "
        "the state of its backend. Answers 404 when no plugin has that id. Only a superuser can call it."
    ),
)
async def restore_plugin(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.set_status(db, plugin_id, False, superuser.uuid)


@platform_router.put(
    "/{plugin_id}/overrides",
    summary="Set the overrides of a plugin",
    description=(
        "Replaces the plugin's overrides of the frame policy (`csp`) and of the server network (`server_network`) with "
        "the ones in the request, after checking them. `confirmations` names the risky choices that the superuser "
        "accepts. Answers 422 with the list of errors when an override is not valid, and 404 when no plugin has that "
        "id. Only a superuser can call it."
    ),
)
async def put_overrides(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    body: OverridesBody,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.set_overrides(
        db, plugin_id, body.csp, body.server_network, list(body.confirmations), superuser.uuid
    )


@platform_router.post(
    "/{plugin_id}/backend/check",
    summary="Check a plugin's backend now",
    description=(
        "Contacts the plugin's registered backend, when it has one, and returns the state of its registration and "
        "identity. Answers 409 when no version of the plugin is active. Only a superuser can call it."
    ),
)
async def check_plugin_backend(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    _: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await calls.check_backend(db, plugin_id)


@platform_router.put(
    "/{plugin_id}/secrets/{name}",
    summary="Set a plugin secret",
    description=(
        "Stores the value of a secret that a version of the plugin declares. The body is "
        '`{"value": "<the secret>"}`. Answers 404 when no version declares the secret, 409 when the deployment '
        "sets the secret itself, and 422 when the body or the value is not valid. Only a superuser can call it."
    ),
)
async def put_plugin_secret(
    plugin_id: Annotated[str, Path(description="The id of the plugin.")],
    name: Annotated[str, Path(description="The name of the secret that the plugin declares.")],
    request: Request,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    body = await _json_object(request, MAX_SECRET_LENGTH * 2)
    if set(body) != {"value"} or not isinstance(body["value"], str):
        raise HTTPException(422, detail='The body is {"value": "<the secret>"}')
    await service.set_secret(
        db,
        _checked(plugin_id, PLUGIN_ID_PATTERN, "plugin"),
        _checked(name, NAME_PATTERN, "secret"),
        body["value"],
        superuser.uuid,
    )
    return {"success": True}


@platform_router.delete(
    "/{plugin_id}/secrets/{name}",
    summary="Clear a plugin secret",
    description=(
        "Deletes the stored value of a plugin's secret. Answers 404 when no value is stored. Only a superuser can call "
        "it."
    ),
)
async def delete_plugin_secret(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    name: Annotated[
        str, StringConstraints(pattern=NAME_PATTERN), Path(description="The name of the secret that the plugin declares.")
    ],
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    await service.clear_secret(db, plugin_id, name, superuser.uuid)
    return {"success": True}


@platform_router.put(
    "/{plugin_id}/entities",
    summary="Enable or disable a plugin for every organization",
    description=(
        "Sets whether the plugin is enabled for all organizations and returns how many organizations it changed, in the "
        "field `entities`. Only a superuser can call it."
    ),
)
async def put_plugin_all_entities(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    body: AllEntitiesChanges,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    count = await service.update_all_entities(
        db, plugin_id, body.model_dump(mode="json", exclude_unset=True), superuser.uuid
    )
    return {"success": True, "entities": count}


@platform_router.put(
    "/{plugin_id}/entities/{entity_uuid}",
    summary="Change a plugin for one organization",
    description=(
        "Applies the changes in the request to what one organization does with the plugin: enabling it, narrowing its "
        "permissions, frame sources and server hosts, mapping its data sources to the organization's backends, filling "
        "in its settings, and choosing which plugin renders a widget type. Answers 404 when the organization does not "
        "exist. Only a superuser can call it."
    ),
)
async def put_plugin_entity(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    entity_uuid: Annotated[UUID, Path(description="The UUID of the organization.")],
    body: EntityChanges,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    superuser: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    if await db.get(models.Entity, entity_uuid) is None:
        raise HTTPException(404, detail="Entity not found")
    await service.update_entity(
        db, entity_uuid, plugin_id, body.model_dump(mode="json", exclude_unset=True), superuser.uuid
    )
    return {"success": True}


@platform_router.get(
    "/{plugin_id}/events",
    summary="List the events of a plugin",
    description=(
        "Returns the recorded events of the plugin, newest first: versions that were found, changed, gone or back, "
        "approvals, blocks, revocations, restores, overrides, enablement, secrets and backend mismatches. Only a "
        "superuser can call it."
    ),
)
async def get_plugin_events(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    _: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.plugin_events(db, plugin_id)


@platform_router.get(
    "/{plugin_id}/csp-reports",
    summary="List the requests that a plugin's frame was refused",
    description=(
        "Returns the reports of requests that the plugin's frame policy refused, one for each directive and origin, "
        "most frequent first, with the version, the organization, the number of times it occurred and when it was first "
        "and last seen. Only a superuser can call it."
    ),
)
async def get_plugin_reports(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    _: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    return await service.list_reports(db, plugin_id)


@platform_router.delete(
    "/{plugin_id}",
    summary="Forget a plugin",
    description=(
        "Deletes the record of a plugin and its secrets. Answers 409 unless the files of all its versions are gone. "
        "Only a superuser can call it."
    ),
)
async def forget_plugin(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    _: Annotated[models.User, Depends(auth_helpers.get_current_superuser)],
):
    await service.forget(db, plugin_id)
    return {"success": True}


async def _admin_entity(db: AsyncSession, admin: Row) -> UUID:
    entity_uuid = await app_helpers.get_entity_uuid(db, admin.uuid)
    if entity_uuid is None:
        raise HTTPException(404, detail="Entity not found")
    return entity_uuid


@admin_router.get(
    "/plugins",
    summary="List the plugins of the organization",
    description=(
        "Returns whether the deployment has the plugin feature turned on, the plugins that are approved at the "
        "deployment with what the admin's organization has done with each, and the organization's backends that a "
        "plugin's data source can map to."
    ),
)
async def list_entity_plugins(
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    entity_uuid = await _admin_entity(db, admin)
    return {
        "enabled": service.feature_enabled(),
        "plugins": await service.entity_listing(db, entity_uuid),
        "backends": await service.entity_backends(db, entity_uuid),
    }


@admin_router.put(
    "/plugins/{plugin_id}",
    summary="Change a plugin for the organization",
    description=(
        "Applies the changes in the request to what the admin's organization does with the plugin: enabling it, "
        "narrowing its permissions, frame sources and server hosts, mapping its data sources to the organization's "
        "backends, filling in its settings, choosing which plugin renders a widget type, and setting how many presets "
        "each user may keep of each widget."
    ),
)
async def put_entity_plugin(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    body: EntityChanges,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    await service.update_entity(
        db, await _admin_entity(db, admin), plugin_id, body.model_dump(mode="json", exclude_unset=True), admin.uuid
    )
    return {"success": True}


@admin_router.get(
    "/plugins/{plugin_id}/csp-reports",
    summary="List the requests that a plugin's frame was refused for the organization",
    description=(
        "Returns the reports of requests that the plugin's frame policy refused for users of the admin's organization, "
        "one for each directive and origin, most frequent first, with the number of times it occurred and when it was "
        "first and last seen."
    ),
)
async def get_entity_plugin_reports(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    return await service.list_reports(db, plugin_id, await _admin_entity(db, admin))


@admin_router.get(
    "/plugins/{plugin_id}/events",
    summary="List the events of a plugin for the organization",
    description="Returns the recorded events of the plugin that concern the admin's organization, newest first.",
)
async def get_entity_plugin_events(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    return await service.plugin_events(db, plugin_id, await _admin_entity(db, admin))


@admin_router.get(
    "/plugins/{plugin_id}/widgets/{widget_id}/presets",
    summary="List the organization's presets of a plugin widget",
    description=(
        "Returns `{ presets }`, the presets that the admin's organization publishes for the widget, ordered by name. "
        "Each preset is `{ id, name, scope, is_default, config, state, updated_at }`. Answers 404 when the plugin has "
        "no approved version with that widget."
    ),
)
async def get_org_presets(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    target = await presets.org_target(db, await _admin_entity(db, admin), plugin_id, widget_id)
    return {"presets": await presets.listing(db, target)}


@admin_router.post(
    "/plugins/{plugin_id}/widgets/{widget_id}/presets",
    summary="Publish a preset of a plugin widget to the organization",
    description=(
        "Saves a preset that every user of the admin's organization who may use the widget can apply, and returns it. "
        "Making it the default replaces the organization's previous default for the widget. Answers 404 when the "
        "plugin has no approved version with that widget, 422 when the name or the settings are not valid, and 413 "
        "when the state is too large."
    ),
)
async def post_org_preset(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    body: PresetBody,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    target = await presets.org_target(db, await _admin_entity(db, admin), plugin_id, widget_id)
    return await presets.create(db, target, body.model_dump())


@admin_router.patch(
    "/plugins/{plugin_id}/widgets/{widget_id}/presets/{preset_id}",
    summary="Change a preset that the organization publishes",
    description=(
        "Applies the changes in the request to one of the organization's presets of the widget and returns it. Making "
        "it the default replaces the organization's previous default for the widget. Answers 404 when the preset does "
        "not exist, 422 when the name or the settings are not valid, and 413 when the state is too large."
    ),
)
async def patch_org_preset(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    preset_id: PresetId,
    body: PresetChanges,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    target = await presets.org_target(db, await _admin_entity(db, admin), plugin_id, widget_id)
    return await presets.change(db, target, preset_id, body.model_dump(exclude_unset=True))


@admin_router.delete(
    "/plugins/{plugin_id}/widgets/{widget_id}/presets/{preset_id}",
    summary="Delete a preset that the organization publishes",
    description="Deletes one of the organization's presets of the widget. Answers 404 when the preset does not exist.",
)
async def delete_org_preset(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    preset_id: PresetId,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    target = await presets.org_target(db, await _admin_entity(db, admin), plugin_id, widget_id)
    await presets.remove(db, target, preset_id)
    return {"success": True}


@admin_router.get(
    "/role/{role_uuid}/plugin-access",
    response_model=RoleGrants,
    summary="List the plugin widgets that a role grants",
    description=(
        "Returns the plugin widgets that the role grants, each as a plugin id and a widget id, where `*` stands for "
        "every widget of the plugin. Answers 404 when the role does not exist in the organization."
    ),
)
async def get_role_plugin_access(
    role_uuid: Annotated[UUID, Path(description="The UUID of the role.")],
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    if not await app_helpers.role_exists(db, role_uuid, await _admin_entity(db, admin)):
        raise HTTPException(404, detail="Role not found")
    return {"grants": await service.get_role_grants(db, role_uuid)}


@admin_router.put(
    "/role/{role_uuid}/plugin-access",
    summary="Set the plugin widgets that a role grants",
    description=(
        "Replaces the plugin widgets that the role grants with the list in the request. Answers 404 when the role does "
        "not exist in the organization."
    ),
)
async def put_role_plugin_access(
    role_uuid: Annotated[UUID, Path(description="The UUID of the role.")],
    body: RoleGrants,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    admin: Annotated[Row, Depends(auth_helpers.get_current_admin)],
):
    if not await app_helpers.role_exists(db, role_uuid, await _admin_entity(db, admin)):
        raise HTTPException(404, detail="Role not found")
    await service.set_role_grants(db, role_uuid, [g.model_dump() for g in body.grants])
    return {"success": True}


@app_router.get(
    "",
    summary="List the plugins that the user may use",
    description=(
        "Returns `{ enabled, etag, plugins, vizHandlers }`, which describes the plugins and the widget types that the "
        "signed-in user may use. The answer carries an `ETag` and the header `Cache-Control: private, no-cache`."
    ),
)
@limiter.limit(LIMIT_DEFAULT)
async def get_available_plugins(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    listing = await service.user_listing(db, user.uuid)
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["ETag"] = f'"{listing["etag"]}"'
    return listing


@app_router.get(
    "/widgets-schema",
    summary="Get the widgets.json schema of the user's organization",
    description=(
        "Returns the JSON Schema of `widgets.json`, extended with the widget types that the organization's plugins add. "
        "The answer carries an `ETag`, and a request whose `If-None-Match` names it receives 304. A superuser can read "
        "the schema of another organization with the query parameter `entity`, and other users receive 403 when they "
        "name one."
    ),
)
@limiter.limit(LIMIT_DEFAULT)
async def get_widgets_schema(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid", "is_superuser"], app_session=True)),
    entity: Annotated[
        UUID | None,
        Query(description="The UUID of the organization whose schema to read. Only a superuser may name one."),
    ] = None,
):
    if entity is not None and not user.is_superuser:
        raise HTTPException(403, detail="Only a superuser may read another entity's schema")
    entity_uuid = entity if entity is not None else await service.user_entity(db, user.uuid)
    etag, schema = await widgets_schema.schema_for_entity(db, entity_uuid, service.feature_enabled())
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["ETag"] = f'"{etag}"'
    if request.headers.get("if-none-match") == f'"{etag}"':
        return Response(status_code=304, headers={"ETag": f'"{etag}"', "Cache-Control": "private, no-cache"})
    return schema


@app_router.get(
    "/{plugin_id}/widgets/{widget_id}/presets",
    summary="List the presets of a plugin widget",
    description=(
        "Returns `{ presets, limit }`: the signed-in user's own presets of the widget, then the presets that the "
        "organization publishes, each group ordered by name, and how many presets the user may keep of the widget. "
        "Each preset is `{ id, name, scope, is_default, config, state, updated_at }`, where `scope` is `user` or "
        "`org`. Answers 404 when the user may not use the widget."
    ),
)
async def get_presets(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    target, limit = await presets.user_target(db, user.uuid, plugin_id, widget_id)
    return {"presets": await presets.listing(db, target), "limit": limit}


@app_router.post(
    "/{plugin_id}/widgets/{widget_id}/presets",
    summary="Save a preset of a plugin widget",
    description=(
        "Saves the settings and the state in the request as a preset of the signed-in user, which they can apply on "
        "any of their dashboards, and returns it. Making it the default replaces the user's previous default for the "
        "widget. Answers 404 when the user may not use the widget, 409 when the user already keeps as many presets of "
        "the widget as the organization allows, 422 when the name or the settings are not valid, and 413 when the "
        "state is too large."
    ),
)
async def post_preset(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    body: PresetBody,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    target, limit = await presets.user_target(db, user.uuid, plugin_id, widget_id)
    return await presets.create(db, target, body.model_dump(), limit)


@app_router.patch(
    "/{plugin_id}/widgets/{widget_id}/presets/{preset_id}",
    summary="Change a preset of a plugin widget",
    description=(
        "Applies the changes in the request to one of the signed-in user's own presets and returns it. Making it the "
        "default replaces the user's previous default for the widget. Answers 404 when the preset is not one of the "
        "user's own, 422 when the name or the settings are not valid, and 413 when the state is too large."
    ),
)
async def patch_preset(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    preset_id: PresetId,
    body: PresetChanges,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    target, _ = await presets.user_target(db, user.uuid, plugin_id, widget_id)
    return await presets.change(db, target, preset_id, body.model_dump(exclude_unset=True))


@app_router.delete(
    "/{plugin_id}/widgets/{widget_id}/presets/{preset_id}",
    summary="Delete a preset of a plugin widget",
    description=(
        "Deletes one of the signed-in user's own presets. Answers 404 when the preset is not one of the user's own."
    ),
)
async def delete_preset(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    widget_id: WidgetId,
    preset_id: PresetId,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    target, _ = await presets.user_target(db, user.uuid, plugin_id, widget_id)
    await presets.remove(db, target, preset_id)
    return {"success": True}


@app_router.get(
    "/{plugin_id}/{digest}/files/{file_path:path}",
    summary="Download a file of a plugin version",
    description=(
        "Returns a file of the approved plugin version whose digest is in the path, as `application/octet-stream` with "
        "`Content-Disposition: attachment`. The API checks the file against its recorded hash and lets the browser "
        "cache it for good. The user must be allowed to use the plugin."
    ),
)
async def get_plugin_file(
    plugin_id: Annotated[PluginId, Path(description="The id of the plugin.")],
    digest: Annotated[str, StringConstraints(max_length=80), Path(description="The digest of the plugin version.")],
    file_path: Annotated[
        str, StringConstraints(max_length=200), Path(description="The path of the file inside the plugin version.")
    ],
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    path, info = await service.served_file(db, user.uuid, plugin_id, digest, file_path)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": "attachment",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable",
            "ETag": f'"{info["sha256"]}"',
        },
    )


@app_router.post(
    "/{plugin_id}/proxy/{proxy_id}",
    summary="Call a proxy of a plugin",
    description=(
        "Runs one of the proxies that the plugin's manifest declares on behalf of the signed-in user. The body is "
        '`{"widget": "<widget id>", "args": {...}}`, and the answer is `{ content_type, body }`. Answers 404 '
        "when the plugin, the widget or the proxy does not exist, 422 when the body is not valid, 413 when it is "
        "too large, and a refusal with `{ code, message }` when the call is not allowed or fails."
    ),
)
async def post_proxy_call(
    plugin_id: Annotated[str, Path(description="The id of the plugin.")],
    proxy_id: Annotated[str, Path(description="The id of a proxy that the plugin's manifest declares.")],
    request: Request,
    db: Annotated[AsyncSession, Depends(aget_read_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    body = await _json_object(request, MAX_CALL_BODY)
    widget_id, args = body.get("widget"), body.get("args", {})
    if set(body) - {"widget", "args"} or not isinstance(widget_id, str) or not isinstance(args, dict):
        raise HTTPException(422, detail='The body is {"widget": "<widget id>", "args": {...}}')
    try:
        result = await calls.proxy_call(
            db,
            user.uuid,
            _checked(plugin_id, PLUGIN_ID_PATTERN, "plugin"),
            _checked(widget_id, WIDGET_ID_PATTERN, "widget"),
            _checked(proxy_id, PROXY_ID_PATTERN, "proxy"),
            args,
        )
    except CallError as error:
        raise HTTPException(error.status, detail={"code": error.code, "message": error.message}) from None
    return {"content_type": result.content_type, "body": result.body}


@app_router.post(
    "/{plugin_id}/backend/{route_id}",
    summary="Call a route of a plugin's backend",
    description=(
        "Calls a route of the plugin's backend on behalf of the signed-in user. The body is "
        '`{"widget": "<widget id>", "instance": "<id>", "args": {...}}`, and the answer is `{ body }`. '
        "Answers 404 when the plugin, the widget or the route does not exist, 422 when the body is not valid, 413 "
        "when it is too large, and a refusal with `{ code, message }` when the call is not allowed or fails."
    ),
)
async def post_backend_call(
    plugin_id: Annotated[str, Path(description="The id of the plugin.")],
    route_id: Annotated[str, Path(description="The id of a backend route that the plugin's manifest declares.")],
    request: Request,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    body = await _json_object(request, MAX_CALL_BODY)
    widget_id, instance_id, args = body.get("widget"), body.get("instance", ""), body.get("args", {})
    if (
        set(body) - {"widget", "instance", "args"}
        or not isinstance(widget_id, str)
        or not isinstance(instance_id, str)
        or len(instance_id) > MAX_INSTANCE_ID
        or not isinstance(args, dict)
    ):
        raise HTTPException(422, detail='The body is {"widget": "<widget id>", "instance": "<id>", "args": {...}}')
    try:
        result = await calls.backend_call(
            db,
            user.uuid,
            _checked(plugin_id, PLUGIN_ID_PATTERN, "plugin"),
            _checked(widget_id, WIDGET_ID_PATTERN, "widget"),
            instance_id,
            _checked(route_id, PROXY_ID_PATTERN, "route"),
            args,
        )
    except CallError as error:
        raise HTTPException(error.status, detail={"code": error.code, "message": error.message}) from None
    return {"body": result.body}


@app_router.post(
    "/report",
    summary="Report refused requests and frame failures",
    description=(
        "Stores the reports that the web app sends when a plugin's frame policy refuses a request, and the failure of a "
        "frame, for the plugin version in the body. The answer is `{ stored }`, the number of reports that the API "
        "kept."
    ),
)
@limiter.limit(LIMIT_DEFAULT)
async def post_plugin_report(
    request: Request,
    body: ReportBody,
    db: Annotated[AsyncSession, Depends(aget_write_db)],
    user=Depends(auth_helpers.GetCurrentUser(["uuid"], app_session=True)),
):
    stored = await service.record_reports(
        db, user.uuid, body.plugin_id, body.version, [r.model_dump() for r in body.reports], body.failure
    )
    return {"stored": stored}


@broker_router.post(
    "/data/{data_source_id}",
    summary="Read from a data source for a plugin backend",
    description=(
        "Lets a plugin's backend read through FINOS Workspace from the backend that an organization mapped to the data "
        "source. The caller proves the call with the header `X-Workspace-Call`, and the body is `{ path, method, query, "
        "body }`, where `path` starts with `/` below the mapped backend's address. Browsers do not call this route. "
        "Answers 404 when the data source does not exist, 422 when the body is not valid, and a refusal with `{ code, "
        "message }` when the call is not allowed or fails."
    ),
)
async def post_broker_read(
    data_source_id: Annotated[
        str, Path(description="The id of the data source that the organization mapped to a backend.")
    ],
    request: Request,
    db: Annotated[AsyncSession, Depends(aget_read_db)],
):
    token = request.headers.get(backends.CALL_HEADER, "")
    body = await _json_object(request, MAX_CALL_BODY)
    if set(body) - {"path", "method", "query", "body"} or not isinstance(body.get("path"), str):
        raise HTTPException(422, detail='The body is {"path": "/...", "method", "query", "body"}')
    try:
        return await broker.read(db, token, _checked(data_source_id, DATA_SOURCE_PATTERN, "data source"), body)
    except CallError as error:
        raise HTTPException(error.status, detail={"code": error.code, "message": error.message}) from None


routers = [platform_router, admin_router, app_router, broker_router]
