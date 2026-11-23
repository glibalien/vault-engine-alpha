if (process.send) process.send({ type: 'ready' });

process.on('message', (message) => {
  if (message.type !== 'embed' || !process.send) return;
  const contextBytes = Buffer.byteLength(JSON.stringify(message.context), 'utf8');
  process.send({ type: 'embed-result', requestId: message.requestId, vectors: [[contextBytes]] });
});
