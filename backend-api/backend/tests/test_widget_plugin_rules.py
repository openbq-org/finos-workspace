import json
import os
from pathlib import Path

import pytest

from api.widget_plugins import csp, proxy as proxy_rules
from api.widget_plugins.discovery import action_icon_problem, inspect_version, resolve_served_file, scan
from api.widget_plugins.manifest import (
    ACTION_ICON_TAGS,
    ACTION_ICON_VALUES,
    ACTION_ICONS,
    MAX_ACTION_ICON_BYTES,
    Manifest,
)
from api.widget_plugins.schema_lint import lint_fragment, lint_settings_schema
from tests.fixtures.widget_plugins import digest_of, manifest, write_package

CASES = json.loads((Path(__file__).resolve().parents[3] / "frontend/src/plugins/csp-cases.json").read_text())


def _scan(root: Path, **kwargs):
    return scan(str(root), **kwargs)


class TestCspValidator:
    @pytest.mark.parametrize("case", CASES["author"], ids=lambda c: c["name"])
    def test_author_cases(self, case):
        check = csp.check_policy(case["policy"])
        assert check.ok is case["ok"], check.errors
        if "needs" in case:
            assert check.needs == set(case["needs"])

    @pytest.mark.parametrize("case", CASES["override"], ids=lambda c: c["name"])
    def test_override_cases(self, case):
        check = csp.check_policy(case["policy"], confirmations=set(case["confirmations"]), override=True)
        assert check.ok is case["ok"], check.errors

    @pytest.mark.parametrize("case", CASES["network"], ids=lambda c: c["name"])
    def test_server_network_cases(self, case):
        check = proxy_rules.check_network(
            case["network"],
            confirmations=set(case.get("confirmations", [])),
            override=case.get("override", False),
            backend=case.get("backend", False),
        )
        assert check.ok is case["ok"], check.errors

    @pytest.mark.parametrize("case", CASES["compose"], ids=lambda c: c["name"])
    def test_compose_cases(self, case):
        assert csp.compose(case["policy"]) == case["effective"]

    def test_an_override_replaces_a_directive_and_keeps_the_others(self):
        declared = {"connect-src": ["https://api.example.com"], "img-src": ["https://t.example.com"]}
        approved = csp.approved_policy(declared, {"connect-src": []})
        assert approved == {"connect-src": [], "img-src": ["https://t.example.com"]}
        assert csp.compose(approved)["connect-src"] == ["'none'"]

    def test_narrowing_only_removes(self):
        policy = {"img-src": ["https://a.example.com", "https://b.example.com"]}
        assert csp.narrow(policy, {"img-src": ["https://b.example.com", "https://c.example.com"]}) == {
            "img-src": ["https://b.example.com"]
        }

    def test_risk_and_egress(self):
        policy = {"connect-src": ["https://api.example.com"], "img-src": ["data:"]}
        assert csp.directive_risk("connect-src", policy["connect-src"]) == "high"
        assert csp.directive_risk("img-src", ["data:"]) == "none"
        assert csp.directive_risk("script-src", ["https://cdn.example.com"]) == "critical"
        assert csp.hosts(policy) == ["api.example.com"]


class TestSchemaLint:
    def test_a_closed_fragment_passes(self):
        assert lint_fragment(manifest()["contributes"]["widgets"][0]["handles"][0]["definition"]) == []

    @pytest.mark.parametrize(
        ("fragment", "problem"),
        [
            ({"type": "object", "properties": {}}, "additionalProperties"),
            ({"type": "object", "additionalProperties": False, "properties": {"a": {"type": "string"}}}, "maxLength"),
            (
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"a": {"type": "array", "items": {"type": "boolean"}}},
                },
                "maxItems",
            ),
            ({"type": "object", "additionalProperties": False, "patternProperties": {}}, "not allowed"),
            (
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"a": {"$ref": "https://example.com/s.json"}},
                },
                "$ref",
            ),
            (
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"a": {"type": "string", "pattern": "(a)\\1"}},
                },
                "backreferences",
            ),
            ({"type": "string", "maxLength": 3}, "root"),
        ],
    )
    def test_open_or_unbounded_fragments_fail(self, fragment, problem):
        problems = lint_fragment(fragment)
        assert any(problem in p for p in problems), problems

    def test_depth_is_capped(self):
        node: dict = {"type": "boolean"}
        for _ in range(10):
            node = {"type": "object", "additionalProperties": False, "properties": {"a": node}}
        assert any("deeper" in p for p in lint_fragment(node))

    def test_settings_schemas_are_flat_forms(self):
        assert lint_settings_schema({"type": "object", "properties": {"size": {"type": "integer", "minimum": 1}}}) == []
        assert lint_settings_schema({"type": "object", "properties": {"nested": {"type": "object"}}})


class TestManifest:
    def test_a_valid_manifest(self):
        Manifest.model_validate(manifest())

    @pytest.mark.parametrize(
        "change",
        [
            {"unknown": 1},
            {"host": {"api": 2, "afm": "0.11"}},
            {"host": {"api": 1, "afm": "0.9"}},
            {"id": "Bad_Id"},
            {"version": "1.0"},
            {"csp": {"connect-src": ["'self'"]}},
            {"cspNotes": {"connect-src": "not in csp"}},
            {"secrets": [{"name": "key", "purpose": "x"}]},
            {"identity": "pseudonymous"},
            {"signatures": ["x"]},
            {"entry": {"module": "../escape.js"}},
            {"entry": {"module": "backend/entry.js"}},
            {"icon": "icon.png"},
        ],
        ids=str,
    )
    def test_invalid_manifests(self, change):
        with pytest.raises(ValueError):
            Manifest.model_validate({**manifest(), **change})

    @pytest.mark.parametrize(
        "widget_change",
        [
            {"handles": [{"type": "markdown"}]},
            {"handles": []},
            {"permissions": ["core:everything"]},
            {"permissions": ["core:proxy:call"]},
            {"permissions": ["core:export:provide"], "exports": ["csv"]},
            {"model": {"traits": {"rows": {"bind": "data", "access": "readwrite"}}}},
            {"model": {"traits": {"rows": {"bind": "window"}}}},
            {"model": {"traits": {"tiles": {"bind": "adminSettings:tiles", "access": "readwrite"}}}},
            {"permissions": ["core:config:edit"]},
            {"handles": [{"type": "t1", "definition": {"type": "object"}}]},
        ],
        ids=str,
    )
    def test_invalid_widgets(self, widget_change):
        data = manifest()
        data["contributes"]["widgets"][0].update(widget_change)
        with pytest.raises(ValueError):
            Manifest.model_validate(data)

    @pytest.mark.parametrize(
        "traits",
        [
            {"zoom": {"bind": "config:zoom", "access": "readwrite"}},
            {"settings": {"bind": "config", "access": "readwrite"}},
        ],
        ids=str,
    )
    def test_a_module_may_write_its_config(self, traits):
        data = manifest()
        data["contributes"]["widgets"][0].update(
            {"model": {"traits": traits}, "permissions": ["core:data:read", "core:config:write"]}
        )
        Manifest.model_validate(data)


HEATMAP_SETTINGS = {
    "schema": {"properties": {"heatmap": {"type": "boolean"}, "title": {"type": "string", "maxLength": 40}}},
    "defaults": {"heatmap": False},
}


ARTIFACT_DATA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["rowData"],
    "properties": {
        "rowData": {
            "type": "array",
            "maxItems": 1000,
            "items": {
                "type": "object",
                "additionalProperties": {"type": ["string", "number", "boolean", "null"], "maxLength": 500},
            },
        }
    },
}


def _with_actions(actions, permissions=("core:data:read", "core:ui:button", "core:ui:menu"), settings=None):
    data = manifest()
    data["contributes"]["widgets"][0].update(
        {"actions": actions, "permissions": list(permissions), "settings": settings or HEATMAP_SETTINGS}
    )
    return data


def _action(action_id="zoom", placement="navbar", **extra):
    return {"id": action_id, "label": "Zoom in", "icon": "zoom-in", "placement": placement, **extra}


class TestCardActions:
    def test_a_widget_declares_buttons_and_menu_items(self):
        parsed = Manifest.model_validate(
            _with_actions(
                [
                    _action(),
                    _action("heatmap", toggles="heatmap"),
                    _action("reset", "menu"),
                ]
            )
        )
        actions = parsed.contributes.widgets[0].actions
        assert [(a.id, a.placement, a.toggles) for a in actions] == [
            ("zoom", "navbar", None),
            ("heatmap", "navbar", "heatmap"),
            ("reset", "menu", None),
        ]

    def test_a_widget_without_actions_needs_neither_permission(self):
        Manifest.model_validate(_with_actions([], permissions=["core:data:read"]))

    @pytest.mark.parametrize(
        ("actions", "permissions"),
        [
            ([_action()], ["core:data:read"]),
            ([_action("reset", "menu")], ["core:data:read"]),
            ([], ["core:data:read", "core:ui:button"]),
            ([], ["core:data:read", "core:ui:menu"]),
            ([_action("reset", "menu")], ["core:data:read", "core:ui:menu", "core:ui:button"]),
            ([_action(icon="skull")], ["core:data:read", "core:ui:button"]),
            ([_action(icon="bell-icon")], ["core:data:read", "core:ui:button"]),
            ([_action(), _action()], ["core:data:read", "core:ui:button"]),
            ([_action(label="")], ["core:data:read", "core:ui:button"]),
            ([_action(label="x" * 41)], ["core:data:read", "core:ui:button"]),
            ([_action(action_id="Zoom")], ["core:data:read", "core:ui:button"]),
            ([_action(placement="toolbar")], ["core:data:read", "core:ui:button"]),
            ([_action(html="<b>x</b>")], ["core:data:read", "core:ui:button"]),
            ([_action(f"a{i}") for i in range(4)], ["core:data:read", "core:ui:button"]),
            ([_action(f"a{i}", "menu") for i in range(9)], ["core:data:read", "core:ui:menu"]),
            ([_action("reset", "menu", toggles="heatmap")], ["core:data:read", "core:ui:menu"]),
            ([_action(toggles="title")], ["core:data:read", "core:ui:button"]),
            ([_action(toggles="missing")], ["core:data:read", "core:ui:button"]),
        ],
        ids=str,
    )
    def test_invalid_actions(self, actions, permissions):
        with pytest.raises(ValueError):
            Manifest.model_validate(_with_actions(actions, permissions=permissions))

    def test_a_toggle_needs_a_declared_setting(self):
        data = _with_actions([_action(toggles="heatmap")], permissions=["core:data:read", "core:ui:button"])
        del data["contributes"]["widgets"][0]["settings"]
        with pytest.raises(ValueError):
            Manifest.model_validate(data)

    def test_a_widget_adds_a_widget_of_its_plugin_after_an_action(self):
        data = _with_actions(
            [_action("freeze", "menu")],
            permissions=["core:data:read", "core:ui:menu", "core:dashboard:add-widget"],
        )
        table = {**data["contributes"]["widgets"][0], "id": "table", "actions": [], "settings": None}
        table.update(
            {
                "permissions": ["core:data:read"],
                "handles": [{"type": "test_table"}],
                "artifact": {"description": "Rows in a table", "data": ARTIFACT_DATA},
            }
        )
        data["contributes"]["widgets"].append(table)
        Manifest.model_validate(data)

    def test_adding_a_widget_needs_an_action(self):
        data = _with_actions([], permissions=["core:data:read", "core:dashboard:add-widget"])
        data["contributes"]["widgets"][0]["artifact"] = {"description": "Rows", "data": ARTIFACT_DATA}
        with pytest.raises(ValueError, match="an action that toggles nothing"):
            Manifest.model_validate(data)

    def test_a_toggle_does_not_count_as_an_action_that_adds_a_widget(self):
        data = _with_actions(
            [_action("heat", toggles="heatmap")],
            permissions=["core:data:read", "core:ui:button", "core:dashboard:add-widget"],
        )
        data["contributes"]["widgets"][0]["artifact"] = {"description": "Rows", "data": ARTIFACT_DATA}
        with pytest.raises(ValueError, match="an action that toggles nothing"):
            Manifest.model_validate(data)

    def test_adding_a_widget_needs_a_widget_that_takes_data(self):
        data = _with_actions(
            [_action("freeze", "menu")],
            permissions=["core:data:read", "core:ui:menu", "core:dashboard:add-widget"],
        )
        with pytest.raises(ValueError, match="has a widget with an artifact"):
            Manifest.model_validate(data)

    def test_an_action_may_use_an_svg_of_the_package(self):
        parsed = Manifest.model_validate(
            _with_actions([_action(icon="assets/zoom.svg")], permissions=["core:data:read", "core:ui:button"])
        )
        assert "assets/zoom.svg" in parsed.served_paths()

    @pytest.mark.parametrize("icon", ["zoom.svg", "assets/zoom.png", "assets/../plugin.json", "assets/a/b.svg"])
    def test_an_icon_path_is_an_svg_directly_under_assets(self, icon):
        with pytest.raises(ValueError, match="neither a host icon nor an SVG file"):
            Manifest.model_validate(_with_actions([_action(icon=icon)], permissions=["core:data:read", "core:ui:button"]))

    @pytest.mark.parametrize(
        "svg",
        [
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
            '<path d="M0 0h16v16z" fill="currentColor"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
            'stroke-width="1.5" stroke-linecap="round"><g transform="translate(1, 2) rotate(45)">'
            '<circle cx="8" cy="8" r="2" fill="#0af"/></g></svg>',
        ],
    )
    def test_a_clean_icon_passes(self, svg):
        assert action_icon_problem(svg) is None

    @pytest.mark.parametrize(
        ("svg", "problem"),
        [
            ('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "<script>"),
            ('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "onload"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>', "<foreignObject>"),
            (
                '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink">'
                '<use x:href="https://evil.example/a.svg#i"/></svg>',
                "<use>",
            ),
            ('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>', "<a>"),
            (
                '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/p)"/></svg>',
                "a value of fill",
            ),
            ('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="\\75 rl(https://e.example/p)"/></svg>', "fill"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><rect stroke="u\\72l(https://e.example/c)"/></svg>', "stroke"),
            (
                '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="image-set(\'https://e.example/m\' 1x)"/></svg>',
                "fill",
            ),
            ('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/></svg>', "a value of fill"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><rect id="root"/></svg>', "attribute id"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><rect mask="url(#m)"/></svg>', "attribute mask"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>', "<defs>"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><g transform="url(https://e.example/x)"/></svg>', "transform"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 url(https://e.example/x)"/></svg>', "a value of d"),
            ('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red"/></svg>', "style"),
            ('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>', "DOCTYPE or an entity"),
            ("<html/>", "not an <svg>"),
            ("<svg", "not well-formed"),
        ],
        ids=lambda v: v[:40] if isinstance(v, str) else v,
    )
    def test_an_unsafe_icon_is_refused(self, svg, problem):
        assert problem in (action_icon_problem(svg) or "")

    def test_a_package_with_an_unsafe_icon_is_blocked(self, tmp_path):
        data = _with_actions([_action(icon="assets/zoom.svg")], permissions=["core:data:read", "core:ui:button"])
        data["version"] = "1.0.0"
        files = {
            "entry.js": b"export default {}\n",
            "entry.css": b"body{}\n",
            "assets/zoom.svg": b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        }
        write_package(tmp_path, data, files=files)
        [found] = _scan(tmp_path).versions
        assert any("assets/zoom.svg: the action icon" in e for e in found.errors)

    def test_a_package_without_its_icon_is_blocked(self, tmp_path):
        data = _with_actions([_action(icon="assets/zoom.svg")], permissions=["core:data:read", "core:ui:button"])
        write_package(tmp_path, data)
        [found] = _scan(tmp_path).versions
        assert "assets/zoom.svg: named by the manifest but missing" in found.errors

    def test_the_host_and_the_web_app_allow_the_same_svg(self):
        spec = json.loads((Path(__file__).resolve().parents[3] / "frontend/src/plugins/action-icon-svg.json").read_text())
        assert set(spec["tags"]) == ACTION_ICON_TAGS
        assert spec["values"] == ACTION_ICON_VALUES
        assert spec["maxBytes"] == MAX_ACTION_ICON_BYTES

    def test_the_host_and_the_web_app_offer_the_same_icons(self):
        icons = json.loads((Path(__file__).resolve().parents[3] / "frontend/src/plugins/action-icons.json").read_text())
        assert set(icons) == ACTION_ICONS


class TestDiscovery:
    def test_a_valid_package(self, tmp_path):
        directory = write_package(tmp_path)
        result = _scan(tmp_path)
        assert result.error is None
        [found] = result.versions
        assert found.errors == []
        assert found.block_reason is None
        assert found.digest == digest_of(directory)
        assert set(found.served_files()) == {"entry.js", "entry.css"}

    def test_a_version_whose_directory_is_gone_is_reported_and_not_raised(self, tmp_path):
        (tmp_path / "test-chart").mkdir()
        found = inspect_version(
            tmp_path, "test-chart", "1.0.0", pins={}, require_pins=False, max_files=10, max_bytes=1000, development=True
        )
        assert found.errors == ["test-chart/1.0.0 is missing"]

    def test_the_directory_must_be_set_and_exist(self, tmp_path):
        assert scan(None).error
        assert scan(str(tmp_path / "missing")).error

    def test_a_checksum_mismatch_blocks(self, tmp_path):
        write_package(tmp_path, checksum="sha256-" + "B" * 43)
        [found] = _scan(tmp_path).versions
        assert any("checksum" in e for e in found.errors)
        assert found.block_reason == "checksum"

    def test_files_changed_after_writing_the_checksum_block(self, tmp_path):
        directory = write_package(tmp_path)
        (directory / "entry.js").write_bytes(b"export default {};\n")
        [found] = _scan(tmp_path).versions
        assert any("checksum" in e for e in found.errors)

    def test_id_and_version_must_match_the_directories(self, tmp_path):
        directory = write_package(tmp_path)
        directory.rename(tmp_path / "test-chart" / "1.0.1")
        [found] = _scan(tmp_path).versions
        assert any("version" in e for e in found.errors)
        assert found.block_reason == "manifest"

    def test_symbolic_links_are_refused(self, tmp_path):
        directory = write_package(tmp_path)
        (directory / "assets").mkdir()
        os.symlink("/etc/hosts", directory / "assets" / "hosts")
        [found] = _scan(tmp_path).versions
        assert any("symbolic" in e for e in found.errors)
        assert found.block_reason == "files"

    def test_a_linked_plugin_directory_is_not_read(self, tmp_path):
        real = tmp_path / "elsewhere"
        write_package(real)
        root = tmp_path / "plugins"
        root.mkdir()
        os.symlink(real / "test-chart", root / "test-chart")
        result = _scan(root)
        assert result.versions == []
        assert result.rejected

    def test_caps(self, tmp_path):
        write_package(tmp_path)
        [found] = _scan(tmp_path, max_files=2).versions
        assert any("more than 2 files" in e for e in found.errors)
        [found] = _scan(tmp_path, max_bytes=10).versions
        assert any("larger than" in e for e in found.errors)

    def test_odd_names_are_rejected(self, tmp_path):
        (tmp_path / "Not-An-Id").mkdir()
        (tmp_path / "ok-id").mkdir()
        (tmp_path / "ok-id" / "latest").mkdir()
        result = _scan(tmp_path)
        assert result.versions == []
        assert len(result.rejected) == 2

    def test_pins(self, tmp_path):
        directory = write_package(tmp_path)
        digest = digest_of(directory)
        [found] = _scan(tmp_path, pins={"test-chart@1.0.0": digest}).versions
        assert found.pin_status == "pinned" and found.errors == []
        [found] = _scan(tmp_path, pins={"test-chart@1.0.0": "sha256-" + "C" * 43}).versions
        assert found.pin_status == "mismatch" and found.errors
        assert found.block_reason == "pin"
        [found] = _scan(tmp_path, require_pins=True).versions
        assert found.pin_status == "unpinned" and found.errors
        assert found.block_reason == "pin"

    def test_named_files_must_exist(self, tmp_path):
        write_package(tmp_path, files={"entry.js": b"export default {};"})
        [found] = _scan(tmp_path).versions
        assert any("entry.css" in e for e in found.errors)

    def test_warnings_do_not_block(self, tmp_path):
        write_package(
            tmp_path,
            files={
                "entry.js": b'import x from "https://cdn.example.com/x.js"; eval("1");',
                "entry.css": b"",
            },
        )
        [found] = _scan(tmp_path).versions
        assert found.errors == []
        assert len(found.warnings) == 2

    def test_backend_files_are_never_served(self, tmp_path):
        write_package(
            tmp_path,
            files={
                "entry.js": b"export default {};",
                "entry.css": b"",
                "backend/main.py": b"",
                "assets/icon.svg": b"<svg/>",
            },
        )
        [found] = _scan(tmp_path).versions
        assert set(found.served_files()) == {"entry.js", "entry.css", "assets/icon.svg"}

    def test_resolving_a_served_file_stays_inside_the_version(self, tmp_path):
        write_package(tmp_path)
        assert resolve_served_file(str(tmp_path), "test-chart/1.0.0", "entry.js")
        assert resolve_served_file(str(tmp_path), "test-chart/1.0.0", "../1.0.0/entry.js") is None
        assert resolve_served_file(str(tmp_path), "test-chart/1.0.0", "plugin.json/../entry.js") is None
        assert resolve_served_file(str(tmp_path), "../outside", "entry.js") is None

    def test_inspecting_is_read_only(self, tmp_path):
        directory = write_package(tmp_path)
        before = {p: p.stat().st_mtime_ns for p in directory.rglob("*")}
        inspect_version(tmp_path, "test-chart", "1.0.0", pins={}, require_pins=False, max_files=200, max_bytes=10**8)
        assert before == {p: p.stat().st_mtime_ns for p in directory.rglob("*")}
