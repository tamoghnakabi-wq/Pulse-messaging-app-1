# Pulse API — Node/Express + Socket.IO
# Built for Docker Compose, Fly.io, and Cloudflare Containers (`wrangler deploy`).
# Cloudflare Containers build for linux/amd64 via Wrangler; do not hardcode --platform here.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# Prefer the lockfile for reproducible images; fall back only when the workspace
# monorepo has not vendored a backend-level lock.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV UPLOAD_DIR=/app/uploads
# ClamAV client (clamdscan talks to compose `clamav` service; daemon not in this image)
RUN apk add --no-cache clamav-clamdscan clamav-libunrar \
  && mkdir -p /app/uploads \
  && chown -R node:node /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY scripts/malware-scan.sh /app/malware-scan.sh
COPY clamd.conf /app/clamd.conf
RUN chmod 755 /app/malware-scan.sh && chown node:node /app/malware-scan.sh /app/clamd.conf
USER node
EXPOSE 8080

# Readiness, not liveness: reports 503 when the Mongo connection is down so an
# orchestrator pulls the container out of rotation instead of serving errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Set MALWARE_SCAN_CMD=/app/malware-scan.sh in compose/production when ClamAV is reachable.
# PORT is overridable (compose uses 5000; Fly / Cloudflare Containers use 8080)
CMD ["node", "dist/server.js"]
