process.send?.({ type: 'ready' });

process.on('message', (message) => {
  if (message.type === 'shutdown') process.exit(0);
  if (message.type !== 'embed') return;

  const delayMs = message.text === 'slow' ? 100 : 0;
  setTimeout(() => {
    process.send?.({
      type: 'embed-result',
      requestId: message.requestId,
      vectors: [Array(256).fill(0.5)],
    });
  }, delayMs);
});
