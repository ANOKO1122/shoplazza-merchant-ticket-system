FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# 若仓库仅保留预编译 dist（无 src），跳过 tsc，直接使用 COPY 进来的 dist
RUN if [ -f src/index.ts ]; then npm run build; fi && npm prune --production
EXPOSE 4000
CMD ["node", "dist/index.js"]
