---
title: Build the images
sidebar_position: 2
---

# Build the images

FINOS Workspace runs from four images. Each release publishes them on Docker Hub:

| Image | On Docker Hub | What runs from it |
|---|---|---|
| `workspace-backend` | `finos/workspace-backend` | The API, the worker and the init step |
| `workspace-web` | `finos/workspace-web` | The web app |
| `workspace-agent` | `finos/workspace-agent` | The agent |
| `workspace-agent-mcp` | `finos/workspace-agent-mcp` | The agent's MCP server |

The four images of a release carry the release's tag, including its leading `v`, and `latest`. They are built for `linux/amd64` only. An arm64 machine runs them through emulation, which is slower. [Deploy with Docker Compose](../deploy/deploy-with-docker-compose.md) and [Deploy on Kubernetes](../deploy/deploy-on-kubernetes.mdx) pull them from Docker Hub, so deploying a release does not need this page.

Build the images yourself when you change the code, when you use a [white label](../../features/white-label/index.md) setting that is read when the web app is built, or when your servers cannot reach Docker Hub. This page builds all four from a clone of the repository and pushes them to your own registry.

## What you need

- Docker with BuildKit. Docker Engine and Docker Desktop use it by default.
- A clone of the repository. Run the commands on this page from its root folder.
- A GitHub account that can read the packages of `finos-labs`, logged in to `ghcr.io` as [Log in to the container registry](run-the-stack-from-source.md#log-in-to-the-container-registry) shows. The Node base below is in GitHub's container registry, which serves it to logged-in readers only.
- A registry that your servers can pull from. Below, `<registry>` stands for it and `<version>` for the version you give the images.

## The Node base

The agent and its MCP server run on `finos-node`, a build of Node that the repository compiles and releases itself, and the web app is built with it. The web app's Dockerfile has no other way to get Node, so it does not build without the base. The agent's Dockerfile compiles Node from source when it does not get the base. The agent's README puts that at about 20 minutes on a fast machine that builds for its own architecture, and it takes hours under emulation. The release run of `finos-node` 26.12.1-1 took over four hours on a GitHub-hosted runner.

So use the released base. `docker-compose.yml` names the release that the repository builds with, and this command reads it from there:

```bash
NODE_BASE=$(grep -m 1 -o 'docker-image://[^ ]*' docker-compose.yml)
```

The base is released for `linux/amd64`, so the web app and agent images are built for that platform too. On an x86-64 machine that is the default. On a Mac with Apple silicon, the `--platform linux/amd64` in the commands below makes Docker build them through emulation, which is slower but works.

## Build the images

```bash
docker build -f backend-api/backend/fastapi.Dockerfile \
  -t <registry>/workspace-backend:<version> backend-api/backend

docker build --platform linux/amd64 --build-context "node=$NODE_BASE" \
  -t <registry>/workspace-web:<version> frontend

docker build --platform linux/amd64 --build-context "node=$NODE_BASE" \
  --target agent --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  -t <registry>/workspace-agent:<version> agent

docker build --platform linux/amd64 --build-context "node=$NODE_BASE" \
  --target agent-mcp \
  -t <registry>/workspace-agent-mcp:<version> agent
```

The backend image is built for the machine you build on. If you build on Apple silicon for x86-64 servers, add `--platform linux/amd64` to its command too. `agent` and `agent-mcp` are the names of the two stages in `agent/Dockerfile` that the agent images are built from.

The worker is the backend image with the command `python base_workers.py`, and the init step is the backend image with the commands that [Production setup](../deploy/production-setup.mdx#the-order-in-which-things-start) lists. `GIT_SHA` puts the commit into the traces of the agent as its version.

The builds download packages from npm and from other registries along the way. If a network error stops one halfway, run the same command again: Docker reuses the steps that already finished.

## Push the images

```bash
docker push <registry>/workspace-backend:<version>
docker push <registry>/workspace-web:<version>
docker push <registry>/workspace-agent:<version>
docker push <registry>/workspace-agent-mcp:<version>
```

Then deploy them with [Docker Compose](../deploy/deploy-with-docker-compose.md) or on [Kubernetes](../deploy/deploy-on-kubernetes.mdx).
