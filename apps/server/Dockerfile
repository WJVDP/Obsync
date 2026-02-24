FROM node:20-alpine
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm install

COPY apps/server ./apps/server
COPY packages/shared ./packages/shared

RUN npm run -w @obsync/shared build && npm run -w @obsync/server build

EXPOSE 8080
CMD ["npm", "run", "-w", "@obsync/server", "start"]
