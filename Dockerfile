FROM node:20-alpine AS client-build

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/. .
RUN npm run build

FROM node:20-alpine AS server-deps

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/src ./src
COPY --from=client-build /app/client/dist ./client-dist

EXPOSE 3000

CMD ["node", "src/server.js"]