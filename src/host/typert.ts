import { PACKAGE, descriptors } from '../contracts/remote.js';

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: descriptors(),
  model: { services: [], events: [], objects: [] },
};

export default TYPERT;
