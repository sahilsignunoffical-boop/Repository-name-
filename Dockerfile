FROM ghcr.io/puppeteer/puppeteer:latest

USER root

# Setup workspace environment
WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy master files
COPY . .

# Run bot engine
CMD ["npm", "start"]
