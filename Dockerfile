# Stage 1: Build the React application
FROM node:22-alpine AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Production Node.js server
FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js .
COPY src/ ./src/
COPY --from=build /app/frontend/dist ./frontend/dist

EXPOSE 9091
CMD ["node", "server.js"]
