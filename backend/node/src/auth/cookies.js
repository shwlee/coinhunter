export function appendCookie(response, value) {
  const existing = response.getHeader?.('Set-Cookie');
  response.setHeader(
    'Set-Cookie',
    existing ? [value, ...(Array.isArray(existing) ? existing : [existing])] : value,
  );
}
