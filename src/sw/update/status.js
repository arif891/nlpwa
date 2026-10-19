import { getStaged } from '../cache/store.js';

let _currentStatus = 'idle';

export function setUpdateStatus(status) {
  _currentStatus = status;
}

export function getCurrentStatus() {
  return _currentStatus;
}

export async function getUpdateStatus() {
  const staged = await getStaged();
  if (staged?.complete) return 'ready';
  return _currentStatus;
}
