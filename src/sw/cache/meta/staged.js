import { readMeta, writeMeta, deleteMeta } from './store.js';

const STAGED_KEY = '/_nlpwa/staged.json';

let _stagedPromise = null;

export function getStaged() {
  if (!_stagedPromise) {
    _stagedPromise = readMeta(STAGED_KEY).catch(() => {
      _stagedPromise = null;
      return null;
    });
  }
  return _stagedPromise;
}

export async function setStaged(record) {
  await writeMeta(STAGED_KEY, record);
  _stagedPromise = Promise.resolve(record);
}

export async function clearStaged() {
  await deleteMeta(STAGED_KEY);
  _stagedPromise = Promise.resolve(null);
}

export function resetStagedMemo() {
  _stagedPromise = null;
}

export { STAGED_KEY };
