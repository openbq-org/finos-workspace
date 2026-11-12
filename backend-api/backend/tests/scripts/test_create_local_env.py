import json
import time
import tomllib

import jwt
import pytest

from api import crypto
from scripts import create_local_env as local_env
from utilities.config import Settings, check_strong_secret

EXAMPLE = """\
DB_HOST=mysql # a note
DB_NAME=sample_db
# FOLDER_STORAGE_PATH=local_storage
STORAGE_PROVIDER=aws
JWT_SECRET=placeholder
UNRELATED=kept
"""


ADMIN = ["--admin-email", "admin@mail.test"]


@pytest.fixture
def config(tmp_path, monkeypatch):
    path = tmp_path / "cfgs" / "config.toml"
    monkeypatch.setattr(local_env, "CONFIG", path)
    monkeypatch.setattr(local_env, "USER_CREATE", tmp_path / "user_create.json")
    monkeypatch.setattr(local_env, "AGENT_EXAMPLE", tmp_path / "agent" / ".env.example")
    monkeypatch.setattr(local_env, "AGENT_TARGET", tmp_path / "agent" / ".env")
    return path


def parse(text: str) -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in text.splitlines()
        if "=" in line and not line.startswith("#")
    )


def test_render_sets_what_it_is_given_and_keeps_the_rest():
    values = {"DB_NAME": "workspace", "STORAGE_PROVIDER": "folder"}

    rendered = parse(local_env.render(EXAMPLE, values))

    assert rendered["DB_NAME"] == "workspace"
    assert rendered["STORAGE_PROVIDER"] == "folder"
    assert rendered["UNRELATED"] == "kept"


def test_render_drops_the_note_after_a_replaced_value():
    rendered = parse(local_env.render(EXAMPLE, {"DB_HOST": "db"}))

    assert rendered["DB_HOST"] == "db"


def test_render_appends_a_key_the_example_does_not_have():
    rendered = parse(local_env.render(EXAMPLE, {"LOCAL_STORAGE_SECRET_KEY": "s"}))

    assert rendered["LOCAL_STORAGE_SECRET_KEY"] == "s"


def test_render_leaves_commented_keys_alone():
    rendered = local_env.render(EXAMPLE, {"FOLDER_STORAGE_PATH": "/data"})

    assert "# FOLDER_STORAGE_PATH=local_storage" in rendered
    assert rendered.splitlines()[-1] == "FOLDER_STORAGE_PATH=/data"


def test_the_client_token_is_signed_with_the_jwt_secret():
    values = local_env.settings("a-secret", "0123456789abcdef", "storage")

    payload = jwt.decode(values["WORKSPACE_AUTH_TOKEN"], "a-secret", algorithms=["HS256"])

    assert payload["sub"] == "workspace"
    assert payload["auth"]


def test_jwt_hs256_matches_pyjwt():
    payload = {"sub": "workspace", "auth": "x"}

    ours = local_env.jwt_hs256(payload, "secret")

    assert jwt.decode(ours, "secret", algorithms=["HS256"]) == payload
    assert jwt.get_unverified_header(ours)["alg"] == "HS256"


def test_the_settings_point_at_the_compose_services():
    values = local_env.settings("a-secret", "0123456789abcdef", "storage")

    assert values["DB_HOST"] == "mysql"
    assert values["REDIS_HOST"] == "valkey"
    assert values["STORAGE_PROVIDER"] == "folder"
    assert values["FRONTENDURL"] == "http://localhost:3000"
    assert values["SELFURL"] == "http://localhost:8000"


def test_main_writes_secrets_that_differ_between_runs(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    runs = []
    for index in range(2):
        target = tmp_path / f"env{index}"
        monkeypatch.setattr(local_env, "TARGET", target)
        assert local_env.main([*ADMIN, "--force"]) == 0
        runs.append(parse(target.read_text()))

    assert runs[0]["JWT_SECRET"] != runs[1]["JWT_SECRET"]
    assert runs[0]["WORKSPACE_AES_KEY"] != runs[1]["WORKSPACE_AES_KEY"]
    assert runs[0]["JWT_SECRET"] != "placeholder"
    for run in runs:
        assert len(crypto.decode_key_material(run["WORKSPACE_AES_KEY"])) >= 32
        for name in ("JWT_SECRET", "LOCAL_STORAGE_SECRET_KEY"):
            assert check_strong_secret(name, run[name]) == run[name]


def test_main_refuses_to_overwrite_without_force(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    target = tmp_path / ".env"
    target.write_text("KEEP=me\n")
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", target)

    assert local_env.main(ADMIN) == 1
    assert target.read_text() == "KEEP=me\n"

    assert local_env.main([*ADMIN, "--force"]) == 0
    assert "KEEP" not in target.read_text()


def test_main_refuses_to_overwrite_the_seed_config_without_force(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")
    config.parent.mkdir()
    config.write_text("KEEP = 1\n")

    assert local_env.main(ADMIN) == 1
    assert config.read_text() == "KEEP = 1\n"
    assert not (tmp_path / ".env").exists()


def test_main_needs_an_administrator(tmp_path, monkeypatch, config):
    with pytest.raises(SystemExit):
        local_env.main([])


def test_the_seed_config_names_the_administrator_and_no_password(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")

    assert local_env.main([*ADMIN, "--entity-name", "Acme", "--no-extra-admins"]) == 0

    seed = tomllib.loads(config.read_text())
    assert seed["entity"]["name"] == "Acme"
    assert seed["admins"] == [
        {"email": "admin@mail.test", "first_name": "FINOS Workspace", "last_name": "Administrator"}
    ]
    assert "password" not in config.read_text()
    assert "password" not in (tmp_path / ".env").read_text().lower()


def test_the_seed_config_also_names_three_local_dev_admins_by_default(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")

    assert local_env.main([*ADMIN]) == 0

    seed = tomllib.loads(config.read_text())
    emails = [admin["email"] for admin in seed["admins"]]
    assert emails == [
        "admin@mail.test",
        "workspace-dev1@example.com",
        "workspace-dev2@example.com",
        "workspace-dev3@example.com",
    ]
    assert "password" not in config.read_text()


def test_create_local_env_prints_the_dev_admin_passwords(tmp_path, monkeypatch, config, capsys):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")

    assert local_env.main([*ADMIN]) == 0

    out = capsys.readouterr().out
    assert "workspace-dev1@example.com" in out
    assert "WorkspaceDev!1" in out
    assert "workspace-dev2@example.com" in out
    assert "WorkspaceDev!2" in out
    assert "workspace-dev3@example.com" in out
    assert "WorkspaceDev!3" in out
    assert "MODE=local" in out


def test_every_dev_admin_email_passes_pydantic_email_str():
    from pydantic import BaseModel, EmailStr
    from scripts.local_dev_admins import LOCAL_DEV_ADMINS

    class HasEmails(BaseModel):
        emails: list[EmailStr]

    HasEmails(emails=[email for email, _f, _l, _p in LOCAL_DEV_ADMINS])


def test_no_extra_admins_leaves_just_the_primary(tmp_path, monkeypatch, config, capsys):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")

    assert local_env.main([*ADMIN, "--no-extra-admins"]) == 0

    seed = tomllib.loads(config.read_text())
    assert [admin["email"] for admin in seed["admins"]] == ["admin@mail.test"]
    out = capsys.readouterr().out
    assert "WorkspaceDev" not in out


def test_the_administrator_password_is_no_option():
    with pytest.raises(SystemExit):
        local_env.main([*ADMIN, "--admin-password", "Secret!123"])


def test_the_seed_config_quotes_what_it_is_given():
    seed = tomllib.loads(local_env.seed_config('A "quoted" name', 'a"b\\@mail.test'))

    assert seed["entity"]["name"] == 'A "quoted" name'
    assert seed["admins"][0]["email"] == 'a"b\\@mail.test'


def test_the_web_app_is_an_allowed_origin():
    values = local_env.settings("a-secret", "0123456789abcdef", "storage")

    assert json.loads(values["BACKEND_CORS_ORIGINS"]) == [
        "http://localhost:3000",
        "http://localhost:1420",
    ]


def _api_settings(monkeypatch, env_file) -> Settings:
    for key in parse(env_file.read_text()):
        monkeypatch.delenv(key, raising=False)
    return Settings(_env_file=env_file)


def test_the_compose_environment_starts_the_api(tmp_path, monkeypatch, config):
    target = tmp_path / ".env"
    monkeypatch.setattr(local_env, "TARGET", target)

    assert local_env.main(ADMIN) == 0

    loaded = _api_settings(monkeypatch, target)
    assert loaded.MODE == "production"
    assert loaded.BACKEND_CORS_ORIGINS == local_env.BACKEND_CORS_ORIGINS
    assert loaded.GOOGLE_OAUTH_CLIENT_ID is None


def test_config_only_leaves_the_environment_file_alone(tmp_path, monkeypatch, config):
    target = tmp_path / ".env"
    target.write_text("KEEP=me\n")
    monkeypatch.setattr(local_env, "TARGET", target)

    assert local_env.main([*ADMIN, "--config-only"]) == 0

    assert target.read_text() == "KEEP=me\n"
    assert tomllib.loads(config.read_text())["admins"][0]["email"] == "admin@mail.test"


def test_sqlite_mode_writes_its_own_file_with_the_same_secrets(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.sqlite.example"
    example.write_text("JWT_SECRET=\nWORKSPACE_AUTH_TOKEN=\nDB_PATH=test.db\n")
    target = tmp_path / ".env.sqlite"
    monkeypatch.setattr(local_env, "SQLITE_EXAMPLE", example)
    monkeypatch.setattr(local_env, "SQLITE_TARGET", target)

    assert local_env.main([*ADMIN, "--sqlite"]) == 0

    written = parse(target.read_text())
    assert written["DB_PATH"] == "test.db"
    jwt.decode(written["WORKSPACE_AUTH_TOKEN"], written["JWT_SECRET"], algorithms=["HS256"])


def test_the_real_example_activates_no_placeholder_path():
    active = [
        line
        for line in local_env.EXAMPLE.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    ]

    assert [line for line in active if "/path/to/" in line] == []


def test_main_writes_the_empty_file_that_compose_mounts(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")

    assert local_env.main(ADMIN) == 0

    assert (tmp_path / "user_create.json").read_text().strip() == "{}"


def test_main_keeps_a_user_create_file_that_exists(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")
    (tmp_path / "user_create.json").write_text('{"keep": 1}')

    assert local_env.main(ADMIN) == 0

    assert (tmp_path / "user_create.json").read_text() == '{"keep": 1}'


def test_config_only_and_sqlite_leave_user_create_alone(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.sqlite.example"
    example.write_text("JWT_SECRET=\nWORKSPACE_AUTH_TOKEN=\n")
    monkeypatch.setattr(local_env, "SQLITE_EXAMPLE", example)
    monkeypatch.setattr(local_env, "SQLITE_TARGET", tmp_path / ".env.sqlite")

    assert local_env.main([*ADMIN, "--config-only"]) == 0
    assert local_env.main([*ADMIN, "--sqlite", "--force"]) == 0

    assert not (tmp_path / "user_create.json").exists()


AGENT_EXAMPLE = """\
DEFAULT_MODEL=
NVIDIA_API_KEY=
# What the agent uses to report usage and to sign the scope of a chat
AGENT_METERING_TOKEN=
AGENT_SCOPE_SECRET=
"""


@pytest.fixture
def agent(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / ".env.example").write_text(AGENT_EXAMPLE)
    return tmp_path / "agent" / ".env"


def test_the_metering_token_is_what_the_api_expects(agent):
    values = local_env.agent_secrets("a-secret")

    payload = jwt.decode(
        values["AGENT_METERING_TOKEN"],
        "a-secret",
        algorithms=["HS256"],
        options={"require": ["exp"]},
    )

    assert payload["sub"] == "metering"
    assert payload["exp"] - payload["iat"] == local_env.METERING_TOKEN_DAYS * 24 * 60 * 60
    assert len(values["AGENT_SCOPE_SECRET"]) >= 16


def test_the_metering_token_runs_out(agent):
    long_ago = time.time() - local_env.METERING_TOKEN_DAYS * 24 * 60 * 60 - 60
    stale = local_env.metering_token("a-secret", now=long_ago)

    with pytest.raises(jwt.ExpiredSignatureError):
        jwt.decode(stale, "a-secret", algorithms=["HS256"])


def test_main_creates_agent_environment_from_her_example(agent, tmp_path):
    assert local_env.main(ADMIN) == 0

    written = parse(agent.read_text())
    jwt_secret = parse((tmp_path / ".env").read_text())["JWT_SECRET"]
    jwt.decode(written["AGENT_METERING_TOKEN"], jwt_secret, algorithms=["HS256"])
    assert len(written["AGENT_SCOPE_SECRET"]) >= 16
    assert not written["DEFAULT_MODEL"]
    assert agent.stat().st_mode & 0o077 == 0


def test_main_keeps_what_a_user_set_in_agent_environment(agent, tmp_path):
    agent.write_text("DEFAULT_MODEL=provider:model\nNVIDIA_API_KEY=a-key\nAGENT_SCOPE_SECRET=keep-this-secret\n")

    assert local_env.main([*ADMIN, "--force"]) == 0

    written = parse(agent.read_text())
    assert written["DEFAULT_MODEL"] == "provider:model"
    assert written["NVIDIA_API_KEY"] == "a-key"
    assert written["AGENT_SCOPE_SECRET"] == "keep-this-secret"
    jwt_secret = parse((tmp_path / ".env").read_text())["JWT_SECRET"]
    jwt.decode(written["AGENT_METERING_TOKEN"], jwt_secret, algorithms=["HS256"])


def test_a_new_jwt_secret_means_a_new_metering_token(agent):
    assert local_env.main(ADMIN) == 0
    first = parse(agent.read_text())["AGENT_METERING_TOKEN"]

    assert local_env.main([*ADMIN, "--force"]) == 0

    assert parse(agent.read_text())["AGENT_METERING_TOKEN"] != first


def test_main_without_agent_writes_nothing_for_her(tmp_path, monkeypatch, config):
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE)
    monkeypatch.setattr(local_env, "EXAMPLE", example)
    monkeypatch.setattr(local_env, "TARGET", tmp_path / ".env")

    assert local_env.main(ADMIN) == 0

    assert not (tmp_path / "agent").exists()


def test_config_only_and_sqlite_leave_agent_alone(agent, tmp_path, monkeypatch):
    sqlite_example = tmp_path / ".env.sqlite.example"
    sqlite_example.write_text("JWT_SECRET=\nWORKSPACE_AUTH_TOKEN=\n")
    monkeypatch.setattr(local_env, "SQLITE_EXAMPLE", sqlite_example)
    monkeypatch.setattr(local_env, "SQLITE_TARGET", tmp_path / ".env.sqlite")

    assert local_env.main([*ADMIN, "--config-only"]) == 0
    assert local_env.main([*ADMIN, "--sqlite", "--force"]) == 0

    assert not agent.exists()
