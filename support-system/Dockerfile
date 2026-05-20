FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN if [ -f src/index.ts ]; then npm run build; fi && npm prune --production
EXPOSE 4001
CMD ["node", "dist/index.js"]
