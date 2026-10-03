export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청에 실패했습니다.');
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
        location.reload();
      } catch (error) {
        alert(error.message);
      }
    };
    host.append(logout);
  } else if (session.mock) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', '개발용 로그인 계정');
    for (const email of session.identities) select.add(new Option(email, email));
    const login = document.createElement('button');
    login.textContent = '목업 로그인';
    login.type = 'button';
    login.onclick = async () => {
      try {
        await api('/api/auth/mock', {
          method: 'POST',
          body: JSON.stringify({ email: select.value }),
        });
        location.reload();
      } catch (error) {
        alert(error.message);
      }
    };
    host.append(select, login);
  } else {
    label.textContent = 'Google 로그인 연결 설정이 필요합니다.';
  }
  onChange(session);
  return session;
}
