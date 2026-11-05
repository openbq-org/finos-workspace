import asyncio
from time import time
from types import SimpleNamespace
from typing import Literal
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from loguru import logger
from sqlalchemy import and_, case, delete, false, func, insert, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.sql import quoted_name

from api import base, crud, database, models, schemas, source_proxy
from api.auth_helpers import CustomRow
from api.widget_plugins import service as widget_plugin_service
from utilities.config import settings

EXCEPTION_401 = HTTPException(
    status.HTTP_401_UNAUTHORIZED,
    detail="Incorrect username or password",
    headers={"WWW-Authenticate": "Bearer"},
)


async def set_app_user_data(user, db: AsyncSession) -> schemas.AppUserReturn:
    own_connections = await may_add_connections(db, user.uuid)
    return schemas.AppUserReturn(
        expiration_date=user.expiration_date,
        first_name=user.first_name,
        last_name=user.last_name,
        display_settings=user.display_settings,
        file_widgets=[x.__dict__ for x in user.FileWidget] if own_connections else [],
        api_sources=[x.__dict__ for x in user.ApiSource] if own_connections else [],
        username=user.username,
        email=user.email,
        uuid=user.uuid,
        entity_info=await _get_user_entity_info(db, user.uuid),
    )


async def get_mcp_servers(db: AsyncSession, user: models.User) -> schemas.MCPServers:
    stored: list[dict] = []
    headers: dict = {}
    if await may_add_connections(db, user.uuid):
        query = (
            select(models.MCPServers.servers, models.MCPServers.headers)
            .where(models.MCPServers.user_uuid == user.uuid)
            .limit(1)
        )
        row = (await db.execute(query)).first()
        if row is not None:
            stored = row.servers or []
            headers = row.headers or {}
    has = {schemas.normalize_mcp_url(server["url"]) for server in stored}
    defaults = [
        schemas.MCPServer(id=server.id, name=server.name, url=server.url, enabled=True)
        for server in settings.DEFAULT_MCP_SERVERS
        if schemas.normalize_mcp_url(server.url) not in has
    ]
    own = [
        {
            **server,
            **schemas.mcp_header_flags(headers.get(schemas.normalize_mcp_url(server["url"]))),
        }
        for server in stored
    ]
    return schemas.MCPServers(servers=[*defaults, *own])


def merge_mcp_server_headers(
    stored: dict[str, dict[str, str]], servers: list[schemas.MCPServer]
) -> dict[str, dict[str, str]]:
    merged: dict[str, dict[str, str]] = {}
    for server in servers:
        key = schemas.normalize_mcp_url(server.url)
        current = dict(merged.get(key) or stored.get(key) or {})
        for name, value in (server.custom_headers or {}).items():
            current = {k: v for k, v in current.items() if k.lower() != name.lower()}
            if value is not None:
                current[name] = value
        if current:
            merged[key] = current
    return merged


async def save_mcp_servers(db: AsyncSession, user_uuid: UUID, servers: list[schemas.MCPServer]) -> None:
    row = (
        await db.execute(
            select(models.MCPServers.uuid, models.MCPServers.headers)
            .where(models.MCPServers.user_uuid == user_uuid)
            .limit(1)
        )
    ).first()
    values = {
        "servers": [server.stored_fields() for server in servers],
        "headers": merge_mcp_server_headers(row.headers or {} if row else {}, servers) or None,
    }
    if row is None:
        await db.execute(insert(models.MCPServers).values(user_uuid=user_uuid, **values))
    else:
        await db.execute(update(models.MCPServers).where(models.MCPServers.user_uuid == user_uuid).values(**values))
    await db.commit()


async def get_mcp_server_headers(db: AsyncSession, user_uuid: UUID, url: str) -> dict[str, str] | None:
    row = (
        await db.execute(
            select(models.MCPServers.servers, models.MCPServers.headers)
            .where(models.MCPServers.user_uuid == user_uuid)
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    target = schemas.normalize_mcp_url(url)
    if not any(schemas.normalize_mcp_url(server["url"]) == target for server in row.servers or []):
        return None
    return dict((row.headers or {}).get(target) or {})


async def get_copilot_key_status(db: AsyncSession, user_uuid: UUID) -> schemas.CopilotKeysStatus:
    row = (
        await db.execute(
            select(
                models.User.openai_api_key.is_not(None).label("has_openai_key"),
                models.User.perplexity_api_key.is_not(None).label("has_perplexity_key"),
            ).where(models.User.uuid == user_uuid)
        )
    ).first()
    if row is None:
        return schemas.CopilotKeysStatus()
    return schemas.CopilotKeysStatus(
        has_openai_key=bool(row.has_openai_key),
        has_perplexity_key=bool(row.has_perplexity_key),
    )


async def get_copilot_provider_keys(db: AsyncSession, user_uuid: UUID) -> schemas.CopilotProviderKeys:
    row = (
        await db.execute(
            select(models.User.openai_api_key, models.User.perplexity_api_key).where(models.User.uuid == user_uuid)
        )
    ).first()
    if row is None:
        return schemas.CopilotProviderKeys()
    return schemas.CopilotProviderKeys(openai_api_key=row.openai_api_key, perplexity_api_key=row.perplexity_api_key)


async def set_copilot_provider_keys(db: AsyncSession, user_uuid: UUID, keys: schemas.CopilotProviderKeys) -> None:
    values = {name: getattr(keys, name) for name in keys.model_fields_set}
    if values:
        await db.execute(update(models.User).where(models.User.uuid == user_uuid).values(**values))
        await db.commit()


async def get_copilot_chats(db: AsyncSession, user_uuid: UUID) -> list[schemas.ChatInfo | schemas.Chat]:

    last_opened_query = (
        select(models.CopilotChat)
        .options(selectinload(models.CopilotChat.messages))
        .where(models.CopilotChat.user_uuid == user_uuid)
        .order_by(models.CopilotChat.last_opened.desc())
        .limit(1)
    )
    last_opened = (await db.execute(last_opened_query)).scalar_one_or_none()

    latest_uuid = last_opened.uuid if last_opened else None

    query = (
        select(
            models.CopilotChat.uuid,
            models.CopilotChat.content,
            models.CopilotChat.created_date,
            models.CopilotChat.updated_date,
        )
        .where(models.CopilotChat.user_uuid == user_uuid)
        .order_by(models.CopilotChat.created_date.desc())
    )
    chats: list[schemas.ChatInfo | schemas.Chat] = []

    async for v in (await db.stream(query)).mappings():
        row = CustomRow(**v)
        chats.append(schemas.Chat.from_row(last_opened if row.uuid == latest_uuid else row))

    return chats or schemas.default_chats()


async def get_user_questions_history(db: AsyncSession, user_uuid: UUID) -> list[str]:
    query = (
        select(models.ChatMessages.searchable_content)
        .where(
            models.ChatMessages.user_uuid == user_uuid,
            models.ChatMessages.role == base.ChatMessageRole.human,
            models.ChatMessages.searchable_content.isnot(None),
        )
        .group_by(models.ChatMessages.searchable_content)
        .order_by(func.max(models.ChatMessages.updated_date).asc())
    )
    return (await db.execute(query)).scalars().all()


async def get_stored_theme_settings(db: AsyncSession, entity_uuid: UUID) -> models.EntityThemeSettings | None:
    query = select(models.EntityThemeSettings).where(models.EntityThemeSettings.entity_uuid == entity_uuid).limit(1)
    return (await db.execute(query)).scalar_one_or_none()


async def get_entity_theme_settings(db: AsyncSession, entity_uuid: UUID):
    stored = await get_stored_theme_settings(db, entity_uuid)
    result = stored.settings if stored else None
    if not result:
        return schemas.EntityThemeSettings()

    settings = schemas.EntityThemeSettings.model_validate(result)
    active = str(result.get("active_preset") or "")
    for preset in result.get("presets", []):
        if str(preset.get("uuid")) == active:
            settings.properties = schemas.ThemeVariants.model_validate({"light": preset["light"], "dark": preset["dark"]})
    return settings


async def save_stored_theme_settings(
    db: AsyncSession,
    entity_uuid: UUID,
    stored: models.EntityThemeSettings | None,
    settings: dict,
) -> None:
    if stored:
        stored.settings = settings
    else:
        db.add(models.EntityThemeSettings(entity_uuid=entity_uuid, settings=settings))
    await db.commit()


async def user_app_task(type: Literal["owned", "shared"], user_uuid: UUID) -> crud.UserApps:
    start_time = time()
    try:
        async with database.AsyncReadSessionLocal.session() as session:
            if type == "owned":
                return await crud.get_user_apps_owned(session, user_uuid)
            if type == "shared":
                return await crud.get_user_apps_shared(session, user_uuid)
    except Exception as e:
        logger.exception(e)
    finally:
        logger.warning(
            f"User app task {type} took {(time() - start_time) * 1000:.2f}ms",
            exclude=True,
        )
    return {}


async def get_user_apps_complete(user: models.User) -> schemas.UserAppsComplete:
    tasks: list[asyncio.Task[crud.UserApps]] = [
        asyncio.create_task(user_app_task("owned", user.uuid)),
        asyncio.create_task(user_app_task("shared", user.uuid)),
    ]

    owned, shared = await asyncio.gather(*tasks)

    return schemas.UserAppsComplete(owned=owned, shared=shared)


async def dashboard_task(
    type: Literal["owned", "shared", "entity_shared"],
    user_uuid: UUID,
    permissions_uuid: UUID | None = None,
) -> crud.UserDashboards:
    start_time = time()
    try:
        async with database.AsyncReadSessionLocal.session() as session:
            if type == "owned":
                return await crud.get_user_dashboards_owned(session, user_uuid)
            if type == "shared":
                return await crud.get_user_dashboards_shared(session, user_uuid)
            if type == "entity_shared":
                return await crud.get_user_dashboards_entity_shared(session, user_uuid, permissions_uuid)
    except Exception as e:
        logger.exception(e)
    finally:
        logger.warning(
            f"Dashboard task {type} took {(time() - start_time) * 1000:.2f}ms",
            exclude=True,
        )
    return {}


async def get_dashboards_complete(user: models.User) -> schemas.DashboardComplete:
    tasks: list[asyncio.Task[crud.UserDashboards]] = [
        asyncio.create_task(dashboard_task("owned", user.uuid)),
        asyncio.create_task(dashboard_task("shared", user.uuid)),
        asyncio.create_task(dashboard_task("entity_shared", user.uuid, user.permissions_uuid)),
    ]

    owned, shared, entity_shared = await asyncio.gather(*tasks)

    entity_shared = {k: v for k, v in entity_shared.items() if k not in shared}

    return schemas.DashboardComplete(owned=owned, shared=shared, entity_shared=entity_shared)


def check_login(user: schemas.UserLogin, db_user: schemas.AppUserSchema | None):
    if not db_user:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="The provided credentials do not match any registered user account.",
        )

    if not user._bypass_password_check and not base.verify_password(user.password, db_user.password):
        raise EXCEPTION_401


async def get_entity_uuid(db: AsyncSession, user_uuid: UUID) -> UUID:
    entity_query = (
        select(models.Entity.uuid)
        .select_from(models.User)
        .join(
            models.PermissionsEntityMap,
            models.User.permissions_uuid == models.PermissionsEntityMap.uuid,
            isouter=True,
        )
        .join(
            models.Entity,
            models.PermissionsEntityMap.entity_uuid == models.Entity.uuid,
            isouter=True,
        )
        .where(models.User.uuid == user_uuid)
        .limit(1)
    )
    entity_uuid = (await db.execute(entity_query)).scalar_one_or_none()

    return entity_uuid


async def get_entity_users(db: AsyncSession, entity_uuid: UUID):
    query = (
        select(models.User.uuid)
        .select_from(models.User)
        .join(
            models.PermissionsEntityMap,
            models.PermissionsEntityMap.uuid == models.User.permissions_uuid,
        )
        .join(models.Entity, models.Entity.uuid == models.PermissionsEntityMap.entity_uuid)
        .where(models.Entity.uuid == entity_uuid)
    )
    return (await db.execute(query)).scalars().all()


async def get_user_type(db: AsyncSession, user_uuid: UUID) -> str | None:
    query = (
        select(models.PermissionsEntityMap.name)
        .join(
            models.User,
            models.User.permissions_uuid == models.PermissionsEntityMap.uuid,
        )
        .where(models.User.uuid == user_uuid)
    )
    user_type = (await db.execute(query)).scalar_one_or_none()
    return user_type if user_type in models.USER_TYPES else None


async def may_add_connections(db: AsyncSession, user_uuid: UUID) -> bool:
    return await get_user_type(db, user_uuid) in models.CONNECTION_TYPES


async def check_may_add_connections(db: AsyncSession, user_uuid: UUID) -> None:
    if not await may_add_connections(db, user_uuid):
        raise HTTPException(403, detail="Your account type cannot add connections")


async def readable_backends(db: AsyncSession, user_uuid: UUID, entity_uuid: UUID | None):
    rules = []
    if entity_uuid is not None:
        granted = (
            select(models.RoleBackend.backend_uuid)
            .join(models.UserRole, models.UserRole.role_uuid == models.RoleBackend.role_uuid)
            .join(models.Role, models.Role.uuid == models.RoleBackend.role_uuid)
            .where(
                models.UserRole.user_uuid == user_uuid,
                models.Role.entity_uuid == entity_uuid,
                models.Role.deleted_at.is_(None),
                models.RoleBackend.access == "access",
            )
        )
        rules.append(models.ApiSource.uuid.in_(granted))
    if await may_add_connections(db, user_uuid):
        rules.append(models.ApiSource.user_uuid == user_uuid)
    return or_(*rules) if rules else false()


async def get_backend_mcp_grants(db: AsyncSession, user_uuid: UUID) -> list[schemas.McpGrant]:
    readable = await readable_backends(db, user_uuid, await get_entity_uuid(db, user_uuid))
    rows = (await db.execute(select(models.ApiSource.mcp_servers).where(readable))).scalars()
    urls = {url for servers in rows for url in servers or []}
    return [schemas.McpGrant.model_construct(server_url=url, tool_name=schemas.ALL_MCP_TOOLS) for url in sorted(urls)]


async def get_own_mcp_grants(db: AsyncSession, user_uuid: UUID) -> list[schemas.McpGrant]:
    if not await may_add_connections(db, user_uuid):
        return []
    servers = (
        await db.execute(select(models.MCPServers.servers).where(models.MCPServers.user_uuid == user_uuid).limit(1))
    ).scalar_one_or_none()
    defaults = {schemas.mcp_host_and_port(server.url) for server in settings.DEFAULT_MCP_SERVERS}
    urls = {
        schemas.normalize_mcp_url(server["url"])
        for server in servers or []
        if schemas.mcp_host_and_port(server["url"]) not in defaults
    }
    return [schemas.McpGrant.model_construct(server_url=url, tool_name=schemas.ALL_MCP_TOOLS) for url in sorted(urls)]


async def shares_need_approval(db: AsyncSession, user_uuid: UUID) -> bool:
    return await get_user_type(db, user_uuid) == models.DEVELOPER_TYPE


def _user_roles(user_uuid: UUID, *columns):
    return (
        select(*columns)
        .select_from(models.UserRole)
        .join(models.Role, models.Role.uuid == models.UserRole.role_uuid)
        .join(models.User, models.User.uuid == models.UserRole.user_uuid)
        .join(
            models.PermissionsEntityMap,
            models.PermissionsEntityMap.uuid == models.User.permissions_uuid,
        )
        .where(
            models.UserRole.user_uuid == user_uuid,
            models.Role.deleted_at.is_(None),
            models.Role.entity_uuid == models.PermissionsEntityMap.entity_uuid,
        )
    )


async def get_user_access(db: AsyncSession, user_uuid: UUID) -> schemas.UserAccess:
    return schemas.UserAccess(
        user_type=await get_user_type(db, user_uuid),
        sharing=(await crud.get_users_sharing(db, [user_uuid]))[user_uuid],
    )


async def get_user_limits(db: AsyncSession, user_uuid: UUID) -> schemas.UserLimits:
    if await get_user_type(db, user_uuid) == models.DEVELOPER_TYPE:
        return schemas.UserLimits(copilot_calls_day=None, copilot_tokens_day=None, upload_size_gb=None)

    roles = (
        await db.execute(
            _user_roles(
                user_uuid,
                models.Role.copilot_calls_day,
                models.Role.copilot_tokens_day,
                models.Role.upload_size_gb,
            )
        )
    ).all()

    def highest(values: list[int | None]) -> int | None:
        if not values:
            return 0
        if any(value is None for value in values):
            return None
        return max(values)

    return schemas.UserLimits(
        copilot_calls_day=highest([role.copilot_calls_day for role in roles]),
        copilot_tokens_day=highest([role.copilot_tokens_day for role in roles]),
        upload_size_gb=highest([role.upload_size_gb for role in roles]),
    )


def invalidate_usage_cache(user_uuid: UUID) -> None:
    settings.redis_cache(f"usage:{user_uuid}", delete=True)


async def roles_changed(db: AsyncSession, user_uuids: list[UUID]) -> None:
    for user_uuid in user_uuids:
        invalidate_usage_cache(user_uuid)
    await crud.revoke_disallowed_shares(db, user_uuids)


async def left_organization(db: AsyncSession, user_uuid: UUID) -> None:
    await crud.leave_other_organizations(db, user_uuid)
    await roles_changed(db, [user_uuid])


async def check_usage_cache(db: AsyncSession, user: models.User) -> schemas.UsageGet:
    from api.worker_tasks import update_user_usage_cache  # noqa: PLC0415

    cache_key = f"usage:{user.uuid}"

    if usage := settings.redis_cache(cache_key):
        return schemas.UsageGet.model_validate(usage)

    if (user_usage := await update_user_usage_cache(user.uuid)) is None:
        user_usage = await _create_usage(user, db)

    return settings.redis_cache(cache_key, user_usage, update=True)


async def _create_usage(user: models.User, db: AsyncSession) -> schemas.UsageGet:
    limits = await get_user_limits(db, user.uuid)

    select_query = select(func.sum(models.StoredFile.size)).where(models.StoredFile.creater_uuid == user.uuid)
    total_file_bytes = (await db.execute(select_query)).scalar_one_or_none()

    total_file_upload_size_gb_count = (total_file_bytes / (1024**3)) if total_file_bytes else 0

    usage = models.UserUsage(
        user_uuid=user.uuid,
        number_copilot_calls_day_count=0,
        total_file_upload_size_gb_count=total_file_upload_size_gb_count,
    )

    db.add(usage)
    await db.commit()

    user_usage = {
        "copilot_calls_limit": limits.copilot_calls_day,
        "copilot_tokens_limit": limits.copilot_tokens_day,
        "file_upload_size_limit": limits.upload_size_gb,
        "number_copilot_calls_day_count": 0,
        "number_copilot_tokens_day_count": 0,
        "total_file_upload_size_gb_count": total_file_upload_size_gb_count or 0,
    }

    return schemas.UsageGet.model_validate(user_usage)


async def get_widget_metadata(
    db: AsyncSession,
    user: models.User,
    widget_id: UUID | None = None,
    widget_type: str | None = None,
    name: str | None = None,
):
    query = select(
        models.WidgetMetadata.name,
        models.WidgetMetadata.description,
        models.WidgetMetadata.source,
        models.WidgetMetadata.category,
        models.WidgetMetadata.sub_category,
        models.WidgetMetadata.widget_type,
        models.WidgetMetadata.storage,
        models.WidgetMetadata.widget_config,
        models.WidgetMetadata.widget_id,
    ).where(
        models.WidgetMetadata.user_uuid == user.uuid,
    )
    if widget_id:
        query = query.where(models.WidgetMetadata.widget_id == widget_id)
    elif widget_type:
        query = query.where(models.WidgetMetadata.widget_type == widget_type)
        if name:
            query = query.where(models.WidgetMetadata.name == name)

    result = (await db.execute(query)).all()
    return [schemas.WidgetMetadataResponse.model_validate(item._asdict()) for item in result]


async def _get_user_entity_info(db: AsyncSession, user_uuid: UUID) -> schemas.UserEntityInfo:
    query = (
        select(models.Entity.name, models.PermissionsEntityMap.name.label("permission"))
        .select_from(models.User)
        .where(models.User.uuid == user_uuid)
        .outerjoin(
            models.PermissionsEntityMap,
            models.PermissionsEntityMap.uuid == models.User.permissions_uuid,
        )
        .outerjoin(models.Entity, models.Entity.uuid == models.PermissionsEntityMap.entity_uuid)
    )
    result = (await db.execute(query)).first()
    return schemas.UserEntityInfo(entity_name=result.name, permission_name=result.permission)


async def delete_user(db: AsyncSession, user_uuid: UUID) -> bool:
    user_details_query = select(
        models.User.email,
        models.User.username,
        models.User.clean_email,
    ).where(models.User.uuid == user_uuid)
    user_details = (await db.execute(user_details_query)).first()
    if not user_details:
        raise HTTPException(status_code=404, detail="User not found")

    query = delete(models.Session).where(models.Session.user_uuid == user_uuid)
    await db.execute(query)
    the_rand = base.random_string(4)
    query2 = (
        update(models.User)
        .where(models.User.uuid == user_uuid)
        .values(
            deleted=True,
            email=f"deleted-{the_rand}-{user_details.email}",
            username=f"deleted-{the_rand}-{user_details.username}",
            clean_email=f"deleted-{the_rand}-{user_details.clean_email}",
            password=str(uuid4()),
            permissions_uuid=None,
        )
    )
    response = await db.execute(query2)
    await db.commit()
    await left_organization(db, user_uuid)
    return response.rowcount == 1


def replace_headers(stored: dict[str, str] | None, incoming: dict[str, str] | None) -> dict[str, str]:
    if incoming is None:
        return dict(stored or {})
    kept = {name.lower(): value for name, value in (stored or {}).items()}
    return {name: value or kept[name.lower()] for name, value in incoming.items() if value or name.lower() in kept}


async def insert_or_update_custom_copilot(db: AsyncSession, user_uuid: UUID, custom_copilot: schemas.CustomCopilot):
    stored = (
        await db.execute(
            select(models.CustomCopilot.url, models.CustomCopilot.headers).where(
                models.CustomCopilot.uuid == custom_copilot.uuid,
                models.CustomCopilot.user_uuid == user_uuid,
            )
        )
    ).first()
    kept = stored.headers if stored and source_proxy.on_origin(stored.url, custom_copilot.url) else None
    headers = replace_headers(kept, custom_copilot.headers)

    if stored is not None:
        await db.execute(
            update(models.CustomCopilot)
            .where(
                models.CustomCopilot.uuid == custom_copilot.uuid,
                models.CustomCopilot.user_uuid == user_uuid,
            )
            .values(url=custom_copilot.url, headers=headers, copilots=custom_copilot.copilots)
        )
    else:
        db.add(
            models.CustomCopilot(
                uuid=custom_copilot.uuid,
                user_uuid=user_uuid,
                url=custom_copilot.url,
                headers=headers,
                copilots=custom_copilot.copilots,
            )
        )

    await db.commit()


async def get_custom_copilots(db: AsyncSession, user_uuid: UUID) -> list[schemas.CustomCopilot]:
    if not await may_add_connections(db, user_uuid):
        return []
    query = select(models.CustomCopilot).where(models.CustomCopilot.user_uuid == user_uuid)
    result = await db.execute(query)
    return [
        schemas.CustomCopilot(
            uuid=item.uuid,
            url=item.url,
            header_names=sorted(item.headers or {}),
            copilots=item.copilots,
        )
        for item in result.scalars().all()
    ]


async def get_custom_copilot_connection(db: AsyncSession, user_uuid: UUID, copilot_uuid: UUID) -> SimpleNamespace | None:
    if not await may_add_connections(db, user_uuid):
        return None
    row = (
        await db.execute(
            select(models.CustomCopilot.uuid, models.CustomCopilot.url, models.CustomCopilot.headers).where(
                models.CustomCopilot.uuid == copilot_uuid,
                models.CustomCopilot.user_uuid == user_uuid,
            )
        )
    ).first()
    return None if row is None else agent_connection(row.uuid, row.url, row.headers, user_uuid)


def agent_connection(
    copilot_uuid: UUID | None, url: str, headers: dict[str, str] | None, user_uuid: UUID
) -> SimpleNamespace:
    return SimpleNamespace(
        uuid=copilot_uuid,
        url=url,
        endpointHeaders=[{"key": name, "value": value, "location": "headers"} for name, value in (headers or {}).items()],
        entity_uuid=None,
        user_uuid=user_uuid,
    )


async def delete_custom_copilot(db: AsyncSession, user_uuid: UUID, uuid: str | None = None):
    delete_stmt = delete(models.CustomCopilot).where(
        models.CustomCopilot.user_uuid == user_uuid,
    )
    if uuid:
        delete_stmt = delete_stmt.where(models.CustomCopilot.uuid == uuid)
    await db.execute(delete_stmt)
    await db.commit()


async def insert_user_prompt_state(db: AsyncSession, user_uuid: UUID, prompts: list[schemas.Prompt]):
    user_prompt_uuids = await _get_user_prompt_uuids(db, user_uuid)
    for prompt_uuid in user_prompt_uuids:
        if prompt_uuid not in [prompt.id for prompt in prompts]:
            await delete_user_prompt(db, user_uuid, prompt_uuid)

    for prompt in prompts:
        prompt_uuid = prompt.id

        if prompt_uuid not in user_prompt_uuids:
            insert_query = insert(models.UserPrompts).values(
                user_uuid=user_uuid, uuid=prompt_uuid, prompt=prompt.model_dump()
            )
            await db.execute(insert_query)
        else:
            await _update_user_prompt(db, user_uuid, prompt_uuid, prompt)

    await db.commit()


async def delete_user_prompt(db: AsyncSession, user_uuid: UUID, prompt_uuid: UUID):
    delete_query = delete(models.UserPrompts).where(
        models.UserPrompts.user_uuid == user_uuid,
        models.UserPrompts.uuid == prompt_uuid,
    )
    await db.execute(delete_query)
    await db.commit()


async def _get_user_prompt_uuids(db: AsyncSession, user_uuid: UUID) -> list[UUID]:
    query = select(models.UserPrompts.uuid).where(models.UserPrompts.user_uuid == user_uuid)
    result = await db.execute(query)
    return result.scalars().all()


async def _update_user_prompt(db: AsyncSession, user_uuid: UUID, prompt_uuid: UUID, prompt: schemas.Prompt):
    update_query = (
        update(models.UserPrompts)
        .where(
            models.UserPrompts.user_uuid == user_uuid,
            models.UserPrompts.uuid == prompt_uuid,
        )
        .values(prompt=prompt.model_dump())
    )

    await db.execute(update_query)
    await db.commit()


async def get_user_prompt_state(db: AsyncSession, user_uuid: UUID) -> list[schemas.Prompt]:
    query = select(models.UserPrompts.prompt).where(models.UserPrompts.user_uuid == user_uuid)
    result = (await db.execute(query)).scalars().all()

    prompts = []
    for prompt in result:
        if isinstance(prompt, list):
            prompts.extend([schemas.Prompt(**p) for p in prompt])
        elif isinstance(prompt, dict):
            prompts.append(schemas.Prompt(**prompt))

    return prompts


async def delete_user_skills(db: AsyncSession, user_uuid: UUID, skill_uuids: list[UUID]):
    delete_query = delete(models.UserSkills).where(
        models.UserSkills.user_uuid == user_uuid,
        models.UserSkills.uuid.in_(skill_uuids),
    )
    await db.execute(delete_query)
    await db.commit()


async def update_user_skill(db: AsyncSession, user_uuid: UUID, skill_uuid: UUID, skill: schemas.SkillCreate):
    update_query = (
        update(models.UserSkills)
        .where(
            models.UserSkills.user_uuid == user_uuid,
            models.UserSkills.uuid == skill_uuid,
        )
        .values(**skill.model_dump())
    )

    await db.execute(update_query)
    await db.commit()


async def get_user_skill_state(db: AsyncSession, user_uuid: UUID):
    query = (
        select(models.UserSkills)
        .where(models.UserSkills.user_uuid == user_uuid)
        .order_by(models.UserSkills.created_date.desc())
    )
    own = (await db.execute(query)).scalars().all()
    taken = {skill.slug for skill in own}
    provided = [
        SimpleNamespace(**skill)
        for skill in await widget_plugin_service.plugin_skills(db, user_uuid)
        if skill["slug"] not in taken
    ]
    return [*own, *provided]


async def entity_require_authenticator(db: AsyncSession, entity_uuid: UUID) -> bool:
    if not entity_uuid:
        return False

    query = select(models.Entity.require_authenticator).where(models.Entity.uuid == entity_uuid)
    result = (await db.execute(query)).scalar_one_or_none()
    return result is not None and result


async def require_entity_users_2fa(db: AsyncSession, entity_uuid: UUID, require_authenticator: bool) -> bool:
    entity_users = await get_entity_users(db, entity_uuid)
    for user_uuid in entity_users:
        update_query = (
            update(models.User)
            .where(
                models.User.uuid == user_uuid,
                and_(
                    models.User.totp_active.is_(False),
                    models.User.totp_secret.is_(None),
                ),
            )
            .values(two_factor_auth=require_authenticator)
        )
        await db.execute(update_query)
    await db.commit()


async def _get_user_uuid_by_email(db: AsyncSession, email: str) -> UUID | None:
    query = select(models.User.uuid).where(models.User.email == email)
    result = await db.execute(query)
    return result.scalar_one_or_none()


async def _get_role_entity_uuid(db: AsyncSession, role_uuid: UUID) -> UUID:
    query = select(models.Role.entity_uuid).where(models.Role.uuid == role_uuid)
    result = (await db.execute(query)).scalar_one_or_none()
    return result


async def _convert_emails_to_uuids(db: AsyncSession, users: list[str]) -> list[UUID]:
    return [await _get_user_uuid_by_email(db, email) for email in users]


AGENT_USER_ROLE = "Agent User"
SHARER_ROLE = "Sharer"
DEFAULT_AGENT_ID = "default_agent"

DEFAULT_ROLES: dict[str, dict] = {
    AGENT_USER_ROLE: {
        "description": "The agent, with every model it offers and the deployment's own tools, "
        "with no daily limits. New users get this role.",
        "sharing": models.SHARING_NONE,
        "copilot_calls_day": None,
        "copilot_tokens_day": None,
        "upload_size_gb": None,
        "search_web": True,
        "fetch_from_web": True,
    },
    SHARER_ROLE: {
        "description": "Shares dashboards and apps with others; nothing else.",
        "sharing": models.SHARING_SHARE,
        "copilot_calls_day": 0,
        "copilot_tokens_day": 0,
        "upload_size_gb": 0,
        "search_web": False,
        "fetch_from_web": False,
    },
}


async def _live_roles(db: AsyncSession, entity_uuid: UUID, names: list[str]) -> dict[str, UUID]:
    rows = await db.execute(
        select(models.Role.name, models.Role.uuid).where(
            models.Role.entity_uuid == entity_uuid,
            models.Role.name.in_(names),
            models.Role.deleted_at.is_(None),
        )
    )
    return {row.name: row.uuid for row in rows}


async def create_default_roles(db: AsyncSession, entity_uuid: UUID) -> dict[str, UUID]:
    roles = await _live_roles(db, entity_uuid, list(DEFAULT_ROLES))
    for name, role_settings in DEFAULT_ROLES.items():
        if name in roles:
            continue
        roles[name] = uuid4()
        await db.execute(
            insert(models.Role).values(uuid=roles[name], name=name, entity_uuid=entity_uuid, **role_settings)
        )
        if name == AGENT_USER_ROLE:
            await db.execute(
                insert(models.RoleCopilotModel).values(
                    role_uuid=roles[name],
                    agent_id=DEFAULT_AGENT_ID,
                    model_id=schemas.ALL_MODELS,
                )
            )
            servers = {schemas.normalize_mcp_url(s.url) for s in settings.DEFAULT_MCP_SERVERS}
            for server_url in sorted(servers):
                await db.execute(
                    insert(models.RoleMcpAccess).values(
                        role_uuid=roles[name],
                        server_url=server_url,
                        tool_name=schemas.ALL_MCP_TOOLS,
                    )
                )
    return roles


async def give_default_roles(db: AsyncSession, user_uuid: UUID, permissions_uuid: UUID | None, names: list[str]) -> None:
    if permissions_uuid is None:
        return
    entity_uuid = await crud.get_user_entity_uuid(db, permissions_uuid)
    if entity_uuid is None:
        return
    roles = await _live_roles(db, entity_uuid, names)
    held = set(
        (
            await db.execute(
                select(models.UserRole.role_uuid).where(
                    models.UserRole.user_uuid == user_uuid,
                    models.UserRole.role_uuid.in_(list(roles.values())),
                )
            )
        ).scalars()
    )
    for role_uuid in roles.values():
        if role_uuid not in held:
            await db.execute(insert(models.UserRole).values(user_uuid=user_uuid, role_uuid=role_uuid))


async def role_exists(db: AsyncSession, role_uuid: UUID, entity_uuid: UUID) -> bool:
    query = select(models.Role.uuid).where(
        models.Role.uuid == role_uuid,
        models.Role.entity_uuid == entity_uuid,
        models.Role.deleted_at.is_(None),
    )
    result = (await db.execute(query)).scalar_one_or_none()
    return result is not None


async def add_users_to_role(db: AsyncSession, role_uuid: UUID, users: list[str]):
    entity_uuid = await _get_role_entity_uuid(db, role_uuid)
    if not entity_uuid:
        raise HTTPException(404, detail="Role not found")

    entity_users = await get_entity_users(db, entity_uuid)

    valid_users = await _convert_emails_to_uuids(db, users)
    valid_users = [user_uuid for user_uuid in valid_users if user_uuid in entity_users]

    for user_uuid in valid_users:
        user_role = models.UserRole(role_uuid=role_uuid, user_uuid=user_uuid)
        db.add(user_role)
        await db.flush()
    await db.commit()


async def remove_users_from_role(db: AsyncSession, role_uuid: UUID, users: list[str]):
    user_uuids_to_remove = await _convert_emails_to_uuids(db, users)

    if user_uuids_to_remove:
        user_roles = (
            await db.scalars(
                select(models.UserRole).where(
                    and_(
                        models.UserRole.role_uuid == role_uuid,
                        models.UserRole.user_uuid.in_(user_uuids_to_remove),
                    )
                )
            )
        ).all()
        for user_role in user_roles:
            await db.delete(user_role)
        await db.commit()


async def get_role_copilot_access(db: AsyncSession, role_uuids: list[UUID]) -> schemas.RoleCopilotAccess:
    if not role_uuids:
        return schemas.RoleCopilotAccess()

    model_rows = (
        await db.execute(
            select(models.RoleCopilotModel.agent_id, models.RoleCopilotModel.model_id)
            .where(models.RoleCopilotModel.role_uuid.in_(role_uuids))
            .distinct()
            .order_by(models.RoleCopilotModel.agent_id, models.RoleCopilotModel.model_id)
        )
    ).all()
    mcp_rows = (
        await db.execute(
            select(models.RoleMcpAccess.server_url, models.RoleMcpAccess.tool_name)
            .where(models.RoleMcpAccess.role_uuid.in_(role_uuids))
            .distinct()
            .order_by(models.RoleMcpAccess.server_url, models.RoleMcpAccess.tool_name)
        )
    ).all()
    return schemas.RoleCopilotAccess(
        models=[schemas.CopilotModelGrant(agent_id=row[0], model_id=row[1]) for row in model_rows],
        mcp=[schemas.McpGrant.model_construct(server_url=row[0], tool_name=row[1]) for row in mcp_rows],
    )


async def get_user_copilot_access(db: AsyncSession, user_uuid: UUID) -> schemas.CopilotAccess:
    role_uuids = list(await _get_user_roles(db, user_uuid))
    granted = await get_role_copilot_access(db, role_uuids)
    return schemas.CopilotAccess(
        models=granted.models,
        mcp=[
            *granted.mcp,
            *await get_backend_mcp_grants(db, user_uuid),
            *await get_own_mcp_grants(db, user_uuid),
        ],
        disabled_capabilities=await get_disabled_copilot_capabilities(db, role_uuids),
    )


async def get_disabled_copilot_capabilities(db: AsyncSession, role_uuids: list[UUID]) -> list[schemas.CopilotCapability]:
    flags = (
        await db.execute(
            select(models.Role.search_web, models.Role.fetch_from_web).where(models.Role.uuid.in_(role_uuids))
        )
    ).all()
    disabled = []
    if not any(row.search_web for row in flags):
        disabled.append(schemas.CopilotCapability.SEARCH_WEB)
    if not any(row.fetch_from_web for row in flags):
        disabled.append(schemas.CopilotCapability.FETCH_FROM_WEB)
    return disabled


async def set_role_copilot_access(db: AsyncSession, role_uuid: UUID, access: schemas.RoleCopilotAccess) -> None:
    await db.execute(delete(models.RoleCopilotModel).where(models.RoleCopilotModel.role_uuid == role_uuid))
    await db.execute(delete(models.RoleMcpAccess).where(models.RoleMcpAccess.role_uuid == role_uuid))
    for agent_id, model_id in {(m.agent_id, m.model_id) for m in access.models}:
        db.add(models.RoleCopilotModel(role_uuid=role_uuid, agent_id=agent_id, model_id=model_id))
    for server_url, tool_name in {(m.server_url, m.tool_name) for m in access.mcp}:
        db.add(models.RoleMcpAccess(role_uuid=role_uuid, server_url=server_url, tool_name=tool_name))
    await db.commit()


def disabled_mcp_tools(access: schemas.CopilotAccess) -> frozenset[str]:
    return frozenset(
        tool for capability in access.disabled_capabilities for tool in schemas.CAPABILITY_MCP_TOOLS[capability]
    )


def is_mcp_tool_allowed(access: schemas.CopilotAccess, server_url: str, tool_name: str) -> bool:
    if tool_name in disabled_mcp_tools(access):
        return False
    url = schemas.normalize_mcp_url(server_url)
    return any(grant.server_url == url and grant.tool_name in {schemas.ALL_MCP_TOOLS, tool_name} for grant in access.mcp)


def check_copilot_access(
    access: schemas.CopilotAccess, request: schemas.CopilotAuthorize
) -> schemas.CopilotAuthorizeResult:
    agent_allowed = any(m.agent_id == request.agent_id for m in access.models)
    denied_model = None
    if request.model:
        granted = {(m.agent_id, m.model_id) for m in access.models}
        named = {(request.agent_id, request.model), (request.agent_id, schemas.ALL_MODELS)}
        if not named & granted:
            denied_model = request.model

    denied_tools = [tool for tool in request.tools if not is_mcp_tool_allowed(access, tool.url, tool.tool_name)]
    return schemas.CopilotAuthorizeResult(
        allowed=agent_allowed and denied_model is None and not denied_tools,
        denied_model=denied_model,
        denied_tools=denied_tools,
        disabled_capabilities=access.disabled_capabilities,
    )


async def get_role_users(db: AsyncSession, role_uuid: UUID) -> list[str]:
    query = (
        select(models.User.email)
        .join(models.UserRole, models.UserRole.user_uuid == models.User.uuid)
        .where(models.UserRole.role_uuid == role_uuid)
    )
    result = (await db.execute(query)).scalars().all()
    return result


async def get_role_user_uuids(db: AsyncSession, role_uuid: UUID) -> list[UUID]:
    query = select(models.UserRole.user_uuid).where(models.UserRole.role_uuid == role_uuid)
    return list((await db.execute(query)).scalars().all())


async def update_role_users(db: AsyncSession, role_uuid: UUID, new_users: list[str]):
    entity_uuid = await _get_role_entity_uuid(db, role_uuid)
    if not entity_uuid:
        raise HTTPException(404, detail="Role not found")

    current_users = await get_role_users(db, role_uuid)

    users_to_add = [email for email in new_users if email not in current_users]
    users_to_remove = [email for email in current_users if email not in new_users]

    if users_to_add:
        await add_users_to_role(db, role_uuid, users_to_add)

    if users_to_remove:
        await remove_users_from_role(db, role_uuid, users_to_remove)


async def insert_or_update_backend_permissions(
    db: AsyncSession,
    role_uuid: UUID,
    backend_uuid: UUID,
    permissions: schemas.RolePermissions,
):
    query = select(models.RoleBackend).where(
        models.RoleBackend.role_uuid == role_uuid,
        models.RoleBackend.backend_uuid == backend_uuid,
    )
    result = (await db.execute(query)).scalar_one_or_none()

    permissions_dict: dict[str, list[dict]] = permissions.model_dump(
        exclude=["type", "category", "uuid"], exclude_none=True, exclude_unset=True
    )

    if not result:
        result = models.RoleBackend(role_uuid=role_uuid, backend_uuid=backend_uuid, **permissions_dict)
        db.add(result)

        return await db.commit()

    for key, value in permissions_dict.items():
        has_changes = False
        if key == "widgets" and value:
            has_changes |= len(result.widgets or []) != len(value)

            new_access = {w.get("widgetId"): w.get("access") for w in value if w.get("widgetId") and w.get("access")}
            for widget in result.widgets or []:
                if has_changes:
                    break
                widget_id = widget.get("widgetId")
                has_changes |= bool(widget.get("access") != new_access.get(widget_id))

        if key == "templates" and value:
            has_changes |= len(result.templates or []) != len(value)

            new_access: dict[str, str] = {}
            new_prompts: dict = {}

            for t in value:
                if has_changes:
                    break
                template_id = t.get("templateId")
                if not (template_id and t.get("access")):
                    continue
                new_prompts[template_id] = {
                    p.get("promptId"): p.get("access")
                    for p in t.get("prompts", [])
                    if p.get("promptId") and p.get("access")
                }
                new_access[template_id] = t.get("access")

            for template in result.templates or []:
                if has_changes:
                    break
                template_id = template.get("templateId")
                prompts: list[dict] = template.get("prompts", [])
                new_prompts_access: dict = new_prompts.get(template_id, {})

                prompts_change = [
                    p.get("promptId") for p in prompts if p.get("access") != new_prompts_access.get(p.get("promptId"))
                ]
                template_change = template.get("access") != new_access.get(template_id)
                has_changes |= bool(prompts_change or template_change)

            if not has_changes:
                continue

        setattr(result, key, value)

    await db.flush()
    await db.commit()


async def insert_or_update_file_permissions(db: AsyncSession, role_uuid: UUID, file_uuid: UUID, access: bool):
    query = select(models.RoleFile).where(models.RoleFile.role_uuid == role_uuid, models.RoleFile.file_uuid == file_uuid)
    result = (await db.execute(query)).scalar_one_or_none()

    if result:
        result.access = access
    else:
        result = models.RoleFile(role_uuid=role_uuid, file_uuid=file_uuid, access=access)
        db.add(result)

    await db.commit()


async def insert_or_update_prompt_permissions(db: AsyncSession, role_uuid: UUID, prompt_uuid: UUID, access: bool):
    query = select(models.RolePrompt).where(
        models.RolePrompt.role_uuid == role_uuid,
        models.RolePrompt.prompt_uuid == prompt_uuid,
    )
    result = (await db.execute(query)).scalar_one_or_none()

    if result:
        result.access = access
    else:
        result = models.RolePrompt(role_uuid=role_uuid, prompt_uuid=prompt_uuid, access=access)
        db.add(result)

    await db.commit()


async def insert_or_update_prompt_template_permissions(
    db: AsyncSession, role_uuid: UUID, permissions: schemas.RolePermissions
):
    query = select(models.RoleBackend).where(
        models.RoleBackend.role_uuid == role_uuid,
        models.RoleBackend.backend_uuid == permissions.uuid,
    )
    result = (await db.execute(query)).scalar_one_or_none()
    if not result:
        raise HTTPException(404, detail="Prompt not found")

    permissions_templates_json = [perm_tpl.model_dump() for perm_tpl in permissions.templates]
    template_id = permissions.templates[0].templateId

    template_exists = any(t["templateId"] == template_id for t in result.templates or [])

    if template_exists:
        templates = result.templates or []
        for i, template in enumerate(templates):
            if template["templateId"] == template_id:
                templates[i] = permissions_templates_json[0]
        result.templates = templates
    else:
        templates = result.templates or []
        templates.extend(permissions_templates_json)
        result.templates = templates

    flag_modified(result, "templates")
    await db.commit()


async def _get_user_roles(db: AsyncSession, user_uuid: UUID) -> list[UUID]:
    query = _user_roles(user_uuid, models.UserRole.role_uuid)
    result = (await db.execute(query)).scalars().all()
    return result


async def _get_role_backend_permissions(db: AsyncSession, role_uuid: UUID) -> list[schemas.BackendPermissionsModel]:
    query = (
        select(
            models.RoleBackend.backend_uuid,
            models.ApiSource.name,
            models.ApiSource.created_date,
            models.ApiSource.updated_date,
            models.RoleBackend.access,
            models.RoleBackend.widgets,
            models.RoleBackend.templates,
            case(
                (models.RoleBackend.access == literal("access"), models.ApiSource.url),
                else_=None,
            ).label("url"),
            case(
                (
                    models.RoleBackend.access == literal("access"),
                    models.ApiSource.endpointHeaders,
                ),
                else_=None,
            ).label(quoted_name("endpointHeaders", False)),
            case(
                (
                    and_(
                        models.User.first_name.is_not(None),
                        models.User.last_name.is_not(None),
                    ),
                    func.concat(models.User.first_name, " ", models.User.last_name),
                ),
                (models.User.email.is_not(None), models.User.email),
                else_=models.Entity.name,
            ).label("created_by"),
        )
        .select_from(models.RoleBackend)
        .join(models.ApiSource, models.ApiSource.uuid == models.RoleBackend.backend_uuid)
        .join(
            models.User,
            models.User.uuid == models.ApiSource.user_uuid,
            isouter=True,
        )
        .join(
            models.Entity,
            models.Entity.uuid == models.ApiSource.entity_uuid,
            isouter=True,
        )
        .where(
            models.RoleBackend.role_uuid == role_uuid,
            models.RoleBackend.access != "no-access",
        )
    )
    result = await db.execute(query)
    return [
        {
            "uuid": str(row.backend_uuid),
            "name": row.name,
            "access": row.access,
            "widgets": [w for w in (row.widgets or []) if w["access"] != "no-access"],
            "templates": [
                {
                    **t,
                    "prompts": [p for p in t.get("prompts", []) if p.get("access") != "no-access"],
                }
                for t in (row.templates or [])
                if t["access"] != "no-access"
            ],
            "url": row.url,
            "endpointHeaders": row.endpointHeaders,
            "created_date": row.created_date,
            "updated_date": row.updated_date,
            "created_by": row.created_by,
        }
        for row in result.all()
    ]


async def _get_role_file_permissions(db: AsyncSession, role_uuid: UUID) -> list[schemas.FilePermissionsModel]:
    query = (
        select(
            models.RoleFile.file_uuid,
            models.FileWidget.name,
            models.FileWidget.description,
            models.RoleFile.access,
            case((models.RoleFile.access == "access", models.FileWidget.url), else_=None).label("url"),
        )
        .select_from(models.RoleFile)
        .join(models.FileWidget, models.FileWidget.uuid == models.RoleFile.file_uuid)
        .where(
            models.RoleFile.role_uuid == role_uuid,
            models.RoleFile.access != "no-access",
        )
    )
    result = await db.execute(query)
    return [
        {
            "uuid": str(row.file_uuid),
            "access": row.access,
            "name": row.name,
            "description": row.description,
            "url": row.url,
        }
        for row in result.all()
    ]


async def _get_role_prompt_permissions(db: AsyncSession, role_uuid: UUID) -> list[schemas.PromptPermissionsModel]:
    query = (
        select(
            models.RolePrompt.prompt_uuid,
            models.UserPrompts.prompt,
            models.RolePrompt.access,
        )
        .select_from(models.RolePrompt)
        .join(models.UserPrompts, models.RolePrompt.prompt_uuid == models.UserPrompts.uuid)
        .where(
            models.RolePrompt.role_uuid == role_uuid,
            models.RolePrompt.access != "no-access",
        )
    )
    result = await db.execute(query)
    return [
        {
            "uuid": str(row.prompt_uuid),
            "access": row.access,
            "prompt": row.prompt,
        }
        for row in result.all()
    ]


async def get_user_role_permissions(db: AsyncSession, user_uuid: UUID) -> schemas.UserRolesPermissions:
    permissions = {}

    roles = await _get_user_roles(db, user_uuid)

    for role_uuid in roles:
        permissions[str(role_uuid)] = {"backends": [], "files": [], "prompts": []}

        backend_permissions = await _get_role_backend_permissions(db, role_uuid)
        file_permissions = await _get_role_file_permissions(db, role_uuid)
        prompt_permissions = await _get_role_prompt_permissions(db, role_uuid)

        permissions[str(role_uuid)]["backends"] = backend_permissions
        permissions[str(role_uuid)]["files"] = file_permissions
        permissions[str(role_uuid)]["prompts"] = prompt_permissions

    return schemas.UserRolesPermissions(permissions=permissions)


def flatten_permissions(
    permissions_dict: schemas.UserRolesPermissions,
) -> schemas.UserRolesPermissionsFlattened:
    def _get_most_permissive_access(access1, access2):
        return "access" if "access" in {access1, access2} else "no-access"

    def _merge_items(items1, items2, id_key):
        items_map = {item[id_key]: item for item in (items1 or [])}
        for item in items2 or []:
            if item[id_key] in items_map:
                items_map[item[id_key]]["access"] = _get_most_permissive_access(
                    items_map[item[id_key]]["access"], item["access"]
                )
            else:
                items_map[item[id_key]] = item
        return list(items_map.values())

    def _handle_resource_type(resources, resource_type, id_key, merge_fn=None):
        flattened_resources = {}
        for _, role_permissions in resources.get("permissions", {}).items():
            for resource in role_permissions.get(resource_type) or []:
                resource_id = resource[id_key]
                if resource_id not in flattened_resources:
                    flattened_resources[resource_id] = resource
                else:
                    existing = flattened_resources[resource_id]
                    existing["access"] = _get_most_permissive_access(existing["access"], resource["access"])

                    if merge_fn:
                        merge_fn(existing, resource)

                    if existing["access"] == "no-access" and "url" in existing:
                        existing["url"] = None
                        if "endpointHeaders" in existing:
                            existing["endpointHeaders"] = None

        return list(flattened_resources.values())

    def _merge_backend_specifics(existing, new):
        existing["widgets"] = _merge_items(existing["widgets"], new["widgets"], "widgetId")
        existing["templates"] = _merge_items(existing["templates"], new["templates"], "templateId")

    return schemas.UserRolesPermissionsFlattened(
        backends=_handle_resource_type(permissions_dict, "backends", "uuid", _merge_backend_specifics),
        files=_handle_resource_type(permissions_dict, "files", "uuid"),
        prompts=_handle_resource_type(permissions_dict, "prompts", "uuid"),
    )


def create_details_message(action: str, resource_type: str, details: dict) -> str:
    if action == "update":
        changed_fields = []
        for field, value in details.items():
            if isinstance(value, dict) and "old" in value and "new" in value:
                changed_fields.append(field)
        if changed_fields:
            return f"Changed {', '.join(changed_fields)}."

    if action in {"create", "delete", "restore"} and resource_type == "role":
        message_map = {
            "create": f"Created role '{details.get('name', '')}'.",
            "delete": "Role was deleted.",
            "restore": "Role was restored.",
        }
        return message_map[action]

    if action == "assign" and resource_type in {"backend", "file", "prompt"}:
        prefix_map = {
            "backend": "Assigned backend",
            "file": "Assigned file",
            "prompt": "Assigned prompt",
        }
        suffix = f"permissions with {details.get('access', {}).get('new', 'unknown')}."

        return f"{prefix_map[resource_type]} {suffix}"

    if action in {"assign", "remove"} and resource_type == "widget_plugin":
        widget = details.get("widget_id")
        what = "every widget" if widget in {None, "*"} else f"widget '{widget}'"
        verb = "Granted" if action == "assign" else "Stopped granting"
        return f"{verb} {what} of plugin '{details.get('name', '')}'."

    if action in {"add", "remove"} and resource_type == "user":
        message_map = {
            "add": "Added user to role.",
            "remove": "Removed user from role.",
        }
        return message_map[action]

    return "Action performed."


async def _process_backend_widgets(backend_entry, role_uuid, backend):
    for widget in backend.get("widgets", []):
        widget_entry = {
            "widgetId": widget.get("widgetId"),
            "access": [{role_uuid: widget.get("access")}],
        }
        backend_entry["widgets"].append(widget_entry)


async def _update_backend_widgets(dc, role_uuid, backend):
    existing_widget_ids = {w.get("widgetId") for w in dc["widgets"]}
    for widget in backend.get("widgets", []):
        widget_id = widget.get("widgetId")
        if widget_id in existing_widget_ids:
            for w in dc["widgets"]:
                if w.get("widgetId") == widget_id:
                    w["access"].append({role_uuid: widget.get("access")})
        else:
            dc["widgets"].append({"widgetId": widget_id, "access": [{role_uuid: widget.get("access")}]})


async def _add_or_update_template_prompt(
    role_uuid: UUID,
    prompt,
    template_id: str,
    prompts_list: list,
    processed_prompts: set,
):
    prompt_uuid = prompt.get("promptId")
    if prompt_uuid not in processed_prompts:
        prompts_list.append(
            {
                "uuid": prompt_uuid,
                "prompt": prompt.get("prompt"),
                "access": [{role_uuid: prompt.get("access")}],
                "templateId": template_id,
            }
        )
        processed_prompts.add(prompt_uuid)
    else:
        for p in prompts_list:
            if p.get("uuid") == prompt_uuid:
                p["access"].append({role_uuid: prompt.get("access")})


async def process_templates(  # noqa: PLR0913, PLR0917
    role_uuid: UUID,
    backend,
    processed_templates: set,
    templates: list,
    prompts_list: list,
    processed_prompts: set,
):
    for template in backend.get("templates", []):
        template_id = template.get("templateId")
        if template_id not in processed_templates:
            templates.append(
                {
                    "templateId": template_id,
                    "access": [{role_uuid: template.get("access")}],
                    "prompts": [],
                }
            )
            processed_templates.add(template_id)

            for prompt in template.get("prompts", []):
                await _add_or_update_template_prompt(role_uuid, prompt, template_id, prompts_list, processed_prompts)
        else:
            for t in templates:
                if t.get("templateId") == template_id:
                    t["access"].append({role_uuid: template.get("access")})
                    for prompt in template.get("prompts", []):
                        await _add_or_update_template_prompt(
                            role_uuid,
                            prompt,
                            template_id,
                            prompts_list,
                            processed_prompts,
                        )


async def process_backend(role_uuid: UUID, backend, data_connectors: list, processed_backends: set):
    backend_uuid = backend.get("uuid")
    if backend_uuid not in processed_backends:
        backend_entry = {
            "uuid": backend_uuid,
            "type": "backend",
            "name": backend.get("name"),
            "access": [{role_uuid: backend.get("access")}],
            "widgets": [],
        }
        await _process_backend_widgets(backend_entry, role_uuid, backend)
        data_connectors.append(backend_entry)
        processed_backends.add(backend_uuid)
    else:
        for dc in data_connectors:
            if dc.get("uuid") == backend_uuid:
                dc["access"].append({role_uuid: backend.get("access")})
                await _update_backend_widgets(dc, role_uuid, backend)


async def process_file(role_uuid: UUID, file, data_connectors: list, processed_files: set):
    file_uuid = file.get("uuid")
    if file_uuid not in processed_files:
        data_connectors.append(
            {
                "uuid": file_uuid,
                "type": "file",
                "name": file.get("name"),
                "description": file.get("description"),
                "access": [{role_uuid: file.get("access")}],
            }
        )
        processed_files.add(file_uuid)
    else:
        for dc in data_connectors:
            if dc.get("uuid") == file_uuid:
                dc["access"].append({role_uuid: file.get("access")})


async def process_prompts(role_uuid: UUID, prompts_data: list, processed_prompts: set, prompts_list: list):
    for prompt in prompts_data:
        prompt_uuid = prompt.get("uuid")
        if prompt_uuid not in processed_prompts:
            prompts_list.append(
                {
                    "uuid": prompt_uuid,
                    "prompt": prompt.get("prompt"),
                    "access": [{role_uuid: prompt.get("access")}],
                }
            )
            processed_prompts.add(prompt_uuid)
        else:
            for p in prompts_list:
                if p.get("uuid") == prompt_uuid:
                    p["access"].append({role_uuid: prompt.get("access")})


async def get_role_name(db: AsyncSession, role_uuid: UUID) -> str:
    query = select(models.Role.name).where(models.Role.uuid == role_uuid)
    result = (await db.execute(query)).scalar_one_or_none()
    return result


async def compute_final_permission(permissions_dict):
    if not permissions_dict:
        return "no-access"

    for access in permissions_dict.values():
        if access == "access":
            return "access"

    return "no-access"


async def add_final_permissions_to_resources(  # noqa: PLR0912
    data_connectors, templates, prompts
):
    for connector in data_connectors:
        role_permissions = {}
        for access_entry in connector.get("access", []):
            for role, access in access_entry.items():
                role_permissions[role] = access
        connector["final_permission"] = await compute_final_permission(role_permissions)

        if connector.get("type") == "backend" and "widgets" in connector:
            for widget in connector.get("widgets", []):
                widget_role_permissions = {}
                for access_entry in widget.get("access", []):
                    for role, access in access_entry.items():
                        widget_role_permissions[role] = access
                widget["final_permission"] = await compute_final_permission(widget_role_permissions)

    for template in templates:
        role_permissions = {}
        for access_entry in template.get("access", []):
            for role, access in access_entry.items():
                role_permissions[role] = access
        template["final_permission"] = await compute_final_permission(role_permissions)

    for prompt in prompts:
        role_permissions = {}
        for access_entry in prompt.get("access", []):
            for role, access in access_entry.items():
                role_permissions[role] = access
        prompt["final_permission"] = await compute_final_permission(role_permissions)


async def get_shared_file_uuids(db: AsyncSession, user: models.User | None) -> list[UUID]:
    if not user:
        return []

    select_query = select(models.StoredFileShare.stored_file_uuids).where(
        models.StoredFileShare.shared_user_uuid == user.uuid,
        models.StoredFileShare.creater_uuid != user.uuid,
    )

    results = (await db.execute(select_query)).scalars().all()

    shared_uuids = [uuid for item in results for uuid in item] if results else []

    permissions = await get_user_role_permissions(db, user.uuid)
    role_permissions = flatten_permissions(permissions.model_dump())
    if role_permissions.files:
        shared_uuids.extend(
            [
                file.stored_file_uuid
                for file in role_permissions.files
                if file.stored_file_uuid and file.access != "no-access"
            ]
        )

    return list(set(shared_uuids))
