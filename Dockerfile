FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
  curl \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
