# PBX-NG · Dashboard (Next.js 14, salida standalone)
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
ARG API_URL=http://api:3000
ENV API_URL=$API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Imagen final: solo lo que el server standalone necesita (~200 MB en vez de ~1.4 GB)
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Pisa el server.js genérico del standalone con el nuestro (Next + proxy a la API con
# X-Forwarded-For real); lee la config embebida en .next/required-server-files.json.
COPY --from=build /app/server.js ./server.js
EXPOSE 3001
CMD ["node", "server.js"]
