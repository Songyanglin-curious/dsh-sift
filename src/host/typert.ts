<<<<<<< HEAD
import { PACKAGE, descriptors } from '../remote.js';
=======
import { PACKAGE, descriptors } from '../contracts/remote.js';
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
<<<<<<< HEAD
  invocations: descriptors,
=======
  invocations: descriptors(),
>>>>>>> 191153c63fd9b7f10c529e8b71abbfb8a984c5c0
  model: { services: [], events: [], objects: [] },
};

export default TYPERT;
