# Sayso as one long-running service: the app, the hosted MCP endpoint, webhooks and the tick loop.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
ENV NODE_ENV=production PORT=4021
EXPOSE 4021
CMD ["sh", "scripts/start.sh"]
