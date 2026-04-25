const { processEvent } = require('./server');

async function startAmqpConsumer() {
  const mode = process.env.BLOCKCHAIN_AMQP_MODE || 'off';
  if (mode === 'off') return { started: false, reason: 'BLOCKCHAIN_AMQP_MODE=off' };

  let amqp;
  try {
    amqp = require('amqplib');
  } catch (error) {
    throw new Error('amqplib is required when BLOCKCHAIN_AMQP_MODE is enabled');
  }

  const inputHost = process.env.BLOCKCHAIN_INPUT_HOST || 'amqp://localhost';
  const inputQueue = process.env.BLOCKCHAIN_INPUT_QUEUE;
  if (!inputQueue) throw new Error('BLOCKCHAIN_INPUT_QUEUE is required');

  const outputQueue = process.env.BLOCKCHAIN_OUTPUT_QUEUE || 'map-events';
  const connection = await amqp.connect(inputHost);
  const channel = await connection.createChannel();
  await channel.assertQueue(inputQueue, { durable: true });
  if (mode === 'consume_publish') await channel.assertQueue(outputQueue, { durable: true });

  await channel.consume(inputQueue, async message => {
    if (!message) return;
    try {
      const event = JSON.parse(message.content.toString('utf8'));
      const result = await processEvent(event);
      if (mode === 'consume_publish') {
        channel.sendToQueue(outputQueue, Buffer.from(JSON.stringify(result)), { persistent: true });
      }
      channel.ack(message);
    } catch (error) {
      channel.nack(message, false, false);
    }
  });

  return { started: true, inputQueue, outputQueue, mode };
}

if (require.main === module) {
  startAmqpConsumer()
    .then(info => console.log(JSON.stringify(info, null, 2)))
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { startAmqpConsumer };
