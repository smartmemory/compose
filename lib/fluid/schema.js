/**
 * lib/fluid/schema.js — fluid-record contract loader.
 *
 * Mirrors lib/judgment/schema.js: the contract is memoized and callers validate
 * against a NAMED DEFINITION rather than the root.
 *
 * This exists because "the seam validates its records" has to be executable to
 * be true. Hand-rolled field checks drift from the published contract the moment
 * either changes, and the drift is invisible — the code keeps accepting what the
 * contract forbids while the contract keeps claiming otherwise.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaValidator } from '../../server/schema-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const FLUID_SCHEMA_PATH = resolve(__dirname, '../../contracts/fluid-record.schema.json');

let _validator = null;

export function getFluidValidator() {
  if (!_validator) _validator = new SchemaValidator(FLUID_SCHEMA_PATH);
  return _validator;
}

function describe(errors) {
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');
}

/** Validate against a definition, or throw with the schema's own complaint. */
export function assertValid(defName, obj, what = defName) {
  const { valid, errors } = getFluidValidator().validate(defName, obj);
  if (!valid) {
    throw new Error(`fluid: invalid ${what} — ${describe(errors)}`);
  }
  return obj;
}
