# apps/server/Dockerfile
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
# Copy pre-built web app into the dist folder so the server can serve it
RUN if [ -d "public" ]; then cp -r public dist/public; fi
EXPOSE 8080
CMD ["npm", "start"]