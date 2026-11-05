import re
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel as PydanticBaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from . import (
    csp as csp_rules,
    proxy as proxy_rules,
)
from .proxy import MAX_TIMEOUT_MS, NAME_PATTERN, PROXY_ID_PATTERN, Proxy, RouteArg
from .schema_lint import lint_fragment, lint_settings_schema, validate_settings_values

HOST_API = 1
HOST_AFM = "0.11"

PLUGIN_ID_PATTERN = r"^[a-z][a-z0-9-]{1,47}$"
WIDGET_ID_PATTERN = r"^[a-z][a-z0-9_-]{0,47}$"
VIZ_TYPE_PATTERN = r"^[a-z][a-z0-9_-]{1,31}$"
VERSION_PATTERN = r"^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$"
DIGEST_PATTERN = r"^sha256-[A-Za-z0-9_-]{43}$"

BUILT_IN_TYPES = frozenset({"markdown", "html", "iframe", "newsfeed", "pdf"})

PERMISSIONS = frozenset(
    {
        "core:default",
        "core:data:read",
        "core:data:stream",
        "core:params:write",
        "core:state:write",
        "core:config:write",
        "core:copilot:context",
        "core:export:provide",
        "core:ui:notify",
        "core:ui:open-link",
        "core:ui:button",
        "core:ui:menu",
        "core:dashboard:add-widget",
        "core:clipboard:write",
        "core:download:save",
        "core:proxy:call",
        "core:backend:call",
        "core:presets",
    }
)
PERMISSIONS_LATER = frozenset({"core:data:query"})
ACTION_ICONS = frozenset(
    {
        "bell",
        "calendar",
        "chart",
        "check",
        "clock",
        "code",
        "columns",
        "copy",
        "database",
        "download",
        "edit",
        "eye",
        "filter",
        "globe",
        "grid",
        "info",
        "link",
        "lock",
        "maximize",
        "pie-chart",
        "play",
        "refresh",
        "search",
        "settings",
        "sliders",
        "sparkles",
        "star",
        "table",
        "upload",
        "zap",
        "zoom-in",
        "zoom-out",
    }
)
ACTION_ICON_PATH = r"^assets/[A-Za-z0-9._-]{1,100}\.svg$"
MAX_ACTION_ICON_BYTES = 16384
ACTION_ICON_TAGS = frozenset(
    {
        "circle",
        "desc",
        "ellipse",
        "g",
        "line",
        "path",
        "polygon",
        "polyline",
        "rect",
        "svg",
        "title",
    }
)
ACTION_ICON_VALUES = {
    "clip-rule": r"nonzero|evenodd",
    "cx": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "cy": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "d": r"[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\- \t\n\r]*",
    "fill": r"none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}",
    "fill-opacity": r"[0-9]*\.?[0-9]+%?",
    "fill-rule": r"nonzero|evenodd",
    "height": r"[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?(px|%)?",
    "opacity": r"[0-9]*\.?[0-9]+%?",
    "points": r"[0-9eE.,+\- \t\n\r]*",
    "r": r"[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "rx": r"[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?|auto",
    "ry": r"[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?|auto",
    "stroke": r"none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}",
    "stroke-dasharray": r"none|[0-9eE.,%\- \t]+",
    "stroke-dashoffset": r"[-+]?[0-9]*\.?[0-9]+%?",
    "stroke-linecap": r"butt|round|square",
    "stroke-linejoin": r"arcs|bevel|miter|miter-clip|round",
    "stroke-miterlimit": r"[0-9]*\.?[0-9]+",
    "stroke-opacity": r"[0-9]*\.?[0-9]+%?",
    "stroke-width": r"[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?(px|%)?",
    "transform": r"(\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE.,+\- \t]*\)\s*,?)*\s*",
    "viewBox": r"[-+]?[0-9.eE]+([ ,]+[-+]?[0-9.eE]+){3}",
    "width": r"[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?(px|%)?",
    "x": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "x1": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "x2": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "xmlns": r"http://www\.w3\.org/2000/svg",
    "y": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "y1": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
    "y2": r"[-+]?[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?%?",
}
ACTION_ICON_ATTRIBUTES = frozenset(ACTION_ICON_VALUES)
MAX_NAVBAR_ACTIONS = 3
MAX_MENU_ACTIONS = 8
ACTION_PERMISSIONS = {"navbar": "core:ui:button", "menu": "core:ui:menu"}
MAX_ROUTE_BYTES = 5 * 1024 * 1024


TRAITS = ("data", "params", "definition", "config", "adminSettings", "state", "theme", "capabilities", "meta")

_TRAIT_BINDING = re.compile(
    rf"^({'|'.join(TRAITS)})$"
    r"|^param:[A-Za-z_][A-Za-z0-9_.-]{0,63}$"
    r"|^(config|adminSettings):[A-Za-z][A-Za-z0-9_]{0,63}$"
)
_WRITABLE = re.compile(r"^(params|param:.+|state|config|config:.+)$")

ShortText = Annotated[str, StringConstraints(min_length=1, max_length=80)]
Sentence = Annotated[str, StringConstraints(max_length=300)]


def _package_path(value: str) -> str:
    parts = value.split("/")
    if (
        not re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", value)
        or value.startswith("/")
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise ValueError(f"{value!r} is not a relative path inside the package")
    return value


PackagePath = Annotated[str, AfterValidator(_package_path)]

closed = ConfigDict(extra="forbid", frozen=True)


class BaseModel(PydanticBaseModel):
    model_config = closed


class Publisher(BaseModel):
    model_config = closed

    name: Annotated[str, StringConstraints(min_length=1, max_length=100)] = Field(description="The publisher's name.")
    url: Annotated[str, StringConstraints(pattern=r"^https://[^\s]{1,200}$")] | None = Field(
        default=None, description="The publisher's website, an https URL."
    )


class HostTarget(BaseModel):
    model_config = closed

    api: int = Field(description="The host API version that the package is built against.")
    afm: Annotated[str, StringConstraints(max_length=16)] = Field(
        description="The AFM version that the package follows, as text."
    )

    @model_validator(mode="after")
    def supported(self):
        if self.api != HOST_API:
            raise ValueError(f"targets host API {self.api}; this FINOS Workspace implements {HOST_API}")
        if self.afm != HOST_AFM:
            raise ValueError(f"follows AFM {self.afm}; this FINOS Workspace implements {HOST_AFM}")
        return self


class Entry(BaseModel):
    model_config = closed

    module: PackagePath = Field(description="The module, one .js file outside backend/.")
    styles: list[PackagePath] = Field(
        default_factory=list, max_length=8, description="The style sheets, .css files outside backend/."
    )

    @field_validator("module")
    @classmethod
    def javascript(cls, value: str) -> str:
        if not value.endswith(".js") or value.startswith("backend/"):
            raise ValueError("the entry module is a .js file outside backend/")
        return value

    @field_validator("styles")
    @classmethod
    def stylesheets(cls, value: list[str]) -> list[str]:
        if any(not s.endswith(".css") or s.startswith("backend/") for s in value):
            raise ValueError("styles are .css files outside backend/")
        return value


class Secret(BaseModel):
    model_config = closed

    name: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")] = Field(
        description="The secret's name, in lowercase letters, digits and underscores."
    )
    purpose: Sentence = Field(description="What the secret is for. Admins read this text in the review.")


class DataSource(BaseModel):
    model_config = closed

    id: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_-]{0,63}$")] = Field(
        description="The data source's id, unique within the plugin."
    )
    purpose: Sentence = Field(
        description="What the backend reads from the data source. Admins read this text in the review."
    )


class RouteResponse(BaseModel):
    model_config = closed

    maxBytes: int = Field(  # noqa: N815
        default=1024 * 1024,
        ge=1,
        le=MAX_ROUTE_BYTES,
        description="The most bytes that the route may answer with. The deployment caps the value as well.",
    )
    timeoutMs: int = Field(  # noqa: N815
        default=10_000,
        ge=100,
        le=MAX_TIMEOUT_MS,
        description="How long a call may take, in milliseconds. The deployment caps the value as well.",
    )


class Route(BaseModel):
    model_config = closed

    id: Annotated[str, StringConstraints(pattern=PROXY_ID_PATTERN)] = Field(
        description="The route's id, unique within the backend."
    )
    args: dict[Annotated[str, StringConstraints(pattern=NAME_PATTERN)], RouteArg] = Field(
        default_factory=dict,
        max_length=32,
        description="The arguments that the route accepts, by name. The API checks them before it makes the call.",
    )
    secrets: list[Annotated[str, StringConstraints(pattern=NAME_PATTERN)]] = Field(
        default_factory=list,
        max_length=16,
        description="The secrets that the route sends, by name. Each one is declared in the manifest's secrets.",
    )
    response: RouteResponse = Field(default_factory=RouteResponse, description="The limits of the route's answer.")


class Backend(BaseModel):
    model_config = closed

    protocol: Literal[1] = Field(description="The version of the protocol that the API speaks with the backend.")
    routes: list[Route] = Field(min_length=1, max_length=32, description="The routes that the backend serves.")


class Server(BaseModel):
    model_config = closed

    network: list[Annotated[str, StringConstraints(max_length=255)]] = Field(
        default_factory=list,
        max_length=32,
        description=(
            "The https origins that the server may call for the plugin and, for a backend, "
            "the tcp://host:port endpoints that it opens."
        ),
    )
    proxies: list[Proxy] = Field(
        default_factory=list, max_length=32, description="The requests that the server makes on behalf of widgets."
    )
    backend: Backend | None = Field(default=None, description="The plugin's own server-side code.")


class SettingsSpec(BaseModel):
    model_config = closed

    schema_: dict[str, Any] = Field(
        default_factory=dict,
        alias="schema",
        description="The JSON Schema of the form, a flat object of simple properties.",
    )
    defaults: dict[str, Any] = Field(
        default_factory=dict, description="The default value of each property. The defaults satisfy the schema."
    )

    @model_validator(mode="after")
    def valid(self):
        problems = lint_settings_schema(self.schema_) if self.schema_ else []
        if not problems and self.defaults:
            problems = validate_settings_values(self.schema_, self.defaults)
        if problems:
            raise ValueError("; ".join(problems))
        return self


class TraitBinding(BaseModel):
    model_config = closed

    bind: Annotated[str, StringConstraints(max_length=80)] = Field(
        description=(
            "The host state that the trait is bound to: one of the traits that the host offers, "
            "or param:<name>, config:<key> or adminSettings:<key>."
        )
    )
    access: Literal["read", "readwrite"] = Field(
        default="read",
        description=(
            "Whether the module may write the trait. "
            "Only params, param:<name>, state, config and config:<key> can be readwrite."
        ),
    )

    @model_validator(mode="after")
    def valid(self):
        if not _TRAIT_BINDING.fullmatch(self.bind):
            raise ValueError(f"{self.bind!r} is not a host binding")
        if self.access == "readwrite" and not _WRITABLE.fullmatch(self.bind):
            raise ValueError(f"{self.bind!r} is read-only")
        return self


class ModelSpec(BaseModel):
    model_config = closed

    traits: dict[
        Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")],
        TraitBinding,
    ] = Field(default_factory=dict, max_length=64, description="The module's own trait names, each bound to host state.")


class Response(BaseModel):
    model_config = closed

    accepts: Literal["json"] = Field(default="json", description="The kind of answer that the backend returns.")
    description: Sentence = Field(default="", description="What the backend returns.")
    schema_: dict[str, Any] | None = Field(default=None, alias="schema", description="A JSON Schema of the answer.")


class Handle(BaseModel):
    model_config = closed

    type: Annotated[str, StringConstraints(pattern=VIZ_TYPE_PATTERN)] = Field(
        description=(
            'The viz type that the widget renders. It is the "type" value in a backend\'s widgets.json, '
            "and it cannot be a built-in type."
        )
    )
    definition: dict[str, Any] | None = Field(
        default=None,
        description=(
            "The JSON Schema of the data.<type> object that a backend writes for the type. It is closed and bounded."
        ),
    )
    response: Response = Field(
        default_factory=Response, description="The JSON that the backend's endpoint returns for the type."
    )

    @model_validator(mode="after")
    def valid(self):
        if self.type in BUILT_IN_TYPES:
            raise ValueError(f"{self.type!r} is a built-in widget type")
        if self.definition is not None:
            problems = lint_fragment(self.definition)
            if problems:
                raise ValueError("the definition is not closed and bounded: " + "; ".join(problems[:10]))
        return self


class Grid(BaseModel):
    model_config = closed

    w: Annotated[int, Field(ge=1, le=40)] = Field(default=20, description="The default width on the dashboard grid.")
    h: Annotated[int, Field(ge=1, le=100)] = Field(default=12, description="The default height on the dashboard grid.")
    minW: Annotated[int, Field(ge=1, le=40)] | None = Field(  # noqa: N815
        default=None, description="The smallest width that the user may give the widget."
    )
    minH: Annotated[int, Field(ge=1, le=100)] | None = Field(  # noqa: N815
        default=None, description="The smallest height that the user may give the widget."
    )


class WidgetArtifact(BaseModel):
    model_config = closed

    description: Annotated[str, StringConstraints(min_length=1, max_length=300)] = Field(
        description="When the agent shows the widget in the chat."
    )
    data: dict[str, Any] = Field(description="The JSON Schema of the data the agent may fill in.")

    @model_validator(mode="after")
    def valid(self):
        problems = lint_fragment(self.data)
        if problems:
            raise ValueError("the artifact data schema is not closed and bounded: " + "; ".join(problems[:10]))
        return self


class WidgetServer(BaseModel):
    model_config = closed

    proxies: list[Annotated[str, StringConstraints(max_length=64)]] = Field(
        default_factory=list,
        max_length=32,
        description=(
            "The ids of the proxies that the widget may call. "
            "The widget then needs the permission core:proxy:call, and it needs it only for this purpose."
        ),
    )
    routes: list[Annotated[str, StringConstraints(max_length=64)]] = Field(
        default_factory=list,
        max_length=32,
        description=(
            "The ids of the backend routes that the widget may call. "
            "The widget then needs the permission core:backend:call, and it needs it only for this purpose."
        ),
    )


class Action(BaseModel):
    model_config = closed

    id: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_-]{0,31}$")] = Field(
        description="The action's id, unique within the widget. The module receives it when the user picks the action."
    )
    label: Annotated[str, StringConstraints(min_length=1, max_length=40)] = Field(
        description="The text of the menu item, or the tooltip of the button."
    )
    icon: str = Field(
        description=(
            "One of the icons that the host offers, by name, or an SVG file of the package under assets/. "
            "The host draws only the SVG elements and attributes that it allows."
        )
    )
    placement: Literal["navbar", "menu"] = Field(
        description="navbar puts a button in the card's header, menu puts an item in the card's options menu."
    )
    toggles: Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,63}$")] | None = Field(
        default=None,
        description=(
            "A boolean setting of the widget that the button switches on and off. "
            "The button shows as pressed while the setting is on. Only a navbar button toggles."
        ),
    )

    @model_validator(mode="after")
    def valid(self):
        if self.icon not in ACTION_ICONS and not re.fullmatch(ACTION_ICON_PATH, self.icon):
            raise ValueError(f"{self.icon!r} is neither a host icon nor an SVG file under assets/")
        if self.toggles is not None and self.placement != "navbar":
            raise ValueError("only a navbar button toggles a setting")
        return self


class Widget(BaseModel):
    model_config = closed

    id: Annotated[str, StringConstraints(pattern=WIDGET_ID_PATTERN)] = Field(
        description="The widget's id, unique within the plugin."
    )
    name: ShortText = Field(description="The name that Add widget shows.")
    description: Sentence = Field(default="", description="What the widget shows.")
    category: Annotated[str, StringConstraints(max_length=60)] | None = Field(
        default=None, description="The category in Add widget."
    )
    subCategory: Annotated[str, StringConstraints(max_length=60)] | None = Field(  # noqa: N815
        default=None, description="The sub-category in Add widget."
    )
    handles: list[Handle] = Field(
        default_factory=list, max_length=8, description="The viz types that the widget renders for backend widgets."
    )
    standalone: bool = Field(
        default=False,
        description=(
            "Whether the widget appears in Add widget on its own and needs no backend. "
            "A widget handles at least one type or is standalone."
        ),
    )
    artifact: WidgetArtifact | None = Field(
        default=None,
        description=(
            "What the widget gives the agent when the user asks for it in the chat: "
            "when it is useful, and the data the agent may fill in."
        ),
    )
    permissions: list[str] = Field(
        default_factory=list, max_length=32, description="The host permissions that the widget asks for."
    )
    server: WidgetServer | None = Field(
        default=None, description="The proxies and backend routes that the widget may call."
    )
    model: ModelSpec | None = Field(default=None, description="The module's own traits and what they are bound to.")
    params: list[dict[str, Any]] = Field(
        default_factory=list,
        max_length=32,
        description=(
            "The parameters of a standalone widget, written as in widgets.json. "
            "Every parameter has a paramName, and the names are unique."
        ),
    )
    settings: SettingsSpec | None = Field(
        default=None, description="A form that the user edits for each widget instance."
    )
    grid: Grid = Field(default_factory=Grid, description="The widget's size on the dashboard grid.")
    actions: list[Action] = Field(
        default_factory=list,
        max_length=MAX_NAVBAR_ACTIONS + MAX_MENU_ACTIONS,
        description=(
            "Buttons in the card's header and items in its options menu. The host draws them, "
            "and sends the module an action event when the user picks one."
        ),
    )

    def _check_actions(self) -> None:
        ids = [a.id for a in self.actions]
        if len(set(ids)) != len(ids):
            raise ValueError("an action id is declared twice")
        for placement, permission in ACTION_PERMISSIONS.items():
            declared = any(a.placement == placement for a in self.actions)
            if declared != (permission in self.permissions):
                raise ValueError(f"a widget with {placement} actions has the permission {permission}, and only then")
        if sum(a.placement == "navbar" for a in self.actions) > MAX_NAVBAR_ACTIONS:
            raise ValueError(f"a widget has at most {MAX_NAVBAR_ACTIONS} navbar buttons")
        if "core:dashboard:add-widget" in self.permissions and not any(a.toggles is None for a in self.actions):
            raise ValueError(
                "a widget with the permission core:dashboard:add-widget has an action that toggles nothing, "
                "since it adds a widget only right after the user picks such an action"
            )
        if sum(a.placement == "menu" for a in self.actions) > MAX_MENU_ACTIONS:
            raise ValueError(f"a widget has at most {MAX_MENU_ACTIONS} menu items")
        properties = (self.settings.schema_.get("properties") or {}) if self.settings else {}
        for action in self.actions:
            if action.toggles is not None and (properties.get(action.toggles) or {}).get("type") != "boolean":
                raise ValueError(f"the action {action.id!r} toggles {action.toggles!r}, which is not a boolean setting")

    def _check_artifact(self) -> None:
        if self.artifact is None:
            return
        if "core:data:read" not in self.permissions:
            raise ValueError("a widget with an artifact reads its data, so it has the permission core:data:read")
        if self.model is not None and not any(t.bind == "data" for t in self.model.traits.values()):
            raise ValueError("a widget with an artifact binds a trait to data")

    @model_validator(mode="after")
    def valid(self):
        if not self.handles and not self.standalone:
            raise ValueError("a widget handles at least one type, or is standalone")
        types = [h.type for h in self.handles]
        if len(set(types)) != len(types):
            raise ValueError("a type is handled twice")
        for permission in self.permissions:
            if permission in PERMISSIONS_LATER:
                raise ValueError(f"{permission} is not available on this FINOS Workspace yet")
            if permission not in PERMISSIONS:
                raise ValueError(f"{permission!r} is not a host permission")
        if len(set(self.permissions)) != len(self.permissions):
            raise ValueError("a permission is listed twice")
        self._check_artifact()
        self._check_actions()
        calls_proxies = bool(self.server and self.server.proxies)
        if calls_proxies != ("core:proxy:call" in self.permissions):
            raise ValueError("a widget that names proxies has the permission core:proxy:call, and only then")
        calls_routes = bool(self.server and self.server.routes)
        if calls_routes != ("core:backend:call" in self.permissions):
            raise ValueError("a widget that names backend routes has the permission core:backend:call, and only then")
        names = [p.get("paramName") for p in self.params]
        if not all(isinstance(n, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", n) for n in names):
            raise ValueError("every param has a paramName")
        if len(set(names)) != len(names):
            raise ValueError("a paramName is declared twice")
        return self


SKILL_SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
SKILL_FILE_PATTERN = r"^skills/[A-Za-z0-9._-]{1,100}\.md$"


class Skill(BaseModel):
    slug: Annotated[str, StringConstraints(pattern=SKILL_SLUG_PATTERN, min_length=2, max_length=50)] = Field(
        description="The slug of the skill: lowercase letters, digits and single `-`."
    )
    description: Annotated[str, StringConstraints(min_length=1, max_length=300)] = Field(
        description="What the skill is for."
    )
    file: Annotated[str, StringConstraints(pattern=SKILL_FILE_PATTERN)] = Field(
        description="The markdown file of the skill, under `skills/` in the plugin."
    )


class Contributes(BaseModel):
    model_config = closed

    widgets: list[Widget] = Field(min_length=1, max_length=20, description="The widget types that the plugin offers.")
    skills: list[Skill] = Field(
        default_factory=list, max_length=20, description="The skills that the plugin gives the agent."
    )

    @model_validator(mode="after")
    def unique(self):
        ids = [w.id for w in self.widgets]
        if len(set(ids)) != len(ids):
            raise ValueError("widget ids must be unique")
        slugs = [s.slug for s in self.skills]
        if len(set(slugs)) != len(slugs):
            raise ValueError("skill slugs must be unique")
        files = [s.file for s in self.skills]
        if len(set(files)) != len(files):
            raise ValueError("two skills name the same file")
        types = [h.type for w in self.widgets for h in w.handles]
        if len(set(types)) != len(types):
            raise ValueError("two widgets of the plugin handle the same type")
        return self


class Manifest(BaseModel):
    model_config = closed

    manifestVersion: Literal[1] = Field(description="The version of the manifest format.")  # noqa: N815
    id: Annotated[str, StringConstraints(pattern=PLUGIN_ID_PATTERN)] = Field(
        description="The plugin's id. It equals the name of the directory that holds the plugin's versions."
    )
    version: Annotated[str, StringConstraints(pattern=VERSION_PATTERN)] = Field(
        description=(
            "The version, in the form major.minor.patch with numbers only. It equals the name of the version's directory."
        )
    )
    name: ShortText = Field(description="The name that admins and users see.")
    description: Sentence = Field(default="", description="A short description of the plugin.")
    publisher: Publisher = Field(
        description=(
            "Who publishes the plugin. Admins see the values as the package states them, "
            "and Workspace does not verify them."
        )
    )
    icon: PackagePath | None = Field(default=None, description="A file under assets/ that serves as the plugin's icon.")
    host: HostTarget = Field(
        description=(
            "The host API version and the AFM version that the package is built against. "
            "A host that implements other versions blocks the package."
        )
    )
    checksum: Annotated[str, StringConstraints(pattern=DIGEST_PATTERN)] = Field(
        description=(
            "The text sha256- followed by the base64url SHA-256 of the sorted lines that each hold a file's path, "
            "a zero byte, the file's SHA-256 in hexadecimal and a newline, for every file except plugin.json. "
            "The command plugin_check --digest prints it."
        )
    )
    entry: Entry = Field(description="The module and the style sheets that the frame receives.")
    csp: dict[str, list[str]] | None = Field(
        default=None, description="The sources that the frame itself may reach, by directive."
    )
    cspNotes: dict[str, Sentence] | None = Field(  # noqa: N815
        default=None, description="One sentence for each directive in csp that explains why the frame needs it."
    )
    secrets: list[Secret] = Field(
        default_factory=list,
        max_length=16,
        description="The secrets that proxies and backend routes send. A manifest never contains a value.",
    )
    dataSources: list[DataSource] = Field(  # noqa: N815
        default_factory=list, max_length=16, description="The data that the backend reads for the user."
    )
    identity: Literal["none", "pseudonymous"] = Field(
        default="none", description="Whether the backend learns a pseudonymous id of the user."
    )
    server: Server | None = Field(
        default=None,
        description="What the server does for the plugin: the hosts that it calls, its proxies and its backend.",
    )
    adminSettings: SettingsSpec | None = Field(  # noqa: N815
        default=None, description="A settings form that an organization's admin fills in. It must not hold secrets."
    )
    contributes: Contributes = Field(description="The widgets that the plugin contributes.")
    signatures: None = Field(
        default=None,
        description="Reserved. A manifest that sets it is blocked, because this host verifies no signatures.",
    )

    @model_validator(mode="after")
    def valid(self):
        check = csp_rules.check_policy(self.csp)
        if not check.ok:
            raise ValueError("csp: " + "; ".join(check.errors))
        for directive in self.cspNotes or {}:
            if directive not in (self.csp or {}):
                raise ValueError(f"cspNotes: {directive} is not in csp")
        self._check_server()
        widgets = self.contributes.widgets
        if any("core:dashboard:add-widget" in w.permissions for w in widgets) and not any(w.artifact for w in widgets):
            raise ValueError(
                "a plugin whose widget has the permission core:dashboard:add-widget has a widget with an artifact"
            )
        if self.icon and not self.icon.startswith("assets/"):
            raise ValueError("the icon is a file under assets/")
        return self

    def _check_server(self) -> None:
        secrets = [s.name for s in self.secrets]
        if len(set(secrets)) != len(secrets):
            raise ValueError("a secret is declared twice")
        server = self.server or Server()
        check = proxy_rules.check_network(list(server.network), backend=server.backend is not None)
        problems = list(check.errors)
        ids = [p.id for p in server.proxies]
        if len(set(ids)) != len(ids):
            problems.append("a proxy id is declared twice")
        for proxy in server.proxies:
            problems.extend(proxy_rules.check_proxy(proxy, list(server.network), set(secrets)))
        problems.extend(self._backend_problems(server, set(secrets)))
        routes = [r.id for r in server.backend.routes] if server.backend else []
        for widget in self.contributes.widgets:
            for proxy_id in widget.server.proxies if widget.server else []:
                if proxy_id not in ids:
                    problems.append(f"widget {widget.id}: {proxy_id!r} is not a declared proxy")
            for route_id in widget.server.routes if widget.server else []:
                if route_id not in routes:
                    problems.append(f"widget {widget.id}: {route_id!r} is not a route of the backend")
        if self.secrets and not (server.proxies or server.backend):
            problems.append("secrets are for proxies and backend routes, and this plugin declares neither")
        if problems:
            raise ValueError("; ".join(problems))

    def _backend_problems(self, server: Server, secrets: set[str]) -> list[str]:
        problems: list[str] = []
        sources = [d.id for d in self.dataSources]
        if len(set(sources)) != len(sources):
            problems.append("a data source is declared twice")
        if not server.backend:
            if self.dataSources or self.identity != "none":
                problems.append("data sources and identity are for a plugin backend, and this plugin declares none")
            return problems
        routes = [r.id for r in server.backend.routes]
        if len(set(routes)) != len(routes):
            problems.append("a route id is declared twice")
        for route in server.backend.routes:
            problems.extend(
                f"server.backend.routes[{route.id}]: {name!r} is not a declared secret"
                for name in route.secrets
                if name not in secrets
            )
            if len(set(route.secrets)) != len(route.secrets):
                problems.append(f"server.backend.routes[{route.id}]: a secret is listed twice")
        return problems

    def skill_paths(self) -> set[str]:
        return {skill.file for skill in self.contributes.skills}

    def action_icon_paths(self) -> set[str]:
        return {a.icon for w in self.contributes.widgets for a in w.actions if a.icon not in ACTION_ICONS}

    def served_paths(self) -> set[str]:
        paths = {self.entry.module, *self.entry.styles, *self.action_icon_paths()}
        if self.icon:
            paths.add(self.icon)
        return paths
