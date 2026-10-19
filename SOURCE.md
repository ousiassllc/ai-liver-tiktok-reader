# Corresponding source / 対応ソース

tiktok-reader is licensed under AGPL-3.0-only (see `LICENSE`). If you interact
with a running instance over a network (HTTP / WebSocket), you are entitled to
receive the complete corresponding source of the version you are talking to,
free of charge (AGPL section 13).

## How to find the source of a running instance

1. Request `GET /source` on the instance. It returns JSON:

   ```json
   {
     "license": "AGPL-3.0-only",
     "version": "<source commit the image was built from>",
     "sourceUrl": "<URL of the corresponding source>"
   }
   ```

   - `version` comes from the `SOURCE_COMMIT` environment variable, which the
     Dockerfile bakes into the image from the `SOURCE_COMMIT` build argument.
   - `sourceUrl` comes from the `TIKTOK_READER_SOURCE_URL` environment variable.
     The Docker build argument of the same name sets its image default; a
     runtime environment variable overrides that default. An unset or empty
     value is reported as `null` and does not provide a source download URL.
     **Anyone who runs a modified copy as a network service must set it to a
     URL from which the modified source can be obtained.**
2. Source instructions and license notices are in the image: `/app/SOURCE.md`, `/app/NOTICE`,
   `/app/LICENSE`, `/app/THIRD_PARTY_NOTICES.txt`, and the OCI labels
   `org.opencontainers.image.revision` / `org.opencontainers.image.licenses`.
   The build-time source URL is recorded in `org.opencontainers.image.source`.
   Runtime environment overrides do not change these image labels.

## Mapping a release to its source

| Artifact | Identifier |
| --- | --- |
| Source snapshot | git tag `src-<SHORT_SHA>` in the published repository (`Source-Commit: <full SHA>` in the commit message) |
| Container image | tag `tiktok-reader:<SHORT_SHA>` (same `<SHORT_SHA>`), label `org.opencontainers.image.revision` |
| Running instance | `GET /source` → `version` |

Record the image digest and the Cloud Run revision that serve it next to this
mapping at deploy time, and keep the source tag of every revision you may roll
back to.

Before setting the source URL, verify that the published tag is accessible
without credentials and contains the source for that image. Use the tag URL,
not a moving branch URL. Creating a private repository or configuring a URL
does not publish its source. Source synchronization and deployment run
independently, so verify that publication has completed before deploying.

The ai-liver Cloud Build configuration accepts the explicit substitution
`_TIKTOK_READER_SOURCE_URL` and passes it to the Docker build. Its default is
empty. It does not derive a URL from a repository name or commit: in particular,
`develop` revisions are not included in the `main`-only public mirror.
Cloud Build does not change an existing Cloud Run `TIKTOK_READER_SOURCE_URL`
environment override. Before deployment and rollback, check whether one is
set and ensure it matches the target image, or remove it to use the image
default. Verify the resulting `GET /source` response after deployment.

## Building from source

See `README.md`. Set `SOURCE_COMMIT` and `TIKTOK_READER_SOURCE_URL` to the
verified source identifier and published tag URL, then build:

```sh
docker build \
  --build-arg SOURCE_COMMIT="$SOURCE_COMMIT" \
  --build-arg TIKTOK_READER_SOURCE_URL="$TIKTOK_READER_SOURCE_URL" .
```

Both arguments are optional for local builds. Their defaults are `unknown`
and an empty URL, respectively; they do not claim that a source has been
published. Operators of modified versions must provide the corresponding
source URL for their version.
The dependency set is pinned by `package-lock.json`; third-party license texts
are in `THIRD_PARTY_NOTICES.txt` (`npm run notices`) and an SBOM is produced by
`npm run sbom`.

Protocol buffer definitions: the `tiktok-live-connector` / `tiktok-live-proto`
npm packages bundle generated code. If a pinned version does not ship the
`.proto` originals, record the upstream repository and commit that they were
generated from in `NOTICE` before publishing.
