export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || '요청에 실패했습니다.'), {
      diagnostic: data.diagnostic,
    });
  return data;
}
export async function accountBar(onChange = () => {}) {
  const host = document.getElementById('account-bar');
  const session = await api('/api/session');
  host.replaceChildren();
  const label = document.createElement('span');
  label.textContent = session.user ? session.user.email : '게스트';
  host.append(label);
  if (session.user) {
    const logout = document.createElement('button');
    logout.textContent = '로그아웃';
    logout.type = 'button';
    logout.onclick = async () => {
      if (!confirm('로그아웃하면 실행 중인 테스트가 종료됩니다. 계속할까요?')) return;
      try {
        await api('/api/auth/logout', { method: 'POST', body: '{}' });
        location.assign('/');
      } catch (error) {
        alert(error.message);
      }
    };
    host.append(logout);
  } else {
    const login = document.createElement('a');
    login.textContent = '로그인 / 가입';
    const next = ['/editor', '/game'].includes(location.pathname) ? location.pathname : '/';
    login.href = `/signin?next=${encodeURIComponent(next)}`;
    host.append(login);
  }
  onChange(session);
  return session;
}
