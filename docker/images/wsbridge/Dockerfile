# PBX-NG · wsbridge (cliente SIP-over-WSS hacia troncales WebRTC remotas)
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY index.js ./
ENV NODE_ENV=production
CMD ["node", "index.js"]
