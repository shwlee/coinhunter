import { readFile, writeFile } from 'node:fs/promises';
import { mapRepository } from '../src/game/map-repository.js';

const [command, argument, extra] = process.argv.slice(2);
try {
  switch (command) {
    case 'list':
      console.log(JSON.stringify(mapRepository.registry(), null, 2));
      break;
    case 'import': {
      const document = JSON.parse(await readFile(argument, 'utf8'));
      const map = await mapRepository.saveDraft(document, { expectedRevision: Number(extra ?? 0) });
      console.log(`임시 저장: ${map.id} / revision ${map.revision}`);
      break;
    }
    case 'publish':
      await mapRepository.publish(argument, Number(extra));
      console.log(`게시: ${argument} / revision ${extra}`);
      break;
    case 'enable':
    case 'disable':
      await mapRepository.setEnabled(argument, command === 'enable');
      console.log(`${command}: ${argument}`);
      break;
    case 'export': {
      const map = mapRepository.getDraft(argument) ?? mapRepository.getPublished(argument);
      if (!map) throw new Error('맵을 찾을 수 없습니다.');
      await writeFile(extra, JSON.stringify(map, null, 2) + '\n', { flag: 'wx' });
      console.log(`내보내기: ${extra} / revision ${map.revision}`);
      break;
    }
    default:
      throw new Error(
        '사용법: npm run maps -- list | import <JSON 경로> [현재 draft 버전] | publish <ID> <버전> | enable/disable <ID> | export <ID> <새 파일 경로>',
      );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
