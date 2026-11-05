FROM node:24-bookworm-slim AS source
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci
COPY . .

FROM source AS api
ENV HOST=0.0.0.0 PORT=4100 PAYMENT_MODE=simulated
USER node
EXPOSE 4100
CMD ["node", "apps/api/src/server.js"]

FROM source AS web-build
RUN npm run build

FROM nginx:stable-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
