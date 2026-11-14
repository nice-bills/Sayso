# Sayso as one long-running service: the app, the hosted MCP endpoint, webhooks and the tick loop.
# The browser's on-device Whisper needs two files from @huggingface/transformers and onnxruntime-web;
# a build stage copies just those, so the image carries no native ML binaries.
FROM node:24-slim AS vendor
WORKDIR /v
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && mkdir -p out/transformers out/ort \
 && cp node_modules/@huggingface/transformers/dist/transformers.min.js out/transformers/ \
 && cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded* out/ort/

FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
COPY --from=vendor /v/out ./vendor
ENV NODE_ENV=production PORT=4021
EXPOSE 4021
CMD ["sh", "scripts/start.sh"]
