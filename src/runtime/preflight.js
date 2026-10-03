import { fork } from 'node:child_process';

const active = new Set();

// This is a disposable validation session, never a running match's player process.
export async function validateAlgorithm(source, owner) {
  if (active.has(owner) || active.size >= 2) {
    throw Object.assign(new Error('코드 검사가 진행 중입니다. 잠시 후 다시 검사하세요.'), {
      status: 429,
    });
  }
  active.add(owner);
  try {
    return await new Promise((resolve, reject) => {
      const worker = fork(new URL('./preflight-worker.js', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        windowsHide: true,
      });
      let result;
      let failure;
      const timer = setTimeout(() => {
        failure = new Error('검사 전체 대기 시간을 초과했습니다. 코드를 확인하고 다시 검사하세요.');
        worker.kill();
      }, 30000);
      worker.once('message', (message) => {
        result = message;
      });
      worker.once('error', (error) => {
        failure = error;
      });
      worker.once('close', () => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (!result) reject(new Error('코드 검사 프로세스가 비정상 종료되었습니다.'));
        else resolve(result);
      });
      worker.send({ source }, (error) => {
        if (error) {
          failure = error;
          worker.kill();
        }
      });
    });
  } finally {
    active.delete(owner);
  }
}
