export const CHARACTERS = [
  { id: 'kobi', name: '코비', description: '함께 달리는 AI 로봇', column: 0, playable: false },
  { id: 'pengko', name: '펭코', description: '모험을 좋아하는 펭귄', column: 1, playable: true },
  { id: 'nyangtami', name: '냥탐이', description: '호기심 많은 탐험가', column: 2, playable: true },
  { id: 'dino', name: '디노', description: '용감한 아기 공룡', column: 3, playable: true },
  { id: 'lumi', name: '루미', description: '별빛을 따라가는 마법사', column: 4, playable: true },
];
export const DEFAULT_CHARACTER = 'pengko';
export const rivalCharacterFor = (id) =>
  CHARACTERS.find((character) => character.playable && character.id !== id).id;
export const isPlayableCharacter = (id) => CHARACTERS.some((c) => c.id === id && c.playable);
export const characterFor = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[1];
