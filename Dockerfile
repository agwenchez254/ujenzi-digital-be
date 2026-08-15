# ----------------------------------------------------
# Stage 1: Build Stage
# ----------------------------------------------------
FROM node:20-alpine AS builder

# Install build dependencies for native packages (bcrypt, prisma)
RUN apk add --no-cache python3 make g++ openssl libc6-compat
RUN npm install -g pnpm

WORKDIR /app

# Copy package manifests & prisma schema first
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# Install all dependencies (including devDependencies required for compilation)
RUN pnpm install --no-frozen-lockfile

# Copy source code and configuration files
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Generate Prisma Client & Build the application
RUN pnpm prisma generate
RUN pnpm run build

# Prune devDependencies to keep only production dependencies in node_modules
RUN pnpm prune --prod

# ----------------------------------------------------
# Stage 2: Production Runner Stage
# ----------------------------------------------------
FROM node:20-alpine AS runner

# Install runtime dependencies for Prisma and OpenSSL
RUN apk add --no-cache openssl libc6-compat
RUN npm install -g pnpm

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PATH="/app/node_modules/.bin:$PATH"

# Copy package manifests & prisma schema
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# Copy production node_modules directly from builder (avoids re-compiling bcrypt)
COPY --from=builder /app/node_modules ./node_modules

# Copy compiled JavaScript output from the builder stage
COPY --from=builder /app/dist ./dist

# Create directory for persistent uploads
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/main"]

