import { api, accountBar } from './account.js';

const $ = (id) => document.getElementById(id);
let currentUser;
let accounts = [];
let busy = false;

function feedback(message, error = false) {
  $('user-feedback').textContent = message;
  $('user-feedback').classList.toggle('error', error);
}

function render() {
  const query = $('user-search').value.trim().toLowerCase();
  const roleFilter = $('role-filter').value;
  const activeFilter = $('active-filter').value;
  const visible = accounts.filter(
    (user) =>
      user.email.toLowerCase().includes(query) &&
      (roleFilter === 'all' || user.role === roleFilter) &&
      (activeFilter === 'all' || user.active === (activeFilter === 'active')),
  );
  $('user-count').textContent = `전체 ${accounts.length}명 · 표시 ${visible.length}명`;
  $('users-empty').hidden = visible.length !== 0;
  $('refresh-users').disabled = busy;
  $('users').setAttribute('aria-busy', String(busy));
  $('users').replaceChildren();
  const adminCount = accounts.filter((user) => user.active && user.role === 'admin').length;
  for (const user of visible) {
    const self = user.id === currentUser.id;
    const lastAdmin = user.active && user.role === 'admin' && adminCount === 1;
    const protectedAccount = self || lastAdmin;
    const row = document.createElement('article');
    row.className = 'admin-user-row';
    row.setAttribute('role', 'listitem');
    row.dataset.userId = user.id;
    const identity = document.createElement('div');
    identity.className = 'user-identity';
    const email = document.createElement('strong');
    email.textContent = user.email;
    const state = document.createElement('span');
    state.className = `user-state${user.active ? '' : ' inactive'}`;
    state.textContent = `${user.active ? '이용 가능' : '이용 중지'} · ${user.role === 'admin' ? '관리자' : '일반 사용자'}${self ? ' · 내 계정' : ''}`;
    identity.append(email, state);
    if (protectedAccount) {
      const reason = document.createElement('small');
      reason.textContent =
        self && lastAdmin
          ? '본인 계정이며 마지막 활성 관리자입니다. 중지하거나 강등할 수 없습니다.'
          : self
            ? '본인 계정의 이용 상태와 권한은 다른 관리자가 변경할 수 있습니다.'
            : '마지막 활성 관리자는 중지하거나 강등할 수 없습니다.';
      identity.append(reason);
    }
    const controls = document.createElement('div');
    controls.className = 'user-controls';
    const role = document.createElement('select');
    role.setAttribute('aria-label', `${user.email} 권한`);
    role.add(new Option('일반 사용자', 'user'));
    role.add(new Option('관리자', 'admin'));
    role.value = user.role;
    role.disabled = busy || protectedAccount;
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = '권한 저장';
    save.disabled = true;
    role.onchange = () => {
      save.disabled = busy || role.value === user.role;
    };
    save.onclick = () => update(user, { active: user.active, role: role.value });
    const active = document.createElement('button');
    active.type = 'button';
    active.className = user.active ? 'danger-button' : 'secondary-button';
    active.textContent = user.active ? '이용 중지' : '이용 허용';
    active.disabled = busy || protectedAccount;
    // State changes preserve the stored role, independent of an unsaved selection.
    active.onclick = () => update(user, { active: !user.active, role: user.role });
    controls.append(role, save, active);
    row.append(identity, controls);
    $('users').append(row);
  }
}

async function load() {
  accounts = (await api('/api/admin/users')).users;
  accounts.sort((a, b) => a.email.localeCompare(b.email));
  render();
}

async function update(user, input) {
  if (busy) return;
  const action =
    input.active !== user.active
      ? input.active
        ? '이용을 허용'
        : '이용을 중지'
      : input.role === 'admin'
        ? '관리자 권한을 부여'
        : '일반 사용자로 변경';
  if (
    !confirm(
      `${user.email} 계정의 ${action}하시겠습니까?${!input.active && user.active ? '\n로그인 세션과 진행 중 경기가 종료됩니다.' : ''}`,
    )
  )
    return;
  busy = true;
  render();
  feedback('변경 사항을 저장하고 있습니다…');
  try {
    await api(`/api/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...input, expectedActive: user.active, expectedRole: user.role }),
    });
    await load();
    feedback(`${user.email} 계정 설정을 변경했습니다.`);
  } catch (error) {
    await load().catch(() => {});
    feedback(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

$('user-search').oninput = render;
$('role-filter').onchange = $('active-filter').onchange = render;
$('refresh-users').onclick = async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    await load();
    feedback('계정 목록을 새로고침했습니다.');
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    render();
  }
};

try {
  const session = await accountBar();
  currentUser = session.user;
  if (!currentUser) location.replace('/signin?next=%2Fadmin');
  else if (currentUser.role !== 'admin') location.replace('/');
  else {
    $('user-management').hidden = false;
    busy = true;
    render();
    try {
      await load();
    } catch (error) {
      feedback(error.message, true);
    } finally {
      busy = false;
      render();
    }
  }
} catch (error) {
  $('entry-status').textContent = error.message;
}
