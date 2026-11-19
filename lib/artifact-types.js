import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../contracts/feature-json.schema.json');

export const ARTIFACT_TYPES = Object.freeze([...schema.properties.artifacts.items.properties.type.enum]);
