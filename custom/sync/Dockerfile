FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist/main.js ./main.js
# Volume de estado gravável pelo usuário sem privilégios.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "main.js"]
