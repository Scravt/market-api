FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 UPLOAD_DIR=/data/uploads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "src/server.ts"]
