from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
)

type BridgeErrorCode = Literal[
    "invalid_request",
    "unauthorized",
    "unavailable",
    "timeout",
    "command_failed",
    "unknown",
]
type NavigationOperation = Literal["create", "add_tabs", "remove_tabs", "rename_tabs"]
type GenerativeWidgetType = Literal["note", "html"]
type DashboardOperation = Literal["create", "read", "update"]
type WorkspaceNavigationOperation = Literal["dashboard", "tab"]
type BackendsOperation = Literal["list", "add", "update", "refresh", "remove"]
type AppsOperation = Literal["list", "read", "instantiate"]
type EndpointHeaderLocation = Literal["headers", "query"]
type BridgePayload = dict[str, Any]
type BridgePayloadList = list[BridgePayload]


def new_request_id() -> str:
    return f"cmd_{uuid4().hex}"


def widget_groups() -> dict[str, list[dict[str, Any]]]:
    return {"primary": [], "secondary": [], "extra": []}


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class BridgeError(Model):
    code: BridgeErrorCode
    message: str
    details: dict[str, Any] | None = None
    retryable: bool = False


class BrowserSessionStartRequest(Model):
    client_name: str = "workspace-ui"
    current_dashboard_id: str | None = None
    current_tab_id: str | None = None


class BrowserSessionContext(Model):
    current_dashboard_id: str | None = None
    current_tab_id: str | None = None


class BrowserSession(Model):
    session_id: str
    client_name: str
    current_dashboard_id: str | None = None
    current_tab_id: str | None = None


class BrowserSessionStartResponse(Model):
    session: BrowserSession
    websocket_url: str


class AgentFeatureSelectOption(BaseModel):
    label: str
    value: str


class AgentFeatureOption(BaseModel):
    label: str
    type: Literal["toggle", "text", "select"] | None = None
    default: bool | str | None = None
    description: str | None = None
    placeholder: str | None = None
    options: list[AgentFeatureSelectOption] | None = None


class WorkspaceAgent(BaseModel):
    holder_url: str | None = None
    id: str
    name: str
    description: str | None = None
    features: dict[str, bool | AgentFeatureOption] = Field(default_factory=dict)


class CopiedFrom(BaseModel):
    widget_uuid: str
    name: str
    created_at: str | None = None


class FromArtifact(BaseModel):
    artifact_uuid: str
    name: str
    created_at: str | None = None
    in_current_chat: bool | None = None


class WidgetInfo(BaseModel):
    widget_uuid: str
    name: str
    copied_from: CopiedFrom | None = None
    from_artifact: FromArtifact | None = None


class TabInfo(BaseModel):
    tab_id: str = "__no_tab__"
    widgets: list[WidgetInfo] | None = None


class DashboardInfo(BaseModel):
    id: str
    name: str
    current_tab_id: str
    tabs: list[TabInfo] | None = None


class WorkspaceState(BaseModel):
    action_history: list[str] | None = None
    agents: list[WorkspaceAgent] | None = None
    current_dashboard_uuid: UUID | None = None
    current_dashboard_info: DashboardInfo | None = None
    current_page_context: str | None = None


class AgentTool(BaseModel):
    server_id: str | None = None
    name: str
    url: str
    endpoint: str | None = None
    description: str | None = None
    input_schema: dict[str, Any] | None = None


class WorkspaceSnapshot(Model):
    generated_at: int
    workspace_state: WorkspaceState | None = None
    workspace_options: list[str] = Field(default_factory=list)
    dashboards: list[dict[str, Any]] = Field(default_factory=list)
    dashboard_composition: dict[str, Any] | None = None
    widgets: dict[str, list[dict[str, Any]]] = Field(default_factory=widget_groups)
    context: list[dict[str, Any]] = Field(default_factory=list)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    files: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[AgentTool] = Field(default_factory=list)
    skills: list[dict[str, Any]] = Field(default_factory=list)


class WorkspaceWidgetConfig(Model):
    data_args: dict[str, Any] | None = Field(default=None, description="The values of the widget's data parameters.")
    ui_args: dict[str, Any] | None = Field(default=None, description="The values of the widget's interface settings.")


class WidgetDataRequest(Model):
    origin: str = Field(validation_alias=AliasChoices("origin", "backend_name"))
    widget_id: str
    data_args: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias=AliasChoices(
            "data_args",
            "params",
            "input_args",
            "dataArgs",
            "inputArgs",
        ),
    )
    widget_uuid: str | None = None


class ParamOptionsRequest(Model):
    origin: str = Field(validation_alias=AliasChoices("origin", "backend_name"))
    widget_id: str
    param_name: str
    data_args: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias=AliasChoices(
            "data_args",
            "params",
            "options_endpoint_input_args",
            "dataArgs",
            "optionsEndpointInputArgs",
        ),
    )


RequestId = Annotated[
    str | None,
    Field(
        description=(
            "Identifies the request. The result carries the same id, "
            "and a command that is sent again with it receives the stored result."
        )
    ),
]
DashboardId = Annotated[
    str | None,
    Field(description="The dashboard to act on. When it is missing, the dashboard that the tab shows."),
]
WidgetUuid = Annotated[
    str | None,
    Field(description="The widget instance to act on. It is preferred over widget_id."),
]
WidgetIdFallback = Annotated[
    str | None,
    Field(
        description=(
            "The widget type id. It identifies the widget only when exactly one widget of that type is on the dashboard."
        )
    ),
]
Activate = Annotated[
    bool | None,
    Field(description="Whether the tab shows the new dashboard. It does by default."),
]


class GetWidgetDataCommand(Model):
    command: Literal["get_widget_data"]
    request_id: RequestId = None
    data_sources: BridgePayloadList = Field(
        default_factory=list,
        description=(
            "The data sources to fetch. Each has the origin, the widget id, the data arguments "
            "and optionally the widget UUID."
        ),
    )


class ListAvailableWidgetsCommand(Model):
    command: Literal["list_available_widgets"]
    request_id: RequestId = None
    origin: str | None = Field(default=None, description="Lists only the widgets of this origin.")
    backend_id: str | None = Field(default=None, description="Lists only the widgets of this backend.")


class GetWidgetSchemaCommand(Model):
    command: Literal["get_widget_schema"]
    request_id: RequestId = None
    origin: str | None = Field(default=None, description="The origin of the widget.")
    widget_id: str = Field(description="The widget type id.")


class GetWidgetsSchemaCommand(Model):
    command: Literal["get_widgets_schema"]
    request_id: RequestId = None


class GetParamOptionsCommand(Model):
    command: Literal["get_params_options"]
    request_id: RequestId = None
    param_options_queries: BridgePayloadList = Field(
        default_factory=list,
        description="The lookups to make. Each has the origin, the widget id, the parameter name and the data arguments.",
    )


class ReadWidgetCommand(Model):
    command: Literal["read_widget"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    widget_uuid: WidgetUuid = None
    widget_id: WidgetIdFallback = None


class CreateWidgetCommand(Model):
    command: Literal["create_widget"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    backend_name: str = Field(
        validation_alias=AliasChoices("backend_name", "origin"),
        description="The name of the backend that offers the widget, which is the origin of the widget.",
    )
    widget_id: str = Field(description="The widget type id.")
    config: WorkspaceWidgetConfig | None = Field(
        default=None, description="The data arguments and the interface arguments of the new widget."
    )
    dry_run: bool | None = Field(default=None, description="Validates and previews the change without making it.")


class UpdateWidgetCommand(Model):
    command: Literal["update_widget"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    widget_uuid: WidgetUuid = None
    widget_id: WidgetIdFallback = None
    config: WorkspaceWidgetConfig = Field(description="The new data arguments and interface arguments of the widget.")
    dry_run: bool | None = Field(default=None, description="Validates and previews the change without making it.")


class DeleteWidgetCommand(Model):
    command: Literal["delete_widget"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    widget_uuid: WidgetUuid = None
    widget_id: WidgetIdFallback = None


class ManageDashboardCommand(Model):
    command: Literal["manage_dashboard"]
    request_id: RequestId = None
    operation: DashboardOperation = Field(description="What to do with the dashboard.")
    dashboard_id: DashboardId = None
    name: str | None = Field(default=None, description="The dashboard's name. Create and update need it.")
    activate: Activate = None


class NavigateWorkspaceCommand(Model):
    command: Literal["navigate_workspace"]
    request_id: RequestId = None
    operation: WorkspaceNavigationOperation = Field(description="Whether to move to a dashboard or to an inner tab.")
    dashboard_id: DashboardId = None
    tab_id: str | None = Field(default=None, description="The inner tab to move to. The operation tab needs it.")


class UpdateDashboardLayoutCommand(Model):
    command: Literal["update_dashboard_layout"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    widget_uuid: WidgetUuid = None
    widget_id: WidgetIdFallback = None
    tab_id: str | None = Field(default=None, description="The inner tab that the widget moves to.")
    x: float = Field(description="The column of the widget's left edge on the dashboard grid.")
    y: float = Field(description="The row of the widget's top edge on the dashboard grid.")
    w: float = Field(description="The widget's width in grid columns.")
    h: float = Field(description="The widget's height in grid rows.")
    min_w: float | None = Field(default=None, description="The smallest width that the user may give the widget.")
    min_h: float | None = Field(default=None, description="The smallest height that the user may give the widget.")
    max_w: float | None = Field(default=None, description="The largest width that the user may give the widget.")
    max_h: float | None = Field(default=None, description="The largest height that the user may give the widget.")


class ManageNavigationBarCommand(Model):
    command: Literal["manage_navigation_bar"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    operation: NavigationOperation = Field(description="What to do with the navigation tabs.")
    tabs: list[dict[str, Any]] = Field(
        default_factory=list, description="The tabs to create, add or remove, each an object with a name."
    )
    rename_map: dict[str, str] = Field(
        default_factory=dict, description="The new name of each tab to rename, by the id of the tab."
    )


class AddGenerativeWidgetCommand(Model):
    command: Literal["add_generative_widget"]
    request_id: RequestId = None
    dashboard_id: DashboardId = None
    widget_type: GenerativeWidgetType = Field(description="Whether the widget is a note, which is markdown, or HTML.")
    data: str | None = Field(default=None, description="The content of the widget, as text or HTML.")
    name: str | None = Field(default=None, description="The name of the new widget.")
    description: str | None = Field(default=None, description="A short description of the new widget.")
    inner_tab: str | None = Field(default=None, description="An existing inner tab to place the widget on.")


class AssignTasksToAgentsCommand(Model):
    command: Literal["assign_tasks_to_agents"]
    request_id: RequestId = None
    task_requests: BridgePayloadList = Field(
        default_factory=list,
        description=(
            "The tasks to assign. Each has an id, a description, the URL of the agent's holder and the id of the agent."
        ),
    )


class GetSkillContentCommand(Model):
    command: Literal["get_skill_content"]
    request_id: RequestId = None
    slug: str = Field(description="The slug of the skill.")
    reason: str | None = Field(default=None, description="Why the skill is loaded.")


class GetWorkspaceSnapshotCommand(Model):
    command: Literal["get_workspace_snapshot"]
    request_id: RequestId = None


class BackendEndpointHeader(Model):
    key: str = Field(description="The name of the header or of the query parameter.")
    value: str = Field(description="The value that the backend's endpoints receive.")
    location: EndpointHeaderLocation = Field(
        default="headers", description="Whether it goes in the headers or in the query."
    )


class NavigationTabInput(Model):
    name: str

    @field_validator("name")
    @classmethod
    def _name_must_be_non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must not be blank")
        return value


class TaskRequest(Model):
    id: str = Field(description="The id that identifies the task.")
    description: str = Field(description="What the agent is to do.")
    assigned_holder_url: str = Field(
        description="The address of the agent holder that serves the agent. Take it from get_workspace_snapshot.",
    )
    assigned_agent_id: str = Field(
        description="The id of the agent that does the task. Take it from get_workspace_snapshot.",
    )


class ManageBackendsCommand(Model):
    command: Literal["manage_backends"]
    request_id: RequestId = None
    operation: BackendsOperation = Field(description="What to do with the backends.")
    backend_id: str | None = Field(default=None, description="The backend to update, refresh or remove.")
    name: str | None = Field(default=None, description="The name of the backend.")
    url: str | None = Field(default=None, description="The base URL of the backend.")
    endpoint_headers: list[BackendEndpointHeader] | None = Field(
        default=None, description="Headers or query parameters that the backend's endpoints receive."
    )
    validate_widgets: bool | None = Field(
        default=None, description="For add: whether to check that the backend's widgets load. It does by default."
    )


class ManageAppsCommand(Model):
    command: Literal["manage_apps"]
    request_id: RequestId = None
    operation: AppsOperation = Field(description="What to do with the apps.")
    backend_id: str | None = Field(default=None, description="For list: only the apps of this backend.")
    app_name: str | None = Field(
        default=None, description="The app to read or instantiate. The template id can name it instead."
    )
    template_id: str | None = Field(default=None, description="The template of the app, as an alternative to its name.")
    dashboard_name: str | None = Field(default=None, description="For instantiate: the name of the new dashboard.")
    activate: Activate = None


type WorkspaceCommand = Annotated[
    GetWidgetDataCommand
    | ListAvailableWidgetsCommand
    | GetWidgetSchemaCommand
    | GetWidgetsSchemaCommand
    | GetParamOptionsCommand
    | ReadWidgetCommand
    | CreateWidgetCommand
    | UpdateWidgetCommand
    | DeleteWidgetCommand
    | ManageDashboardCommand
    | UpdateDashboardLayoutCommand
    | NavigateWorkspaceCommand
    | ManageNavigationBarCommand
    | AddGenerativeWidgetCommand
    | AssignTasksToAgentsCommand
    | GetSkillContentCommand
    | GetWorkspaceSnapshotCommand
    | ManageBackendsCommand
    | ManageAppsCommand,
    Field(discriminator="command"),
]


class WorkspaceCommandResult(Model):
    ok: bool
    command: str
    request_id: str | None = None
    message: str
    data: Any | None = None
    error: BridgeError | None = None
    warnings: list[str] = Field(default_factory=list)


class BrowserCommandResultMessage(Model):
    type: Literal["command_result"]
    result: WorkspaceCommandResult


class BrowserPing(Model):
    type: Literal["ping"]


class BrowserSessionContextChangedMessage(Model):
    type: Literal["session_context_changed"]
    session: BrowserSessionContext


type BrowserMessage = Annotated[
    BrowserCommandResultMessage | BrowserPing | BrowserSessionContextChangedMessage,
    Field(discriminator="type"),
]


class SessionReadyEvent(Model):
    type: Literal["session_ready"]
    session: BrowserSession


class CommandRequestEvent(Model):
    type: Literal["command_request"]
    command: WorkspaceCommand


class ErrorEvent(Model):
    type: Literal["error"]
    error: BridgeError


class PongEvent(Model):
    type: Literal["pong"]


workspace_command_adapter: TypeAdapter[WorkspaceCommand] = TypeAdapter(WorkspaceCommand)
browser_message_adapter: TypeAdapter[BrowserMessage] = TypeAdapter(BrowserMessage)
