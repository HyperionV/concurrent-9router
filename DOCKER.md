# Docker

This project ships with a `Dockerfile` for building and running 9Router in a container.

The runtime is Node-based. Bun is not a supported production runtime for this branch because the app now uses `better-sqlite3` for SQLite persistence.

## Build image

```bash
docker build -t 9router .
```

## Start container

```bash
docker run --rm \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  9router
```

The app listens on port `20128` in the container.

## What the volume does

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

`9router` stores its runtime database at `path.join(DATA_DIR, "state.sqlite")`.
Without `DATA_DIR`, the app falls back to the current user's home directory. In the container, set `DATA_DIR=/app/data` so the bind mount is actually used.

With the example above, the database file is:

```text
/app/data/state.sqlite
```

and it is persisted on the host at:

```text
$HOME/.9router/state.sqlite
```

## Stop container

```bash
docker stop 9router
```

## Run in background

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  9router
```

## View logs

```bash
docker logs -f 9router
```

## Optional environment variables

You can override runtime env vars with `-e`.

Example:

```bash
docker run --rm \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  9router
```

## Rebuild after code changes

```bash
docker build -t 9router .
```

Then restart the container.

## Runtime requirements

- build and run the image with Node, not Bun
- do not mount a host `node_modules` into the container
- if `better-sqlite3` fails to load, rebuild the image instead of reusing dependencies built under another runtime
