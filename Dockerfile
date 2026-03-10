FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY server/package.json /app/server/package.json
COPY server/package-lock.json /app/server/package-lock.json
WORKDIR /app/server
RUN npm install

# Copy app source + assets
WORKDIR /app
COPY server /app/server
COPY build-web /app/build-web

EXPOSE 8080

WORKDIR /app/server
CMD ["node", "server.js"]
