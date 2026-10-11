import 'dotenv/config';
import { createAccountRepository } from '../src/persistence/account-repository.js';

const args = process.argv.slice(2);
try {
  const accounts = createAccountRepository();
  if (args[0] === '--list' && (args.length === 1 || (args.length === 3 && args[1] === '--email'))) {
    const email = args[2]?.trim().toLowerCase();
    const users = (await accounts.listUsers()).filter((user) => !email || user.email === email);
    console.log(
      JSON.stringify(
        users.map(({ id, email, role, active, authProviders }) => ({
          id,
          email,
          role,
          active,
          authProviders,
        })),
        null,
        2,
      ),
    );
  } else if (args.length === 2 && args[0] === '--user-id') {
    const user = await accounts.grantAdmin(args[1]);
    console.log(`관리자 권한을 부여했습니다: ${user.email} (${user.id})`);
  } else
    throw new Error(
      '사용법: npm run admin:grant -- --list [--email <이메일>] 또는 --user-id <계정 ID>',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
