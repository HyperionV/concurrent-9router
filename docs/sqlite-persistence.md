# SQLite Persistence and Deployment Notes

_Last updated: 2026-04-20_

## What Changed

9Router no longer uses whole-file JSON databases on the hot path.

The runtime now uses SQLite as the canonical local persistence layer:

- main state: `${DATA_DIR}/state.sqlite`
- providers, keys, aliases, combos, settings, pricing: stored in SQLite
- usage events, request logs, request details: stored in SQLite
- backups: exported as a versioned JSON envelope that contains a SQLite-native backup payload

The old JSON files are no longer used as the active runtime database:

- `${DATA_DIR}/db.json`
- `~/.9router/usage.json`
- `~/.9router/log.txt`
- `${DATA_DIR}/request-details.json`

Those files are treated as legacy import sources only.

## First Boot Migration Behavior

On first startup against a writable data directory, the app bootstraps SQLite and checks for legacy JSON state.

If legacy files exist, it imports them into `state.sqlite` once and then continues running from SQLite.

Migration scope:

- `db.json` -> app settings, provider connections, provider nodes, proxy pools, aliases, combos, API keys, pricing
- `usage.json` -> usage events
- `log.txt` -> request log rows
- `request-details.json` -> request detail rows

This is a one-way runtime cutover. The app does not keep JSON and SQLite in sync.

## Backup and Restore Contract

Backup/export is still supported, but the format changed.

Current backup format:

- outer format: versioned JSON envelope
- inner payload: SQLite database content encoded in the envelope

Restore behavior:

- current SQLite backup envelopes restore directly into the SQLite runtime
- legacy JSON backups are still accepted and imported through the legacy migration path

This keeps the feature, but removes the old JSON runtime dependency.

## Native Module Requirement

SQLite access uses `better-sqlite3`, which is a native Node module.

That means install-time Node and run-time Node must be ABI-compatible.

The failure mode looks like this:

```text
The module 'better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION X. This version of Node.js requires NODE_MODULE_VERSION Y.
```

This is not a database corruption issue. It means the native addon was installed for one Node runtime and loaded by another.

## Deployment Guidance

### New server or fresh environment

In a normal deployment, this should just work.

You do not need any special workaround as long as you do all of these with the same Node runtime:

1. install dependencies
2. build the app
3. run the app

Typical safe cases:

- Docker image built and run with one Node image/version
- VPS where `npm install`, `npm run build`, and `npm run start` all use the same `node` binary
- CI/CD build and production runtime pinned to the same Node major

### When the earlier incident can happen again

It can happen if one environment installs dependencies and another runtime loads them from the same `node_modules`.

Common causes:

- mixed local toolchains on the same machine
- IDE-bundled Node used for install/rebuild, but system Node used for `npm run dev`
- copying `node_modules` between machines or containers
- mounting a host `node_modules` into a container with a different Node version

### Recommended prevention

- do not reuse `node_modules` across different Node majors
- pin one Node version for the project and use it consistently
- if you change Node major versions, rerun install or rebuild native modules
- in Docker, build and run inside the same image family
- on servers, prefer clean install on the target machine over copying local `node_modules`

Practical rule:

```text
same Node runtime for install + build + run = safe
mixed runtimes against one node_modules = eventually breaks
```

## Operational Checklist

For a new server deploy:

1. install the intended Node version on the server
2. run `npm install`
3. run `npm run build`
4. run `npm run start`
5. verify `/api/settings` and login load successfully

For Docker:

1. build the image
2. run the container
3. do not mount a host `node_modules` over the container install

If you ever see an ABI mismatch again:

1. stop the app
2. make sure the intended `node` is first on `PATH`
3. reinstall or rebuild `better-sqlite3` with that same runtime
4. restart the app with that same runtime
