# Pulse API — Node/Express + Socket.IO
# Built for Docker Compose, Fly.io, and Cloudflare Containers (`wrangler deploy`).
# Cloudflare Containers build for linux/amd64 via Wrangler; do not hardcode --platform here.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
# Workspaces monorepo may not ship backend/package-lock.json — install is fine here.
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV UPLOAD_DIR=/app/uploads
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 8080
# PORT is overridable (compose uses 5000; Fly / Cloudflare Containers use 8080)
CMD ["node", "dist/server.js"]
