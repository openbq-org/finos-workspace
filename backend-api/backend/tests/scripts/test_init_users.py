import io
import re
import secrets
from datetime import timedelta

import pytest
from sqlalchemy import delete, insert, select, update

from api import base, models
from scripts import init_users
from scripts.init_users import Config, SetupConfig
from scripts.local_dev_admins import LOCAL_DEV_ADMINS
from tests.fixtures.base import _set_fk_checks

ENTITY_NAME = "Initial Organization"
ADMIN_EMAIL = "bootstrap-admin@example.com"
OTHER_EMAIL = "bootstrap-member@example.com"
DEV_EMAIL = LOCAL_DEV_ADMINS[0][0]
DEV_PASSWORD = LOCAL_DEV_ADMINS[0][3]
CREATED = re.compile(
    rf"^The administrator {re.escape(ADMIN_EMAIL)} was created\. Set their password with: "
    rf"python -m scripts\.init_users --new-password {re.escape(ADMIN_EMAIL)}$",
    re.MULTILINE,
)


def _password() -> str:
    return "Ch0sen!" + secrets.token_urlsafe(8)


def _type(monkeypatch, text: str) -> None:
    monkeypatch.setattr(init_users.sys, "stdin", io.StringIO(text))


def _config() -> Config:
    return Config(
        entity={"name": ENTITY_NAME},
        admins=[
            {
                "email": ADMIN_EMAIL,
                "first_name": "Bootstrap",
                "last_name": "Admin",
            }
        ],
        users=[],
    )


@pytest.fixture
async def bootstrap_cleanup(db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(init_users, "USER_CREATE_JSON_PATH", tmp_path / "user_create.json")
    yield

    await _set_fk_checks(db_session, enabled=False)
    entity_uuid = (
        await db_session.execute(
            select(models.Entity.uuid).where(models.Entity.name == ENTITY_NAME)
        )
    ).scalar_one_or_none()
    emails = [ADMIN_EMAIL, OTHER_EMAIL, DEV_EMAIL]
    users = select(models.User.uuid).where(models.User.email.in_(emails))
    await db_session.execute(delete(models.Session).where(models.Session.user_uuid.in_(users)))
    await db_session.execute(
        delete(models.User).where(models.User.email.in_(emails))
    )
    if entity_uuid:
        roles = select(models.Role.uuid).where(models.Role.entity_uuid == entity_uuid)
        for table in (models.UserRole, models.RoleCopilotModel, models.RoleMcpAccess):
            await db_session.execute(delete(table).where(table.role_uuid.in_(roles)))
        await db_session.execute(delete(models.Role).where(models.Role.entity_uuid == entity_uuid))
        await db_session.execute(
            delete(models.PermissionsEntityMap).where(
                models.PermissionsEntityMap.entity_uuid == entity_uuid
            )
        )
        await db_session.execute(delete(models.Entity).where(models.Entity.uuid == entity_uuid))
    await _set_fk_checks(db_session, enabled=True)
    await db_session.commit()


async def _admin(db_session) -> models.User:
    admin = (
        await db_session.execute(
            select(models.User)
            .where(models.User.email == ADMIN_EMAIL)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return admin


@pytest.mark.asyncio
async def test_bootstrap_creates_the_entity_and_a_working_admin(
    db_session, bootstrap_cleanup, capsys
):
    await SetupConfig(_config(), db_session).run()
    out = capsys.readouterr().out

    entity = (
        await db_session.execute(
            select(models.Entity).where(models.Entity.name == ENTITY_NAME)
        )
    ).scalar_one()

    maps = (
        (
            await db_session.execute(
                select(models.PermissionsEntityMap.name).where(
                    models.PermissionsEntityMap.entity_uuid == entity.uuid
                )
            )
        )
        .scalars()
        .all()
    )
    assert set(maps) == {"Admin", "Developer", "User"}

    admin = await _admin(db_session)
    assert admin.is_superuser
    roles = dict(
        (
            await db_session.execute(
                select(models.Role.name, models.Role.uuid).where(
                    models.Role.entity_uuid == entity.uuid
                )
            )
        ).all()
    )
    assert set(roles) == {"Agent User", "Sharer"}
    held = (
        await db_session.execute(
            select(models.UserRole.role_uuid).where(models.UserRole.user_uuid == admin.uuid)
        )
    ).scalars()
    assert set(held) == set(roles.values())
    created = CREATED.search(out)
    assert created
    printed = [line for line in out.splitlines() if line.strip() and not line.startswith("{")]
    assert printed == [created.group(0)]
    assert admin.password


def test_a_config_names_no_password():
    assert "password" not in init_users.AdminUser.model_fields
    assert "password" not in _config().model_dump_json()


@pytest.mark.asyncio
async def test_a_later_run_says_nothing_and_keeps_the_admins_password(
    db_session, bootstrap_cleanup, capsys
):
    await SetupConfig(_config(), db_session).run()
    capsys.readouterr()
    chosen = "Ch0sen!" + secrets.token_urlsafe(8)
    await db_session.execute(
        update(models.User).where(models.User.email == ADMIN_EMAIL).values(password=chosen)
    )
    await db_session.commit()

    await SetupConfig(_config(), db_session).run()

    assert not CREATED.findall(capsys.readouterr().out)
    assert base.verify_password(chosen, (await _admin(db_session)).password)


@pytest.mark.asyncio
async def test_a_later_run_gives_back_no_role_an_admin_took_away(db_session, bootstrap_cleanup):
    await SetupConfig(_config(), db_session).run()
    admin = await _admin(db_session)
    await db_session.execute(delete(models.UserRole).where(models.UserRole.user_uuid == admin.uuid))
    await db_session.commit()

    await SetupConfig(_config(), db_session).run()

    held = (
        await db_session.execute(
            select(models.UserRole.uuid).where(models.UserRole.user_uuid == admin.uuid)
        )
    ).scalars()
    assert list(held) == []


@pytest.mark.asyncio
async def test_bootstrap_can_run_again(db_session, bootstrap_cleanup):
    await SetupConfig(_config(), db_session).run()
    await SetupConfig(_config(), db_session).run()

    entities = (
        (
            await db_session.execute(
                select(models.Entity.uuid).where(models.Entity.name == ENTITY_NAME)
            )
        )
        .scalars()
        .all()
    )
    assert len(entities) == 1


async def _sign_in(db_session, user_uuid) -> None:
    await db_session.execute(
        insert(models.Session).values(
            token_hash=secrets.token_hex(32),
            user_uuid=user_uuid,
            expiration_date=base.get_now() + timedelta(days=1),
            app_session=True,
            source="app",
        )
    )
    await db_session.commit()


async def _sessions(db_session, user_uuid) -> int:
    rows = await db_session.execute(
        select(models.Session.uuid).where(models.Session.user_uuid == user_uuid)
    )
    return len(rows.all())


@pytest.mark.asyncio
async def test_a_new_password_is_read_from_standard_input_and_ends_every_session(
    db_session, bootstrap_cleanup, capsys, monkeypatch
):
    await SetupConfig(_config(), db_session).run()
    admin = await _admin(db_session)
    await _sign_in(db_session, admin.uuid)
    capsys.readouterr()
    password = _password()
    _type(monkeypatch, password + "\n")

    assert await init_users.change_password(db_session, ADMIN_EMAIL) == 0

    admin = await _admin(db_session)
    assert base.verify_password(password, admin.password)
    assert not admin.temporary_password
    assert await _sessions(db_session, admin.uuid) == 0
    shown = capsys.readouterr()
    assert f"The password of {ADMIN_EMAIL} is set" in shown.out
    assert password not in shown.out + shown.err


@pytest.mark.asyncio
async def test_on_a_terminal_the_password_is_typed_twice_without_echo(
    db_session, bootstrap_cleanup, capsys, monkeypatch
):
    await SetupConfig(_config(), db_session).run()
    password = _password()
    monkeypatch.setattr(init_users.sys.stdin, "isatty", lambda: True, raising=False)

    typed = iter([password, password + "x"])
    monkeypatch.setattr(init_users.getpass, "getpass", lambda prompt: next(typed))
    assert await init_users.change_password(db_session, ADMIN_EMAIL) == 2
    assert "The two passwords differ." in capsys.readouterr().err
    assert not base.verify_password(password, (await _admin(db_session)).password)

    typed = iter([password, password])
    assert await init_users.change_password(db_session, ADMIN_EMAIL) == 0
    assert base.verify_password(password, (await _admin(db_session)).password)


@pytest.mark.asyncio
async def test_a_weak_password_is_refused(db_session, bootstrap_cleanup, capsys, monkeypatch):
    await SetupConfig(_config(), db_session).run()
    before = (await _admin(db_session)).password
    _type(monkeypatch, "weak\n")

    assert await init_users.change_password(db_session, ADMIN_EMAIL) == 2

    assert "Password must be at least 8 characters long" in capsys.readouterr().err
    assert (await _admin(db_session)).password == before


@pytest.mark.asyncio
async def test_a_new_password_is_only_for_an_administrator(
    db_session, bootstrap_cleanup, capsys, monkeypatch
):
    await SetupConfig(_config(), db_session).run()
    admin = await _admin(db_session)
    member_password = _password()
    await db_session.execute(
        insert(models.User).values(
            email=OTHER_EMAIL,
            clean_email=base.clean_email(OTHER_EMAIL),
            confirmed=1,
            is_superuser=0,
            permissions_uuid=admin.permissions_uuid,
            password=member_password,
        )
    )
    await db_session.commit()

    for email in (OTHER_EMAIL, "nobody@example.com"):
        _type(monkeypatch, _password() + "\n")
        assert await init_users.change_password(db_session, email) == 1
        assert f"{email} is not an administrator" in capsys.readouterr().err
    member = (
        await db_session.execute(
            select(models.User)
            .where(models.User.email == OTHER_EMAIL)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert base.verify_password(member_password, member.password)


@pytest.mark.asyncio
async def test_local_dev_admin_is_created_with_its_known_password(
    db_session, bootstrap_cleanup, capsys, monkeypatch
):
    monkeypatch.setattr(init_users.settings, "MODE", "local")
    config = Config(
        entity={"name": ENTITY_NAME},
        admins=[
            {"email": ADMIN_EMAIL, "first_name": "Bootstrap", "last_name": "Admin"},
            {"email": DEV_EMAIL, "first_name": "Workspace", "last_name": "Dev 1"},
        ],
        users=[],
    )

    await SetupConfig(config, db_session).run()

    dev = (
        await db_session.execute(select(models.User).where(models.User.email == DEV_EMAIL))
    ).scalar_one()
    assert dev.is_superuser
    assert base.verify_password(DEV_PASSWORD, dev.password)
    out = capsys.readouterr().out
    assert f"The local-dev administrator {DEV_EMAIL} was created" in out
    assert DEV_PASSWORD not in out


@pytest.mark.asyncio
async def test_a_dev_email_in_non_local_mode_gets_a_random_password(
    db_session, bootstrap_cleanup, capsys, monkeypatch
):
    monkeypatch.setattr(init_users.settings, "MODE", "production")
    config = Config(
        entity={"name": ENTITY_NAME},
        admins=[
            {"email": ADMIN_EMAIL, "first_name": "Bootstrap", "last_name": "Admin"},
            {"email": DEV_EMAIL, "first_name": "Workspace", "last_name": "Dev 1"},
        ],
        users=[],
    )

    await SetupConfig(config, db_session).run()

    dev = (
        await db_session.execute(select(models.User).where(models.User.email == DEV_EMAIL))
    ).scalar_one()
    assert not base.verify_password(DEV_PASSWORD, dev.password)


@pytest.mark.asyncio
async def test_the_new_password_command(db_session, bootstrap_cleanup, capsys, monkeypatch):
    await SetupConfig(_config(), db_session).run()
    capsys.readouterr()

    async def the_test_database():
        yield db_session

    monkeypatch.setattr(init_users, "aget_write_db", the_test_database)
    password = _password()
    _type(monkeypatch, password + "\n")

    assert await init_users.set_new_password(ADMIN_EMAIL) == 0
    assert base.verify_password(password, (await _admin(db_session)).password)
    shown = capsys.readouterr()
    assert password not in shown.out + shown.err
