from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy_utils import UUIDType

from api.models.model_helpers import (
    AwareDateTime,
    Base,
    DateMixin,
    EncryptedType,
    GzipJsonType,
    JSONType,
    UUIDMixin,
)

PLUGIN_DISABLED = "disabled"
PLUGIN_ENABLED = "enabled"
PLUGIN_REVOKED = "revoked"

VERSION_DISCOVERED = "discovered"
VERSION_ACTIVE = "active"
VERSION_BLOCKED = "blocked"
VERSION_RETIRED = "retired"
VERSION_MISSING = "missing"
VERSION_DEVELOPMENT = "development"

PRESET_USER = "user"
PRESET_ORG = "org"
DEFAULT_PRESET_LIMIT = 100


class WidgetPlugin(Base, UUIDMixin, DateMixin):
    __tablename__ = "widget_plugin"

    plugin_id: Mapped[str] = mapped_column(String(48), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(16), default=PLUGIN_DISABLED)
    active_version: Mapped[str | None] = mapped_column(String(32), default=None)
    overrides: Mapped[dict | None] = mapped_column(JSONType, default=None)


class WidgetPluginVersion(Base, UUIDMixin, DateMixin):
    __tablename__ = "widget_plugin_version"
    __table_args__ = (UniqueConstraint("plugin_uuid", "version", name="uix_widget_plugin_version"),)

    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    plugin: Mapped["WidgetPlugin"] = relationship(foreign_keys=[plugin_uuid])
    version: Mapped[str] = mapped_column(String(32))
    digest: Mapped[str | None] = mapped_column(String(80), default=None)
    declared_checksum: Mapped[str | None] = mapped_column(String(80), default=None)
    pin_status: Mapped[str] = mapped_column(String(16), default="unpinned")
    manifest: Mapped[dict | None] = mapped_column(GzipJsonType, default=None)
    files: Mapped[dict | None] = mapped_column(JSONType, default=None)
    path: Mapped[str] = mapped_column(String(120))
    state: Mapped[str] = mapped_column(String(16), default=VERSION_DISCOVERED)
    blocked_reason: Mapped[str | None] = mapped_column(Text, default=None)
    findings: Mapped[dict | None] = mapped_column(JSONType, default=None)
    discovered_at: Mapped[datetime | None] = mapped_column(AwareDateTime(), default=None)
    approved: Mapped[dict | None] = mapped_column(JSONType, default=None)
    approved_by_uuid: Mapped[UUID | None] = mapped_column(UUIDType, default=None)
    approved_at: Mapped[datetime | None] = mapped_column(AwareDateTime(), default=None)


class EntityWidgetPlugin(Base, UUIDMixin, DateMixin):
    __tablename__ = "entity_widget_plugin"
    __table_args__ = (UniqueConstraint("entity_uuid", "plugin_uuid", name="uix_entity_widget_plugin"),)

    entity_uuid: Mapped[UUID] = mapped_column(ForeignKey("entity.uuid", ondelete="CASCADE"), index=True)
    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    plugin: Mapped["WidgetPlugin"] = relationship(foreign_keys=[plugin_uuid])
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    settings: Mapped[dict | None] = mapped_column(JSONType, default=None)
    narrowed_permissions: Mapped[list | None] = mapped_column(JSONType, default=None)
    csp_narrow: Mapped[dict | None] = mapped_column(JSONType, default=None)
    server_network_narrow: Mapped[list | None] = mapped_column(JSONType, default=None)
    data_sources: Mapped[dict | None] = mapped_column(JSONType, default=None)
    preset_limit: Mapped[int | None] = mapped_column(Integer, default=None)


class EntityVizHandler(Base, UUIDMixin, DateMixin):
    __tablename__ = "entity_viz_handler"
    __table_args__ = (UniqueConstraint("entity_uuid", "viz_type", name="uix_entity_viz_handler"),)

    entity_uuid: Mapped[UUID] = mapped_column(ForeignKey("entity.uuid", ondelete="CASCADE"), index=True)
    viz_type: Mapped[str] = mapped_column(String(32))
    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    widget_id: Mapped[str] = mapped_column(String(48))


class RoleWidgetPlugin(Base, UUIDMixin, DateMixin):
    __tablename__ = "role_widget_plugin"
    __table_args__ = (UniqueConstraint("role_uuid", "plugin_uuid", "widget_id", name="uix_role_widget_plugin"),)

    role_uuid: Mapped[UUID] = mapped_column(ForeignKey("role.uuid", ondelete="CASCADE"), index=True)
    role = relationship("Role", foreign_keys=[role_uuid])
    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    plugin: Mapped["WidgetPlugin"] = relationship(foreign_keys=[plugin_uuid])
    widget_id: Mapped[str] = mapped_column(String(48), default="*")


class WidgetPluginEvent(Base, UUIDMixin, DateMixin):
    __tablename__ = "widget_plugin_event"

    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    version: Mapped[str | None] = mapped_column(String(32), default=None)
    entity_uuid: Mapped[UUID | None] = mapped_column(UUIDType, default=None, index=True)
    actor_uuid: Mapped[UUID | None] = mapped_column(UUIDType, default=None)
    action: Mapped[str] = mapped_column(String(48))
    details: Mapped[dict | None] = mapped_column(JSONType, default=None)


class WidgetPluginCspReport(Base, UUIDMixin, DateMixin):
    __tablename__ = "widget_plugin_csp_report"
    __table_args__ = (
        UniqueConstraint(
            "plugin_uuid",
            "entity_uuid",
            "directive",
            "blocked_origin",
            name="uix_widget_plugin_csp_report",
        ),
    )

    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(32))
    entity_uuid: Mapped[UUID] = mapped_column(ForeignKey("entity.uuid", ondelete="CASCADE"), index=True)
    directive: Mapped[str] = mapped_column(String(32))
    blocked_origin: Mapped[str] = mapped_column(String(255))
    count: Mapped[int] = mapped_column(Integer, default=0)
    first_seen: Mapped[datetime | None] = mapped_column(AwareDateTime(), default=None)
    last_seen: Mapped[datetime | None] = mapped_column(AwareDateTime(), default=None)


class WidgetPluginSecret(Base, UUIDMixin, DateMixin):
    __tablename__ = "widget_plugin_secret"
    __table_args__ = (UniqueConstraint("plugin_uuid", "name", name="uix_widget_plugin_secret"),)

    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    value: Mapped[dict] = mapped_column(EncryptedType("widget_plugin_secret.value"))
    set_by_uuid: Mapped[UUID | None] = mapped_column(UUIDType, default=None)


class WidgetPluginPreset(Base, UUIDMixin, DateMixin):
    __tablename__ = "widget_plugin_preset"
    __table_args__ = (Index("ix_widget_plugin_preset_widget", "entity_uuid", "plugin_uuid", "widget_id"),)

    plugin_uuid: Mapped[UUID] = mapped_column(ForeignKey("widget_plugin.uuid", ondelete="CASCADE"), index=True)
    widget_id: Mapped[str] = mapped_column(String(48))
    entity_uuid: Mapped[UUID] = mapped_column(ForeignKey("entity.uuid", ondelete="CASCADE"), index=True)
    owner_uuid: Mapped[UUID | None] = mapped_column(ForeignKey("user.uuid", ondelete="CASCADE"), default=None, index=True)
    scope: Mapped[str] = mapped_column(String(8), default=PRESET_USER)
    name: Mapped[str] = mapped_column(String(80))
    config: Mapped[dict | None] = mapped_column(JSONType, default=None)
    state: Mapped[Any] = mapped_column(JSONType, default=None, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
