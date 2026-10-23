FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN if [ -f src/index.ts ]; then npm run build; fi && npm prune --omit=dev
EXPOSE 4001
CMD ["node", "dist/index.js"]
