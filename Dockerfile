# Neopolis LeadDesk — production image
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# SQLite database lives on a mounted volume (Railway: mount at /data)
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
