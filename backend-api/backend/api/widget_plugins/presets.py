import json
from dataclasses import dataclass, replace
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api import models
from api.models.widget_plugin_models import DEFAULT_PRESET_LIMIT, PRESET_ORG, PRESET_USER

from . import service
from .schema_lint import validate_settings_values

MAX_NAME_LENGTH = 80
MAX_STATE_BYTES = 64 * 1024


@dataclass(frozen=True)
class Target:
    entity_uuid: UUID
    plugin_uuid: UUID
    widget: dict
    owner_uuid: UUID | None

    @property
    def scope(self) -> str:
        return PRESET_ORG if self.owner_uuid is None else PRESET_USER

    def where(self) -> tuple:
        return (
            models.WidgetPluginPreset.entity_uuid == self.entity_uuid,
            models.WidgetPluginPreset.plugin_uuid == self.plugin_uuid,
            models.WidgetPluginPreset.widget_id == self.widget["id"],
            models.WidgetPluginPreset.scope == self.scope,
            models.WidgetPluginPreset.owner_uuid == self.owner_uuid,
        )


def view(row: models.WidgetPluginPreset) -> dict[str, Any]:
    return {
        "id": str(row.uuid),
        "name": row.name,
        "scope": row.scope,
        "is_default": bool(row.is_default),
        "config": row.config,
        "state": row.state,
        "updated_at": (row.updated_date or row.created_date).isoformat(),
    }


async def user_target(db: AsyncSession, user_uuid: UUID, plugin_id: str, widget_id: str) -> tuple[Target, int]:
    entry = next((e for e in await service.available(db, user_uuid) if e["plugin"].plugin_id == plugin_id), None)
    widget = next((w for w in entry["widgets"] if w["id"] == widget_id), None) if entry else None
    if entry is None or widget is None:
        raise HTTPException(404, detail="This plugin widget is not available to you")
    row = entry["entity_row"]
    return Target(row.entity_uuid, entry["plugin"].uuid, widget, user_uuid), row.preset_limit or DEFAULT_PRESET_LIMIT


async def org_target(db: AsyncSession, entity_uuid: UUID, plugin_id: str, widget_id: str) -> Target:
    plugin, active = await service.plugin_and_active_version(db, plugin_id)
    widgets = (((active.manifest if active else None) or {}).get("contributes") or {}).get("widgets") or []
    widget = next((w for w in widgets if w["id"] == widget_id), None)
    if widget is None:
        raise HTTPException(404, detail="The plugin has no such widget")
    return Target(entity_uuid, plugin.uuid, widget, None)


async def listing(db: AsyncSession, target: Target) -> list[dict[str, Any]]:
    shown = [and_(*target.where())]
    if target.owner_uuid is not None:
        shown.append(and_(*replace(target, owner_uuid=None).where()))
    rows = (
        (await db.execute(select(models.WidgetPluginPreset).where(or_(*shown)).order_by(models.WidgetPluginPreset.name)))
        .scalars()
        .all()
    )
    return [view(row) for row in sorted(rows, key=lambda r: r.scope != PRESET_USER)]


def _checked(target: Target, values: dict[str, Any]) -> dict[str, Any]:
    if "name" in values:
        name = (values["name"] or "").strip()
        if not 1 <= len(name) <= MAX_NAME_LENGTH:
            raise HTTPException(422, detail=f"A preset's name has 1 to {MAX_NAME_LENGTH} characters")
        values = {**values, "name": name}
    if values.get("config") is not None:
        schema = (target.widget.get("settings") or {}).get("schema") or {}
        problems = validate_settings_values(schema, values["config"])
        if problems:
            raise HTTPException(422, detail={"message": "Invalid settings", "errors": problems})
    if "state" in values:
        size = len(json.dumps(values["state"], separators=(",", ":"), ensure_ascii=False).encode())
        if size > MAX_STATE_BYTES:
            raise HTTPException(413, detail=f"A preset's state holds at most {MAX_STATE_BYTES // 1024} KiB of JSON")
    return values


async def _clear_defaults(db: AsyncSession, target: Target) -> None:
    await db.execute(update(models.WidgetPluginPreset).where(*target.where()).values(is_default=False))


async def create(db: AsyncSession, target: Target, values: dict[str, Any], limit: int | None = None) -> dict[str, Any]:
    values = _checked(target, values)
    if limit is not None:
        count = (
            await db.execute(select(func.count()).select_from(models.WidgetPluginPreset).where(*target.where()))
        ).scalar_one()
        if count >= limit:
            raise HTTPException(409, detail=f"You already have {limit} presets of this widget, the most you may keep")
    if values.get("is_default"):
        await _clear_defaults(db, target)
    row = models.WidgetPluginPreset(
        plugin_uuid=target.plugin_uuid,
        widget_id=target.widget["id"],
        entity_uuid=target.entity_uuid,
        owner_uuid=target.owner_uuid,
        scope=target.scope,
        name=values["name"],
        config=values.get("config"),
        state=values.get("state"),
        is_default=bool(values.get("is_default")),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return view(row)


async def _preset(db: AsyncSession, target: Target, preset_id: UUID) -> models.WidgetPluginPreset:
    row = (
        await db.execute(
            select(models.WidgetPluginPreset).where(models.WidgetPluginPreset.uuid == preset_id, *target.where())
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, detail="Preset not found")
    return row


async def change(db: AsyncSession, target: Target, preset_id: UUID, changes: dict[str, Any]) -> dict[str, Any]:
    row = await _preset(db, target, preset_id)
    changes = _checked(target, changes)
    if changes.get("is_default"):
        await _clear_defaults(db, target)
    for key in ("name", "config", "state"):
        if key in changes:
            setattr(row, key, changes[key])
    if changes.get("is_default") is not None:
        row.is_default = bool(changes["is_default"])
    await db.commit()
    await db.refresh(row)
    return view(row)


async def remove(db: AsyncSession, target: Target, preset_id: UUID) -> None:
    await db.delete(await _preset(db, target, preset_id))
    await db.commit()
