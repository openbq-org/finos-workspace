# syntax=docker/dockerfile:1

FROM chimeralinux/chimera@sha256:29102d7e12a1f464707d7aba19ce53e652d277861838ed4129178d0655444b1a AS builder-base

ARG PYTHON_RELEASE=20261021
ARG PYTHON_VERSION=3.13.17
ARG PYTHON_SHA256_X86_64=089e64ce3a7969382e4782e2051c12d6de143e9f7d102c89a8c8d54e7c554b90
ARG PYTHON_SHA256_AARCH64=5af630e7e458af4675ea9a39b220b80baed17bc7a3e22b0fc97115a54fa0e96e

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PIP_DEFAULT_TIMEOUT=100 \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_VIRTUALENVS_OPTIONS_NO_PIP=true \
    POETRY_NO_INTERACTION=1 \
    PYSETUP_PATH="/opt" \
    VENV_PATH="/opt/.venv" \
    CC=clang \
    CXX=clang++ \
    LDSHARED="clang -shared"

RUN apk upgrade --no-cache --available \
    && apk add --no-cache clang musl-devel linux-headers pkgconf rust cargo git curl bsdtar llvm-binutils \
      openssl3-devel libffi8-devel libcxx-devel tzdb

RUN arch="$(uname -m)" \
    && case "$arch" in \
      x86_64) sha="$PYTHON_SHA256_X86_64" ;; \
      aarch64) sha="$PYTHON_SHA256_AARCH64" ;; \
      *) echo "No CPython build for $arch" >&2; exit 1 ;; \
    esac \
    && tarball="cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${arch}-unknown-linux-musl-install_only_stripped.tar.gz" \
    && curl -fsSLO "https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${tarball}" \
    && echo "$sha  $tarball" | sha256sum -c - \
    && mkdir -p /opt && bsdtar -xzf "$tarball" -C /opt \
    && rm "$tarball"

COPY ./poetry-requirements.txt /tmp/poetry-requirements.txt
RUN /opt/python/bin/python3 -m venv /opt/poetry && /opt/poetry/bin/pip install --require-hashes -r /tmp/poetry-requirements.txt && rm /tmp/poetry-requirements.txt

WORKDIR $PYSETUP_PATH
COPY ./pyproject.toml ./poetry.lock ./

RUN /opt/python/bin/python3 - <<'EOF'
import subprocess, tomllib
lock = tomllib.load(open("poetry.lock", "rb"))
compiled = [p["name"] for p in lock["package"]
            if any(f["file"].endswith(".whl") and not f["file"].endswith("-none-any.whl") for f in p.get("files", []))]
subprocess.run(["/opt/poetry/bin/poetry", "config", "installer.no-binary", ",".join(compiled)], check=True)
EOF

RUN /opt/poetry/bin/poetry env use /opt/python/bin/python3 && /opt/poetry/bin/poetry install --only main

RUN rm -rf $VENV_PATH/src/slowapi/poetry.lock $VENV_PATH/src/slowapi/docs/requirements.txt

RUN set -e; \
    arch="$(uname -m)"; \
    mkdir -p /rootfs/usr/lib /rootfs/opt /rootfs/etc/ssl/certs /rootfs/usr/share /rootfs/tmp \
      /writable/home/appuser /writable/opt/code/local_storage; \
    ln -s usr/lib /rootfs/lib; \
    ln -s libc.so "/rootfs/usr/lib/ld-musl-$arch.so.1"; \
    bsdtar -cf - -C /opt python | bsdtar -xpf - -C /rootfs/opt; \
    cd /rootfs/opt/python; \
    rm -rf bin/pip* bin/idle* bin/pydoc* bin/2to3* bin/*-config include share lib/pkgconfig \
      lib/libtcl* lib/libtk* lib/tcl* lib/tk* lib/itcl* lib/thread* \
      lib/python3.13/ensurepip lib/python3.13/idlelib lib/python3.13/tkinter lib/python3.13/turtle.py \
      lib/python3.13/turtledemo lib/python3.13/test lib/python3.13/site-packages/pip* \
      lib/python3.13/lib-dynload/_dbm.* lib/python3.13/lib-dynload/_tkinter.*; \
    ln -s "$("$VENV_PATH/bin/python" -c 'import certifi; print(certifi.where())')" /rootfs/etc/ssl/certs/ca-certificates.crt; \
    ln -s certs/ca-certificates.crt /rootfs/etc/ssl/cert.pem; \
    bsdtar -cf - -C /usr/share zoneinfo | bsdtar -xpf - -C /rootfs/usr/share; \
    chmod 1777 /rootfs/tmp; \
    printf '%s\n' \
      'root:x:0:0:root:/root:/sbin/nologin' \
      'nobody:x:65534:65534:nobody:/nonexistent:/sbin/nologin' \
      'appuser:x:1000:1000:appuser:/home/appuser:/sbin/nologin' > /rootfs/etc/passwd; \
    printf '%s\n' 'root:x:0:' 'nobody:x:65534:' 'appuser:x:1000:' > /rootfs/etc/group

RUN mkdir -p /rootfs/usr/share/sbom && /opt/python/bin/python3 - <<'EOF'
import curses, decimal, json, os, pathlib, platform, pyexpat, re, readline, shutil, sqlite3, ssl, subprocess, sys, zlib

root = pathlib.Path("/rootfs")
lib = root / "usr/lib"

def run(*args, check=True):
    return subprocess.run(args, capture_output=True, text=True, check=check).stdout

def is_elf(path):
    with path.open("rb") as f:
        return f.read(4) == b"\x7fELF"

def needed(path):
    return re.findall(r"\(NEEDED\)\s+Shared library: \[(.+?)\]", run("llvm-readelf", "-d", str(path)))

elfs = [p for tree in (root / "opt/python", pathlib.Path(os.environ["VENV_PATH"]))
        for p in sorted(tree.rglob("*")) if p.is_file() and not p.is_symlink() and is_elf(p)]
own = {p.name for p in elfs}
copied = {}

def link(queue):
    while queue:
        name = queue.pop()
        if name in own or name in copied:
            continue
        real = (pathlib.Path("/usr/lib") / name).resolve(strict=True)
        shutil.copy2(real, lib / real.name)
        if real.name != name:
            (lib / name).symlink_to(real.name)
        copied[name] = real
        queue += needed(real)

link([name for p in elfs for name in needed(p)])
modules = []
if "libcrypto.so.3" in copied:
    (lib / "ossl-modules").mkdir()
    for module in sorted(pathlib.Path("/usr/lib/ossl-modules").glob("*.so")):
        shutil.copy2(module, lib / "ossl-modules" / module.name)
        modules.append(module)
        link(needed(module))

shipped = elfs + [lib / real.name for real in copied.values()] + [lib / "ossl-modules" / m.name for m in modules]
gcc_runtime = re.compile(r"lib(gcc_s|stdc\+\+|atomic|gomp|quadmath|ssp|itm|gfortran|[altu]san)\.so")
gcc = [f"{p}: {name}" for p in shipped for name in [p.name, *needed(p)] if gcc_runtime.match(name)]
if gcc:
    sys.exit("GCC's runtime libraries, or files linked to them:\n" + "\n".join(gcc))
if readline.backend != "editline":
    sys.exit(f"CPython's readline module uses {readline.backend}")

def component(name, version, licence, purl=None, cpe=None, **properties):
    c = {"type": "library", "name": name, "licenses": [{"expression": licence}]}
    if version:
        c["version"] = version
        c["purl"] = purl or f"pkg:generic/{name}@{version}"
        if cpe:
            c["cpe"] = f"cpe:2.3:a:{cpe}:{version.split('-r')[0]}:*:*:*:*:*:*:*"
    if properties:
        c["properties"] = [{"name": k.replace("_", "-"), "value": v} for k, v in properties.items()]
    return c

def chimera(path):
    pkgver = re.search(r"is owned by (\S+)", run("apk", "info", "--who-owns", str(path))).group(1)
    name, version = re.fullmatch(r"(.+)-([^-]+-r\d+)", pkgver).groups()
    licence = re.search(rf"^{re.escape(pkgver)} \S+ \{{\S+\}} \((.*)\) \[installed\]$", run("apk", "list", "-I", name), re.M).group(1)
    return name, version, licence

cpes = {"musl": "musl-libc:musl", "openssl3-libs": "openssl:openssl"}
packages = sorted({chimera(path) for path in [pathlib.Path("/usr/lib") / name for name in copied] + modules})
components = [component(name, version, licence, f"pkg:apk/chimera/{name}@{version}?arch={platform.machine()}", cpes.get(name))
              for name, version, licence in packages]
musl = next(f"musl {version}" for name, version, _ in packages if name == "musl")
python = ".".join(map(str, sys.version_info[:3]))
in_python = {"compiled-into": f"cpython {python}"}
components += [
    component("mimalloc", None, "MIT", compiled_into=musl),
    component("cpython", python, "Python-2.0", cpe="python:python"),
    component("openssl", ssl.OPENSSL_VERSION.split()[1], "Apache-2.0", cpe="openssl:openssl", **in_python),
    component("sqlite", sqlite3.sqlite_version, "blessing", cpe="sqlite:sqlite", **in_python),
    component("zlib", zlib.ZLIB_RUNTIME_VERSION, "Zlib", cpe="zlib:zlib", **in_python),
    component("expat", pyexpat.EXPAT_VERSION.removeprefix("expat_"), "MIT", cpe="libexpat_project:libexpat", **in_python),
    component("mpdecimal", decimal.__libmpdec_version__, "BSD-2-Clause", cpe="bytereef:mpdecimal", **in_python),
    component("ncurses", ".".join(map(str, curses.ncurses_version[:2])), "X11", cpe="gnu:ncurses", **in_python),
    component("libedit", None, "BSD-3-Clause", **in_python),
    component("libffi", None, "MIT", **in_python),
    component("bzip2", None, "bzip2-1.0.6", **in_python),
    component("xz", None, "0BSD", **in_python),
    component("libuuid", None, "BSD-3-Clause", **in_python),
]
tzdb = chimera(pathlib.Path("/usr/share/zoneinfo/UTC"))
components.append(component(tzdb[0], tzdb[1], "LicenseRef-Public-Domain", f"pkg:apk/chimera/{tzdb[0]}@{tzdb[1]}", "iana:tzdata"))
sbom = {"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1, "components": components}
(root / "usr/share/sbom/runtime.cdx.json").write_text(json.dumps(sbom, indent=2) + "\n")
EOF

FROM scratch AS production-stage

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8 \
    VENV_PATH="/opt/.venv" \
    TZ="America/New_York" \
    PATH="/opt/.venv/bin:/opt/python/bin:/usr/local/bin:/usr/bin:/bin"

COPY --from=builder-base /rootfs/ /
COPY --from=builder-base --chown=1000:1000 /writable/ /
COPY --from=builder-base $VENV_PATH $VENV_PATH

WORKDIR /opt/code
COPY --chown=1000:1000 ./ ./

USER 1000:1000

CMD ["python", "api_entrypoint.py"]
