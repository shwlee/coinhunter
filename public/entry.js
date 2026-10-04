import { api, accountBar } from './account.js';
const $ = (id) => document.getElementById(id);
const status = (message) => {
  $('entry-status').textContent = message;
};
const requested = new URLSearchParams(location.search).get('next');
// Only application destinations are accepted, never URLs supplied by a caller.
const next = ['/', '/editor', '/game'].includes(requested) ? requested : '/';
try {
  if (document.body.dataset.page === 'home') {
    const session = await accountBar();
    if (!session.user) location.replace('/signin');
  } else {
    const signup = location.pathname === '/signup';
    for (const name of ['signin', 'signup'])
      $(name + '-tab').href = `/${name}?next=${encodeURIComponent(next)}`;
    $(signup ? 'signup-tab' : 'signin-tab').setAttribute('aria-current', 'page');
    document.title = `${signup ? '가입' : '로그인'} · Coin Hunter`;
    $('destination').textContent =
      next === '/'
        ? '로그인하면 홈 화면으로 이동합니다.'
        : `로그인 후 ${next === '/editor' ? '알고리즘 작업실' : '게임 플레이'}로 이동합니다.`;
    if (signup)
      $('auth-description').textContent =
        '별도 비밀번호 없이 회사 계정으로 가입합니다. 기존 계정이면 바로 로그인됩니다.';
    const session = await api('/api/session');
    if (session.user) {
      location.replace(next);
    } else {
      $('guest-link').hidden = false;
      $('guest-help').hidden = false;
      if (session.mock) {
        $('mock-identity').hidden = false;
        for (const email of session.identities) $('identity').add(new Option(email, email));
        $('authenticate').disabled = false;
        $('authenticate').textContent = signup
          ? '목업 계정으로 가입하고 계속'
          : '목업 로그인하고 계속';
      } else {
        $('authenticate').textContent = 'Google 로그인 준비 중';
        status('Google 인증 연결 설정이 필요합니다.');
      }
      $('auth-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if ($('authenticate').disabled) return;
        $('authenticate').disabled = true;
        status('로그인하고 있습니다…');
        try {
          await api('/api/auth/mock', {
            method: 'POST',
            body: JSON.stringify({ email: $('identity').value }),
          });
          location.replace(next);
        } catch (error) {
          status(error.message);
          $('authenticate').disabled = false;
        }
      });
    }
  }
} catch (error) {
  status(error.message);
}
