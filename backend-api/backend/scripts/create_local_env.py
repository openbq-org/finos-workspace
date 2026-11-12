import argparse
import base64
import hashlib
import hmac
import json
import secrets
import sys
import time
from pathlib import Path

from scripts.local_dev_admins import LOCAL_DEV_ADMINS

ENVS = Path(__file__).resolve().parent.parent / "envs"
EXAMPLE = ENVS / ".env.example"
TARGET = ENVS / ".env"
SQLITE_EXAMPLE = ENVS / ".env.sqlite.example"
SQLITE_TARGET = ENVS / ".env.sqlite"
CONFIG = Path(__file__).resolve().parent / "cfgs" / "config.toml"
USER_CREATE = Path(__file__).resolve().parent.parent / "user_create.json"
AGENT = Path(__file__).resolve().parents[3] / "agent"
AGENT_EXAMPLE = AGENT / ".env.example"
AGENT_TARGET = AGENT / ".env"

WEB_URL = "http://localhost:3000"
API_URL = "http://localhost:8000"
BACKEND_CORS_ORIGINS = [WEB_URL, "http://localhost:1420"]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt_hs256(payload: dict[str, object], secret: str) -> str:
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256)
    return f"{header}.{body}.{_b64(signature.digest())}"


METERING_TOKEN_DAYS = 365


def metering_token(jwt_secret: str, now: float | None = None) -> str:
    issued = int(time.time() if now is None else now)
    return jwt_hs256(
        {
            "sub": "metering",
            "iat": issued,
            "exp": issued + METERING_TOKEN_DAYS * 24 * 60 * 60,
        },
        jwt_secret,
    )


def secrets_for(
    jwt_secret: str, aes_key: str, storage_secret: str
) -> dict[str, str]:
    return {
        "JWT_SECRET": jwt_secret,
        "WORKSPACE_AES_KEY": aes_key,
        "WORKSPACE_AUTH_TOKEN": jwt_hs256(
            {"sub": "workspace", "auth": secrets.token_hex(16)}, jwt_secret
        ),
        "LOCAL_STORAGE_SECRET_KEY": storage_secret,
    }


def settings(
    jwt_secret: str, aes_key: str, storage_secret: str
) -> dict[str, str]:
    return {
        "DB_HOST": "mysql",
        "DB_NAME": "workspace",
        "REDIS_HOST": "valkey",
        "STORAGE_PROVIDER": "folder",
        "MODE": "production",
        "FRONTENDURL": WEB_URL,
        "APPURL": WEB_URL,
        "SELFURL": API_URL,
        "BACKEND_CORS_ORIGINS": json.dumps(BACKEND_CORS_ORIGINS, separators=(",", ":")),
        **secrets_for(jwt_secret, aes_key, storage_secret),
    }


def seed_config(entity_name: str, email: str, extra_admins: bool = True) -> str:
    primary = f"""\
[entity]
name = {json.dumps(entity_name)}

[[admins]]
email = {json.dumps(email)}
first_name = "FINOS Workspace"
last_name = "Administrator"
"""
    if not extra_admins:
        return primary
    extras = "".join(
        f"""
[[admins]]
email = {json.dumps(dev_email)}
first_name = {json.dumps(first)}
last_name = {json.dumps(last)}
"""
        for dev_email, first, last, _password in LOCAL_DEV_ADMINS
    )
    return primary + extras


def agent_secrets(jwt_secret: str, current_scope_secret: str = "") -> dict[str, str]:
    return {
        "AGENT_METERING_TOKEN": metering_token(jwt_secret),
        "AGENT_SCOPE_SECRET": current_scope_secret or secrets.token_urlsafe(32),
    }


def write_agent_env(jwt_secret: str) -> Path | None:
    if not AGENT_EXAMPLE.exists():
        return None
    text = AGENT_TARGET.read_text() if AGENT_TARGET.exists() else AGENT_EXAMPLE.read_text()
    current = dict(line.partition("=")[::2] for line in text.splitlines()).get("AGENT_SCOPE_SECRET", "")
    AGENT_TARGET.write_text(render(text, agent_secrets(jwt_secret, current.strip())))
    AGENT_TARGET.chmod(0o600)
    return AGENT_TARGET


def render(example: str, values: dict[str, str]) -> str:
    lines = example.splitlines()
    remaining = dict(values)
    for index, line in enumerate(lines):
        key, sign, _ = line.partition("=")
        if sign and key in remaining:
            lines[index] = f"{key}={remaining.pop(key)}"
    lines += [f"{key}={value}" for key, value in remaining.items()]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Write envs/.env and scripts/cfgs/config.toml for docker compose."
    )
    parser.add_argument(
        "--admin-email", required=True, help="Email address of the first administrator"
    )
    parser.add_argument("--entity-name", default="FINOS Workspace", help="Name of the organization")
    parser.add_argument(
        "--sqlite",
        action="store_true",
        help="Write envs/.env.sqlite (from .env.sqlite.example) instead of envs/.env",
    )
    parser.add_argument(
        "--config-only",
        action="store_true",
        help="Write only scripts/cfgs/config.toml and leave the environment file alone",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing files")
    parser.add_argument(
        "--no-extra-admins",
        action="store_true",
        help=(
            "Do not seed the three extra local-dev admins "
            "(workspace-dev1..dev3@example.com) with known passwords"
        ),
    )
    args = parser.parse_args(argv)

    example, target = (SQLITE_EXAMPLE, SQLITE_TARGET) if args.sqlite else (EXAMPLE, TARGET)
    for path in (CONFIG,) if args.config_only else (target, CONFIG):
        if path.exists() and not args.force:
            sys.stderr.write(f"{path} exists; pass --force to replace it\n")
            return 1

    generated = dict(
        jwt_secret=secrets.token_urlsafe(48),
        aes_key=secrets.token_urlsafe(32),
        storage_secret=secrets.token_urlsafe(32),
    )
    if not args.config_only:
        values = secrets_for(**generated) if args.sqlite else settings(**generated)
        target.write_text(render(example.read_text(), values))
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    extra_admins = not args.no_extra_admins
    CONFIG.write_text(seed_config(args.entity_name, args.admin_email, extra_admins=extra_admins))
    if not (args.config_only or args.sqlite) and not USER_CREATE.exists():
        USER_CREATE.write_text("{}\n")
    agent = None if args.config_only or args.sqlite else write_agent_env(generated["jwt_secret"])
    sys.stdout.write(
        f"Wrote {CONFIG if args.config_only else f'{target} and {CONFIG}'}\n"
        f"The first start creates the administrator {args.admin_email} without a password. "
        "Set it with: docker compose run --rm init python -m scripts.init_users "
        f"--new-password {args.admin_email}\n"
    )
    if extra_admins:
        sys.stdout.write(
            "The first start also creates three local-dev admins with known passwords "
            "so other agents can sign in at the same time; these are for MODE=local only, "
            "never a deployment:\n"
        )
        for dev_email, _first, _last, password in LOCAL_DEV_ADMINS:
            sys.stdout.write(f"  {dev_email}  {password}\n")
    if agent:
        sys.stdout.write(f"Set the agent's secrets in {agent}; set DEFAULT_MODEL and that provider's key there too.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
