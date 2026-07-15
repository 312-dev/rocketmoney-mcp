# Read-only Rocket Money MCP server.
# Usable standalone (own Fly app) OR built as a submodule inside mcp-gateway.
# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Chromium for the headless auto-login (puppeteer-core drives this system binary,
# so no ~130MB Playwright/Puppeteer browser download). fonts-liberation avoids
# blank glyphs on the login pages. Chromium's shared-lib deps are pulled in as
# apt dependencies of the chromium package itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
# Rotating session cookie + persistent Chromium profile persist here; mount a
# volume in production so the MFA-trusted device profile survives redeploys.
ENV ROCKETMONEY_STATE_DIR=/data/rocketmoney
VOLUME /data
CMD ["node", "dist/index.js"]
