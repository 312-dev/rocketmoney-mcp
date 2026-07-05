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
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
# Rotating session cookie persists here; mount a volume in production.
ENV ROCKETMONEY_STATE_DIR=/data/rocketmoney
VOLUME /data
CMD ["node", "dist/index.js"]
