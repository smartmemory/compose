import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../contracts/comp-obs-contract.schema.json');

let cached = null;

function load() {
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  cached = { schema, ajv };
  return cached;
}

export class SchemaValidator {
  constructor() {
    const { schema, ajv } = load();
    this.schema = schema;
    this.ajv = ajv;
    this._validators = new Map();
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

  validate(defName, obj) {
    const v = this._getValidator(defName);
    const valid = v(obj);
    return { valid: !!valid, errors: valid ? [] : (v.errors || []) };
  }
}

export const SCHEMA_VERSION = load().schema.version;
