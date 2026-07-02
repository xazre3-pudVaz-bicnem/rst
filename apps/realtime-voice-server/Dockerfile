# RST リアルタイム音声中継サーバー（Render/Railway/Fly.io/Cloud Run 共通）
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
