FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:24-alpine

# Compressing snapshot tarballs. Node ships a zstd binding, but single-threaded:
# over a 762 MB tar the binary with -T0 took 1.5 s where gzip took ~60 s, and the
# capture path shells out to it whenever it is present.
RUN apk add --no-cache zstd

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
# Optional custom security profiles (e.g. a hardened seccomp profile) referenced
# by config. Resolved relative to the working directory at runtime.
COPY --from=builder /app/security ./security

EXPOSE 3200

CMD ["node", "dist/main"]
