# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script builds dist/ with TypeScript, a dev dependency. The image runs the .ts sources directly.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY bin ./bin
COPY schema ./schema
RUN printf '#!/bin/sh\nexec node /app/bin/admin-sdk-mock.ts "$@"\n' > /usr/local/bin/admin-sdk-mock \
 && printf '#!/bin/sh\nexec node /app/bin/mockctl.ts "$@"\n' > /usr/local/bin/mockctl \
 && chmod 755 /usr/local/bin/admin-sdk-mock /usr/local/bin/mockctl
ENV NODE_ENV=production \
    MOCK_DATA_DIR=/data \
    MOCK_GOOGLE_HOST=0.0.0.0 \
    MOCK_GOOGLE_PORT=443 \
    MOCK_CONTROL_PORT=8080 \
    MOCK_CONTROL_HOST=0.0.0.0 \
    MOCK_PROXY_HOST=0.0.0.0 \
    MOCK_CONFIG_DEFAULT=/config/admin-sdk-mock.json
RUN mkdir -p /data /ca-public /config && chown node:node /data /ca-public
USER node
VOLUME ["/data"]
EXPOSE 443 3128 8080
# /health answers 503 until every domain is ready. A large seed blocks the event loop, so the
# start period covers the action's 600-second ready wait. The shell form reads the control port.
HEALTHCHECK --interval=5s --timeout=3s --start-period=600s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:${MOCK_CONTROL_PORT:-8080}/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "bin/admin-sdk-mock.ts", "start"]
