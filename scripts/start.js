import 'dotenv/config';
import { createGameServer } from '../src/server.js';
import { createAuthoring } from '../src/authoring-api.js';

const { server, close } = createGameServer({
  authoring: createAuthoring({
    aiDiagnostics:
      process.env.AI_DIAGNOSTICS === 'true'
        ? ({ code, source, providerCode }) =>
            console.warn('AI diagnostic:', JSON.stringify({ code, source, providerCode }))
        : undefined,
  }),
});
const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => console.log(`Coin Hunter: http://127.0.0.1:${port}`));
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await close();
  });
