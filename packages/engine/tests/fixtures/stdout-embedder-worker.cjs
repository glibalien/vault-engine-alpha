// An embedder worker that logs on stdout for each embed, as the real one does.
process.send?.({ type: 'ready' });

process.on('message', (message) => {
  if (message.type === 'shutdown') process.exit(0);
  if (message.type !== 'embed') return;

  console.log('[stdout-embedder-worker] embed served');
  process.send?.({
    type: 'embed-result',
    requestId: message.requestId,
    vectors: [Array(256).fill(0.5)],
  });
});
