---
title: Widget Parameters
uri: workspace://specs/widget-parameters
use_when: You are defining widget params (text, number, boolean, date, endpoint dropdowns) and need the right type and option-source choice.
language_specific: false
related:
  - workspace://specs/widgets-json
  - workspace://specs/apps-json
  - workspace://specs/widget-types
---

# Widget Parameters

Widget controls live under a widget's `params` array in `widgets.json`. The right `type` is the one that **matches the shape of the value**, not the easiest to implement.

## Fields

A param accepts these keys and no others; `paramName` and `type` are required, and every param should have a `label`, a `description` and a sensible `value`:

<!-- generated:param-fields -->
| Field | Param types | Value | Notes |
|---|---|---|---|
| `type` | all | `text`, `tabs`, `date`, `number`, `boolean`, `button`, `endpoint`, `form` | The control the param shows |
| `paramName` | all | text, at most 128 characters | The name the value is sent under: a query name, a header name or a body key. Unique in the widget; a `{paramName}` placeholder in the endpoint takes the value instead. For `form`: A name for the form; it is not sent |
| `label` | all | text, at most 200 characters | The control's label; the paramName by default |
| `description` | all | text, at most 4,000 characters | Help shown on hover, which the AI Agent also reads |
| `show` | all | `true` or `false` | False hides the control; the value is still sent, as when a parameter group or another widget supplies it |
| `row` | all | whole number, 0 to 31 | The row of the parameter bar the control is placed in |
| `roles` | all but `form` | list of `fileSelector`, at most 1 | `fileSelector`: the param picks the file the widget shows, at most one per widget |
| `placeholder` | all but `form` | text, at most 200 characters | Shown in the control while it is empty |
| `style` | all but `form` | object | `popupWidth`: the width of a dropdown's list, in pixels |
| `options` | all but `form` | list of object, at most 1,000 | The choices of a dropdown, as `{ label, value, extraInfo }` |
| `multiSelect` | all but `form` | `true` or `false` | Several values can be chosen; sent joined with commas, or as a list in a body |
| `in` | all but `form` | `query`, `header`, `body` | Where the value goes: `query` (the default), `header` or `body` (which needs the method POST). A param in a path placeholder declares none |
| `value` | all but `form` | depends on `type` | The default value. For `date`: The default: a date, `YYYY-MM-DD`, or `$currentDate` with a modifier such as `$currentDate-1M`. For `number`: The default: a number, or a string of digits. For `endpoint`: The default: an option's value, or a list of them for multiSelect (or a comma-separated string) |
| `multiple` | `text` | `true` or `false` | Several values can be entered, sent like multiSelect |
| `language` | `text` | `sql`, `javascript`, `python`, `json`, `html`, `css`, `markdown`, `xml`, `text` | The value is code in this language, edited in a code editor |
| `bodyRoot` | `text` | `true` or `false` | With `in: "body"`: the value is a JSON object whose keys go at the top of the body instead of under the param's name, for a backend that takes a client's request as the whole body |
| `optionsEndpoint` | `endpoint` | text, at most 2,048 characters | A path or an absolute URL with no `?` and no `#`, which answers with the choices as a list of strings or `{ label, value, extraInfo }` |
| `optionsMethod` | `endpoint` | `GET`, `POST` | How the options are requested: GET (the default) or POST |
| `optionsParams` | `endpoint` | object | Values for the options request: a `{name}` placeholder of optionsEndpoint takes one, the rest go in the query (GET) or a JSON body (POST). `$name` is the current value of the param `name` |
| `endpoint` | `form` | text, at most 2,048 characters | A path or an absolute URL with no `?` and no `#`, which receives the form's inputs as a JSON body; `{name}` takes an input's or a param's value |
| `method` | `form` | `POST`, `PUT` | How the form is sent: POST (the default) or PUT |
| `inputParams` | `form` | list of object, at most 32 | The form's fields, each like a param, with no `in` |
<!-- /generated:param-fields -->

`paramName` is unique in a widget: storage and parameter groups key on it.

## Where a value goes

- **The path.** A param whose name is a `{name}` placeholder in the widget's `endpoint` fills it, encoded as one path segment, and is sent nowhere else, so it declares no `in`. It takes one value, so it is not `multiSelect` or `multiple`, and the request waits until it has one.
- **`in: "query"`** (the default): `name=value` in the query.
- **`in: "header"`**: a header named `paramName`. The rules are below.
- **`in: "body"`**: a key of the JSON body. It needs `"method": "POST"` on the widget; the body is one flat object.
- An `iframe` widget's params go in the query or the path only, and a form's inputs go in the form's own body, so neither declares `in`.

How a value is written:

| Param type | In the query, a header or the path | In the body |
|---|---|---|
| `text`, `tabs` | the string | a JSON string |
| `number` | the decimal string | a JSON number |
| `boolean` | `true` or `false` | a JSON boolean |
| `date` | the date, `YYYY-MM-DD`, after `$currentDate` modifiers | a JSON string in the same format |
| `endpoint` | the option's value as a string | the option's value |
| `multiSelect`, `multiple` | the values joined with commas | a JSON array; a default written as a comma-separated string is split on commas |

An empty value is not sent; `0` and `false` are. Credentials do not belong in params, whose values are saved with dashboards and shown in the UI: they belong to the backend connection.

### Header params

<!-- generated:header-names -->
- The name matches `` ^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$ ``: 1 to 64 characters of the HTTP token set.
- Not a name a browser forbids page script to set, which `fetch` drops silently: `accept-charset`, `accept-encoding`, `access-control-request-headers`, `access-control-request-method`, `connection`, `content-length`, `cookie`, `date`, `dnt`, `expect`, `host`, `keep-alive`, `origin`, `referer`, `set-cookie`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `via`, or a name that starts with `proxy-`, `sec-` (compared without case).
- Not a name FINOS Workspace sets or reserves: `authorization`, `content-type`, `accept`, `x-microsoft-id-token`, `x-okta-id-token`, `x-workspace-identity`, `x-workspace-user`.
- Not a header the backend connection's credentials use; checked when the backend is connected.
- The value matches `^[\x20-\x7E]{0,1024}$`: printable ASCII, at most 1,024 characters. Any other value stops the request and the param is shown as invalid.
<!-- /generated:header-names -->

## Type cheatsheet

Pick the right type before defaulting to `text` with options. Wrong type → clunky UX even though it "works".

| Param shape | Correct `type` | Wrong choice |
|-------------|----------------|--------------|
| Yes/no flag | `boolean` (renders as toggle) | `text` with `[{label:"Yes",value:"true"},{label:"No",value:"false"}]` |
| Free-form integer (limit, days, count) | `number` | `text` with hardcoded options |
| Free-form text (search query) | `text` (no `options`) | `text` with curated options |
| Date or date range | `date` with `$currentDate` modifiers | `text` with hardcoded date strings |
| Curated short list (3–6 fixed values) | `text` with `options` | OK — this is the intended use |
| A choice among values the backend knows (teams, accounts, regions) | `endpoint` with `optionsEndpoint` | `text` (forces the user to type the exact value) |
| Dropdown that depends on another param | `endpoint` with `optionsParams: {key: "$other"}` | static `text` options |

## Type examples

### `text`

```json
{ "paramName": "query", "type": "text", "label": "Search Query",
  "description": "Enter search term", "value": "" }
```

### `number`

```json
{ "paramName": "limit", "type": "number", "label": "Limit",
  "description": "Maximum rows to return", "value": 10 }
```

### `boolean`

```json
{ "paramName": "include_archived", "type": "boolean", "label": "Include Archived",
  "description": "Include items that have been archived", "value": false }
```

### `date`

```json
{ "paramName": "start_date", "type": "date", "label": "Start Date",
  "description": "Window start", "value": "$currentDate-1M" }
```

Date modifiers: `$currentDate`, `$currentDate-1d`, `$currentDate-1w`, `$currentDate-1M`, `$currentDate-1y`. Avoid hardcoded date strings — they get stale.

### Static dropdown — `text` with `options`

```json
{ "paramName": "granularity", "type": "text", "label": "Granularity",
  "description": "How the period is divided", "value": "day",
  "options": [
    { "label": "Day",   "value": "day" },
    { "label": "Week",  "value": "week" },
    { "label": "Month", "value": "month" }
  ] }
```

### Dynamic dropdown — `endpoint`

```json
{ "paramName": "team", "type": "endpoint", "label": "Select Team",
  "description": "Choose a team",
  "optionsEndpoint": "/teams" }
```

The `optionsEndpoint` returns a JSON array of strings or `{ label, value }` objects. Its path follows the rules of `endpoint`: no `?` and no `#`.

Keep dropdown options simple. Use `{label, value}` for normal dropdowns; add `category` only when FINOS Workspace needs that category for grouping/search semantics. Avoid `extraInfo` unless the user explicitly wants an advanced/search-rich dropdown.

### Multi-select dimensions

For filters like years, geographies, countries, sectors, or business units:

```json
{ "paramName": "years", "type": "endpoint", "label": "Years",
  "description": "Reporting years to include",
  "optionsEndpoint": "/year_options",
  "multiSelect": true,
  "value": "2020,2021,2022,2023,2024" }
```

Prefer real individual choices over fake aggregate choices:

- Good: options `2020`, `2021`, `2022`, `2023`, `2024` with all selected by default.
- Avoid: a selectable `2020-2024` option unless it is a real domain value users should choose.
- Good: options `Portugal`, `Angola`, `Brazil`.
- Avoid: a selectable `All Geographies` option unless it is a real source row users should choose directly.

### Dependent dropdown — `optionsParams`

```json
{ "paramName": "city", "type": "endpoint", "label": "City",
  "description": "City within the selected country",
  "optionsEndpoint": "/cities",
  "optionsParams": { "country": "$country" } }
```

When the user changes the `country` param, the `city` dropdown re-fetches with `?country=...` appended.

An `optionsParams` value is a string, a number or a boolean. One that starts with `$` is the current value of the widget's param of that name, which must be declared; any other value is a literal. A `{name}` placeholder in `optionsEndpoint` takes `optionsParams[name]`. With `"optionsMethod": "POST"` the other values go in a JSON body instead of the query:

```json
{ "paramName": "team", "type": "endpoint", "label": "Team",
  "optionsEndpoint": "/teams/search", "optionsMethod": "POST",
  "optionsParams": { "active": true, "region": "$region" } }
```

## Hidden params

A param with `"show": false` is not shown but is still sent to the endpoint. Use it for a value that a parameter group or another widget supplies, so the widget does not offer a second control for the same thing:

```json
{ "paramName": "team", "type": "endpoint", "label": "Team",
  "optionsEndpoint": "/teams", "value": "platform", "show": false }
```

## What this spec does not cover

- The widget-level shape that contains `params` — see `workspace://specs/widgets-json`.
- App-level `groups[].type` choice (`param` vs `endpointParam`) — see `workspace://specs/apps-json`.
- Layout wiring and parameter groups — see `workspace://specs/layout-grid`.
