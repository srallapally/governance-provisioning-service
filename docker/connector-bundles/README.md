# Connector bundles

This directory is what the production `Dockerfile` bakes into the image at
`/app/connector-bundles` -- empty on purpose. This repository does not own
any real connector bundle; those live in the `external-connectors` repo (see
the framework's docs) or wherever your organization builds them.

A real deployment replaces the contents of this directory with real bundles
before running `docker build`:

```bash
rm -rf docker/connector-bundles/*
cp -r /path/to/external-connectors/dist/* docker/connector-bundles/
docker build -t governance-provisioning-service:local .
```

This has to be a copy into the build context, not a build ARG pointing
elsewhere -- Docker's `COPY` instruction can never reach outside the build
context directory (the directory passed as `docker build`'s final
argument), no matter what value a `--build-arg` carries. A path like
`--build-arg CONNECTOR_BUNDLES_DIR=../external-connectors/dist` looks like
it should work and doesn't: it fails at build time with
`"...": not found`, because the daemon never received anything outside `.`
in the first place. Bringing the real bundles inside the context first is
the only way around that.

`docker-compose.yml`'s local-dev stack does not use this directory at all --
it bind-mounts `test/fixtures/connectors` (the same fixture connector the
test suite and soak scripts already use) over `/app/connector-bundles` at
container start, so a fresh `docker compose up` has something to exercise
without needing a real connector.
