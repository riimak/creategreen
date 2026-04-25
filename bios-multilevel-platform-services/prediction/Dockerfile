FROM node:22-alpine

WORKDIR /app

COPY prediction ./prediction

ENV PREDICTION_PORT=8091
ENV BIOS_OUTPUT_DIR=/app/output
ENV PREDICTION_DB_PATH=/data/prediction-store.json

EXPOSE 8091

CMD ["node", "prediction/server.js"]
