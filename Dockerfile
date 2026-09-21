# Node app: builds the React frontend, then serves it plus the /api routes that live in server.js.
# (The Python detection server has its own image: Dockerfile.python, or Dockerfile.gpu on a GPU host.)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "server.js"]
