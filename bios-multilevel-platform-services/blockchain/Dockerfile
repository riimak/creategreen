FROM node:22-alpine

WORKDIR /app

# Build context must be Git / compose repo root (.. from this folder); paths are root-relative.
COPY bios-multilevel-platform-services/blockchain/package.json ./blockchain/package.json
RUN cd blockchain && npm install --omit=dev

COPY bios-multilevel-platform-services/blockchain ./blockchain
COPY bios-multilevel-platform-services/database ./database
COPY bios-multilevel-platform-services/scripts ./scripts
# database/* uses require('pg'); Node resolves from database/node_modules (not blockchain/node_modules).
RUN cd database && npm install --omit=dev

ENV BLOCKCHAIN_PORT=8092
ENV BLOCKCHAIN_DB_PATH=/data/blockchain-store.json
ENV STEALTH_RELAY_MODE=mock

EXPOSE 8092

CMD ["node", "blockchain/server.js"]
