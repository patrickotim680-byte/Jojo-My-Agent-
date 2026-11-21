FROM node:20-bookworm
RUN apt-get update && apt-get install -y python3 python3-pip golang git curl build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install && npx playwright install --with-deps chromium
COPY . .
ENV JOJO_SANDBOX=host PORT=7860
EXPOSE 7860
CMD ["node", "src/server.js"]
