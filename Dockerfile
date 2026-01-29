FROM node:22-alpine

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 5173 4173 4000

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

