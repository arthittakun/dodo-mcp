ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ENV CI=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && mkdir -p /workspace/node_modules/.cache/dodo \
    && chown -R node:node /workspace/node_modules/.cache \
    && chown node:node /workspace

COPY --chown=node:node . .
RUN mkdir -p /evidence \
    && chown node:node /evidence \
    && find /ms-playwright -type f -name chrome_sandbox \
      -exec chown root:root {} \; -exec chmod 4755 {} \;

USER node
CMD ["node", "scripts/release-gate.mjs", "--allow-dirty", "--output-dir", "/evidence"]
