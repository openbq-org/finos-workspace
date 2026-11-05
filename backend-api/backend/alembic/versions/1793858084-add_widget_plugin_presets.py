import sqlalchemy as sa
import sqlalchemy_utils

import api.models.model_helpers
from alembic import op  # type: ignore

revision = "b7e2c94d1a63"
down_revision = "e5a9d3b7c104"
branch_labels = None
depends_on = None


def upgrade():
    uuid_type = sqlalchemy_utils.types.uuid.UUIDType
    json_type = api.models.model_helpers.JSONType
    op.create_table(
        "widget_plugin_preset",
        sa.Column("uuid", uuid_type(), nullable=False),
        sa.Column("created_date", api.models.model_helpers.AwareDateTime(), nullable=True),
        sa.Column("updated_date", api.models.model_helpers.AwareDateTime(), nullable=True),
        sa.Column("plugin_uuid", uuid_type(), nullable=False),
        sa.Column("widget_id", sa.String(length=48), nullable=False),
        sa.Column("entity_uuid", uuid_type(), nullable=False),
        sa.Column("owner_uuid", uuid_type(), nullable=True),
        sa.Column("scope", sa.String(length=8), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("config", json_type(), nullable=True),
        sa.Column("state", json_type(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["plugin_uuid"],
            ["widget_plugin.uuid"],
            name=op.f("fk_widget_plugin_preset_plugin_uuid_widget_plugin"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["entity_uuid"],
            ["entity.uuid"],
            name=op.f("fk_widget_plugin_preset_entity_uuid_entity"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["owner_uuid"],
            ["user.uuid"],
            name=op.f("fk_widget_plugin_preset_owner_uuid_user"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("uuid"),
    )
    with op.batch_alter_table("widget_plugin_preset", schema=None) as batch_op:
        batch_op.create_index(batch_op.f("ix_widget_plugin_preset_plugin_uuid"), ["plugin_uuid"], unique=False)
        batch_op.create_index(batch_op.f("ix_widget_plugin_preset_entity_uuid"), ["entity_uuid"], unique=False)
        batch_op.create_index(batch_op.f("ix_widget_plugin_preset_owner_uuid"), ["owner_uuid"], unique=False)
        batch_op.create_index("ix_widget_plugin_preset_widget", ["entity_uuid", "plugin_uuid", "widget_id"], unique=False)
    with op.batch_alter_table("entity_widget_plugin", schema=None) as batch_op:
        batch_op.add_column(sa.Column("preset_limit", sa.Integer(), nullable=True))


def downgrade():
    with op.batch_alter_table("entity_widget_plugin", schema=None) as batch_op:
        batch_op.drop_column("preset_limit")
    op.drop_table("widget_plugin_preset")
