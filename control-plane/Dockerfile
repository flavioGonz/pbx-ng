# PBX-NG · Control Plane (Node/Express + ARI/AMI + Socket.io)
FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN chmod +x /app/docker-entrypoint.sh
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
