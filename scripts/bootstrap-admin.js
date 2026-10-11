import 'dotenv/config';
import { createAccountRepository } from '../src/persistence/account-repository.js';

const email = process.argv[2];
const extra = process.argv.slice(3);
const provider = extra.length ? extra[1] : process.env.AUTH_MODE === 'google' ? 'google' : 'mock';
if (
  !email ||
  (extra.length && (extra.length !== 2 || extra[0] !== '--provider')) ||
  !['mock', 'google'].includes(provider)
) {
  console.error('사용법: npm run admin:bootstrap -- <관리자 이메일> [--provider mock|google]');
  process.exitCode = 1;
} else {
  try {
    const user = await createAccountRepository().bootstrapAdmin(email, { provider });
    console.log(
      `관리자 계정이 로컬 저장소에 등록되었습니다: ${user.email} (${provider}, ${user.id})`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
