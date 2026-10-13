FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json build-web.mjs ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./
# Simulação salva fica no volume /data, gravável pelo usuário sem privilégios.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3334
CMD ["node", "server.js"]
