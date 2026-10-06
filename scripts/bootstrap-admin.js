import { createAccountRepository } from '../src/persistence/account-repository.js';

const email = process.argv[2];
if (!email) {
  console.error('사용법: npm run admin:bootstrap -- <관리자 이메일>');
  process.exitCode = 1;
} else {
  try {
    const user = await createAccountRepository().bootstrapAdmin(email);
    console.log(`관리자 계정이 로컬 저장소에 등록되었습니다: ${user.email}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
