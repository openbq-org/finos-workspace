import base64
import hashlib
import json
import os
import re
import stat
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import ParseError, fromstring
from pydantic import ValidationError

from .manifest import (
    ACTION_ICON_ATTRIBUTES,
    ACTION_ICON_TAGS,
    ACTION_ICON_VALUES,
    MAX_ACTION_ICON_BYTES,
    PLUGIN_ID_PATTERN,
    VERSION_PATTERN,
    Manifest,
)

MANIFEST_FILE = "plugin.json"
MAX_MANIFEST_BYTES = 256 * 1024
MAX_SKILL_BYTES = 32 * 1024
_FILE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_REMOTE_IMPORT = re.compile(rb"""(?:\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)["'](?:https?:)?//""", re.IGNORECASE)
_DYNAMIC_CODE = re.compile(rb"\beval\s*\(|\bnew\s+Function\s*\(")


@dataclass
class FileInfo:
    size: int
    sha256: str


@dataclass
class DiscoveredVersion:
    plugin_id: str
    version: str
    path: str
    files: dict[str, FileInfo] = field(default_factory=dict)
    digest: str | None = None
    checksum: str | None = None
    declared_checksum: str | None = None
    manifest: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    pin_status: str = "unpinned"
    block_reason: str | None = None

    @property
    def blocked(self) -> bool:
        return bool(self.errors)

    def fail(self, reason: str, *messages: str) -> None:
        self.errors.extend(messages)
        self.block_reason = self.block_reason or reason

    def skill_hashes(self) -> dict[str, str]:
        skills = ((self.manifest or {}).get("contributes") or {}).get("skills") or []
        paths = {skill.get("file") for skill in skills if isinstance(skill, dict)}
        return {path: self.files[path].sha256 for path in sorted(p for p in paths if p in self.files)}

    def served_files(self) -> dict[str, dict[str, Any]]:
        if self.manifest is None:
            return {}
        entry = self.manifest.get("entry", {})
        served = {entry.get("module"), *entry.get("styles", [])}
        if self.manifest.get("icon"):
            served.add(self.manifest["icon"])
        served |= {p for p in self.files if p.startswith("assets/")}
        return {
            p: {"size": self.files[p].size, "sha256": self.files[p].sha256}
            for p in sorted(p for p in served if p in self.files)
        }


@dataclass
class ScanResult:
    versions: list[DiscoveredVersion] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)
    error: str | None = None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


_hash_cache: dict[str, tuple[int, int, str]] = {}


def cached_sha256(path: Path) -> str:
    info = path.stat()
    cached = _hash_cache.get(str(path))
    if cached and cached[0] == info.st_size and cached[1] == info.st_mtime_ns:
        return cached[2]
    digest = sha256_file(path)
    _hash_cache[str(path)] = (info.st_size, info.st_mtime_ns, digest)
    return digest


def listing_digest(files: dict[str, str]) -> str:
    lines = b"".join(f"{path}\0{files[path]}\n".encode() for path in sorted(files))
    raw = hashlib.sha256(lines).digest()
    return "sha256-" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def version_digest(files: dict[str, str]) -> str:
    return listing_digest(files)


def package_checksum(files: dict[str, str]) -> str:
    return listing_digest({p: h for p, h in files.items() if p != MANIFEST_FILE})


def _walk(root: Path, version: DiscoveredVersion, max_files: int, max_bytes: int, hasher: Callable[[Path], str]) -> None:
    total = 0
    stack = [(root, "")]
    while stack:
        directory, prefix = stack.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                relative = f"{prefix}{entry.name}"
                if not _FILE_NAME.fullmatch(entry.name) or entry.name in {".", ".."}:
                    version.fail("files", f"{relative}: a file name that is not allowed")
                    continue
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode):
                    version.fail("files", f"{relative}: symbolic links are not allowed")
                    continue
                if stat.S_ISDIR(info.st_mode):
                    stack.append((Path(entry.path), f"{relative}/"))
                    continue
                if not stat.S_ISREG(info.st_mode):
                    version.fail("files", f"{relative}: not a regular file")
                    continue
                if len(version.files) >= max_files:
                    version.fail("files", f"more than {max_files} files")
                    return
                total += info.st_size
                if total > max_bytes:
                    version.fail("files", f"larger than {max_bytes} bytes in total")
                    return
                version.files[relative] = FileInfo(
                    size=info.st_size,
                    sha256=hasher(Path(entry.path)),
                )


def _format_validation(error: ValidationError) -> list[str]:
    messages = []
    for issue in error.errors()[:20]:
        location = "/".join(str(p) for p in issue["loc"]) or "manifest"
        message = issue["msg"].removeprefix("Value error, ")
        messages.append(f"{location}: {message}")
    return messages


def _check_pin(found: DiscoveredVersion, pin: str | None, require_pins: bool) -> None:
    if pin is None:
        found.pin_status = "unpinned"
        if require_pins:
            found.fail("pin", "no pin, and WIDGET_PLUGINS_REQUIRE_PINS is on")
    elif pin == found.digest:
        found.pin_status = "pinned"
    else:
        found.pin_status = "mismatch"
        found.fail("pin", f"the version digest differs from its pin {pin}")


def _check_skill_file(found: DiscoveredVersion, version_dir: Path, path: str) -> None:
    info = found.files.get(path)
    if info is None:
        found.fail("manifest", f"{path}: named by a skill but missing")
    elif info.size > MAX_SKILL_BYTES:
        found.fail("manifest", f"{path}: a skill is at most {MAX_SKILL_BYTES} bytes")
    else:
        try:
            text = (version_dir / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            found.fail("manifest", f"{path}: a skill is UTF-8 text")
            return
        if not text.strip():
            found.fail("manifest", f"{path}: a skill is not empty")


def _element_problems(root: Any) -> Iterator[str]:
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1]
        if element is root and tag != "svg":
            yield "is not an <svg> element"
        if tag not in ACTION_ICON_TAGS:
            yield f"has the element <{tag}>, which an action icon cannot use"
        for name, value in element.attrib.items():
            local = name.rsplit("}", 1)[-1]
            if local not in ACTION_ICON_ATTRIBUTES:
                yield f"has the attribute {local} on <{tag}>, which an action icon cannot use"
            elif not re.fullmatch(ACTION_ICON_VALUES[local], value.strip()):
                yield f"has a value of {local} on <{tag}> that an action icon cannot use"


def action_icon_problem(text: str) -> str | None:
    try:
        root = fromstring(text, forbid_dtd=True)
    except DefusedXmlException:
        return "has a DOCTYPE or an entity"
    except ParseError as exc:
        return f"is not well-formed XML: {exc}"
    return next(_element_problems(root), None)


def _check_action_icon(found: DiscoveredVersion, version_dir: Path, path: str) -> None:
    info = found.files.get(path)
    if info is None:
        return
    if info.size > MAX_ACTION_ICON_BYTES:
        found.fail("manifest", f"{path}: an action icon is at most {MAX_ACTION_ICON_BYTES} bytes")
        return
    try:
        text = (version_dir / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        found.fail("manifest", f"{path}: an action icon is UTF-8 text")
        return
    problem = action_icon_problem(text)
    if problem:
        found.fail("manifest", f"{path}: the action icon {problem}")


def inspect_version(  # noqa: PLR0911, PLR0912
    root: Path,
    plugin_id: str,
    version_name: str,
    *,
    pins: dict[str, str],
    require_pins: bool,
    max_files: int,
    max_bytes: int,
    development: bool = False,
) -> DiscoveredVersion:
    found = DiscoveredVersion(plugin_id=plugin_id, version=version_name, path=f"{plugin_id}/{version_name}")
    version_dir = root / plugin_id / version_name
    if not version_dir.is_dir():
        found.fail("files", f"{found.path} is missing")
        return found
    _walk(version_dir, found, max_files, max_bytes, cached_sha256 if development else sha256_file)
    if found.errors:
        return found

    hashes = {path: info.sha256 for path, info in found.files.items()}
    found.digest = version_digest(hashes)
    found.checksum = package_checksum(hashes)

    if MANIFEST_FILE not in found.files:
        found.fail("manifest", f"{MANIFEST_FILE} is missing")
        return found
    if found.files[MANIFEST_FILE].size > MAX_MANIFEST_BYTES:
        found.fail("manifest", f"{MANIFEST_FILE} is larger than {MAX_MANIFEST_BYTES} bytes")
        return found
    try:
        raw = json.loads((version_dir / MANIFEST_FILE).read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        found.fail("manifest", f"{MANIFEST_FILE} is not valid JSON: {exc}")
        return found
    if not isinstance(raw, dict):
        found.fail("manifest", f"{MANIFEST_FILE} must be an object")
        return found
    found.manifest = raw
    found.declared_checksum = raw.get("checksum") if isinstance(raw.get("checksum"), str) else None

    try:
        manifest = Manifest.model_validate(raw)
    except ValidationError as exc:
        found.fail("manifest", *_format_validation(exc))
        return found

    if manifest.id != plugin_id:
        found.fail("manifest", f"the manifest id {manifest.id!r} differs from its directory")
    if manifest.version != version_name:
        found.fail("manifest", f"the manifest version {manifest.version!r} differs from its directory")
    if manifest.checksum != found.checksum:
        stale = (
            f"the files do not match the manifest's checksum (declared {manifest.checksum}, computed {found.checksum})"
        )
        if development:
            found.warnings.append(stale)
        else:
            found.fail("checksum", stale)
    for path in sorted(manifest.served_paths()):
        if path not in found.files:
            found.fail("manifest", f"{path}: named by the manifest but missing")
    for path in sorted(manifest.skill_paths()):
        _check_skill_file(found, version_dir, path)
    for path in sorted(manifest.action_icon_paths()):
        _check_action_icon(found, version_dir, path)
    if not development:
        _check_pin(found, pins.get(f"{plugin_id}@{version_name}"), require_pins)

    entry_path = version_dir / manifest.entry.module
    if manifest.entry.module in found.files:
        code = entry_path.read_bytes()
        script_src = (manifest.csp or {}).get("script-src", [])
        if _REMOTE_IMPORT.search(code):
            found.warnings.append(
                "the entry imports from a URL, which the frame cannot load unless the CSP allows that origin"
            )
        if _DYNAMIC_CODE.search(code) and "'unsafe-eval'" not in script_src:
            found.warnings.append(
                "the entry appears to use eval or new Function, which the frame blocks without 'unsafe-eval'"
            )
    return found


def scan(
    plugins_dir: str | None,
    *,
    pins: dict[str, str] | None = None,
    require_pins: bool = False,
    max_files: int = 200,
    max_bytes: int = 64 * 1024 * 1024,
    development: frozenset[str] = frozenset(),
) -> ScanResult:
    result = ScanResult()
    if not plugins_dir:
        result.error = "WIDGET_PLUGINS_DIR is not set"
        return result
    root = Path(plugins_dir)
    try:
        if root.is_symlink():
            root = root.resolve(strict=True)
        if not root.is_dir():
            result.error = f"{plugins_dir} is not a directory"
            return result
    except OSError as exc:
        result.error = f"{plugins_dir} cannot be read: {exc}"
        return result

    for plugin_entry in sorted(os.scandir(root), key=lambda e: e.name):
        if plugin_entry.name.startswith("."):
            continue
        if not re.fullmatch(PLUGIN_ID_PATTERN, plugin_entry.name):
            result.rejected.append(f"{plugin_entry.name}: not a plugin id")
            continue
        if plugin_entry.is_symlink() or not plugin_entry.is_dir(follow_symlinks=False):
            result.rejected.append(f"{plugin_entry.name}: not a directory")
            continue
        for version_entry in sorted(os.scandir(plugin_entry.path), key=lambda e: e.name):
            name = f"{plugin_entry.name}/{version_entry.name}"
            if version_entry.name.startswith("."):
                continue
            if not re.fullmatch(VERSION_PATTERN, version_entry.name):
                result.rejected.append(f"{name}: not a version")
                continue
            if version_entry.is_symlink() or not version_entry.is_dir(follow_symlinks=False):
                result.rejected.append(f"{name}: not a directory")
                continue
            result.versions.append(
                inspect_version(
                    root,
                    plugin_entry.name,
                    version_entry.name,
                    pins=pins or {},
                    require_pins=require_pins,
                    max_files=max_files,
                    max_bytes=max_bytes,
                    development=name in development,
                )
            )
    return result


def resolve_served_file(plugins_dir: str, version_path: str, file_path: str) -> Path | None:
    root = Path(plugins_dir).resolve()
    version_dir = (root / version_path).resolve()
    if root not in version_dir.parents:
        return None
    candidate = version_dir
    for part in file_path.split("/"):
        if part in {"", ".", ".."}:
            return None
        candidate /= part
        if candidate.is_symlink():
            return None
    if version_dir not in candidate.resolve().parents:
        return None
    return candidate if candidate.is_file() else None
