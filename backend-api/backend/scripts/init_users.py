import argparse
import asyncio
import getpass
import json
import sys
import tomllib
from contextlib import suppress
from pathlib import Path
from uuid import UUID

from fastapi.encoders import jsonable_encoder
from loguru import logger
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api import base, schemas
from api.base import clean_email
from api.database import aget_write_db
from api.models import (
    ADMIN_TYPE,
    USER_TYPE,
    Entity,
    PermissionsEntityMap,
    Session,
    User,
)
from routers import administration, app_helpers
from routers.app.index import process_create_user, register_app_user
from scripts.local_dev_admins import LOCAL_DEV_ADMIN_PASSWORDS
from utilities.config import settings

CONFIG_PATH = Path(__file__).parent / "cfgs"

BACKEND_DIR = Path(__file__).parent.parent
USER_CREATE_JSON_PATH = BACKEND_DIR / "user_create.json"
USER_CREATE_JSON_PATH.touch(exist_ok=True)


def show(text: str) -> None:
    sys.stdout.write(f"{text}\n")
    sys.stdout.flush()


class UserConfig(BaseModel):
    email: str
    first_name: str
    last_name: str


class AdminUser(UserConfig):
    uuid: UUID | None = None


class EntityConfig(BaseModel):
    name: str


class Config(BaseModel):
    entity: EntityConfig
    admins: list[AdminUser] = Field(min_length=1)
    users: list[UserConfig] | None = []

    @field_validator("users", "admins", mode="before", check_fields=False)
    @classmethod
    def check_users(cls, v):
        return [user for user in v if user.get("email")]


class SetupConfig:
    db: AsyncSession
    config: Config
    admin_user: type[User] | None

    def __init__(self, config: Config, db: AsyncSession):
        self.db = db
        self.config = config
        self.admin_user: type[User] | None = None

    async def add_entity(self, entity: schemas.EntityPost) -> schemas.AddEntityReturn:
        return await administration.create_entity(self.db, entity)

    async def create_user(self, the_uuid: UUID, email: str) -> UUID | bool:
        return await process_create_user(the_uuid, email, self.db)

    async def init_admins(self, permissions_uuid: UUID) -> User:
        admin_users: list[User] = []
        for admin in self.config.admins:
            admin_users.append(await self.create_admin(admin, permissions_uuid))

        self.admin_user = admin_users[0]

    async def create_admin(self, admin_user: AdminUser, permissions_uuid: UUID) -> User:
        logger.info(f"Checking for admin: {admin_user.email}")
        query = select(User).where(User.email == admin_user.email)
        result = await self.db.execute(query)

        if (user := result.scalars().first()) is None:
            logger.info(f"Creating admin: {admin_user.email} with is_superuser=1")
            seeded = (
                LOCAL_DEV_ADMIN_PASSWORDS.get(admin_user.email)
                if settings.MODE == "local"
                else None
            )
            password = seeded or base.random_password()
            query = insert(User).values(
                email=admin_user.email,
                first_name=admin_user.first_name,
                last_name=admin_user.last_name,
                confirmed=1,
                clean_email=clean_email(admin_user.email),
                permissions_uuid=permissions_uuid,
                is_superuser=1,
                password=password,
            )
            result = await self.db.execute(query)
            await app_helpers.give_default_roles(
                self.db,
                result.inserted_primary_key[0],
                permissions_uuid,
                [app_helpers.AGENT_USER_ROLE, app_helpers.SHARER_ROLE],
            )
            await self.db.commit()
            if seeded:
                show(
                    f"The local-dev administrator {admin_user.email} was created "
                    "with its known password (MODE=local only; never a deployment)."
                )
            else:
                show(
                    f"The administrator {admin_user.email} was created. Set their password with: "
                    f"python -m scripts.init_users --new-password {admin_user.email}"
                )

            return await self.create_admin(admin_user, permissions_uuid)

        if not (user.is_superuser and user.confirmed):
            logger.info(
                f"Updating admin: {admin_user.email} (is_superuser={user.is_superuser})"
            )
            stmt = (
                update(User)
                .where(User.uuid == user.uuid)
                .values(is_superuser=1, confirmed=1)
            )
            await self.db.execute(stmt)
            await self.db.commit()
            await self.db.refresh(user)
            return await self.create_admin(admin_user, permissions_uuid)

        logger.info(
            f"Admin already exists: {admin_user.email}, is_superuser={user.is_superuser}"
        )
        return user

    async def create_entity(self):
        return await self.add_entity(
            schemas.EntityPost(
                name=self.config.entity.name, admin_email=self.config.admins[0].email
            ),
        )

    async def run(self):
        query = select(Entity.uuid).where(Entity.name == self.config.entity.name)
        result = await self.db.execute(query)

        if (entity_uuid := result.scalars().first()) is None:
            entity_uuid = (await self.create_entity()).entity_uuid

        query = select(PermissionsEntityMap).where(
            PermissionsEntityMap.entity_uuid == entity_uuid
        )
        result = await self.db.execute(query)

        permissions_map: dict[str, UUID] = {}

        for permission in result.scalars().all():
            permissions_map[permission.name] = permission.uuid

        await self.init_admins(permissions_map[ADMIN_TYPE])

        user_create = {"permissions_uuid": permissions_map[USER_TYPE]}
        with USER_CREATE_JSON_PATH.open("w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(jsonable_encoder(user_create), indent=4))

        for user in self.config.users:
            user_create = schemas.UserCreateAppAdmin(
                email=user.email,
                permissions_uuid=permissions_map[USER_TYPE],
                first_name=user.first_name,
                last_name=user.last_name,
            )
            extra_info = schemas.RegisterAppUser(inviting_uuid=self.admin_user.uuid)

            with suppress(Exception):
                invite_uuid = await register_app_user(
                    self.db, user_create, extra_info, from_oauth=True
                )
                if not invite_uuid or not await self.create_user(
                    invite_uuid, user.email
                ):
                    continue

        await self.db.commit()


async def setup_configs():
    configs = []
    for file in CONFIG_PATH.glob("*.toml"):
        with file.open("rb") as f:
            configs.append(Config(**tomllib.load(f)))

    async for db in aget_write_db():
        for config in configs:
            await SetupConfig(config, db).run()


async def get_administrator(db: AsyncSession, email: str) -> User | None:
    user = (await db.execute(select(User).where(User.email == email))).scalars().first()
    return user if user is not None and user.is_superuser else None


def read_password() -> str:
    if sys.stdin.isatty():
        password = getpass.getpass("New password: ")
        if getpass.getpass("Repeat the new password: ") != password:
            raise ValueError("The two passwords differ.")
    else:
        password = sys.stdin.readline().rstrip("\r\n")
    return schemas.check_password(password)


async def set_password(db: AsyncSession, user: User, password: str) -> None:
    await db.execute(
        update(User)
        .where(User.uuid == user.uuid)
        .values(password=password, temporary_password=False)
    )
    await db.execute(delete(Session).where(Session.user_uuid == user.uuid))
    await db.commit()


async def change_password(db: AsyncSession, email: str) -> int:
    user = await get_administrator(db, email)
    if user is None:
        sys.stderr.write(f"{email} is not an administrator of this FINOS Workspace.\n")
        return 1
    try:
        password = read_password()
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    await set_password(db, user, password)
    show(f"The password of {email} is set. Every session of the account has ended.")
    return 0


async def set_new_password(email: str) -> int:
    status = 1
    async for db in aget_write_db():
        status = await change_password(db, email)
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create the organizations and administrators that scripts/cfgs/*.toml name."
    )
    parser.add_argument(
        "--new-password",
        dest="admin_email",
        metavar="EMAIL",
        help="Instead, set the password of the administrator EMAIL, read from the terminal "
        "without echo, or from standard input",
    )
    args = parser.parse_args(argv)
    if args.admin_email:
        return asyncio.run(set_new_password(args.admin_email))
    asyncio.run(setup_configs())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
