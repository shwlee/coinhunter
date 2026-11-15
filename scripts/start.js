import 'dotenv/config';
if (process.argv[2] !== 'legacy') {
  const { startBackend } = await import('./backend.js');
  await startBackend({ frontend: true });
} else {
  const { createGameServer } = await import('../backend/node/src/server.js');
  const { server, close } = createGameServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => console.log(`Coin Hunter: http://127.0.0.1:${port}`));
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await close();
    });
}
