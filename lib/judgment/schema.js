/**
 * lib/judgment/schema.js — judgment-record contract loader (S01).
 *
 * Exposes the contract path and a memoized SchemaValidator instance. The
 * schema carries an $id, which the definitions path of SchemaValidator
 * requires (server/schema-validator.js:52). Callers validate per-kind via
 * `getJudgmentValidator().validate('<definition>', obj)`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SchemaValidator } from '../../server/schema-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const JUDGMENT_SCHEMA_PATH = resolve(__dirname, '../../contracts/judgment-record.schema.json');

// Memoized — the contract is static for the life of the process.
let _validator = null;

export function getJudgmentValidator() {
  if (!_validator) _validator = new SchemaValidator(JUDGMENT_SCHEMA_PATH);
  return _validator;
}
