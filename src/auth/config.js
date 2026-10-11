// Read configuration without exposing credentials to HTTP responses or logs.
export function readAuthConfig(env = process.env) {
  const mode = env.AUTH_MODE || (env.NODE_ENV === 'production' ? 'disabled' : 'mock');
  if (!['mock', 'google', 'disabled'].includes(mode))
    throw new Error('AUTH_MODE는 mock, google, disabled 중 하나여야 합니다.');
  if (mode !== 'google') return { mode };
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
    if (!env[key]?.trim()) throw new Error(`Google 인증 설정이 필요합니다: ${key}`);
  }
  let callback;
  try {
    callback = new URL(env.GOOGLE_REDIRECT_URI.trim());
  } catch {
    throw new Error('GOOGLE_REDIRECT_URI가 올바른 URL이 아닙니다.');
  }
  const local = ['127.0.0.1', 'localhost'].includes(callback.hostname);
  if (
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== '/api/auth/google/callback' ||
    (callback.protocol !== 'https:' &&
      !(callback.protocol === 'http:' && local && env.NODE_ENV !== 'production'))
  )
    throw new Error(
      'Google 콜백은 HTTPS 또는 개발용 localhost HTTP 주소의 /api/auth/google/callback이어야 합니다.',
    );
  const list = (key) => [
    ...new Set(
      (env[key] || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const allowedDomains = list('GOOGLE_ALLOWED_DOMAINS');
  const allowedEmails = list('GOOGLE_ALLOWED_EMAILS');
  if (
    allowedDomains.some((domain) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) ||
    allowedEmails.some((email) => !/^[^\s@]+@[^\s@]+$/.test(email))
  )
    throw new Error('Google 허용 도메인·이메일 설정을 확인하세요.');
  if (env.NODE_ENV === 'production' && !allowedDomains.length && !allowedEmails.length)
    throw new Error(
      '운영 Google 인증에는 GOOGLE_ALLOWED_DOMAINS 또는 GOOGLE_ALLOWED_EMAILS가 필요합니다.',
    );
  return {
    mode,
    clientId: env.GOOGLE_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
    redirectUri: callback.href,
    secure: callback.protocol === 'https:',
    allowedDomains,
    allowedEmails,
  };
}
