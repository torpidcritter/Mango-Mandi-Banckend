# Builds the customer shop and the staff panel, then serves both with Caddy.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" && exit 1)
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build && npm run shop:build

FROM caddy:2.8-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv/admin
COPY --from=build /src/customer-app/dist /srv/shop
