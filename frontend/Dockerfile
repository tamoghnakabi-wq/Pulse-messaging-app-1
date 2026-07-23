# Build context must be monorepo root (see docker-compose.yml) so `shared/` is available.
FROM node:20-alpine AS builder
WORKDIR /repo/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
COPY shared /repo/shared
# Empty = browser uses same origin; nginx proxies /api, /socket.io, /uploads
ARG VITE_API_URL=
ARG VITE_SOCKET_URL=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
RUN npm run build

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
