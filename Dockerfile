FROM oven/bun:1

# Install system dependencies required by some Baileys crypto libraries
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package.json bun.lockb* ./

RUN bun install

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Start command
CMD [ "bun", "run", "index.js" ]
