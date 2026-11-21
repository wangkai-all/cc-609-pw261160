import { Store } from './lib/store.js';
import { createSeedData } from './lib/data.js';

export function createStore() {
  return new Store(createSeedData());
}

export { Store };
