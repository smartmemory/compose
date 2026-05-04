import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = resolve(__dirname, '../contracts/comp-obs-contract.schema.json');

// Per-path cache. Each entry: { schema, ajv }.
const cache = new Map();

function load(schemaPath = DEFAULT_SCHEMA_PATH) {
  if (cache.has(schemaPath)) return cache.get(schemaPath);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const entry = { schema, ajv };
  cache.set(schemaPath, entry);
  return entry;
}

/**
 * Load (and cache) a schema by absolute path. Returns `{ schema, ajv }`.
 * Used by code that wants to compile arbitrary `$ref`s against the schema
 * without going through the SchemaValidator class.
 */
export function loadSchema(schemaPath) {
  return load(schemaPath);
}

export class SchemaValidator {
  /**
   * @param {string} [schemaPath] Absolute path to a JSON Schema file.
   *   Default is the comp-obs-contract schema (back-compat for existing
   *   callers that pass no args).
   */
  constructor(schemaPath = DEFAULT_SCHEMA_PATH) {
    const { schema, ajv } = load(schemaPath);
    this.schema = schema;
    this.ajv = ajv;
    this._validators = new Map();
    this._rootValidator = null;
  }

  _getValidator(defName) {
    if (this._validators.has(defName)) return this._validators.get(defName);
    if (!this.schema.definitions || !(defName in this.schema.definitions)) {
      throw new Error(`unknown schema definition: ${defName}`);
    }
    const ref = `${this.schema.$id}#/definitions/${defName}`;
    let v = this.ajv.getSchema(ref);
    if (!v) v = this.ajv.compile({ $ref: ref });
    this._validators.set(defName, v);
    return v;
  }

  /**
   * Validate `obj` against `schema.definitions[defName]`. Used by the
   * comp-obs-contract code paths.
   */
  validate(defName, obj) {
    const v = this._getValidator(defName);
    const valid = v(obj);
    return { valid: !!valid, errors: valid ? [] : (v.errors || []) };
  }

  /**
   * Validate `obj` against the schema's root (no $defs/$ref indirection).
   * Used by feature-json / vision-state / roadmap-row schemas, which are
   * top-level shapes without nested definitions.
   */
  validateRoot(obj) {
    if (!this._rootValidator) {
      // ajv.getSchema by $id returns the root validator if the schema was
      // added via addSchema (which load() does).
      let v = this.schema.$id ? this.ajv.getSchema(this.schema.$id) : null;
      if (!v) v = this.ajv.compile(this.schema);
      this._rootValidator = v;
    }
    const v = this._rootValidator;
    const valid = v(obj);
    return { valid: !!valid, errors: valid ? [] : (v.errors || []) };
  }
}

// Back-compat export — points at the comp-obs schema version. Existing
// callers consuming SCHEMA_VERSION continue to work unchanged.
export const SCHEMA_VERSION = load().schema.version;
