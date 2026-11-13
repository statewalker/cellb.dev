# The sandbox mesh's hub as an image. Build context: this folder, after `pnpm build` (dist/).
#
#   pnpm --filter @statewalker/cellb-sandbox-hub build
#   docker build -t cellb-sandbox-hub apps/sandbox-hub
#   docker compose -f apps/sandbox-hub/deploy/compose.yml up -d
#
# Prefer HOST networking (compose.yml does). Behind Docker's bridge network the members' WebRTC
# upgrade to the hub can fail (httpeers saw it on its servers; a plain local Docker passed): they
# then fall back to the public relay and nobody can reach a published sandbox. The hub warns about
# each such member, and `members` shows it.
# BASE: another registry's copy when Docker Hub limits pulls (mirror.gcr.io/library/node:22-slim).
ARG BASE=node:22-slim
FROM ${BASE}
WORKDIR /app
# Not bundled: the native WebRTC module (prebuilt for linux-x64 and arm64) and CellB, which runs
# the apps tabs deploy to the hub (keep its version the workspace's, packages/cellb).
# Behind a TLS-intercepting proxy: --secret id=ca,src=/path/to/ca.pem (optional, not kept in the image).
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm init -y >/dev/null && npm install --omit=dev node-datachannel@0.33.6 @statewalker/cellb@0.8.8 esbuild@0.28.2 && npm cache clean --force
COPY dist/sandbox-hub.mjs dist/bridge.mjs ./
RUN printf '{"type":"module","private":true}\n' > package.json && mkdir -p /data && chown node:node /data
ENV SANDBOX_HUB_DIR=/data NODE_ENV=production
# The mesh's identity and state: keep this volume, it IS the mesh (a new key is a new mesh).
VOLUME /data
USER node
ENTRYPOINT ["node", "/app/sandbox-hub.mjs"]
CMD ["start"]
