import { fail } from '../persistence/errors.js';

// Development identity verification only. Account creation and sessions belong to the service.
export function createMockProvider({ accounts, enabled, domain }) {
  if (enabled && process.env.NODE_ENV === 'production')
    throw new Error('운영 환경에서는 목업 인증을 사용할 수 없습니다.');
  async function identities() {
    if (!enabled) return [];
    const users = (await accounts.listUsers()).filter((account) => account.active);
    return [
      ...new Set([
        ...users.filter((account) => account.role === 'admin').map((account) => account.email),
        `developer@${domain}`,
        `tester@${domain}`,
      ]),
    ];
  }
  return {
    id: 'mock',
    enabled,
    identities,
    async authenticate(request, credentials) {
      if (
        !enabled ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
      )
        throw fail(403, '로컬 개발에서만 목업 로그인을 사용할 수 있습니다.');
      const email = credentials?.email;
      if (!(await identities()).includes(email))
        throw fail(403, '등록된 개발용 계정을 선택하세요.');
      return { email };
    },
  };
}
