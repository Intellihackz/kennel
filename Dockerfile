# Kennel: one image runs the site, the API, the indexer, the job worker and the live scorer.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# the public address and X account are baked into every page's head (canonical links, share cards, sitemap); both are optional
ARG SITE_URL=
ARG X_HANDLE=
ENV SITE_URL=$SITE_URL X_HANDLE=$X_HANDLE
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 8788
CMD ["npx", "tsx", "server/index.ts"]
