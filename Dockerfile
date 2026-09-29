FROM node:24-bookworm-slim AS build

# better-sqlite3 may need to compile its native module.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
COPY public ./public
COPY server/tsconfig.json ./server/
COPY server/src ./server/src

RUN npm run build && npm run build --prefix server

FROM build AS production-dependencies
WORKDIR /app/server
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app/server

COPY --from=production-dependencies /app/server/node_modules ./node_modules
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/dist /app/dist

RUN mkdir -p /app/server/data && chown node:node /app/server/data
USER node
EXPOSE 3000
CMD ["npm", "start"]
