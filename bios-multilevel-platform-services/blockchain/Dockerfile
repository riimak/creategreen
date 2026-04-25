FROM node:22-alpine

WORKDIR /app

COPY blockchain ./blockchain

ENV BLOCKCHAIN_PORT=8092
ENV BLOCKCHAIN_DB_PATH=/data/blockchain-store.json
ENV STEALTH_RELAY_MODE=mock

EXPOSE 8092

CMD ["node", "blockchain/server.js"]
