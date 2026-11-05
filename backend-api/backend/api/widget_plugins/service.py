import asyncio
import hashlib
import json
import re
import shutil
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any, TypeVar
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException
from sqlalchemy import Select, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api import models
from api.base import get_now
from api.models.widget_plugin_models import (
    DEFAULT_PRESET_LIMIT,
    PLUGIN_DISABLED,
    PLUGIN_ENABLED,
    PLUGIN_REVOKED,
    VERSION_ACTIVE,
    VERSION_BLOCKED,
    VERSION_DEVELOPMENT,
    VERSION_DISCOVERED,
    VERSION_MISSING,
    VERSION_RETIRED,
)
from utilities.config import settings

from . import (
    backends,
    csp as csp_rules,
    metrics,
    proxy as proxy_rules,
    secrets as secret_values,
)
from .discovery import (
    MANIFEST_FILE,
    DiscoveredVersion,
    ScanResult,
    cached_sha256,
    inspect_version,
    package_checksum,
    resolve_served_file,
    scan,
    sha256_file,
)
from .manifest import ACTION_PERMISSIONS, PERMISSIONS, VERSION_PATTERN
from .schema_lint import validate_settings_values

CHANGED = "the files changed after discovery; versions are immutable, so publish a new version"
MAX_REPORT_ORIGINS = 200
MAX_REPORTS_PER_REQUEST = 50
MAX_REPORT_DIRECTIVE_LENGTH = 32
MAX_REPORT_ORIGIN_LENGTH = 255
REPORT_RETENTION = timedelta(days=30)
REPORT_KEYWORDS = {"inline", "eval", "wasm-eval", "data", "blob"}
_REPORT_ORIGIN = re.compile(r"^(https?|wss?)://[a-z0-9.-]{1,253}(:\d{1,5})?$")


def feature_enabled() -> bool:
    return bool(settings.WIDGET_PLUGINS_DIR)


def local_development() -> bool:
    return settings.MODE == "local"


def _require_feature() -> None:
    if not feature_enabled():
        raise HTTPException(409, detail="Widget plugins are off: WIDGET_PLUGINS_DIR is not set")


def _scan_settings() -> dict[str, Any]:
    return {
        "pins": settings.WIDGET_PLUGINS_PINS,
        "require_pins": settings.WIDGET_PLUGINS_REQUIRE_PINS,
        "max_files": settings.WIDGET_PLUGINS_MAX_FILES,
        "max_bytes": settings.WIDGET_PLUGINS_MAX_UNPACKED_BYTES,
    }


_Row = TypeVar("_Row")


async def _added_or_existing(db: AsyncSession, row: _Row, existing: Select) -> _Row:
    try:
        async with db.begin_nested():
            db.add(row)
    except IntegrityError:
        return (await db.execute(existing.with_for_update())).scalar_one()
    return row


def _event(
    db: AsyncSession,
    plugin: models.WidgetPlugin,
    action: str,
    *,
    version: str | None = None,
    entity_uuid: UUID | None = None,
    actor_uuid: UUID | None = None,
    details: dict | None = None,
) -> None:
    db.add(
        models.WidgetPluginEvent(
            plugin_uuid=plugin.uuid,
            version=version,
            entity_uuid=entity_uuid,
            actor_uuid=actor_uuid,
            action=action,
            details=details,
        )
    )


async def record_event(
    db: AsyncSession,
    plugin: models.WidgetPlugin,
    action: str,
    *,
    version: str | None = None,
    details: dict | None = None,
) -> None:
    _event(db, plugin, action, version=version, details=details)
    await db.commit()


def _manifest_name(found: DiscoveredVersion) -> str:
    name = (found.manifest or {}).get("name")
    return name[:100] if isinstance(name, str) and name else found.plugin_id


def _record(row: models.WidgetPluginVersion, found: DiscoveredVersion) -> None:
    row.digest = found.digest
    row.declared_checksum = found.declared_checksum
    row.pin_status = found.pin_status
    row.manifest = found.manifest
    row.files = found.served_files()
    row.path = found.path
    findings = dict(row.findings or {})
    findings.update({"errors": found.errors, "warnings": found.warnings, "skills": found.skill_hashes()})
    row.findings = findings


def _remember_state(row: models.WidgetPluginVersion) -> None:
    if row.state in {VERSION_ACTIVE, VERSION_DISCOVERED, VERSION_RETIRED, VERSION_DEVELOPMENT}:
        row.findings = {**(row.findings or {}), "previous_state": row.state}


def _restore_state(row: models.WidgetPluginVersion) -> str:
    previous = (row.findings or {}).get("previous_state")
    return previous if previous in {VERSION_ACTIVE, VERSION_RETIRED, VERSION_DEVELOPMENT} else VERSION_DISCOVERED


def _in_development(row: models.WidgetPluginVersion) -> bool:
    if row.state == VERSION_DEVELOPMENT:
        return True
    return row.state == VERSION_MISSING and (row.findings or {}).get("previous_state") == VERSION_DEVELOPMENT


async def rescan(db: AsyncSession, actor_uuid: UUID | None = None) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
    _require_feature()
    plugins = {p.plugin_id: p for p in (await db.execute(select(models.WidgetPlugin))).scalars()}
    rows = {(v.plugin_uuid, v.version): v for v in (await db.execute(select(models.WidgetPluginVersion))).scalars()}
    ids = {p.uuid: p.plugin_id for p in plugins.values()}
    developing = frozenset(f"{ids[row.plugin_uuid]}/{row.version}" for row in rows.values() if _in_development(row))
    result: ScanResult = await asyncio.to_thread(
        scan, settings.WIDGET_PLUGINS_DIR, **_scan_settings(), development=developing
    )
    if result.error:
        raise HTTPException(409, detail=result.error)

    summary: dict[str, list[str]] = {
        "discovered": [],
        "blocked": [],
        "missing": [],
        "restored": [],
        "rejected": result.rejected,
    }
    seen: set[tuple[UUID, str]] = set()
    now = get_now()

    for found in result.versions:
        label = f"{found.plugin_id}@{found.version}"
        plugin = plugins.get(found.plugin_id)
        if plugin is None:
            plugin = await _added_or_existing(
                db,
                models.WidgetPlugin(plugin_id=found.plugin_id, name=_manifest_name(found), status=PLUGIN_DISABLED),
                select(models.WidgetPlugin).where(models.WidgetPlugin.plugin_id == found.plugin_id),
            )
            plugins[found.plugin_id] = plugin
        if plugin.active_version is None and not found.blocked:
            plugin.name = _manifest_name(found)

        key = (plugin.uuid, found.version)
        seen.add(key)
        row = rows.get(key)
        reason = "; ".join(found.errors)[:2000] or None

        new = None
        if row is None:
            new = models.WidgetPluginVersion(
                plugin_uuid=plugin.uuid, version=found.version, path=found.path, discovered_at=now
            )
            _record(new, found)
            new.state = VERSION_BLOCKED if found.blocked else VERSION_DISCOVERED
            new.blocked_reason = reason
            row = rows[key] = await _added_or_existing(
                db,
                new,
                select(models.WidgetPluginVersion).where(
                    models.WidgetPluginVersion.plugin_uuid == plugin.uuid,
                    models.WidgetPluginVersion.version == found.version,
                ),
            )
        if row is new:
            if found.blocked:
                metrics.BLOCKS.labels(found.block_reason or "files").inc()
            summary["blocked" if found.blocked else "discovered"].append(label)
            _event(
                db,
                plugin,
                "blocked" if found.blocked else "discovered",
                version=found.version,
                actor_uuid=actor_uuid,
                details={"digest": found.digest, "errors": found.errors},
            )
            continue

        if _in_development(row):
            if row.state == VERSION_MISSING:
                row.state = VERSION_DEVELOPMENT
                summary["restored"].append(label)
                _event(db, plugin, "restored-files", version=found.version, actor_uuid=actor_uuid)
            _record(row, found)
            continue

        if row.digest and found.digest and row.digest != found.digest:
            if row.blocked_reason != CHANGED:
                _remember_state(row)
                row.state = VERSION_BLOCKED
                row.blocked_reason = CHANGED
                row.findings = {**(row.findings or {}), "digest_found": found.digest}
                metrics.BLOCKS.labels("changed").inc()
                summary["blocked"].append(label)
                _event(
                    db,
                    plugin,
                    "changed",
                    version=found.version,
                    actor_uuid=actor_uuid,
                    details={"recorded": row.digest, "found": found.digest},
                )
            continue

        if row.blocked_reason == CHANGED:
            continue

        if found.blocked:
            if row.state != VERSION_BLOCKED or row.blocked_reason != reason:
                _remember_state(row)
                row.state = VERSION_BLOCKED
                row.blocked_reason = reason
                metrics.BLOCKS.labels(found.block_reason or "files").inc()
                summary["blocked"].append(label)
                _event(
                    db,
                    plugin,
                    "blocked",
                    version=found.version,
                    actor_uuid=actor_uuid,
                    details={"errors": found.errors},
                )
            _record(row, found)
            continue

        if row.state in {VERSION_BLOCKED, VERSION_MISSING}:
            state = _restore_state(row)
            if state == VERSION_ACTIVE and plugin.active_version != row.version:
                state = VERSION_RETIRED
            row.state = state
            row.blocked_reason = None
            summary["restored"].append(label)
            _event(db, plugin, "restored-files", version=found.version, actor_uuid=actor_uuid, details={"state": state})
        _record(row, found)

    for key, row in rows.items():
        if key not in seen and row.state != VERSION_MISSING:
            _remember_state(row)
            row.state = VERSION_MISSING
            plugin = next(p for p in plugins.values() if p.uuid == row.plugin_uuid)
            summary["missing"].append(f"{plugin.plugin_id}@{row.version}")
            _event(db, plugin, "missing", version=row.version, actor_uuid=actor_uuid)

    await db.commit()
    for outcome in ("discovered", "blocked", "missing", "restored"):
        if summary[outcome]:
            metrics.DISCOVERIES.labels(outcome).inc(len(summary[outcome]))
    return summary


async def _plugin_or_404(db: AsyncSession, plugin_id: str) -> models.WidgetPlugin:
    plugin = (
        await db.execute(select(models.WidgetPlugin).where(models.WidgetPlugin.plugin_id == plugin_id))
    ).scalar_one_or_none()
    if plugin is None:
        raise HTTPException(404, detail="Plugin not found")
    return plugin


async def _versions(db: AsyncSession, plugin: models.WidgetPlugin) -> list[models.WidgetPluginVersion]:
    rows = (
        (
            await db.execute(
                select(models.WidgetPluginVersion).where(models.WidgetPluginVersion.plugin_uuid == plugin.uuid)
            )
        )
        .scalars()
        .all()
    )
    return sorted(rows, key=lambda r: tuple(int(p) for p in r.version.split(".")), reverse=True)


async def plugin_and_active_version(
    db: AsyncSession, plugin_id: str
) -> tuple[models.WidgetPlugin, models.WidgetPluginVersion | None]:
    plugin = await _plugin_or_404(db, plugin_id)
    return plugin, _active(plugin, await _versions(db, plugin))


def _active(plugin: models.WidgetPlugin, versions: Iterable[models.WidgetPluginVersion]):
    for row in versions:
        if row.version == plugin.active_version:
            return row
    return None


def _widgets(manifest: dict | None) -> list[dict]:
    return list(((manifest or {}).get("contributes") or {}).get("widgets") or [])


def _overrides_csp(plugin: models.WidgetPlugin) -> dict | None:
    return (plugin.overrides or {}).get("csp")


def _server(manifest: dict | None) -> dict:
    return (manifest or {}).get("server") or {}


def _network_override(plugin: models.WidgetPlugin) -> list[str] | None:
    return (plugin.overrides or {}).get("server_network")


def approved_network(plugin: models.WidgetPlugin, declared: list[str]) -> list[str]:
    override = _network_override(plugin)
    return list(override) if override is not None else list(declared)


def private_allowed(plugin: models.WidgetPlugin) -> bool:
    confirmations = (plugin.overrides or {}).get("confirmations", [])
    return _network_override(plugin) is not None and csp_rules.PRIVATE_HOST in confirmations


def _proxy_label(proxy: dict) -> str:
    names = sorted(
        {name for value in (proxy.get("headers") or {}).values() for _kind, name in proxy_rules.TOKEN.findall(value)}
    )
    label = f"{proxy['id']}: {proxy.get('method', 'GET')} {proxy['url']}"
    return label + (f", sends the secrets {', '.join(names)}" if names else "")


def _removed(key: str, family: str, label: str) -> dict[str, Any]:
    return {"key": key, "family": family, "label": label, "risk": "none", "added": False, "removed": True}


def _server_items(plugin: models.WidgetPlugin, manifest: dict | None, previous: dict | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    network = approved_network(plugin, _server(manifest).get("network", []))
    old_network = approved_network(plugin, _server(previous).get("network", [])) if previous is not None else []
    for origin in network:
        items.append(
            {
                "key": f"server:{origin}",
                "family": "network",
                "label": f"server.network {origin}",
                "risk": csp_rules.directive_risk("connect-src", [origin]),
                "overridden": _network_override(plugin) is not None,
                "added": previous is None or origin not in old_network,
            }
        )
    items.extend(_removed(f"server:{o}", "network", f"server.network {o}") for o in old_network if o not in network)

    proxies = {p["id"]: p for p in _server(manifest).get("proxies", [])}
    old_proxies = {p["id"]: p for p in _server(previous).get("proxies", [])}
    for proxy_id, proxy in proxies.items():
        changed = proxy_id in old_proxies and old_proxies[proxy_id] != proxy
        items.append(
            {
                "key": f"proxy:{proxy_id}",
                "family": "proxies",
                "label": _proxy_label(proxy) + (" (changed)" if changed else ""),
                "risk": "medium",
                "added": previous is None or proxy_id not in old_proxies or changed,
            }
        )
    items.extend(_removed(f"proxy:{i}", "proxies", _proxy_label(p)) for i, p in old_proxies.items() if i not in proxies)

    secrets = {x["name"]: x for x in (manifest or {}).get("secrets", [])}
    old_secrets = {x["name"]: x for x in (previous or {}).get("secrets", [])}
    for name, secret in secrets.items():
        items.append(
            {
                "key": f"secret:{name}",
                "family": "secrets",
                "label": f"{name}: {secret.get('purpose', '')}",
                "risk": "none",
                "added": previous is None or name not in old_secrets,
            }
        )
    items.extend(_removed(f"secret:{n}", "secrets", n) for n in old_secrets if n not in secrets)
    return items


def _route_label(route: dict) -> str:
    names = route.get("secrets") or []
    return f"route {route['id']}" + (f", sends the secrets {', '.join(names)}" if names else "")


def _backend_items(manifest: dict | None, previous: dict | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    backend, old_backend = _server(manifest).get("backend"), _server(previous).get("backend")
    if backend:
        items.append(
            {
                "key": "backend",
                "family": "backend",
                "label": "Runs code on the server, in a separate process the deployer runs",
                "risk": "high",
                "added": previous is None or not old_backend,
            }
        )
    elif old_backend:
        items.append(_removed("backend", "backend", "Runs code on the server"))
    routes = {r["id"]: r for r in (backend or {}).get("routes", [])}
    old_routes = {r["id"]: r for r in (old_backend or {}).get("routes", [])}
    for route_id, route in routes.items():
        changed = route_id in old_routes and old_routes[route_id] != route
        items.append(
            {
                "key": f"route:{route_id}",
                "family": "backend",
                "label": _route_label(route) + (" (changed)" if changed else ""),
                "risk": "medium",
                "added": previous is None or route_id not in old_routes or changed,
            }
        )
    items.extend(_removed(f"route:{i}", "backend", _route_label(r)) for i, r in old_routes.items() if i not in routes)

    sources = {d["id"]: d for d in (manifest or {}).get("dataSources", [])}
    old_sources = {d["id"]: d for d in (previous or {}).get("dataSources", [])}
    for source_id, source in sources.items():
        items.append(
            {
                "key": f"data-source:{source_id}",
                "family": "data",
                "label": f"reads the data source {source_id} for the user: {source.get('purpose', '')}",
                "risk": "high",
                "added": previous is None or source_id not in old_sources,
            }
        )
    items.extend(_removed(f"data-source:{i}", "data", i) for i in old_sources if i not in sources)
    if (manifest or {}).get("identity") == "pseudonymous":
        items.append(
            {
                "key": "identity:pseudonymous",
                "family": "data",
                "label": "learns an anonymous id of the user, the same in every call of this plugin",
                "risk": "medium",
                "added": previous is None or previous.get("identity") != "pseudonymous",
            }
        )
    elif (previous or {}).get("identity") == "pseudonymous":
        items.append(_removed("identity:pseudonymous", "data", "an anonymous id of the user"))
    return items


def _skill_items(
    row: "models.WidgetPluginVersion | LiveVersion", previous: dict | None, active: models.WidgetPluginVersion | None
) -> list[dict[str, Any]]:
    def skills_of(manifest: dict | None) -> dict[str, dict]:
        return {s["slug"]: s for s in ((manifest or {}).get("contributes") or {}).get("skills", [])}

    new, old = skills_of(row.manifest), skills_of(previous)
    hashes = row.skills if isinstance(row, LiveVersion) else (row.findings or {}).get("skills") or {}
    old_hashes = ((active.approved if active is not None else None) or {}).get("skills") or {}
    items: list[dict[str, Any]] = []
    for slug, skill in new.items():
        before = old.get(slug)
        same = before is not None and before == skill and hashes.get(skill["file"]) == old_hashes.get(before["file"])
        items.append(
            {
                "key": f"skill:{slug}",
                "family": "skills",
                "label": f"gives the agent the skill {slug}: {skill['description']}",
                "risk": "medium",
                "added": not same,
            }
        )
    items.extend(_removed(f"skill:{slug}", "skills", slug) for slug in old if slug not in new)
    return items


def review_items(
    plugin: models.WidgetPlugin,
    row: models.WidgetPluginVersion,
    active: models.WidgetPluginVersion | None,
) -> list[dict[str, Any]]:
    previous = active.manifest if active is not None and active is not row else None
    items: list[dict[str, Any]] = []

    new_widgets = {w["id"]: w for w in _widgets(row.manifest)}
    old_widgets = {w["id"]: w for w in _widgets(previous)}
    for widget_id, widget in new_widgets.items():
        types = [h["type"] for h in widget.get("handles", [])]
        items.append(
            {
                "key": f"widget:{widget_id}",
                "family": "widgets",
                "label": f"{widget.get('name', widget_id)} ({widget_id})"
                + (f", renders {', '.join(types)}" if types else ", standalone"),
                "risk": "none",
                "added": previous is None or widget_id not in old_widgets,
            }
        )
        if widget.get("artifact"):
            items.append(
                {
                    "key": f"artifact:{widget_id}",
                    "family": "artifacts",
                    "label": f"{widget_id}: the agent can show it in the chat with data it chooses, "
                    f"and a user can add it to a dashboard: {widget['artifact']['description']}",
                    "risk": "medium",
                    "added": previous is None or (old_widgets.get(widget_id) or {}).get("artifact") != widget["artifact"],
                }
            )
        elif (old_widgets.get(widget_id) or {}).get("artifact"):
            items.append(_removed(f"artifact:{widget_id}", "artifacts", widget_id))
        old_permissions = set((old_widgets.get(widget_id) or {}).get("permissions", []))
        for permission in widget.get("permissions", []):
            items.append(
                {
                    "key": f"permission:{widget_id}:{permission}",
                    "family": "permissions",
                    "label": f"{widget_id}: {permission}",
                    "risk": "none",
                    "added": previous is None or permission not in old_permissions,
                }
            )
    for widget_id, widget in old_widgets.items():
        if widget_id not in new_widgets:
            items.append(
                {
                    "key": f"widget:{widget_id}",
                    "family": "widgets",
                    "label": widget_id,
                    "risk": "none",
                    "added": False,
                    "removed": True,
                }
            )

    overrides = _overrides_csp(plugin)
    policy = csp_rules.approved_policy((row.manifest or {}).get("csp"), overrides)
    old_policy = csp_rules.approved_policy(previous.get("csp"), overrides) if previous is not None else {}
    for directive, sources in policy.items():
        for source in sources:
            if source == "'none'":
                continue
            items.append(
                {
                    "key": f"csp:{directive}:{source}",
                    "family": "network",
                    "label": f"{directive} {source}",
                    "risk": csp_rules.directive_risk(directive, [source]),
                    "overridden": directive in (overrides or {}),
                    "added": previous is None or source not in old_policy.get(directive, []),
                }
            )
    for directive, sources in old_policy.items():
        for source in sources:
            if source not in policy.get(directive, []) and source != "'none'":
                items.append(
                    {
                        "key": f"csp:{directive}:{source}",
                        "family": "network",
                        "label": f"{directive} {source}",
                        "risk": "none",
                        "added": False,
                        "removed": True,
                    }
                )

    items.extend(_server_items(plugin, row.manifest, previous))
    items.extend(_backend_items(row.manifest, previous))
    items.extend(_skill_items(row, previous, active))

    changed = active is None or active.digest != row.digest
    items.append(
        {
            "key": f"code:{row.digest}",
            "family": "code",
            "label": "The code of this version" + (" (changed)" if active is not None and changed else ""),
            "risk": "none",
            "added": changed,
        }
    )
    return items


def _version_view(
    plugin: models.WidgetPlugin,
    row: models.WidgetPluginVersion,
    active: models.WidgetPluginVersion | None,
    live: "LiveVersion | None" = None,
) -> dict[str, Any]:
    shown = live or row
    manifest = shown.manifest or {}
    policy = csp_rules.approved_policy(manifest.get("csp"), _overrides_csp(plugin))
    return {
        "version": row.version,
        "state": row.state,
        "blocked_reason": row.blocked_reason,
        "digest": shown.digest,
        "declared_checksum": live.declared_checksum if live else row.declared_checksum,
        "checksum": live.checksum if live else row.declared_checksum,
        "pin_status": row.pin_status,
        "path": row.path,
        "files": shown.files or {},
        "findings": (
            {"errors": live.errors, "warnings": live.warnings}
            if live
            else {
                "errors": (row.findings or {}).get("errors", []),
                "warnings": (row.findings or {}).get("warnings", []),
            }
        ),
        "discovered_at": row.discovered_at,
        "approved_at": row.approved_at,
        "approved_by_uuid": row.approved_by_uuid,
        "manifest": manifest,
        "csp": {
            "declared": manifest.get("csp") or {},
            "notes": manifest.get("cspNotes") or {},
            "approved": policy,
            "effective": csp_rules.compose(policy),
            "egress": csp_rules.hosts(policy),
            "risk": {d: csp_rules.directive_risk(d, s) for d, s in policy.items()},
        },
        "server": {
            "network": {
                "declared": _server(manifest).get("network", []),
                "approved": approved_network(plugin, _server(manifest).get("network", [])),
            },
            "private": private_allowed(plugin),
            "proxies": _server(manifest).get("proxies", []),
            "secrets": manifest.get("secrets", []),
            "backend": _server(manifest).get("backend"),
            "data_sources": manifest.get("dataSources", []),
            "identity": manifest.get("identity", "none"),
        },
        "review": (
            review_items(plugin, shown, active)
            if row.state in {VERSION_DISCOVERED, VERSION_RETIRED, VERSION_DEVELOPMENT}
            else None
        ),
    }


async def _platform_entry(db: AsyncSession, plugin: models.WidgetPlugin) -> dict[str, Any]:
    versions = await _versions(db, plugin)
    active = _active(plugin, versions)
    developing = await development_versions(db, [plugin])
    enabled_for = (
        await db.execute(
            select(models.EntityWidgetPlugin.entity_uuid).where(
                models.EntityWidgetPlugin.plugin_uuid == plugin.uuid,
                models.EntityWidgetPlugin.enabled.is_(True),
            )
        )
    ).all()
    pending = [
        v.version
        for v in versions
        if v.state == VERSION_DISCOVERED
        and (active is None or tuple(map(int, v.version.split("."))) > tuple(map(int, active.version.split("."))))
    ]
    return {
        "plugin_id": plugin.plugin_id,
        "name": plugin.name,
        "status": plugin.status,
        "active_version": plugin.active_version,
        "update_available": pending[0] if pending and active is not None else None,
        "overrides": plugin.overrides or {},
        "enabled_entities": len(enabled_for),
        "enabled_for": [{"entity_uuid": r.entity_uuid} for r in enabled_for],
        "versions": [
            _version_view(plugin, v, active, developing.get(plugin.uuid) if v.state == VERSION_DEVELOPMENT else None)
            for v in versions
        ],
        "secrets": await secret_values.status(db, plugin, versions),
        "backend": backend_status(plugin),
    }


def backend_status(plugin: models.WidgetPlugin) -> dict[str, Any]:
    seen = backends.last_identity(plugin.plugin_id)
    return {
        "registered": backends.registered_url(plugin.plugin_id) is not None,
        "identity": (
            {"state": seen.state, "detail": seen.detail, "digest": seen.digest, "checked_at": seen.checked_at}
            if seen
            else None
        ),
        "breaker": backends.breaker_state(plugin.plugin_id),
    }


async def platform_listing(db: AsyncSession) -> dict[str, Any]:
    plugins = (await db.execute(select(models.WidgetPlugin).order_by(models.WidgetPlugin.plugin_id))).scalars().all()
    return {
        "enabled": feature_enabled(),
        "development": local_development(),
        "plugins": [await _platform_entry(db, p) for p in plugins],
    }


async def platform_plugin(db: AsyncSession, plugin_id: str) -> dict[str, Any]:
    plugin = await _plugin_or_404(db, plugin_id)
    rows = {
        r.entity_uuid: r
        for r in (
            await db.execute(
                select(models.EntityWidgetPlugin).where(models.EntityWidgetPlugin.plugin_uuid == plugin.uuid)
            )
        ).scalars()
    }
    entities = (await db.execute(select(models.Entity.uuid, models.Entity.name).order_by(models.Entity.name))).all()
    return {
        **await _platform_entry(db, plugin),
        "entities": [
            {
                "entity_uuid": e.uuid,
                "name": e.name,
                "enabled": bool(rows[e.uuid].enabled) if e.uuid in rows else False,
            }
            for e in entities
        ],
        "events": await plugin_events(db, plugin_id, limit=50),
    }


async def plugin_events(
    db: AsyncSession, plugin_id: str, entity_uuid: UUID | None = None, limit: int = 200
) -> list[dict[str, Any]]:
    plugin = await _plugin_or_404(db, plugin_id)
    query = select(models.WidgetPluginEvent).where(models.WidgetPluginEvent.plugin_uuid == plugin.uuid)
    if entity_uuid is not None:
        query = query.where(models.WidgetPluginEvent.entity_uuid == entity_uuid)
    rows = (await db.execute(query.order_by(models.WidgetPluginEvent.created_date.desc()).limit(limit))).scalars().all()
    return [
        {
            "action": r.action,
            "version": r.version,
            "entity_uuid": r.entity_uuid,
            "actor_uuid": r.actor_uuid,
            "details": r.details or {},
            "created_date": r.created_date,
        }
        for r in rows
    ]


def _approval_of(manifest: dict, digest: str | None) -> dict[str, Any]:
    return {
        "digest": digest,
        "permissions": {w["id"]: list(w.get("permissions", [])) for w in _widgets(manifest)},
        "csp": manifest.get("csp") or {},
        "server_network": _server(manifest).get("network", []),
        "backend": bool(_server(manifest).get("backend")),
        "data_sources": [d["id"] for d in manifest.get("dataSources", [])],
        "identity": manifest.get("identity", "none"),
    }


@dataclass
class LiveVersion:
    version: str
    path: str
    digest: str | None
    declared_checksum: str | None
    checksum: str | None
    manifest: dict | None
    files: dict[str, dict[str, Any]]
    approved: dict[str, Any]
    skills: dict[str, str] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _inspect_development(plugin_id: str, version: str) -> DiscoveredVersion:
    return inspect_version(
        Path(settings.WIDGET_PLUGINS_DIR or ""),
        plugin_id,
        version,
        development=True,
        **_scan_settings(),
    )


async def development_versions(db: AsyncSession, plugins: list[models.WidgetPlugin]) -> dict[UUID, LiveVersion]:
    if not local_development() or not plugins:
        return {}
    ids = {p.uuid: p.plugin_id for p in plugins}
    rows = (
        await db.execute(
            select(models.WidgetPluginVersion).where(
                models.WidgetPluginVersion.plugin_uuid.in_(list(ids)),
                models.WidgetPluginVersion.state == VERSION_DEVELOPMENT,
            )
        )
    ).scalars()
    live: dict[UUID, LiveVersion] = {}
    for row in rows:
        found = await asyncio.to_thread(_inspect_development, ids[row.plugin_uuid], row.version)
        live[row.plugin_uuid] = LiveVersion(
            version=row.version,
            path=found.path,
            digest=found.digest,
            declared_checksum=found.declared_checksum,
            checksum=found.checksum,
            manifest=found.manifest,
            files=found.served_files(),
            approved=_approval_of(found.manifest or {}, found.digest),
            skills=found.skill_hashes(),
            errors=found.errors,
            warnings=found.warnings,
        )
    return live


def next_version(existing: Iterable[str], bump: str) -> str:
    major, minor, patch = max(tuple(int(part) for part in v.split(".")) for v in existing)
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def _version_names(plugin_dir: Path) -> set[str]:
    if not plugin_dir.is_dir():
        return set()
    return {entry.name for entry in plugin_dir.iterdir() if re.fullmatch(VERSION_PATTERN, entry.name)}


def _copy_version(root: Path, plugin_id: str, source: str, target: str) -> None:
    source_dir = root / plugin_id / source
    if not source_dir.is_dir():
        raise FileNotFoundError(source_dir)
    target_dir = root / plugin_id / target
    target_dir.mkdir()
    try:
        shutil.copytree(source_dir, target_dir, symlinks=True, dirs_exist_ok=True)
        manifest_path = target_dir / MANIFEST_FILE
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        raw["version"] = target
        raw["checksum"] = package_checksum(
            {
                path.relative_to(target_dir).as_posix(): sha256_file(path)
                for path in target_dir.rglob("*")
                if path.is_file() and not path.is_symlink()
            }
        )
        manifest_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    except BaseException:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise


async def start_development(
    db: AsyncSession, plugin_id: str, version: str, bump: str, actor_uuid: UUID | None
) -> dict[str, Any]:
    _require_feature()
    if not local_development():
        raise HTTPException(409, detail="A new version is developed on a local stack only, where MODE is local")
    plugin = await _plugin_or_404(db, plugin_id)
    versions = await _versions(db, plugin)
    source = next((v for v in versions if v.version == version), None)
    if source is None:
        raise HTTPException(404, detail="Version not found")
    if source.state not in {VERSION_ACTIVE, VERSION_RETIRED}:
        raise HTTPException(409, detail="A new version starts from an approved one")
    current = next((v for v in versions if v.state == VERSION_DEVELOPMENT), None)
    if current is not None:
        raise HTTPException(
            409, detail=f"{current.version} is in development: approve it, or delete its directory and rescan"
        )

    root = Path(settings.WIDGET_PLUGINS_DIR or "")
    on_disk = await asyncio.to_thread(_version_names, root / plugin.plugin_id)
    target = next_version({*on_disk, *(v.version for v in versions)}, bump)
    if not re.fullmatch(VERSION_PATTERN, target):
        raise HTTPException(409, detail=f"{target} is not a version number this host accepts")
    try:
        await asyncio.to_thread(_copy_version, root, plugin.plugin_id, source.version, target)
    except FileExistsError:
        raise HTTPException(409, detail=f"{plugin.plugin_id}/{target} already exists in the plugins directory") from None
    except FileNotFoundError:
        raise HTTPException(409, detail=f"The files of {source.version} are not in the plugins directory") from None
    except OSError as error:
        raise HTTPException(409, detail=f"The plugins directory cannot be written: {error.strerror}") from None

    found = await asyncio.to_thread(_inspect_development, plugin.plugin_id, target)
    row = models.WidgetPluginVersion(plugin_uuid=plugin.uuid, version=target, path=found.path, discovered_at=get_now())
    _record(row, found)
    row.state = VERSION_DEVELOPMENT
    db.add(row)
    _event(
        db,
        plugin,
        "development-started",
        version=target,
        actor_uuid=actor_uuid,
        details={"from": source.version, "digest": found.digest},
    )
    await db.commit()
    return {"plugin_id": plugin.plugin_id, "version": target, "path": found.path}


async def approve(
    db: AsyncSession,
    plugin_id: str,
    version: str,
    *,
    digest: str,
    acknowledged: list[str],
    actor_uuid: UUID | None,
) -> dict[str, Any]:
    _require_feature()
    plugin = await _plugin_or_404(db, plugin_id)
    versions = await _versions(db, plugin)
    row = next((v for v in versions if v.version == version), None)
    if row is None:
        raise HTTPException(404, detail="Version not found")
    if row.state not in {VERSION_DISCOVERED, VERSION_RETIRED, VERSION_DEVELOPMENT}:
        raise HTTPException(409, detail=f"This version is {row.state} and cannot be approved")
    developing = row.state == VERSION_DEVELOPMENT
    if not developing and row.digest != digest:
        raise HTTPException(409, detail="The version changed since it was reviewed; review it again")

    found = await asyncio.to_thread(
        inspect_version,
        Path(settings.WIDGET_PLUGINS_DIR or ""),
        plugin.plugin_id,
        version,
        **_scan_settings(),
    )
    if developing:
        if found.digest != digest:
            raise HTTPException(409, detail="The version changed since it was reviewed; review it again")
        if found.blocked:
            raise HTTPException(409, detail=f"The version cannot be approved: {'; '.join(found.errors)}")
        _record(row, found)
    elif found.blocked or found.digest != row.digest:
        _remember_state(row)
        row.state = VERSION_BLOCKED
        row.blocked_reason = CHANGED if found.digest != row.digest else "; ".join(found.errors)
        metrics.BLOCKS.labels("changed" if found.digest != row.digest else found.block_reason or "files").inc()
        _event(
            db,
            plugin,
            "blocked",
            version=version,
            actor_uuid=actor_uuid,
            details={"errors": found.errors, "found": found.digest},
        )
        await db.commit()
        raise HTTPException(409, detail=f"The version cannot be approved: {row.blocked_reason}")

    active = _active(plugin, versions)
    items = review_items(plugin, row, active)
    missing = [i["key"] for i in items if i["added"] and i["key"] not in set(acknowledged)]
    if missing:
        raise HTTPException(422, detail={"message": "Acknowledge every added request", "missing": missing})

    manifest = row.manifest or {}
    if active is not None and active is not row:
        active.state = VERSION_RETIRED
    row.state = VERSION_ACTIVE
    row.blocked_reason = None
    row.approved = {
        **_approval_of(manifest, row.digest),
        "skills": dict((row.findings or {}).get("skills") or {}),
        "acknowledged": sorted({i["key"] for i in items if i["added"]}),
    }
    row.approved_by_uuid = actor_uuid
    row.approved_at = get_now()
    plugin.active_version = row.version
    plugin.name = manifest.get("name") or plugin.name
    if plugin.status == PLUGIN_DISABLED:
        plugin.status = PLUGIN_ENABLED
    metrics.APPROVALS.inc()
    _event(
        db,
        plugin,
        "approved",
        version=version,
        actor_uuid=actor_uuid,
        details={
            "digest": row.digest,
            "acknowledged": row.approved["acknowledged"],
            "replaced": active.version if active is not None and active is not row else None,
        },
    )
    await db.commit()
    return {"plugin_id": plugin.plugin_id, "active_version": row.version, "status": plugin.status}


async def set_status(db: AsyncSession, plugin_id: str, revoke: bool, actor_uuid: UUID | None) -> dict[str, Any]:
    plugin = await _plugin_or_404(db, plugin_id)
    if revoke:
        plugin.status = PLUGIN_REVOKED
    else:
        plugin.status = PLUGIN_ENABLED if plugin.active_version else PLUGIN_DISABLED
        backends.reset(plugin.plugin_id)
    _event(db, plugin, "revoked" if revoke else "restored", actor_uuid=actor_uuid)
    await db.commit()
    return {"plugin_id": plugin.plugin_id, "status": plugin.status}


async def set_overrides(  # noqa: PLR0913
    db: AsyncSession,
    plugin_id: str,
    csp: dict[str, list[str]] | None,
    server_network: list[str] | None,
    confirmations: list[str],
    actor_uuid: UUID | None,
) -> dict[str, Any]:
    plugin = await _plugin_or_404(db, plugin_id)
    given = set(confirmations)
    check = csp_rules.check_policy(csp or {}, confirmations=given, override=True)
    errors, needed = list(check.errors), set(check.needs)
    if server_network is not None:
        backend = any(_server(v.manifest).get("backend") for v in await _versions(db, plugin))
        network_check = proxy_rules.check_network(server_network, confirmations=given, override=True, backend=backend)
        errors.extend(network_check.errors)
        needed |= network_check.needs
        if len(set(server_network)) != len(server_network):
            errors.append("server.network: a host is listed twice")
        if csp_rules.PRIVATE_HOST in given:
            needed.add(csp_rules.PRIVATE_HOST)
    if errors:
        raise HTTPException(422, detail={"message": "The override is not valid", "errors": errors})
    overrides: dict[str, Any] = {}
    if csp:
        overrides["csp"] = csp
    if server_network is not None:
        overrides["server_network"] = server_network
    if overrides:
        overrides["confirmations"] = sorted(needed)
    plugin.overrides = overrides or None
    _event(
        db,
        plugin,
        "overrides",
        actor_uuid=actor_uuid,
        details={"csp": csp, "server_network": server_network, "confirmations": sorted(needed)},
    )
    await db.commit()
    return {"plugin_id": plugin.plugin_id, "overrides": plugin.overrides or {}}


async def set_secret(db: AsyncSession, plugin_id: str, name: str, value: str, actor_uuid: UUID | None) -> None:
    plugin = await _plugin_or_404(db, plugin_id)
    if name not in secret_values.declared(await _versions(db, plugin)):
        raise HTTPException(404, detail="No version of this plugin declares this secret")
    if secret_values.configured(plugin.plugin_id, name) is not None:
        raise HTTPException(409, detail="The deployment sets this secret; change it there")
    problem = secret_values.value_problem(value)
    if problem:
        raise HTTPException(422, detail=problem)
    row = (await secret_values.stored(db, plugin.uuid)).get(name)
    if row is None:
        new = models.WidgetPluginSecret(plugin_uuid=plugin.uuid, name=name, value={"value": value})
        row = await _added_or_existing(
            db,
            new,
            select(models.WidgetPluginSecret).where(
                models.WidgetPluginSecret.plugin_uuid == plugin.uuid, models.WidgetPluginSecret.name == name
            ),
        )
    row.value = {"value": value}
    row.set_by_uuid = actor_uuid
    _event(db, plugin, "secret-set", actor_uuid=actor_uuid, details={"name": name})
    await db.commit()


async def clear_secret(db: AsyncSession, plugin_id: str, name: str, actor_uuid: UUID | None) -> None:
    plugin = await _plugin_or_404(db, plugin_id)
    row = (await secret_values.stored(db, plugin.uuid)).get(name)
    if row is None:
        raise HTTPException(404, detail="No value is stored for this secret")
    await db.delete(row)
    _event(db, plugin, "secret-cleared", actor_uuid=actor_uuid, details={"name": name})
    await db.commit()


async def forget(db: AsyncSession, plugin_id: str) -> None:
    plugin = await _plugin_or_404(db, plugin_id)
    versions = await _versions(db, plugin)
    if any(v.state != VERSION_MISSING for v in versions):
        raise HTTPException(409, detail="Only a plugin whose files are all gone can be forgotten")
    await db.execute(delete(models.WidgetPluginSecret).where(models.WidgetPluginSecret.plugin_uuid == plugin.uuid))
    await db.delete(plugin)
    await db.commit()


def _entity_row_query(entity_uuid: UUID, plugin: models.WidgetPlugin) -> Select:
    return select(models.EntityWidgetPlugin).where(
        models.EntityWidgetPlugin.entity_uuid == entity_uuid,
        models.EntityWidgetPlugin.plugin_uuid == plugin.uuid,
    )


async def _entity_row(db: AsyncSession, entity_uuid: UUID, plugin: models.WidgetPlugin):
    return (await db.execute(_entity_row_query(entity_uuid, plugin))).scalar_one_or_none()


async def entity_listing(db: AsyncSession, entity_uuid: UUID) -> list[dict[str, Any]]:
    plugins = (
        (
            await db.execute(
                select(models.WidgetPlugin)
                .where(models.WidgetPlugin.active_version.is_not(None))
                .order_by(models.WidgetPlugin.plugin_id)
            )
        )
        .scalars()
        .all()
    )
    handlers = {
        h.viz_type: (h.plugin_uuid, h.widget_id)
        for h in (
            await db.execute(select(models.EntityVizHandler).where(models.EntityVizHandler.entity_uuid == entity_uuid))
        ).scalars()
    }
    result = []
    for plugin in plugins:
        versions = await _versions(db, plugin)
        active = _active(plugin, versions)
        if active is None:
            continue
        row = await _entity_row(db, entity_uuid, plugin)
        manifest = active.manifest or {}
        approved = csp_rules.approved_policy((active.approved or {}).get("csp"), _overrides_csp(plugin))
        narrowed = csp_rules.narrow(approved, row.csp_narrow if row else None)
        network = approved_network(plugin, (active.approved or {}).get("server_network", []))
        removed_hosts = set((row.server_network_narrow if row else None) or [])
        grants = (
            await db.execute(
                select(func.count())
                .select_from(models.RoleWidgetPlugin)
                .join(models.Role, models.Role.uuid == models.RoleWidgetPlugin.role_uuid)
                .where(
                    models.RoleWidgetPlugin.plugin_uuid == plugin.uuid,
                    models.Role.entity_uuid == entity_uuid,
                    models.Role.deleted_at.is_(None),
                )
            )
        ).scalar_one()
        result.append(
            {
                "plugin_id": plugin.plugin_id,
                "name": plugin.name,
                "status": plugin.status,
                "active_version": plugin.active_version,
                "available": plugin.status == PLUGIN_ENABLED and active.state == VERSION_ACTIVE,
                "description": manifest.get("description", ""),
                "publisher": manifest.get("publisher"),
                "widgets": [
                    {
                        "id": w["id"],
                        "name": w.get("name"),
                        "description": w.get("description", ""),
                        "handles": [h["type"] for h in w.get("handles", [])],
                        "standalone": bool(w.get("standalone")),
                        "artifact": bool(w.get("artifact")),
                        "permissions": (active.approved or {}).get("permissions", {}).get(w["id"], []),
                    }
                    for w in _widgets(manifest)
                ],
                "admin_settings_schema": (manifest.get("adminSettings") or {}).get("schema"),
                "enabled": bool(row and row.enabled),
                "settings": (row.settings if row else None)
                or (manifest.get("adminSettings") or {}).get("defaults")
                or {},
                "narrowed_permissions": (row.narrowed_permissions if row else None) or [],
                "csp_narrow": (row.csp_narrow if row else None) or {},
                "csp": {
                    "approved": approved,
                    "effective": csp_rules.compose(narrowed),
                    "egress": csp_rules.hosts(narrowed),
                },
                "server_network_narrow": sorted(removed_hosts),
                "data_sources": [
                    {**d, "backend_uuid": ((row.data_sources if row else None) or {}).get(d["id"])}
                    for d in manifest.get("dataSources", [])
                ],
                "server": {
                    "network": {"approved": network, "effective": [h for h in network if h not in removed_hosts]},
                    "proxies": [p["id"] for p in _server(manifest).get("proxies", [])],
                },
                "handlers": {
                    vt: widget_id for vt, (plugin_uuid, widget_id) in handlers.items() if plugin_uuid == plugin.uuid
                },
                "role_grants": grants,
                "preset_limit": (row.preset_limit if row else None) or DEFAULT_PRESET_LIMIT,
            }
        )
    return result


async def update_entity(  # noqa: PLR0912, PLR0915
    db: AsyncSession,
    entity_uuid: UUID,
    plugin_id: str,
    changes: dict[str, Any],
    actor_uuid: UUID | None,
) -> None:
    plugin = await _plugin_or_404(db, plugin_id)
    versions = await _versions(db, plugin)
    active = _active(plugin, versions)
    if active is None:
        raise HTTPException(409, detail="No version of this plugin has been approved")
    manifest = active.manifest or {}
    row = await _entity_row(db, entity_uuid, plugin)
    if row is None:
        row = await _added_or_existing(
            db,
            models.EntityWidgetPlugin(entity_uuid=entity_uuid, plugin_uuid=plugin.uuid, enabled=False),
            _entity_row_query(entity_uuid, plugin),
        )

    if "enabled" in changes and changes["enabled"] is not None:
        row.enabled = bool(changes["enabled"])
    if changes.get("narrowed_permissions") is not None:
        unknown = set(changes["narrowed_permissions"]) - PERMISSIONS
        if unknown:
            raise HTTPException(422, detail=f"Unknown permissions: {', '.join(sorted(unknown))}")
        row.narrowed_permissions = sorted(set(changes["narrowed_permissions"])) or None
    if changes.get("csp_narrow") is not None:
        approved = csp_rules.approved_policy((active.approved or {}).get("csp"), _overrides_csp(plugin))
        narrowing = changes["csp_narrow"]
        if not isinstance(narrowing, dict):
            raise HTTPException(422, detail="csp_narrow is an object of directive to sources")
        for directive, allowed in narrowing.items():
            if directive not in approved or not isinstance(allowed, list) or not set(allowed) <= set(approved[directive]):
                raise HTTPException(422, detail=f"{directive}: an entity can only keep sources the superuser approved")
        row.csp_narrow = narrowing or None
    if changes.get("server_network_narrow") is not None:
        network = approved_network(plugin, (active.approved or {}).get("server_network", []))
        if not set(changes["server_network_narrow"]) <= set(network):
            raise HTTPException(422, detail="An entity can only remove hosts the superuser approved")
        row.server_network_narrow = sorted(set(changes["server_network_narrow"])) or None
    if changes.get("data_sources") is not None:
        row.data_sources = await _data_sources(db, entity_uuid, manifest, row.data_sources, changes["data_sources"])
    if changes.get("settings") is not None:
        schema = (manifest.get("adminSettings") or {}).get("schema") or {}
        problems = validate_settings_values(schema, changes["settings"])
        if problems:
            raise HTTPException(422, detail={"message": "Invalid settings", "errors": problems})
        row.settings = changes["settings"]
    if "preset_limit" in changes:
        row.preset_limit = changes["preset_limit"]
    if changes.get("handlers") is not None:
        handled = {h["type"]: w["id"] for w in _widgets(manifest) for h in w.get("handles", [])}
        for viz_type, widget_id in changes["handlers"].items():
            if viz_type not in handled:
                raise HTTPException(422, detail=f"This plugin does not handle {viz_type!r}")
            existing = (
                await db.execute(
                    select(models.EntityVizHandler).where(
                        models.EntityVizHandler.entity_uuid == entity_uuid,
                        models.EntityVizHandler.viz_type == viz_type,
                    )
                )
            ).scalar_one_or_none()
            if widget_id is None:
                if existing is not None and existing.plugin_uuid == plugin.uuid:
                    await db.delete(existing)
                continue
            if handled[viz_type] != widget_id:
                raise HTTPException(422, detail=f"{widget_id!r} does not render {viz_type!r}")
            if existing is None:
                existing = await _added_or_existing(
                    db,
                    models.EntityVizHandler(
                        entity_uuid=entity_uuid, viz_type=viz_type, plugin_uuid=plugin.uuid, widget_id=widget_id
                    ),
                    select(models.EntityVizHandler).where(
                        models.EntityVizHandler.entity_uuid == entity_uuid,
                        models.EntityVizHandler.viz_type == viz_type,
                    ),
                )
            existing.plugin_uuid = plugin.uuid
            existing.widget_id = widget_id

    _event(
        db,
        plugin,
        "entity-updated",
        entity_uuid=entity_uuid,
        actor_uuid=actor_uuid,
        details={k: v for k, v in changes.items() if v is not None},
    )
    await db.commit()


async def _data_sources(
    db: AsyncSession, entity_uuid: UUID, manifest: dict, current: dict | None, changes: dict[str, Any]
) -> dict | None:
    declared = {d["id"] for d in manifest.get("dataSources", [])}
    mapping = dict(current or {})
    for source_id, backend_uuid in changes.items():
        if source_id not in declared:
            raise HTTPException(422, detail=f"This plugin declares no data source {source_id!r}")
        if backend_uuid is None:
            mapping.pop(source_id, None)
            continue
        owned = (
            await db.execute(
                select(models.ApiSource.uuid).where(
                    models.ApiSource.uuid == UUID(str(backend_uuid)), models.ApiSource.entity_uuid == entity_uuid
                )
            )
        ).scalar_one_or_none()
        if owned is None:
            raise HTTPException(422, detail="A data source is served by one of the organization's backends")
        mapping[source_id] = str(owned)
    return mapping or None


async def entity_backends(db: AsyncSession, entity_uuid: UUID) -> list[dict[str, str]]:
    rows = await db.execute(
        select(models.ApiSource.uuid, models.ApiSource.name)
        .where(models.ApiSource.entity_uuid == entity_uuid)
        .order_by(models.ApiSource.name)
    )
    return [{"uuid": str(r.uuid), "name": r.name} for r in rows]


async def update_all_entities(db: AsyncSession, plugin_id: str, changes: dict[str, Any], actor_uuid: UUID | None) -> int:
    entity_uuids = (await db.execute(select(models.Entity.uuid))).scalars().all()
    for entity_uuid in entity_uuids:
        await update_entity(db, entity_uuid, plugin_id, changes, actor_uuid)
    return len(entity_uuids)


async def get_role_grants(db: AsyncSession, role_uuid: UUID) -> list[dict[str, str]]:
    rows = (
        await db.execute(
            select(models.WidgetPlugin.plugin_id, models.RoleWidgetPlugin.widget_id)
            .join(models.WidgetPlugin, models.WidgetPlugin.uuid == models.RoleWidgetPlugin.plugin_uuid)
            .where(models.RoleWidgetPlugin.role_uuid == role_uuid)
            .order_by(models.WidgetPlugin.plugin_id, models.RoleWidgetPlugin.widget_id)
        )
    ).all()
    return [{"plugin_id": r.plugin_id, "widget_id": r.widget_id} for r in rows]


async def set_role_grants(db: AsyncSession, role_uuid: UUID, grants: list[dict[str, str]]) -> None:
    wanted: set[tuple[UUID, str]] = set()
    for grant in grants:
        plugin = await _plugin_or_404(db, grant["plugin_id"])
        widget_id = grant.get("widget_id") or "*"
        if widget_id != "*":
            versions = await _versions(db, plugin)
            active = _active(plugin, versions)
            known = {w["id"] for w in _widgets(active.manifest if active else None)}
            if widget_id not in known:
                raise HTTPException(422, detail=f"{grant['plugin_id']} has no widget {widget_id!r}")
        wanted.add((plugin.uuid, widget_id))

    existing = {
        (r.plugin_uuid, r.widget_id): r
        for r in (
            await db.execute(select(models.RoleWidgetPlugin).where(models.RoleWidgetPlugin.role_uuid == role_uuid))
        ).scalars()
    }
    for key, row in existing.items():
        if key not in wanted:
            await db.delete(row)
    for plugin_uuid, widget_id in wanted - set(existing):
        await _added_or_existing(
            db,
            models.RoleWidgetPlugin(role_uuid=role_uuid, plugin_uuid=plugin_uuid, widget_id=widget_id),
            select(models.RoleWidgetPlugin).where(
                models.RoleWidgetPlugin.role_uuid == role_uuid,
                models.RoleWidgetPlugin.plugin_uuid == plugin_uuid,
                models.RoleWidgetPlugin.widget_id == widget_id,
            ),
        )
    await db.commit()


async def user_entity(db: AsyncSession, user_uuid: UUID) -> UUID | None:
    return (
        await db.execute(
            select(models.PermissionsEntityMap.entity_uuid)
            .join(models.User, models.User.permissions_uuid == models.PermissionsEntityMap.uuid)
            .where(models.User.uuid == user_uuid)
        )
    ).scalar_one_or_none()


async def available(db: AsyncSession, user_uuid: UUID) -> list[dict[str, Any]]:
    if not feature_enabled():
        return []
    entity_uuid = await user_entity(db, user_uuid)
    if entity_uuid is None:
        return []

    rows = (
        await db.execute(
            select(models.WidgetPlugin, models.WidgetPluginVersion, models.EntityWidgetPlugin)
            .join(
                models.WidgetPluginVersion,
                (models.WidgetPluginVersion.plugin_uuid == models.WidgetPlugin.uuid)
                & (models.WidgetPluginVersion.version == models.WidgetPlugin.active_version),
            )
            .join(
                models.EntityWidgetPlugin,
                (models.EntityWidgetPlugin.plugin_uuid == models.WidgetPlugin.uuid)
                & (models.EntityWidgetPlugin.entity_uuid == entity_uuid),
            )
            .where(
                models.WidgetPlugin.status == PLUGIN_ENABLED,
                models.WidgetPluginVersion.state == VERSION_ACTIVE,
                models.EntityWidgetPlugin.enabled.is_(True),
            )
            .order_by(models.WidgetPlugin.plugin_id)
        )
    ).all()
    if not rows:
        return []

    granted: dict[UUID, set[str]] = {}
    for plugin_uuid, widget_id in (
        await db.execute(
            select(models.RoleWidgetPlugin.plugin_uuid, models.RoleWidgetPlugin.widget_id)
            .join(models.UserRole, models.UserRole.role_uuid == models.RoleWidgetPlugin.role_uuid)
            .join(models.Role, models.Role.uuid == models.RoleWidgetPlugin.role_uuid)
            .where(
                models.UserRole.user_uuid == user_uuid,
                models.Role.entity_uuid == entity_uuid,
                models.Role.deleted_at.is_(None),
            )
        )
    ).all():
        granted.setdefault(plugin_uuid, set()).add(widget_id)

    developing = await development_versions(db, [plugin for plugin, _version, _row in rows])
    plugins = []
    for plugin, active, entity_row in rows:
        version = developing.get(plugin.uuid) or active
        if isinstance(version, LiveVersion) and version.errors:
            continue
        manifest = version.manifest or {}
        approved = version.approved or {}
        narrowed = set(entity_row.narrowed_permissions or [])
        widgets = []
        for widget in _widgets(manifest):
            grants = granted.get(plugin.uuid, set())
            if "*" not in grants and widget["id"] not in grants:
                continue
            permissions = [
                p
                for p in widget.get("permissions", [])
                if p in set(approved.get("permissions", {}).get(widget["id"], [])) and p not in narrowed
            ]
            widgets.append({**widget, "permissions": sorted({"core:default", *permissions})})
        if not widgets:
            continue
        policy = csp_rules.narrow(
            csp_rules.approved_policy(approved.get("csp"), _overrides_csp(plugin)),
            entity_row.csp_narrow,
        )
        removed_hosts = set(entity_row.server_network_narrow or [])
        plugins.append(
            {
                "plugin": plugin,
                "version": version,
                "entity_row": entity_row,
                "widgets": widgets,
                "csp": csp_rules.compose(policy),
                "network": [
                    h for h in approved_network(plugin, approved.get("server_network", [])) if h not in removed_hosts
                ],
                "private": private_allowed(plugin),
            }
        )
    return plugins


_skill_texts: dict[tuple[str, str], str] = {}
SKILL_TEXT_ENTRIES = 512


def _read_skill(version: models.WidgetPluginVersion, file_path: str) -> str | None:
    key = (version.digest or "", file_path)
    if (cached := _skill_texts.get(key)) is not None:
        return cached
    approved = ((version.approved or {}).get("skills") or {}).get(file_path)
    path = resolve_served_file(settings.WIDGET_PLUGINS_DIR or "", version.path, file_path)
    if approved is None or path is None or cached_sha256(path) != approved:
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    if len(_skill_texts) >= SKILL_TEXT_ENTRIES:
        _skill_texts.pop(next(iter(_skill_texts)))
    _skill_texts[key] = text
    return text


async def plugin_skills(db: AsyncSession, user_uuid: UUID) -> list[dict[str, Any]]:
    if not feature_enabled():
        return []
    entity_uuid = await user_entity(db, user_uuid)
    if entity_uuid is None:
        return []
    rows = (
        await db.execute(
            select(models.WidgetPlugin, models.WidgetPluginVersion)
            .join(
                models.WidgetPluginVersion,
                (models.WidgetPluginVersion.plugin_uuid == models.WidgetPlugin.uuid)
                & (models.WidgetPluginVersion.version == models.WidgetPlugin.active_version),
            )
            .join(
                models.EntityWidgetPlugin,
                (models.EntityWidgetPlugin.plugin_uuid == models.WidgetPlugin.uuid)
                & (models.EntityWidgetPlugin.entity_uuid == entity_uuid),
            )
            .where(
                models.WidgetPlugin.status == PLUGIN_ENABLED,
                models.WidgetPluginVersion.state == VERSION_ACTIVE,
                models.EntityWidgetPlugin.enabled.is_(True),
            )
            .order_by(models.WidgetPlugin.plugin_id)
        )
    ).all()
    skills: list[dict[str, Any]] = []
    taken: set[str] = set()
    for plugin, version in rows:
        for skill in ((version.manifest or {}).get("contributes") or {}).get("skills", []):
            if skill["slug"] in taken:
                continue
            text = await asyncio.to_thread(_read_skill, version, skill["file"])
            if text is None:
                continue
            taken.add(skill["slug"])
            stamp = version.approved_at or version.discovered_at or get_now()
            skills.append(
                {
                    "uuid": uuid5(NAMESPACE_URL, f"widget-plugin-skill:{plugin.plugin_id}/{skill['slug']}"),
                    "slug": skill["slug"],
                    "description": skill["description"],
                    "content": text,
                    "plugin_name": plugin.name,
                    "created_date": stamp,
                    "updated_date": stamp,
                }
            )
    return skills


async def user_listing(db: AsyncSession, user_uuid: UUID) -> dict[str, Any]:
    if not feature_enabled():
        return {"enabled": False, "etag": "off", "plugins": []}
    entries = await available(db, user_uuid)
    entity_uuid = await user_entity(db, user_uuid)
    choices = (
        {
            h.viz_type: (h.plugin_uuid, h.widget_id)
            for h in (
                await db.execute(
                    select(models.EntityVizHandler).where(models.EntityVizHandler.entity_uuid == entity_uuid)
                )
            ).scalars()
        }
        if entity_uuid
        else {}
    )

    candidates: dict[str, list[tuple[str, str, UUID]]] = {}
    for entry in entries:
        for widget in entry["widgets"]:
            for handle in widget.get("handles", []):
                candidates.setdefault(handle["type"], []).append(
                    (entry["plugin"].plugin_id, widget["id"], entry["plugin"].uuid)
                )
    handlers: dict[str, dict[str, str]] = {}
    for viz_type, options in candidates.items():
        chosen = choices.get(viz_type)
        pick = next((o for o in options if chosen and (o[2], o[1]) == chosen), None) or min(options)
        handlers[viz_type] = {"plugin": pick[0], "widget": pick[1]}

    plugins = []
    for entry in entries:
        plugin, version = entry["plugin"], entry["version"]
        manifest = version.manifest or {}
        settings_values = entry["entity_row"].settings or (manifest.get("adminSettings") or {}).get("defaults") or {}
        plugins.append(
            {
                "id": plugin.plugin_id,
                "version": version.version,
                "name": plugin.name,
                "description": manifest.get("description", ""),
                "publisher": manifest.get("publisher"),
                "digest": version.digest,
                "entry": manifest.get("entry"),
                "files": version.files or {},
                "csp": entry["csp"],
                "adminSettings": settings_values,
                "widgets": [
                    {
                        "id": w["id"],
                        "name": w["name"],
                        "description": w.get("description", ""),
                        "category": w.get("category"),
                        "subCategory": w.get("subCategory"),
                        "handles": w.get("handles", []),
                        "standalone": bool(w.get("standalone")),
                        "permissions": w["permissions"],
                        "proxies": (w.get("server") or {}).get("proxies", [])
                        if "core:proxy:call" in w["permissions"]
                        else [],
                        "routes": (w.get("server") or {}).get("routes", [])
                        if "core:backend:call" in w["permissions"]
                        else [],
                        "artifact": w.get("artifact"),
                        "model": w.get("model"),
                        "params": w.get("params", []),
                        "settings": w.get("settings"),
                        "grid": w.get("grid") or {"w": 20, "h": 12},
                        "actions": [
                            a for a in w.get("actions", []) if ACTION_PERMISSIONS[a["placement"]] in w["permissions"]
                        ],
                    }
                    for w in entry["widgets"]
                ],
            }
        )
    body = {"enabled": True, "plugins": plugins, "vizHandlers": handlers}
    etag = hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:32]
    return {**body, "etag": etag}


async def served_file(
    db: AsyncSession, user_uuid: UUID, plugin_id: str, digest: str, file_path: str
) -> tuple[Path, dict[str, Any]]:
    def refused(detail: str) -> HTTPException:
        metrics.FILE_FETCHES.labels("refused").inc()
        return HTTPException(404, detail=detail)

    entry = next((e for e in await available(db, user_uuid) if e["plugin"].plugin_id == plugin_id), None)
    if entry is None:
        raise refused("Plugin not found")
    version = entry["version"]
    if version.digest != digest:
        raise refused("This version of the plugin is not the active one")
    info = (version.files or {}).get(file_path)
    if info is None:
        raise refused("Not a file of this plugin")
    path = await asyncio.to_thread(resolve_served_file, settings.WIDGET_PLUGINS_DIR or "", version.path, file_path)
    if path is None:
        raise refused("Not a file of this plugin")
    if await asyncio.to_thread(cached_sha256, path) != info["sha256"]:
        if isinstance(version, LiveVersion):
            metrics.FILE_FETCHES.labels("changed").inc()
            raise HTTPException(409, detail="The plugin's files changed while they were read; reload")
        plugin = entry["plugin"]
        _remember_state(version)
        version.state = VERSION_BLOCKED
        version.blocked_reason = CHANGED
        _event(db, plugin, "changed", version=version.version, details={"file": file_path})
        await db.commit()
        metrics.FILE_FETCHES.labels("changed").inc()
        metrics.BLOCKS.labels("changed").inc()
        raise HTTPException(409, detail="The plugin's files changed; it was blocked")
    metrics.FILE_FETCHES.labels("served").inc()
    return path, info


def _clean_origin(origin: str) -> str | None:
    origin = origin.strip().lower()[:MAX_REPORT_ORIGIN_LENGTH]
    if origin in REPORT_KEYWORDS or _REPORT_ORIGIN.match(origin):
        return origin
    return None


async def record_reports(  # noqa: PLR0913
    db: AsyncSession,
    user_uuid: UUID,
    plugin_id: str,
    version: str,
    reports: list[dict[str, str]],
    failure: str | None = None,
) -> int:
    entry = next((e for e in await available(db, user_uuid) if e["plugin"].plugin_id == plugin_id), None)
    if entry is None or entry["version"].version != version:
        return 0
    if failure is not None:
        metrics.FRAME_FAILURES.labels(plugin_id, version, failure).inc()
    plugin = entry["plugin"]
    entity_uuid = entry["entity_row"].entity_uuid
    now = get_now()
    await db.execute(
        delete(models.WidgetPluginCspReport).where(
            models.WidgetPluginCspReport.plugin_uuid == plugin.uuid,
            models.WidgetPluginCspReport.last_seen < now - REPORT_RETENTION,
        )
    )
    existing = {
        (r.directive, r.blocked_origin): r
        for r in (
            await db.execute(
                select(models.WidgetPluginCspReport).where(
                    models.WidgetPluginCspReport.plugin_uuid == plugin.uuid,
                    models.WidgetPluginCspReport.entity_uuid == entity_uuid,
                )
            )
        ).scalars()
    }
    stored = 0
    for report in reports[:MAX_REPORTS_PER_REQUEST]:
        directive = str(report.get("directive", ""))[:MAX_REPORT_DIRECTIVE_LENGTH]
        origin = _clean_origin(str(report.get("origin", "")))
        if directive not in {*csp_rules.POLICY_DIRECTIVES, "default-src"} or origin is None:
            continue
        row = existing.get((directive, origin))
        if row is None:
            if len(existing) >= MAX_REPORT_ORIGINS:
                continue
            row = existing[(directive, origin)] = await _added_or_existing(
                db,
                models.WidgetPluginCspReport(
                    plugin_uuid=plugin.uuid,
                    version=version,
                    entity_uuid=entity_uuid,
                    directive=directive,
                    blocked_origin=origin,
                    count=0,
                    first_seen=now,
                ),
                select(models.WidgetPluginCspReport).where(
                    models.WidgetPluginCspReport.plugin_uuid == plugin.uuid,
                    models.WidgetPluginCspReport.entity_uuid == entity_uuid,
                    models.WidgetPluginCspReport.directive == directive,
                    models.WidgetPluginCspReport.blocked_origin == origin,
                ),
            )
        row.count += 1
        row.last_seen = now
        row.version = version
        metrics.CSP_REPORTS.labels(directive).inc()
        stored += 1
    await db.commit()
    return stored


async def list_reports(db: AsyncSession, plugin_id: str, entity_uuid: UUID | None = None) -> list[dict[str, Any]]:
    plugin = await _plugin_or_404(db, plugin_id)
    query = select(models.WidgetPluginCspReport).where(models.WidgetPluginCspReport.plugin_uuid == plugin.uuid)
    if entity_uuid is not None:
        query = query.where(models.WidgetPluginCspReport.entity_uuid == entity_uuid)
    rows = (await db.execute(query.order_by(models.WidgetPluginCspReport.count.desc()))).scalars().all()
    return [
        {
            "directive": r.directive,
            "origin": r.blocked_origin,
            "count": r.count,
            "version": r.version,
            "entity_uuid": r.entity_uuid,
            "first_seen": r.first_seen,
            "last_seen": r.last_seen,
        }
        for r in rows
    ]
