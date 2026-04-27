FROM node:22-alpine

WORKDIR /app

# Build context must be Git / compose repo root (.. from this folder); paths are root-relative.
COPY bios-multilevel-platform-services/blockchain/package.json ./blockchain/package.json
RUN cd blockchain && npm install --omit=dev

COPY bios-multilevel-platform-services/blockchain ./blockchain
COPY bios-multilevel-platform-services/database ./database

ENV BLOCKCHAIN_PORT=8092
ENV BLOCKCHAIN_DB_PATH=/data/blockchain-store.json
ENV STEALTH_RELAY_MODE=mock

EXPOSE 8092

CMD ["node", "blockchain/server.js"]
