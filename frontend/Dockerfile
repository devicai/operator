# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

# Runtime stage
FROM nginx:1.27-alpine

# Static assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Reverse-proxy config: routes /api and /ws to the backend service.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
