import { FranceTVProvider } from './fr/francetv.js';
import { MyTF1Provider } from './fr/mytf1.js';
import { SixPlayProvider } from './fr/sixplay.js';
import { CBCProvider } from './ca/cbc.js';

/** Map provider keys to their implementation classes. */
export const PROVIDER_CLASSES = {
  francetv: FranceTVProvider,
  mytf1: MyTF1Provider,
  '6play': SixPlayProvider,
  cbc: CBCProvider,
};

/** The provider class for a given key, or undefined. */
export function getProviderClass(key) {
  return PROVIDER_CLASSES[key];
}
