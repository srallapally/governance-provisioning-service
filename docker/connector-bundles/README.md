# Connector bundles

This directory is the default `CONNECTOR_BUNDLES_DIR` build context for the
production `Dockerfile` -- empty on purpose. This repository does not own
any real connector bundle; those live in the `external-connectors` repo (see
the framework's docs) or wherever your organization builds them.

A real deployment supplies real bundles here before building, or overrides
the build arg to point at a different checkout:

```bash
docker build --build-arg CONNECTOR_BUNDLES_DIR=../external-connectors/dist .
```

`docker-compose.yml`'s local-dev stack does not use this directory at all --
it bind-mounts `test/fixtures/connectors` (the same fixture connector the
test suite and soak scripts already use) over `/app/connector-bundles` at
container start, so a fresh `docker compose up` has something to exercise
without needing a real connector.
