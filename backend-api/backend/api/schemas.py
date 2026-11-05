import re
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Any, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

from fastapi.responses import JSONResponse
from pydantic import (
    AliasGenerator,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    HttpUrl,
    StringConstraints,
    alias_generators,
    field_validator,
    model_validator,
)
from pydantic.functional_validators import AfterValidator, BeforeValidator

from api import base
from api.events.types import RoleAuditAction, RoleResourceType
from utilities.config import settings

if TYPE_CHECKING:
    from api.models.workspace_models import CopilotChat


main_config = ConfigDict(extra="forbid", from_attributes=True)
AppLoginSource = Literal["app", "oauth-app"]
MetaDataWidgetType = Literal[
    "iframe",
    "copilot_table",
    "youtube",
    "widget_studio",
    "chart",
    "html",
    "ag_chart_from_table",
]

permissions_type = Literal["view", "comment"]
UserSourceType = Literal["user", "invite"]
ExtensionType = Literal[
    "csv",
    "json",
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "xls",
    "xlsx",
    "txt",
    "zip",
    "md",
    "docx",
    "doc",
    "html",
]
AccessType = Literal["no-access", "access", "full-access"]
UserType = Literal["Admin", "Developer", "User"]
SharingLevel = Literal["none", "receive", "share"]


def is_bad_word(word: str) -> bool:
    with open("utilities/bad_words.txt", encoding="utf-8") as f:
        for line in f:
            if line.replace("\n", "") == word:
                return True
    return False


def username_check(username: str) -> None | str:
    pattern = r"^\w{4,50}$"
    if not re.match(pattern, username, re.IGNORECASE):
        return (
            "Please make sure your username is letters, numbers, and underscores, and is between 4 and 50 characters long"  # noqa: E501
        )

    if is_bad_word(username.lower()):
        return "This username violates Community Guidelines"
    return None


def check_email(v: str) -> str:
    if not base.check_email(v):
        raise ValueError("Invalid email")
    return v


SharesPermissions = dict[Annotated[str, AfterValidator(check_email)], permissions_type]


VALID_REGEX = r"^(?=\S*[a-z])(?=\S*[A-Z])(?=\S*\d)(?=\S*[^\w\s])\S{8,}$"
SKILL_SLUG_REGEX = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def check_password(v: str) -> str:
    if isinstance(v, bytes):
        v = v.decode("utf-8")

    if isinstance(v, str) and not re.match(VALID_REGEX, v):
        raise ValueError(
            "Password must be at least 8 characters long, contain at least one "
            "uppercase letter, one lowercase letter, one number, and one special character. "
            "Spaces are not allowed."
        )
    return v


def check_email_or_username(v: str) -> str:
    if not base.check_email(v) and username_check(v):
        raise ValueError("Invalid email or username")
    return v


def check_totp_token(v: None | int) -> None | int:
    if v and len(str(v)) > 6:  # noqa: PLR2004
        raise ValueError("Invalid TOTP token")
    return v


def get_camel_config(**config: ConfigDict) -> ConfigDict:
    return ConfigDict(
        **config,
        populate_by_name=True,
        alias_generator=AliasGenerator(alias=alias_generators.to_camel),
    )


def _is_not_none(v) -> bool:
    return v is not None


class SuccessReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    success: bool = Field(description="Whether the operation succeeded.")

    @classmethod
    def success_instance(cls):
        return cls(success=True)

    @classmethod
    def failure_instance(cls):
        return cls(success=False)

    @classmethod
    def from_bool(cls, value: bool):
        return cls(success=value)


class PasswordResetLink(SuccessReturn):
    link: str = Field(description="The single-use link at which the user chooses a new password.")
    expires_at: datetime = Field(description="When the link stops working.")


class PasswordReset(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    token: Annotated[str, Field(min_length=1, max_length=128, description="The token from the password reset link.")]
    new_password: Annotated[str, AfterValidator(check_password)] = Field(
        description=(
            "The new password. It needs at least 8 characters, with an uppercase letter, a lowercase letter, a "
            "number and a special character, and no spaces."
        ),
    )


class DashboardShareReturn(BaseModel):
    created_date: None | datetime = Field(description="When the share was created.")
    permissions: None | base.PermissionEnum = Field(
        description="What the recipient may do with the dashboard: `view`, `comment` or `edit`.",
    )
    first_name: None | str = Field(description="The recipient's first name.")
    last_name: None | str = Field(description="The recipient's last name.")
    pending: bool = Field(False, description="Whether the share waits for an admin's approval.")


class ShareReturn(SuccessReturn):
    pending_approval: bool = Field(
        False,
        description="Whether the request waits for an admin's approval instead of taking effect.",
    )


class ShareRequestUser(BaseModel):
    email: str = Field(description="The user's email address.")
    first_name: None | str = Field(description="The user's first name.")
    last_name: None | str = Field(description="The user's last name.")


class ShareRequestReturn(BaseModel):
    uuid: UUID = Field(description="The UUID of the share request.")
    created_date: None | datetime = Field(description="When the request was made.")
    requester: ShareRequestUser = Field(description="The user who asked to share.")
    item_type: Literal["dashboard", "app"] = Field(description="What the request shares: a `dashboard` or an `app`.")
    item_uuid: UUID = Field(description="The UUID of the dashboard or the app.")
    item_name: str = Field(description="The name of the dashboard or the app.")
    recipient: None | ShareRequestUser = Field(
        description=(
            "The user who receives the share. It is empty when a dashboard is shared with the whole organization."
        ),
    )
    permissions: None | str = Field(description="What the recipient may do with the item: `view` or `comment`.")


class TotpGenerateReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    uri: str = Field(description="The provisioning URI that an authenticator app reads, usually as a QR code.")
    secret: str = Field(description="The authenticator secret, in base 32.")


class MessageReturn(SuccessReturn, extra="ignore"):  # type: ignore[call-arg]
    message: str = Field(description="A sentence that describes the result.")


class PendingFileReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    stored_file_uuid: None | UUID = Field(None, description="The UUID that the stored file received.")
    extension: None | str = Field(None, description="The file's extension.")
    original_file_name: None | str = Field(None, description="The name of the file as the user uploaded it.")
    url: None | str = Field(None, description="The address at which the API serves the file.")
    failed: bool = Field(False, description="Whether the upload failed.")


class PreSignedUrlReturn(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    pre_signed_url: str = Field(description="The signed link, which works without a session until it expires.")
    stored_file_uuid: UUID = Field(
        serialization_alias="stored_file_uuid",
        alias="uuid",
        description="The UUID of the stored file.",
    )
    original_file_name: str = Field(description="The name of the file as the user uploaded it.")


class AgentToken(BaseModel):
    model_config = main_config
    token: str = Field(description="The bearer token.")
    expires_in: int = Field(description="How many seconds the token stays valid.")


class UUIDReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    uuid: UUID = Field(description="The UUID of the new item.")


DISPLAY_SETTINGS_SECRETS = ("openaiApiKey", "perplexityApiKey")


class UserDisplaySettings(BaseModel, extra="allow"):  # type: ignore[call-arg]
    theme: Literal["light", "dark"] | None = Field(
        None,
        description=(
            "The color mode that the user chose, `light` or `dark`. When it is empty, the web app follows the system."
        ),
    )
    showWidgetControls: bool = Field(False, description="Whether widget cards always show their controls.")
    virtualizeWidgets: bool = Field(
        False,
        description="Whether the web app unloads widgets that are scrolled far out of view.",
    )
    fontSize: Literal["small", "medium", "large"] = Field(
        "medium",
        description="The size of the text: `small`, `medium` or `large`.",
    )
    gridCorners: list[Literal["ne", "nw", "se", "sw"]] = Field(
        ["se"],
        description="The corners of a widget card that offer a handle for resizing it.",
    )
    gridSnapping: Literal["off", "vertical"] = Field(
        "vertical",
        description="How widgets snap to the grid: `off`, or `vertical` for vertical snapping.",
    )
    quickAddButtonTransparent: bool = Field(False, description="Whether the quick add button is drawn transparent.")
    lastVisitedPage: str | None = Field("/app", description="The last page that the user visited.")

    @model_validator(mode="before")
    @classmethod
    def drop_secrets(cls, data: Any) -> Any:
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if k not in DISPLAY_SETTINGS_SECRETS}
        return data


class WidgetMetadata(BaseModel):
    model_config = get_camel_config()
    description: None | str = Field(None, description="A description of the widget.")
    category: None | str = Field(None, description="The widget's category.")
    sub_category: None | str = Field(None, description="The widget's subcategory.")


class CreateFileWidget(WidgetMetadata, extra="forbid"):  # type: ignore[call-arg]
    model_config = get_camel_config()
    stored_file_uuid: None | UUID = Field(None, description="The UUID of the uploaded file that the widget shows.")
    url: HttpUrl = Field(description="The address of the file.")
    name: str = Field(description="The widget's name.")
    extension: ExtensionType = Field(description="The file's extension.")
    data_key: None | str = Field(description="The key that holds the data in the file.")
    original_file_name: None | str = Field(description="The name of the file as the user uploaded it.")
    source: None | str = Field(None, description="Where the file came from.")


class ReturnFileWidget(CreateFileWidget, extra="ignore"):  # type: ignore[call-arg]
    model_config = get_camel_config(from_attributes=True)
    uuid: UUID = Field(description="The UUID of the widget.")
    id_: UUID = Field(serialization_alias="id", alias="uuid", description="The UUID of the widget, repeated as `id`.")
    created_date: datetime = Field(
        serialization_alias="createdDate",
        alias="created_date",
        description="When the widget was created.",
    )
    updated_date: datetime = Field(
        serialization_alias="updatedDate",
        alias="updated_date",
        description="When the widget was last changed.",
    )


class ApiSourceEndpointHeaders(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    model_config = get_camel_config()
    key: str = Field(description="The name of the header or of the query parameter.")
    value: str = Field(description="The value to send.")
    location: Literal["headers", "query"] = Field(
        "headers",
        description="Where the web app puts the value: `headers` or `query`.",
    )


class ApiSourceBase(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    model_config = get_camel_config()
    name: str = Field(description="The backend's name.")
    url: HttpUrl = Field(description="The backend's base address.")
    endpointHeaders: None | list[ApiSourceEndpointHeaders] = Field(
        default_factory=list,
        description="The headers and query parameters that the web app adds to every request to the backend.",
    )

    @field_validator("endpointHeaders", mode="before", check_fields=False)
    @classmethod
    def check_endpoint_headers(cls, value: None | dict | list) -> None | list:
        if isinstance(value, dict):
            return list(value.values()) if value else []
        return value


class CreateApiSource(ApiSourceBase):
    pass


class ApiSourceHeaderName(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    model_config = get_camel_config()
    key: str = Field(description="The name of the credential: a header name or a query parameter name.")
    location: Literal["headers", "query"] = Field(
        "headers", description="Where the connection puts the credential: in a header or in the query."
    )


class SourceRequest(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    url: str = Field(
        max_length=4096, description="The absolute URL on the connection's own origin, without its credentials"
    )
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] = Field(
        default="GET", description="How the data connection is called"
    )
    headers: dict[str, str] = Field(
        default_factory=dict, max_length=32, description="Header params of the widget; never a credential"
    )
    body: str | None = Field(
        default=None,
        max_length=1_048_576,
        description="The text to send as the body, JSON unless the connection sets another Content-Type",
    )
    accept: str | None = Field(default=None, max_length=200, description="The media types the caller accepts")


class FrameRequest(BaseModel):
    model_config = get_camel_config(extra="forbid")
    widget_id: str = Field(
        min_length=1, max_length=200, description="The id of the iframe widget in the connection's widgets.json"
    )


class FrameGrant(BaseModel):
    model_config = get_camel_config()
    token: str = Field(description="Names the page in the address the browser opens; it opens nothing else")
    prefix: str = Field(description="The path below which the token lets the page load anything")
    expires_in: int = Field(description="Seconds until the token stops working")


class SourceTestRequest(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    id: UUID | None = Field(
        default=None, description="The saved data connection whose stored values a blank header value keeps"
    )
    url: HttpUrl = Field(description="The address of the data connection being tested")
    endpointHeaders: list[ApiSourceEndpointHeaders] = Field(
        default_factory=list, max_length=32, description="The credentials being tested; a blank value keeps the saved one"
    )
    request: SourceRequest = Field(description="The request that the test sends to the connection")


class ReturnApiSource(ApiSourceBase, extra="ignore"):  # type: ignore[call-arg]
    model_config = get_camel_config(from_attributes=True)
    endpointHeaders: None | list[ApiSourceHeaderName] = Field(
        default_factory=list,
        description="The credential headers of the connection, with the values that are stored for it.",
    )
    uuid: UUID = Field(description="The UUID of the backend.")
    id_: UUID = Field(serialization_alias="id", alias="uuid", description="The UUID of the backend, repeated as `id`.")
    created_date: datetime = Field(
        serialization_alias="createdDate",
        alias="created_date",
        description="When the backend was created.",
    )
    updated_date: datetime = Field(
        serialization_alias="updatedDate",
        alias="updated_date",
        description="When the backend was last changed.",
    )
    is_entity_backend: Annotated[bool, BeforeValidator(_is_not_none)] = Field(
        validation_alias="entity_uuid",
        description="Whether the backend belongs to the organization and not to one user.",
    )
    mcp_servers: list[str] | None = Field(
        default=None,
        description="The MCP server URLs the backend declares, as last reported by its owner.",
    )


class EntityBase(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    name: str = Field(description="The organization's name.")
    sharing_enabled: bool = Field(description="Whether the organization's users may share dashboards and apps.")


class EntityPost(EntityBase):
    admin_email: EmailStr = Field(description="The email address of the organization's admin.")
    sharing_enabled: bool = Field(
        True,
        description="Whether the organization's users may share dashboards and apps. It defaults to true.",
    )


class EntityReturn(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    uuid: UUID = Field(description="The UUID of the organization.")
    name: str = Field(description="The organization's name.")
    sharing_enabled: bool = Field(description="Whether the organization's users may share dashboards and apps.")


class UserAdminUpdate(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    permissions_uuid: None | UUID = Field(None, description="The UUID of the permissions map to move the user to.")


class EntityMapCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    entity_uuid: UUID = Field(description="The UUID of the organization.")
    name: UserType = Field(description="The user type that the map stands for: Admin, Developer or User.")


class EntityMapReturn(EntityMapCreate):
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    uuid: UUID = Field(description="The UUID of the permissions map.")
    entity: EntityReturn = Field(description="The organization that the map belongs to.")
    name: str = Field(description="The user type that the map stands for: Admin, Developer or User.")


class EntityUserReturn(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    uuid: UUID = Field(description="The user's UUID.")
    email: str = Field(description="The user's email address.")
    permissions: EntityMapReturn | None = Field(None, description="The permissions map that gives the user their type.")


class AddEntityReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    entity_uuid: UUID = Field(description="The UUID of the new organization.")
    permission_map_uuid: UUID = Field(description="The UUID of the organization's Admin permissions map.")


class DashboardReturn(BaseModel):
    model_config = main_config
    creator: bool = Field(description="Whether the signed-in user created the dashboard.")
    content: None | dict = Field(description="The dashboard as the web app saved it.")
    created_date: datetime = Field(description="When the dashboard was created.")
    updated_date: datetime = Field(description="When the dashboard was last changed.")
    created_by: str = Field(description="The email address of the dashboard's owner.")
    is_shared: bool | None = Field(False, description="Whether the dashboard is shared with anyone.")


ENDPOINT_CREDENTIAL_KEYS = frozenset({"headers", "query"})


def strip_endpoint_credentials(content: Any) -> Any:
    if isinstance(content, list):
        return [strip_endpoint_credentials(item) for item in content]
    if not isinstance(content, dict):
        return content
    stripped = {key: strip_endpoint_credentials(value) for key, value in content.items() if key != "endpointHeaders"}
    if isinstance(endpoint := stripped.get("endpoint"), dict):
        stripped["endpoint"] = {key: value for key, value in endpoint.items() if key not in ENDPOINT_CREDENTIAL_KEYS}
    return stripped


class DashboardsCreate(BaseModel):
    items: dict[UUID, Literal["DELETE"] | dict] = Field(
        description=(
            "The dashboards to save, by UUID. Each value is the dashboard's content, or `DELETE` to delete the dashboard."
        ),
    )

    @field_validator("items")
    @classmethod
    def strip_credentials(cls, items: dict[UUID, Literal["DELETE"] | dict]) -> dict[UUID, Literal["DELETE"] | dict]:
        return {uuid: strip_endpoint_credentials(content) for uuid, content in items.items()}


class DashboardOwned(BaseModel):
    owned: dict[UUID, DashboardReturn] = Field(description="The dashboards that the user owns, by UUID.")


class DashboardShared(BaseModel):
    shared: dict[UUID, DashboardReturn] = Field(
        description="The dashboards that other users shared with the user, by UUID.",
    )
    entity_shared: dict[UUID, DashboardReturn] = Field(
        description="The dashboards that the user's organization shares with all of its users, by UUID.",
    )


class DashboardComplete(DashboardOwned, DashboardShared):
    pass


class UserAccess(BaseModel):
    model_config = main_config
    user_type: UserType | None = Field(description="The user's type: Admin, Developer or User.")
    sharing: SharingLevel = Field(
        description="The sharing level that the user's roles allow: `none`, `receive` or `share`.",
    )


class UserLimits(BaseModel):
    copilot_calls_day: int | None
    copilot_tokens_day: int | None
    upload_size_gb: int | None


class UsageBase(BaseModel):
    model_config = main_config
    number_copilot_calls_day_count: int = Field(description="The Copilot calls that the user made today.")
    number_copilot_tokens_day_count: int = Field(0, description="The Copilot tokens that the user used today.")
    total_file_upload_size_gb_count: float = Field(description="The storage that the user's files use, in gigabytes.")


class UsagePut(BaseModel):
    add_copilot_count: int | None = Field(0, ge=0, description="How many Copilot calls to add to today's count.")
    subtract_copilot_count: int | None = Field(0, ge=0, description="How many Copilot calls to take off today's count.")
    reset_copilot_count: bool | None = Field(
        False,
        description="Whether to reset today's counts to zero before the change.",
    )
    add_copilot_tokens: int | None = Field(0, ge=0, description="How many Copilot tokens to add to today's count.")


class UsageGet(UsageBase, extra="ignore"):  # type: ignore[call-arg]
    copilot_calls_limit: int | None = Field(
        None,
        description="The user's daily limit of Copilot calls. It is empty when there is no limit.",
    )
    copilot_tokens_limit: int | None = Field(
        None,
        description="The user's daily limit of Copilot tokens. It is empty when there is no limit.",
    )
    file_upload_size_limit: float | None = Field(
        None,
        description="The limit of the user's stored files, in gigabytes. It is empty when there is no limit.",
    )

    @classmethod
    async def check_cache(cls, db, user) -> "UsageGet":
        from routers.app.helpers import check_usage_cache  # noqa: PLC0415

        return await check_usage_cache(db, user)


class UsageLimitError(BaseModel):
    error: str
    message: str
    current_usage: int

    @classmethod
    def limit_error(cls, usage: UsageGet, tokens: bool = False) -> JSONResponse:
        if tokens:
            message = f"The daily token limit of {usage.copilot_tokens_limit} has been reached"
            current_usage = usage.number_copilot_tokens_day_count
        else:
            message = f"Cannot increment usage beyond the maximum limit of {usage.copilot_calls_limit}"
            current_usage = usage.number_copilot_calls_day_count
        return JSONResponse(
            status_code=422,
            content={
                "error": "Maximum usage limit reached",
                "message": message,
                "current_usage": current_usage,
            },
        )


def default_chats() -> list["Chat"]:
    current_at = int(datetime.now(UTC).timestamp() * 1000)
    DEFAULT_CHAT = {
        "uuid": str(uuid4()),
        "createdAt": current_at,
        "label": "New chat",
        "messages": [],
        "titleManuallyUpdated": False,
        "titleNeedsUpdate": True,
        "lastOpened": current_at,
    }
    return [Chat.model_validate(DEFAULT_CHAT)]


class DashboardCompleteWithContext(DashboardComplete):
    model_config = main_config
    access: UserAccess | None = Field(None, description="The user's type and sharing level.")
    usage: UsageGet | None = Field(None, description="The user's Copilot usage and limits.")
    copilot_chats: list["ChatInfo | Chat"] | None = Field(
        default_factory=default_chats,
        description="The user's Copilot chats.",
    )
    questions_history: list[str] | None = Field(None, description="The questions that the user asked the Copilot.")
    mcp_servers: list[dict] | None = Field(default_factory=list, description="The user's saved MCP servers.")
    display_settings: UserDisplaySettings = Field(UserDisplaySettings(), description="The user's display settings.")
    entity_theme_settings: "EntityThemeSettings" = Field(description="The theme settings of the user's organization.")
    file_widgets: list[ReturnFileWidget] = Field(description="The file widgets that the user created.")
    user_apps: "UserAppsComplete" = Field(
        description="The apps that the user owns and the apps that others shared with the user.",
    )
    user_skills: list["SkillReturn"] | None = Field(default_factory=list, description="The user's skills.")
    widget_metadata: list["WidgetMetadataResponse"] | None = Field(
        None,
        description="The metadata that the user saved for widgets.",
    )
    copilot_access: "CopilotAccess | None" = Field(
        None,
        description="The Copilot models, MCP tools and capabilities that the user may use.",
    )


class DashboardSave(BaseModel):
    model_config = main_config
    content: dict = Field(description="The saved content of the dashboard.")
    uuid: UUID = Field(description="The UUID of the saved version.")
    created_date: datetime = Field(description="When the version was saved.")


class UserEntityInfo(BaseModel):
    model_config = main_config
    entity_name: str = Field(description="The name of the user's organization.")
    permission_name: str = Field(description="The user's type: Admin, Developer or User.")


class AppUserReturn(BaseModel):
    model_config = main_config
    expiration_date: datetime = Field(description="When the session expires.")
    first_name: None | str = Field(None, description="The user's first name.")
    last_name: None | str = Field(None, description="The user's last name.")
    display_settings: UserDisplaySettings = Field(UserDisplaySettings(), description="The user's display settings.")
    file_widgets: list[ReturnFileWidget] = Field(description="The file widgets that the user created.")
    api_sources: list[ReturnApiSource] = Field(
        description="The user's own backends and, for an Admin, the organization's backends.",
    )
    username: None | str = Field(None, description="The user's username.")
    email: str = Field(description="The user's email address.")
    uuid: UUID = Field(description="The user's UUID.")
    widget_metadata: list["WidgetMetadataResponse"] | None = Field(
        None,
        description="The metadata that the user saved for widgets.",
    )
    entity_info: UserEntityInfo | None = Field(None, description="The user's organization and user type.")


class UserAdminReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    uuid: UUID = Field(description="The UUID of the user or of the invitation.")
    first_name: None | str = Field(None, description="The user's first name.")
    last_name: None | str = Field(None, description="The user's last name.")
    email: str = Field(description="The user's email address.")
    role: str = Field(description="The user's type: Admin, Developer or User.")
    last_login: None | datetime = Field(None, description="When the user last signed in.")
    last_active: None | datetime = Field(None, description="When the user was last active.")
    status: Literal["active", "pending", "revoked", "expired"] = Field(
        "pending",
        description="The state of the account: `active`, `pending`, `revoked` or `expired`.",
    )
    permissions_uuid: UUID | None = Field(None, description="The UUID of the user's permissions map.")
    source: UserSourceType = Field(description="Whether the entry is a `user` or an `invite`.")


class UserCreateAdmin(BaseModel):
    model_config = main_config
    email: Annotated[EmailStr, AfterValidator(check_email)] = Field(description="The user's email address.")
    permissions_uuid: UUID = Field(description="The UUID of the permissions map that gives the user their type.")
    first_name: None | str = Field(None, description="The user's first name.")
    last_name: None | str = Field(None, description="The user's last name.")
    message: None | str = Field(
        max_length=500,
        default=None,
        description="A message for the new user, up to 500 characters.",
    )
    role: None | UUID = Field(None, description="The UUID of a role to give the user.")


class UserCreateAppAdmin(BaseModel):
    model_config = main_config
    email: Annotated[EmailStr, AfterValidator(check_email)]
    permissions_uuid: UUID
    first_name: None | str = None
    last_name: None | str = None
    message: None | str = Field(max_length=500, default=None)


class UserUpdateAdmin(BaseModel):
    model_config = main_config
    permissions_uuid: UUID = Field(description="The UUID of the permissions map to move the user to.")


class TotpToken(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    totp_token: Annotated[None | int, AfterValidator(check_totp_token)] = Field(
        None,
        description="The code from the user's authenticator app.",
    )


class TotpActivate(TotpToken):
    remember: bool = Field(False, description="Whether to keep the user signed in for longer.")
    version: None | str = Field(None, description="The version of the web app.")


class UserLogin(BaseModel):
    model_config = main_config
    email: Annotated[str, AfterValidator(check_email_or_username)] = Field(
        description="The user's email address or username.",
    )
    remember: bool = Field(False, description="Whether to keep the user signed in for longer.")
    totp_token: Annotated[None | int, AfterValidator(check_totp_token)] = Field(
        None,
        description="The code from the user's authenticator app. It is needed when the user has an active authenticator.",
    )
    password: Annotated[str, AfterValidator(check_password)] = Field(description="The user's password.")

    _bypass_password_check: bool = False


class AppUserLogin(UserLogin):
    source: None | AppLoginSource = Field(
        None,
        description="The kind of client that signs in: `app` or `oauth-app`. It defaults to `app`.",
    )
    version: None | str = Field(None, description="The version of the web app that signs in.")


class OAuthLogin(AppUserLogin):
    password: str | None = None

    def bypass_password_check(self):
        self._bypass_password_check = True

        return self


class UserUpdate(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    old_password: Annotated[None | str, AfterValidator(check_password)] = Field(
        None,
        description="The user's current password.",
    )
    new_password: Annotated[None | str, AfterValidator(check_password)] = Field(
        None,
        description=(
            "The new password. It needs at least 8 characters, with an uppercase letter, a lowercase letter, a "
            "number and a special character, and no spaces."
        ),
    )

    def validated_dict(self, password: str):
        if isinstance(password, bytes):
            password = password.decode("utf-8")

        new_dict = self.model_dump(exclude_none=True)
        old_pass = new_dict.pop("old_password", None)
        new_pass = new_dict.pop("new_password", None)
        if old_pass and new_pass:
            valid = base.verify_password(old_pass, password)
            if not valid:
                raise ValueError("Invalid password")
            new_dict["password"] = new_pass
            new_dict["temporary_password"] = False
        return new_dict


class ShareDashboard(BaseModel):
    model_config = main_config
    shares: SharesPermissions = Field(
        description="The users to share with, by email address, each with the permissions to give: `view` or `comment`.",
    )


class ShareUserApp(ShareDashboard):
    pass


class ShareDashboardList(BaseModel):
    model_config = main_config
    shares: list[Annotated[str, AfterValidator(check_email)]] = Field(
        description="The email addresses of the users to stop sharing with.",
    )


class ShareUserAppList(ShareDashboardList):
    pass


class RegisterAppUser(BaseModel):
    inviting_uuid: None | UUID = None


ForceInt = Annotated[int, BeforeValidator(int)]


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow", from_attributes=True)
    uuid: UUID | None = Field(default=None, description="The UUID of the message.")
    role: base.ChatMessageRole = Field(description="Who wrote the message: `ai`, `human`, `summary`, `system` or `tool`.")
    copilotId: str = Field(description="The id of the Copilot that the message belongs to.")
    timestamp: ForceInt = Field(description="When the message was written, in milliseconds since 1970.")
    content: str | dict | None = Field(None, description="The message, as text or as an object for a structured message.")
    isError: None | bool = Field(None, description="Whether the message reports an error.")
    isFC: None | bool = Field(None, description="Whether the message is a function call or the result of one.")
    function: None | str = Field(None, description="The name of the function that was called.")
    input: None | dict = Field(None, description="The input of the function call.")
    copilot_function_call_arguments: None | dict = Field(
        None,
        description="The arguments of the function call, as the Copilot gave them.",
    )
    isHidden: None | bool = Field(None, description="Whether the web app hides the message.")
    usedPersonalOpenAiKey: None | bool = Field(None, description="Whether the user's own OpenAI key produced the answer.")
    citations: None | list[dict] = Field(None, description="The sources that the answer cites.")
    data: None | dict | list[dict] = Field(None, description="Data that the message carries.")
    extra_state: None | dict = Field(None, description="Further state that the web app keeps with the message.")

    @field_validator("usedPersonalOpenAiKey", mode="before", check_fields=False)
    @classmethod
    def check_used_personal_openai_key(cls, value: str | bool | None) -> bool:
        return bool(value)


def parse_created_at(value: datetime | int | None) -> int:
    if value is None:
        return int(datetime.now(UTC).timestamp() * 1000)
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    return value


class ChatInfo(BaseModel):
    model_config = ConfigDict(extra="allow", from_attributes=True)
    uuid: str | UUID | None = Field(
        default=None,
        serialization_alias="uuid",
        alias="id",
        description="The UUID of the chat.",
    )
    createdAt: Annotated[int, BeforeValidator(parse_created_at)] = Field(
        description="When the chat was created, in milliseconds since 1970.",
    )
    label: str = Field(description="The chat's title.")

    @classmethod
    def corrupted(cls, uuid: UUID) -> "Chat":
        return cls(
            uuid=uuid,
            createdAt=int(datetime.now(UTC).timestamp() * 1000),
            label="Corrupted Chat",
            messages=[
                ChatMessage(
                    uuid=uuid4(),
                    role="system",
                    content={
                        "eventType": "ERROR",
                        "message": "This chat contains corrupted data and cannot be displayed.",
                    },
                    timestamp=int(datetime.now(UTC).timestamp() * 1000),
                    copilotId="default-copilot",
                )
            ],
            lastOpened=int(datetime.now(UTC).timestamp() * 1000),
        )

    def to_content(self) -> dict:
        return self.model_dump(mode="json", exclude={"messages", "artifacts"}, by_alias=True)


class Chat(ChatInfo):
    artifacts: list[dict] | None = Field(default_factory=list, description="The artifacts that the chat produced.")
    messages: list[ChatMessage] = Field(description="The messages of the chat, in order.")

    @classmethod
    def from_row(cls, row: "CopilotChat", from_search: bool = False) -> "ChatInfo | Chat":
        if (value := row.content) is None:
            return cls.corrupted(row.uuid)

        value.pop("id_", None)
        value.pop("id", None)
        value.update({"uuid": row.uuid})
        if not hasattr(row, "messages"):
            return ChatInfo.model_validate(value)

        value.update({"messages": [v.content for v in row.messages if v.content is not None]})
        if not from_search:
            value.update({"artifacts": row.artifacts if hasattr(row, "artifacts") else []})
        return cls.model_validate(value)


class ChatUpdate(Chat):
    messages: dict[UUID, Literal["DELETE"] | dict] = Field(
        default_factory=dict,
        description="The messages to save, by UUID. Each value is the message, or `DELETE` to delete the message.",
    )

    def to_entry(self, chat_uuid: UUID, owner_uuid: UUID):
        v = self.model_dump(mode="json", by_alias=True)
        v.pop("id_", None)
        v.pop("id", None)
        messages: dict[str, Literal["DELETE"] | dict] = v.pop("messages", {})
        artifacts: list[dict] = v.pop("artifacts", [])
        entry = {
            "uuid": chat_uuid,
            "content": v,
            "artifacts": artifacts,
            "label": v.get("label"),
            "last_opened": base.time_ms_now(v.get("lastOpened")),
            "user_uuid": owner_uuid,
        }
        return (entry, messages)


class CopilotChatsCreate(BaseModel):
    chats: dict[UUID, Literal["DELETE"] | ChatUpdate] = Field(
        description="The chats to save, by UUID. Each value is the chat, or `DELETE` to delete the chat.",
    )


class MCPTool(BaseModel):
    model_config = get_camel_config(extra="ignore", from_attributes=True)
    id_: str = Field(serialization_alias="id", alias="id", description="The tool's id.")
    name: str = Field(description="The tool's name.")
    description: str | None = Field(None, description="What the tool does, in the server's words.")
    enabled: bool = Field(True, description="Whether the user switched the tool on.")


MCPHeaderName = Annotated[str, StringConstraints(pattern=r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", max_length=100)]
MCPHeaderValue = Annotated[str, StringConstraints(pattern=r"^[^\r\n\x00]*$", max_length=8192)]


class MCPServer(BaseModel):
    model_config = get_camel_config(extra="allow", from_attributes=True)
    id_: str = Field(serialization_alias="id", alias="id", description="The server's id.")
    client_name: str | None = Field(None, description="The name that the server reported for itself.")
    tools: list[MCPTool] = Field(default_factory=list, description="The tools that the server offers.")
    name: str = Field(description="The name that the user gave the server.")
    url: str = Field(description="The server's address.")
    enabled: bool = Field(description="Whether the user switched the server on.")
    custom_headers: dict[MCPHeaderName, MCPHeaderValue | None] | None = Field(
        default=None,
        exclude=True,
        description=(
            "The headers that the web app sends to the server, by name. The API stores the values and never returns them."
        ),
    )
    custom_header_names: list[str] = Field(
        default_factory=list,
        description="The names of the headers that the user saved for the server.",
    )
    has_token: bool = Field(False, description="Whether the user saved an authorization token for the server.")

    def stored_fields(self) -> dict:
        return self.model_dump(exclude={"custom_header_names", "has_token"})


class MCPServers(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    servers: list[MCPServer] = Field(default_factory=list, description="The user's MCP servers.")

    def get_servers_json(self):
        return self.model_dump(by_alias=True).get("servers", [])


def mcp_header_flags(headers: dict[str, str] | None) -> dict[str, list[str] | bool]:
    names = sorted(headers) if headers else []
    return {
        "custom_header_names": names,
        "has_token": any(name.lower() == "authorization" for name in names),
    }


DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize_mcp_url(url: str) -> str:
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    path = parsed.path.rstrip("/")
    try:
        port = parsed.port
    except ValueError:
        return urlunsplit((scheme, parsed.netloc.lower(), path, "", ""))
    host = (parsed.hostname or "").rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    if port is not None and port != DEFAULT_PORTS.get(scheme):
        host = f"{host}:{port}"
    userinfo, at, _ = parsed.netloc.rpartition("@")
    return urlunsplit((scheme, f"{userinfo.lower()}{at}{host}", path, "", ""))


def mcp_host_and_port(url: str) -> tuple[str, int | None]:
    parsed = urlsplit(normalize_mcp_url(url))
    try:
        port = parsed.port
    except ValueError:
        port = None
    return (parsed.hostname or "").rstrip("."), port or DEFAULT_PORTS.get(parsed.scheme)


def mcp_server_url(url: str) -> str:
    normalized = normalize_mcp_url(url)
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("The MCP server URL must be an http or https URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("The MCP server URL must not carry credentials")
    return normalized


class MCPOAuthServer(BaseModel):
    model_config = main_config
    server_url: Annotated[
        str,
        Field(max_length=2048, description="The address of the MCP server."),
        AfterValidator(mcp_server_url),
    ]


class ApiSourceMcpServers(BaseModel):
    model_config = main_config
    servers: list[Annotated[str, Field(max_length=400), AfterValidator(mcp_server_url)]] = Field(
        max_length=100,
        description="The MCP server URLs the backend declares: iframe widgets' storage.mcpUrl and the apps' mcpServers.",
    )


class MCPOAuthAuthorization(BaseModel):
    model_config = main_config
    authorization_url: str = Field(
        description="The address at which the user grants FINOS Workspace access to the MCP server.",
    )


class MCPOAuthCallback(BaseModel):
    model_config = main_config
    code: str = Field(
        min_length=1,
        max_length=4096,
        description="The authorization code that the MCP server's authorization server returned.",
    )
    state: str = Field(
        min_length=1,
        max_length=512,
        description="The state that the sign-in started with, which the redirect carried back.",
    )


class MCPOAuthCompleted(BaseModel):
    model_config = main_config
    server_url: str = Field(description="The address of the MCP server that the user is now signed in to.")


ALL_MCP_TOOLS = "*"
ALL_MODELS = "*"


class CopilotCapability(StrEnum):
    SEARCH_WEB = "SEARCH_WEB"
    FETCH_FROM_WEB = "FETCH_FROM_WEB"


CAPABILITY_MCP_TOOLS: dict[CopilotCapability, frozenset[str]] = {
    CopilotCapability.SEARCH_WEB: frozenset({"web_search"}),
    CopilotCapability.FETCH_FROM_WEB: frozenset({"fetch_webpage", "inspect_webpage"}),
}


class CopilotModelGrant(BaseModel):
    model_config = main_config
    agent_id: str = Field(min_length=1, max_length=255, description="The id of the agent.")
    model_id: str = Field(
        min_length=1,
        max_length=255,
        description="The id of the model, or `*` for every model of the agent.",
    )


class McpGrant(BaseModel):
    model_config = main_config
    server_url: str = Field(min_length=1, max_length=400, description="The address of the MCP server.")
    tool_name: str = Field(
        default=ALL_MCP_TOOLS,
        min_length=1,
        max_length=200,
        description="The name of the tool, or `*` for every tool of the server.",
    )

    @field_validator("server_url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        return normalize_mcp_url(value)


class RoleCopilotAccess(BaseModel):
    model_config = main_config
    models: list[CopilotModelGrant] = Field(
        default_factory=list,
        description="The agents and models that the role grants.",
    )
    mcp: list[McpGrant] = Field(default_factory=list, description="The MCP tools that the role grants.")


class CopilotAccess(RoleCopilotAccess):
    disabled_capabilities: list[CopilotCapability] = Field(
        default_factory=list,
        description="The Copilot capabilities that the user's roles switch off.",
    )


class CopilotToolRef(BaseModel):
    model_config = main_config
    url: str = Field(description="The address of the MCP server.")
    tool_name: str = Field(description="The name of the tool.")


class CopilotAuthorize(BaseModel):
    model_config = main_config
    agent_id: str | None = Field(None, description="The id of the agent.")
    model: str | None = Field(None, description="The id of the model.")
    tools: list[CopilotToolRef] = Field(default_factory=list, description="The MCP tools that the agent wants to use.")


ProviderKey = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024, pattern=r"^\S+$")]


class CopilotProviderKeys(BaseModel):
    model_config = main_config
    openai_api_key: ProviderKey | None = Field(None, description="The user's own OpenAI key.")
    perplexity_api_key: ProviderKey | None = Field(None, description="The user's own Perplexity key.")


class CopilotKeysStatus(BaseModel):
    model_config = main_config
    has_openai_key: bool = Field(False, description="Whether the user saved an OpenAI key.")
    has_perplexity_key: bool = Field(False, description="Whether the user saved a Perplexity key.")


class CopilotAuthorizeResult(BaseModel):
    model_config = main_config
    allowed: bool = Field(description="Whether the user may use the agent, the model and the tools.")
    denied_model: str | None = Field(None, description="The model that the user may not use.")
    denied_tools: list[CopilotToolRef] = Field(default_factory=list, description="The tools that the user may not use.")
    provider_keys: CopilotProviderKeys | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        description="The user's own provider keys. Only an answer to the Copilot agent carries them.",
    )
    disabled_capabilities: list[CopilotCapability] = Field(
        default_factory=list,
        description="The Copilot capabilities that the user's roles switch off.",
    )


class AppUserSchema(BaseModel):
    model_config = {"from_attributes": True, "populate_by_name": True}

    email: str
    uuid: UUID
    username: str | None = None
    confirmed: bool
    password: str
    latest_version: str | None = None
    permissions_uuid: None | UUID = None
    temporary_password: None | bool = None
    totp_secret: None | str = None
    totp_active: bool | None = None
    two_factor_auth: bool | None = None
    entity_uuid: UUID | None = None
    require_authenticator: bool | None = None
    name: str | None = None
    role: str | None = None
    is_superuser: bool | None = None


class StoredFileSchema(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    uuid: UUID | None = Field(default_factory=uuid4)
    creater_uuid: UUID
    s3_file_name: str
    bucket: str
    extension: ExtensionType
    original_file_name: None | str
    size: int

    failed: bool = False

    def as_return(self) -> "PendingFileReturn":
        return PendingFileReturn(
            stored_file_uuid=self.uuid,
            original_file_name=self.original_file_name,
            extension=self.extension,
            url=f"{settings.SELFURL}/app/files/{self.uuid}.{self.extension}",
            failed=self.failed,
        )

    def set_failed(self) -> "StoredFileSchema":
        updated = self.model_copy(update={"failed": True})
        return updated


class StoredFileReturn(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    uuid: UUID = Field(description="The UUID of the stored file.")
    file_widget_uuid: UUID | None = Field(
        None,
        description="The UUID of the file widget that uses the file. It is empty while no widget uses it.",
    )
    extension: ExtensionType = Field(description="The file's extension.")
    original_file_name: None | str = Field(description="The name of the file as the user uploaded it.")
    size: int | None = Field(None, description="The file's size in bytes.")
    is_global: bool = Field(False, description="Whether the file is available to every user.")


class DownloadManifest(StoredFileReturn):
    model_config = {"from_attributes": True, "populate_by_name": True}

    uuid: UUID | None = None
    file_name: str | None = None

    @model_validator(mode="after")
    def check_file_name(self):
        if not self.file_name:
            self.file_name = f"{self.uuid}.{self.extension}"
        return self


class DeleteStoredFiles(BaseModel):
    file_uuids: list[UUID] = Field(description="The UUIDs of the stored files to delete.")


class WidgetMetadataResponse(BaseModel):
    model_config = get_camel_config()
    name: str = Field(description="The widget's name.")
    description: str = Field(description="A description of the widget.")
    source: str = Field(description="Where the widget's data comes from.")
    category: str = Field(description="The widget's category.")
    sub_category: str = Field(description="The widget's subcategory.")
    widget_type: MetaDataWidgetType = Field(
        description=(
            "The kind of widget: `iframe`, `copilot_table`, `youtube`, `widget_studio`, `chart`, `html` or "
            "`ag_chart_from_table`."
        ),
    )
    storage: dict = Field(description="The widget's stored content.")
    widget_config: dict | None = Field(None, description="The widget's configuration.")
    widget_id: UUID = Field(description="The id of the widget that the metadata describes.")


class WidgetMetadataResponsePatch(BaseModel):
    model_config = get_camel_config()
    name: str | None = Field(None, description="The widget's new name.")
    description: str | None = Field(None, description="The widget's new description.")
    source: str | None = Field(None, description="The widget's new source.")
    category: str | None = Field(None, description="The widget's new category.")
    sub_category: str | None = Field(None, description="The widget's new subcategory.")
    widget_type: MetaDataWidgetType | None = Field(None, description="The widget's new kind.")
    widget_config: dict | None = Field(None, description="The widget's new configuration.")
    storage: dict | None = Field(None, description="The widget's new stored content.")


class UserAppCreate(BaseModel):
    model_config = ConfigDict(extra="allow", from_attributes=True, populate_by_name=True)
    name: str = Field(description="The app's name.")
    description: str | None = Field(None, description="A description of the app.")
    img: str | None = Field(None, description="The app's image.")
    img_dark: str | None = Field(None, description="The image to use in dark mode.")
    img_light: str | None = Field(None, description="The image to use in light mode.")
    prompts: list[str] = Field(default_factory=list, description="The prompts that the app offers.")
    widgets: list[dict] = Field(default_factory=list, description="The widgets of the app.")
    groups: list[dict] = Field(default_factory=list, description="The widget groups of the app.")
    gridLayout: dict[str, list[dict]] = Field(
        default_factory=dict,
        description="The layout of the app's widgets, by tab.",
    )
    currentTab: str | None = Field(None, description="The tab that the app opens on.")

    @model_validator(mode="before")
    @classmethod
    def strip_credentials(cls, content: Any) -> Any:
        return strip_endpoint_credentials(content)


class UserAppReturn(BaseModel):
    model_config = get_camel_config(from_attributes=True)
    content: UserAppCreate = Field(description="The app's content.")
    creator: bool = Field(description="Whether the signed-in user created the app.")
    is_shared: bool | None = Field(False, description="Whether the app is shared with anyone.")
    created_date: datetime = Field(
        serialization_alias="createdDate",
        alias="created_date",
        description="When the app was created.",
    )
    updated_date: datetime = Field(
        serialization_alias="updatedDate",
        alias="updated_date",
        description="When the app was last changed.",
    )
    created_by: str = Field(
        serialization_alias="createdBy",
        alias="created_by",
        description="The email address of the app's owner.",
    )
    sharedWith: list[dict] | None = Field(
        default_factory=list,
        serialization_alias="sharedWith",
        alias="shared_with",
        description="The users with whom the app is shared.",
    )


class UserAppShareReturn(BaseModel):
    created_date: None | datetime = Field(description="When the share was created.")
    permissions: None | base.PermissionEnum = Field(
        description="What the recipient may do with the app: `view`, `comment` or `edit`.",
    )
    first_name: None | str = Field(description="The recipient's first name.")
    last_name: None | str = Field(description="The recipient's last name.")
    pending: bool = Field(False, description="Whether the share waits for an admin's approval.")


class UserAppsComplete(BaseModel):
    shared: dict[UUID, UserAppReturn] = Field(description="The apps that others shared with the user, by UUID.")
    owned: dict[UUID, UserAppReturn] = Field(description="The apps that the user owns, by UUID.")


class SharedDashboardViewed(BaseModel):
    dashboard_uuid: UUID = Field(description="The UUID of the dashboard.")
    viewed: bool = Field(description="Whether the user has viewed the dashboard.")


class SharedAppViewed(BaseModel):
    app_uuid: UUID = Field(description="The UUID of the app.")
    viewed: bool = Field(description="Whether the user has viewed the app.")


class SignInStart(BaseModel):
    model_config = main_config

    version: None | str = Field(
        default=None, max_length=64, description="The version of the web app that asks for the sign-in."
    )


class SignInStarted(BaseModel):
    model_config = main_config

    authorization_url: str = Field(description="The address of the provider's sign-in page, which the browser opens.")


class JsonWebKeySet(BaseModel):
    keys: list[dict] = Field(description="The public keys that verify the identity token, newest first")


class AuthData(BaseModel):
    model_config = main_config

    token: str | None = Field(default=None, max_length=8192, description="The Google credential.")
    version: None | str = Field(None, description="The version of the web app that signs in.")


class CustomCopilot(BaseModel):
    model_config = get_camel_config(extra="ignore", from_attributes=True)
    uuid: UUID | None = Field(default_factory=uuid4, description="The UUID of the custom Copilot.")
    url: str = Field(max_length=200, description="The address of the agent.")
    headers: dict[MCPHeaderName, MCPHeaderValue] | None = Field(
        default=None,
        exclude=True,
        description=(
            "The credentials the API sends to the agent. They are never returned. Left out, the stored ones are "
            "kept; given, they are the whole set: a blank value keeps the stored value of that name and a name "
            "that is missing is removed"
        ),
    )
    header_names: list[str] = Field(default_factory=list, description="The names of the stored credentials")
    copilots: list[dict] | None = Field(
        default_factory=list,
        description="The agent descriptors that the address serves.",
    )

    @field_validator("copilots")
    @classmethod
    def drop_credentials(cls, copilots: list[dict] | None) -> list[dict] | None:
        return [{k: v for k, v in copilot.items() if k != "headers"} for copilot in copilots] if copilots else copilots


class AgentDiscoverRequest(BaseModel, extra="forbid"):  # type: ignore[call-arg]
    id: UUID | None = Field(
        default=None, description="The saved agent connection whose stored credentials a blank value keeps"
    )
    url: str = Field(max_length=200, description="The address of the agent connection")
    headers: dict[MCPHeaderName, MCPHeaderValue] | None = Field(
        default=None, description="The credentials being tried; left out, those of the saved connection are used"
    )


class AgentDiscovery(BaseModel):
    status: int = Field(description="The status the agent answered for its agents.json, or 0 when it did not answer")
    agents: dict | None = Field(default=None, description="The agents.json the agent answered")


class Prompt(BaseModel):
    model_config = ConfigDict(extra="allow", from_attributes=True)
    id: str = Field(description="The prompt's id.")
    prompt: str = Field(description="The prompt's text.")
    widgets: list | None = Field(default_factory=list, description="The widgets that the prompt uses.")
    createdAt: str = Field(description="When the prompt was created.")
    updatedAt: str = Field(description="When the prompt was last changed.")


class SkillCreate(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    model_config = get_camel_config(from_attributes=True)
    slug: str = Field(description="The skill's short name, in lowercase letters, digits and hyphens.")
    description: str = Field(description="What the skill does and when to use it.")
    content: str = Field(description="The skill's instructions.")

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        if len(value) < 2 or len(value) > 50:  # noqa: PLR2004
            raise ValueError("Skill slug must be between 2 and 50 characters")
        if not SKILL_SLUG_REGEX.match(value):
            raise ValueError("Skill slug must contain only lowercase letters, numbers, and hyphens")
        return value


class SkillReturn(SkillCreate):
    model_config = get_camel_config(from_attributes=True)

    plugin_name: str | None = Field(
        default=None,
        description=(
            "The widget plugin that provides this skill. A plugin's skill is read-only; "
            "left out for the user's own skills"
        ),
    )
    uuid: UUID = Field(description="The UUID of the skill.")
    id_: UUID = Field(serialization_alias="id", alias="uuid", description="The UUID of the skill, repeated as `id`.")
    created_date: datetime = Field(
        serialization_alias="createdDate",
        alias="created_date",
        description="When the skill was created.",
    )
    updated_date: datetime = Field(
        serialization_alias="updatedDate",
        alias="updated_date",
        description="When the skill was last changed.",
    )


class TwoFactorAuth(BaseModel):
    model_config = main_config
    two_factor_auth: bool = Field(description="Whether two-factor authentication is on for the user.")


class TwoFactorAuthGet(TwoFactorAuth):
    entity_require_authenticator: bool = Field(
        description="Whether the user's organization requires two-factor authentication.",
    )


ROLE_LIMITS = ("copilot_calls_day", "copilot_tokens_day", "upload_size_gb")


class GetRoleWithUsers(BaseModel):
    model_config = main_config
    uuid: UUID = Field(description="The UUID of the role.")
    name: str = Field(description="The role's name.")
    description: str = Field(description="What the role is for.")
    updated_date: datetime = Field(description="When the role was last changed.")
    users: list[EmailStr] = Field(description="The email addresses of the role's users.")
    sharing: SharingLevel = Field(description="The sharing level that the role gives: `none`, `receive` or `share`.")
    copilot_calls_day: int | None = Field(
        description="The daily limit of Copilot calls that the role sets. It is empty when the role sets none.",
    )
    copilot_tokens_day: int | None = Field(
        description="The daily limit of Copilot tokens that the role sets. It is empty when the role sets none.",
    )
    upload_size_gb: int | None = Field(
        description="The limit of stored files in gigabytes that the role sets. It is empty when the role sets none.",
    )
    search_web: bool = Field(description="Whether the role lets its users search the web.")
    fetch_from_web: bool = Field(description="Whether the role lets its users fetch pages from the web.")

    @classmethod
    def from_role(cls, role, users: list[str]) -> "GetRoleWithUsers":
        return cls(
            uuid=role.uuid,
            name=role.name,
            description=role.description,
            updated_date=role.updated_date,
            users=users,
            sharing=role.sharing,
            copilot_calls_day=role.copilot_calls_day,
            copilot_tokens_day=role.copilot_tokens_day,
            upload_size_gb=role.upload_size_gb,
            search_web=role.search_web,
            fetch_from_web=role.fetch_from_web,
        )


class PostRole(BaseModel):
    model_config = main_config
    uuid: UUID | None = Field(None, description="The UUID for the new role.")
    name: str = Field(description="The role's name.")
    description: str = Field(description="What the role is for.")
    users: list[EmailStr] | None = Field(None, description="The email addresses of the users that the role starts with.")
    sharing: SharingLevel = Field(
        "none",
        description="The sharing level that the role gives: `none`, `receive` or `share`.",
    )
    copilot_calls_day: int | None = Field(
        None,
        ge=0,
        description="The daily limit of Copilot calls for the role's users. Leave it empty for no limit.",
    )
    copilot_tokens_day: int | None = Field(
        None,
        ge=0,
        description="The daily limit of Copilot tokens for the role's users. Leave it empty for no limit.",
    )
    upload_size_gb: int | None = Field(
        None,
        ge=0,
        description="The limit of stored files in gigabytes for the role's users. Leave it empty for no limit.",
    )
    search_web: bool = Field(True, description="Whether the role lets its users search the web.")
    fetch_from_web: bool = Field(True, description="Whether the role lets its users fetch pages from the web.")


class PatchRole(BaseModel):
    model_config = main_config
    name: str | None = Field(None, description="The role's new name.")
    description: str | None = Field(None, description="The role's new description.")
    users: list[EmailStr] | None = Field(
        None,
        description=(
            "The email addresses that the role's members become. Users that the list leaves out are removed from the "
            "role."
        ),
    )
    sharing: SharingLevel | None = Field(None, description="The role's new sharing level: `none`, `receive` or `share`.")
    copilot_calls_day: int | None = Field(
        None,
        ge=0,
        description="The role's new daily limit of Copilot calls. Null removes the limit.",
    )
    copilot_tokens_day: int | None = Field(
        None,
        ge=0,
        description="The role's new daily limit of Copilot tokens. Null removes the limit.",
    )
    upload_size_gb: int | None = Field(
        None,
        ge=0,
        description="The role's new limit of stored files in gigabytes. Null removes the limit.",
    )
    search_web: bool | None = Field(None, description="Whether the role lets its users search the web.")
    fetch_from_web: bool | None = Field(None, description="Whether the role lets its users fetch pages from the web.")

    def changes(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in self.model_dump(exclude={"users"}, exclude_unset=True).items()
            if value is not None or key in ROLE_LIMITS
        }


class WidgetAccess(BaseModel):
    widgetId: str = Field(description="The id of the widget.")
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )


class PromptAccess(BaseModel):
    promptId: str = Field(description="The id of the prompt.")
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )


class TemplateAccess(BaseModel):
    templateId: str = Field(description="The id of the template.")
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )
    prompts: list[PromptAccess] | None = Field(None, description="The access to each prompt of the template.")


class AppReturn(BaseModel):
    uuid: UUID = Field(description="The UUID of the backend.")
    name: str = Field(description="The backend's name.")
    url: str = Field(description="The backend's address.")
    user_uuid: UUID = Field(description="The UUID of the user who connected the backend.")
    user_email: str | None = Field(None, description="The email address of the user who connected the backend.")
    created_date: datetime = Field(description="When the backend was created.")
    updated_date: datetime = Field(description="When the backend was last changed.")


class RolePermissions(BaseModel):
    model_config = main_config
    uuid: UUID = Field(description="The UUID of the backend, the file widget or the prompt.")
    type: Literal["backend", "file", "prompt"] = Field(
        description="What the permission is about: a `backend`, a `file` or a `prompt`.",
    )
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )
    category: Literal["data-connectors", "templates", "prompts"] = Field(
        description="The group that the item belongs to: `data-connectors`, `templates` or `prompts`.",
    )
    widgets: list[WidgetAccess] | None = Field(None, description="The access to each widget of a backend.")
    templates: list[TemplateAccess] | None = Field(None, description="The access to each template of a backend.")
    file_extension: ExtensionType | None = Field(None, description="The file's extension, for a file.")
    prompt: Prompt | None = Field(None, description="The prompt, for a prompt.")


class BackendPermissionsModel(BaseModel):
    model_config = main_config
    uuid: UUID = Field(description="The UUID of the backend.")
    name: str = Field(description="The backend's name.")
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )
    widgets: list[WidgetAccess] | None = Field(None, description="The access to each widget of the backend.")
    templates: list[TemplateAccess] | None = Field(None, description="The access to each template of the backend.")
    url: str | None = Field(None, description="The backend's address.")
    endpointHeaders: list[ApiSourceHeaderName] | None = Field(
        None,
        description="The credentials of the connection, which the API adds to every request to the backend.",
    )
    created_date: datetime = Field(
        serialization_alias="createdDate",
        alias="created_date",
        description="When the backend was created.",
    )
    updated_date: datetime = Field(
        serialization_alias="updatedDate",
        alias="updated_date",
        description="When the backend was last changed.",
    )
    created_by: str | None = Field(
        serialization_alias="createdBy",
        alias="created_by",
        description="The email address of the user who created the backend.",
    )


class FilePermissionsModel(BaseModel):
    model_config = main_config
    uuid: UUID = Field(description="The UUID of the file widget.")
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )
    name: str = Field(description="The file widget's name.")
    description: str = Field(description="A description of the file widget.")
    url: str | None = Field(None, description="The address of the file.")
    stored_file_uuid: UUID | None = Field(None, description="The UUID of the stored file.")

    @model_validator(mode="after")
    def check_stored_file_uuid(self):
        if not self.stored_file_uuid and self.url:
            try:
                uuid_str = self.url.split("/").pop().split(".")[0]
                self.stored_file_uuid = UUID(uuid_str)
            except ValueError:
                self.stored_file_uuid = None
        return self


class PromptPermissionsModel(BaseModel):
    model_config = main_config
    uuid: UUID = Field(description="The UUID of the prompt.")
    access: AccessType = Field(
        description="The access level that the role gives: `no-access`, `access` or `full-access`.",
    )
    prompt: Prompt = Field(description="The prompt.")


class UserRolePermissions(BaseModel):
    model_config = main_config
    backends: list[BackendPermissionsModel] | None = Field(
        default_factory=list,
        description="The backends that the role grants, with the access to each.",
    )
    files: list[FilePermissionsModel] | None = Field(
        default_factory=list,
        description="The file widgets that the role grants, with the access to each.",
    )
    prompts: list[PromptPermissionsModel] | None = Field(
        default_factory=list,
        description="The prompts that the role grants, with the access to each.",
    )


class UserRolesPermissions(BaseModel):
    model_config = main_config
    permissions: dict[UUID, UserRolePermissions] = Field(
        default_factory=dict,
        description="The permissions of each of the user's roles, by role UUID.",
    )


class UserRolesPermissionsFlattened(BaseModel):
    model_config = main_config
    backends: list[BackendPermissionsModel] | None = Field(
        default_factory=list,
        description="The backends that the user's roles grant, with the access to each.",
    )
    files: list[FilePermissionsModel] | None = Field(
        default_factory=list,
        description="The file widgets that the user's roles grant, with the access to each.",
    )
    prompts: list[PromptPermissionsModel] | None = Field(
        default_factory=list,
        description="The prompts that the user's roles grant, with the access to each.",
    )


class RoleAuditLogReturn(BaseModel):
    uuid: UUID = Field(description="The UUID of the entry.")
    created_at: datetime = Field(description="When the change happened.")
    entity_uuid: UUID = Field(description="The UUID of the organization.")
    role_uuid: None | UUID = Field(None, description="The UUID of the role that changed.")
    action: RoleAuditAction = Field(description="What kind of change it was.")
    resource_type: RoleResourceType = Field(description="The kind of resource that the change concerned.")
    resource_uuid: UUID = Field(description="The UUID of the resource that the change concerned.")
    performed_by_email: str = Field(description="The email address of the admin who made the change.")
    details: dict = Field(description="Details of the change, which depend on the action.")
    role_name: str = Field(description="The name of the role.")
    details_msg: str | None = Field(None, description="A sentence that describes the change.")


class UserPermissions(BaseModel):
    data_connectors: list[dict] = Field(
        description="The data connectors that the user can reach, with the user's final access to each.",
    )
    templates: list[dict] = Field(
        description="The templates that the user can reach, with the user's final access to each.",
    )
    prompts: list[dict] = Field(description="The prompts that the user can reach, with the user's final access to each.")


class ThemeSettings(BaseModel):
    model_config = ConfigDict(extra="allow", from_attributes=True)
    appTheme: dict | None = Field(None, description="The app's theme.")


THEME_PROPERTY_NAME_TAIL_MAX_LENGTH = 80
THEME_PROPERTY_VALUE_MAX_LENGTH = 200
THEME_PRESET_NAME_MAX_LENGTH = 60
THEME_PROPERTY_NAME = re.compile(rf"^--[a-z][a-z0-9-]{{0,{THEME_PROPERTY_NAME_TAIL_MAX_LENGTH}}}$")
THEME_PROPERTY_VALUE = re.compile(rf"^[A-Za-z0-9 #%.,()/_+*\"'-]{{1,{THEME_PROPERTY_VALUE_MAX_LENGTH}}}$")
THEME_MAX_PROPERTIES = 400
THEME_MAX_PRESETS = 50


def check_theme_declarations(declarations: dict[str, str]) -> dict[str, str]:
    if len(declarations) > THEME_MAX_PROPERTIES:
        raise ValueError(f"A theme holds at most {THEME_MAX_PROPERTIES} properties")
    for name, value in declarations.items():
        if not THEME_PROPERTY_NAME.match(name):
            raise ValueError(f"{name!r} is not a custom property name")
        if not THEME_PROPERTY_VALUE.match(value) or "url(" in value.lower():
            raise ValueError(f"The value of {name} is not allowed")
    return declarations


ThemeDeclarations = Annotated[dict[str, str], AfterValidator(check_theme_declarations)]


class ThemeVariants(BaseModel):
    model_config = ConfigDict(extra="forbid")
    light: ThemeDeclarations = Field(default_factory=dict, description="The theme's properties for light mode.")
    dark: ThemeDeclarations = Field(default_factory=dict, description="The theme's properties for dark mode.")


class ThemePresetBody(ThemeVariants):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=THEME_PRESET_NAME_MAX_LENGTH)
    ] = Field(
        description="The preset's name.",
    )


class ThemePreset(ThemePresetBody):
    uuid: UUID = Field(description="The UUID of the preset.")


class ThemePresets(BaseModel):
    model_config = ConfigDict(extra="ignore")
    presets: list[ThemePreset] = Field(
        default_factory=list,
        max_length=THEME_MAX_PRESETS,
        description="The organization's theme presets.",
    )
    active_preset: UUID | None = Field(
        None,
        description="The UUID of the active preset. It is empty when no preset is active.",
    )


class ThemeActivePreset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uuid: UUID | None = Field(description="The UUID of the preset to make active, or null to clear the selection.")


class EntityThemeSettings(BaseModel):
    model_config = ConfigDict(extra="ignore", from_attributes=True)
    light: ThemeSettings | None = Field(None, description="The theme settings for light mode.")
    dark: ThemeSettings | None = Field(None, description="The theme settings for dark mode.")
    properties: ThemeVariants | None = Field(None, description="The theme properties for light and dark mode.")


class AppToken(BaseModel, extra="ignore"):  # type: ignore[call-arg]
    uuid: UUID = Field(description="The user's UUID.")
    email: EmailStr = Field(description="The user's email address.")
    username: str | None = Field(description="The user's username.")
    expiration_date: datetime = Field(description="When the session expires.")
    temporary_password: bool = Field(description="Whether the password is temporary and the user must change it.")
    force_2fa: bool = Field(description="Whether the user must set up two-factor authentication.")
    entity_name: None | str = Field(description="The name of the user's organization.")
    entity_theme_settings: EntityThemeSettings = Field(description="The theme settings of the user's organization.")
    role: None | str = Field(description="The user's type: Admin, Developer or User.")
    show_changelog: bool = Field(
        description=(
            "Whether the web app should show the change log, because the user last signed in with another version."
        ),
    )


class AppTokenWithContext(AppToken):
    copilot_chats: list["ChatInfo | Chat"] | None = Field(None, description="The user's Copilot chats.")
    questions_history: list[str] | None = Field(None, description="The questions that the user asked the Copilot.")
    dash_sync: DashboardComplete | None = Field(None, description="The user's dashboards.")
    user_apps: UserAppsComplete = Field(
        description="The apps that the user owns and the apps that others shared with the user.",
    )
    user_skills: list[SkillReturn] | None = Field(None, description="The user's skills.")
    user: AppUserReturn | None = Field(None, description="The user's profile data.")
    access: UserAccess | None = Field(None, description="The user's type and sharing level.")
    usage: UsageGet | None = Field(None, description="The user's Copilot usage and limits.")
    custom_copilots: list[CustomCopilot] | None = Field(None, description="The user's custom Copilots.")
    mcp_servers: list[MCPServer] | None = Field(None, description="The user's saved MCP servers.")
    copilot_keys: CopilotKeysStatus | None = Field(None, description="Which provider keys the user saved.")
    is_first_login: bool | None = Field(False, description="Whether this is the user's first sign-in.")


class SessionUser(BaseModel):
    model_config = main_config
    first_name: None | str = Field(None, description="The user's first name.")
    last_name: None | str = Field(None, description="The user's last name.")
    display_settings: UserDisplaySettings = Field(UserDisplaySettings(), description="The user's display settings.")


class AppSession(BaseModel):
    model_config = main_config
    uuid: UUID = Field(description="The user's UUID.")
    email: EmailStr = Field(description="The user's email address.")
    username: str | None = Field(description="The user's username.")
    expiration_date: datetime = Field(description="When the session expires.")
    temporary_password: bool = Field(description="Whether the password is temporary and the user must change it.")
    force_2fa: bool = Field(description="Whether the user must set up two-factor authentication.")
    entity_name: None | str = Field(description="The name of the user's organization.")
    role: None | str = Field(description="The user's type: Admin, Developer or User.")
    access: UserAccess = Field(description="The user's type and sharing level.")
    usage: UsageGet | None = Field(None, description="The user's Copilot usage and limits.")
    copilot_keys: CopilotKeysStatus = Field(description="Which provider keys the user saved.")
    user: SessionUser = Field(description="The user's name and display settings.")
