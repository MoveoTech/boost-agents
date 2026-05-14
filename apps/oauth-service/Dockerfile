FROM node:20-slim AS base
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]
