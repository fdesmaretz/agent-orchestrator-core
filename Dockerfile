# --- STAGE 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies including devDependencies
RUN npm ci

# Copy tsconfig and source files
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to JavaScript
RUN npm run build

# --- STAGE 2: Production ---
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Set node environment to production
ENV NODE_ENV=production

# Copy dependency definitions
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled build from builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Expose port
EXPOSE 3000

# Run as non-root user
USER node

# Start the application
CMD ["node", "dist/server.js"]
