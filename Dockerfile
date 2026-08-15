# ----------------------------------------------------
# Stage 1: Build Stage
# ----------------------------------------------------
FROM node:24.18.0-alpine AS builder

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package manifests & prisma schema first to leverage layer caching
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# Install all dependencies (including devDependencies required for nest build)
RUN pnpm install --frozen-lockfile

# Copy source code and config files
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Generate Prisma Client & Build the application
RUN pnpm prisma generate
RUN pnpm run build

# ----------------------------------------------------
# Stage 2: Production Runner Stage
# ----------------------------------------------------
FROM node:24.18.0-alpine AS runner

# Install pnpm and openssl (required for Prisma on alpine)
RUN apk add --no-cache openssl
RUN npm install -g pnpm

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package manifests & prisma schema
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# Install only production dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy compiled JavaScript output from the builder stage
COPY --from=builder /app/dist ./dist

# Generate Prisma Client in the runner stage
RUN pnpm prisma generate

# Create directory for file uploads if local filesystem storage is used
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/main"]
