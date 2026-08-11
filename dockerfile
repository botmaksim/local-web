# Stage 1: Build the React application
FROM node:20-alpine AS build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
RUN npm run build

# Stage 2: Setup the production Node.js server
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY server.js .
COPY --from=build /app/frontend/dist ./frontend/dist

EXPOSE 9091
CMD ["node", "server.js"]
