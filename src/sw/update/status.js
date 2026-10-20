import { getStaged } from '../cache/store.js';

let _currentStatus = 'idle';
let _commitDeferred = false;

export function setUpdateStatus(status) {
  _currentStatus = status;
}

export function getCurrentStatus() {
  return _currentStatus;
}

export function setCommitDeferred(val) {
  _commitDeferred = Boolean(val);
}

export function isCommitDeferred() {
  return _commitDeferred;
}

export async function getUpdateStatus() {
  const staged = await getStaged();
  if (staged?.complete) {
    if (_commitDeferred) return 'commit-deferred';
    return 'ready';
  }
  return _currentStatus;
}
