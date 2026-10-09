# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production \
    MOCK_DATA_DIR=/data \
    MOCK_GOOGLE_PORT=443 \
    MOCK_CONTROL_PORT=8080 \
    MOCK_CONTROL_HOST=0.0.0.0
RUN mkdir -p /data /ca-public && chown node:node /data /ca-public
USER node
VOLUME ["/data"]
EXPOSE 443 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "src/main.ts"]
