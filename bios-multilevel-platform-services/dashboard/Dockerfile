FROM denoland/deno:alpine

WORKDIR /app

COPY dashboard ./dashboard

WORKDIR /app/dashboard

ENV PREDICTION_SERVICE_URL=http://prediction:8091
ENV BLOCKCHAIN_SERVICE_URL=http://blockchain:8092

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "main.ts"]
