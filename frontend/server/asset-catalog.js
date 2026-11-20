export const assets = new Map([
  ['/', ['home.html', 'text/html; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin/maps/editor', ['map-editor.html', 'text/html; charset=utf-8']],
  ['/admin/maps', ['map-management.html', 'text/html; charset=utf-8']],
  ['/map-management.js', ['map-management.js', 'text/javascript; charset=utf-8']],
  ['/map-management.css', ['map-management.css', 'text/css; charset=utf-8']],
  ['/map-status.js', ['map-status.js', 'text/javascript; charset=utf-8']],
  ['/map-options.js', ['map-options.js', 'text/javascript; charset=utf-8']],
  ['/map-options.css', ['map-options.css', 'text/css; charset=utf-8']],
  ['/map-editor.js', ['map-editor.js', 'text/javascript; charset=utf-8']],
  ['/map-array-transfer.js', ['map-array-transfer.js', 'text/javascript; charset=utf-8']],
  ['/map-editor.css', ['map-editor.css', 'text/css; charset=utf-8']],
  ['/game', ['index.html', 'text/html; charset=utf-8']],
  ['/signin', ['auth.html', 'text/html; charset=utf-8']],
  ['/signup', ['auth.html', 'text/html; charset=utf-8']],
  ['/entry.css', ['entry.css', 'text/css; charset=utf-8']],
  ['/coin-hunter-icon.svg', ['coin-hunter-icon.svg', 'image/svg+xml']],
  ['/assets/login-gameplay.mp4', ['assets/login-gameplay.mp4', 'video/mp4']],
  ['/assets/login-gameplay.jpg', ['assets/login-gameplay.jpg', 'image/jpeg']],
  ['/algorithm-braces.svg', ['algorithm-braces.svg', 'image/svg+xml']],
  ['/entry.js', ['entry.js', 'text/javascript; charset=utf-8']],
  ['/editor', ['editor.html', 'text/html; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/algorithm-languages.js', ['algorithm-languages.js', 'text/javascript; charset=utf-8']],
  ['/prompt-assistant.js', ['prompt-assistant.js', 'text/javascript; charset=utf-8']],
  ['/prompt-builder.js', ['prompt-builder.js', 'text/javascript; charset=utf-8']],
  ['/code-editor.js', ['generated/code-editor.js', 'text/javascript; charset=utf-8']],
  ['/editor.css', ['editor.css', 'text/css; charset=utf-8']],
  ['/account.js', ['account.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/game-presentation.js', ['game-presentation.js', 'text/javascript; charset=utf-8']],
  ['/coin-renderer.js', ['coin-renderer.js', 'text/javascript; charset=utf-8']],
  ['/podium.js', ['podium.js', 'text/javascript; charset=utf-8']],
  ['/result-analysis.js', ['result-analysis.js', 'text/javascript; charset=utf-8']],
  ['/leaderboard.js', ['leaderboard.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/character-renderer.js', ['character-renderer.js', 'text/javascript; charset=utf-8']],
  ['/assets/characters/atlas.png', ['assets/characters/atlas.png', 'image/png']],
  ['/assets/characters/atlas-hammer.png', ['assets/characters/atlas-hammer.png', 'image/png']],
]);
// Pure rules are shared by browser tools and the Node engine. Preserve existing public URLs.
for (const name of [
  'characters.js',
  'algorithm-strategy.js',
  'strategy-templates.js',
  'map-editing.js',
  'map-array.js',
]) {
  const asset = ['../../shared/' + name, 'text/javascript; charset=utf-8'];
  assets.set('/' + name, asset);
  assets.set('/shared/' + name, asset);
}
for (const direction of ['left', 'up', 'right', 'down'])
  assets.set(`/assets/characters/${direction}.png`, [
    `assets/characters/${direction}.png`,
    'image/png',
  ]);
for (const file of [
  'Coins.png',
  'Diamond.png',
  'blackmatter.png',
  'appear_blackmatter.png',
  'frames.json',
])
  assets.set('/assets/coins/' + file, [
    'assets/coins/' + file,
    file.endsWith('.json') ? 'application/json' : 'image/png',
  ]);
