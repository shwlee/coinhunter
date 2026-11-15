import 'dotenv/config';
const command = process.argv[2];
const value = process.argv[3];
const extra = process.argv.slice(4);
if (
  !['bootstrap', 'grant'].includes(command) ||
  !value ||
  (command === 'grant' && extra.length) ||
  (command === 'bootstrap' &&
    extra.length &&
    (extra.length !== 2 || extra[0] !== '--provider' || !['mock', 'google'].includes(extra[1])))
) {
  console.error(
    'Use admin:bootstrap -- <email> [--provider mock|google] or admin:grant -- <user-id>. Stop Operations first.',
  );
  process.exitCode = 1;
} else {
  const provider = extra[1] || (process.env.AUTH_MODE === 'google' ? 'google' : 'mock');
  process.argv = [
    process.argv[0],
    process.argv[1],
    command,
    value,
    ...(command === 'bootstrap' ? [provider] : []),
  ];
  await import('./backend-maintenance.js');
}
