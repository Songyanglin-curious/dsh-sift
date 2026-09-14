import { PACKAGE, descriptors } from '../remote.js';

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};

export default TYPERT;
