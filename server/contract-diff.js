/**
 * contract-diff.js — COMP-OBS-DRIFT contract_drift axis helper.
 *
 * Compares JSON Schema files between an anchor git ref and the current working
 * tree. Returns field-change counts (added / removed / retyped / total) for use
 * by drift-axes.js in computing the contract_drift ratio.
 *
 * Field-walk strategy: recursively collect leaf property names from
 * schema.properties, counting each as one "field". additionalProperties: false
 * itself counts as a single field (stability signal). Combines all files so
 * the denominator is global-per-feature, not per-file.
 *
 * All git invocations go through execSync; errors are caught and returned as
 * empty field sets (axis falls back to threshold: null in the caller).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Walk a JSON Schema object and return the set of "fields" it declares.
 * Each property name is included; additionalProperties:false adds a sentinel
 * '__additionalProperties_closed__' so it contributes to the count.
 *
 * @param {object} schema
 * @param {string} [prefix]
 * @returns {Set<string>}
 */
function walkSchema(schema, prefix = '') {
  const fields = new Set();
  if (!schema || typeof schema !== 'object') return fields;

  if (schema.additionalProperties === false) {
    fields.add(`${prefix}__additionalProperties_closed__`);
  }

  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props)) {
      const qualifiedKey = prefix ? `${prefix}.${key}` : key;
      fields.add(qualifiedKey);
      // Recurse into nested object schemas
      if (value && typeof value === 'object') {
        const nested = walkSchema(value, qualifiedKey);
        for (const f of nested) fields.add(f);
      }
    }
  }

  // Walk allOf / anyOf / oneOf for completeness
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) {
        const nested = walkSchema(sub, prefix);
        for (const f of nested) fields.add(f);
      }
    }
  }

  return fields;
}

/**
 * Collect a Map<fullyQualifiedPath, typeString> for every field at any depth.
 * Mirrors walkSchema's traversal so paths are comparable across versions.
 *
 * @param {object} schema
 * @param {string} prefix
 * @returns {Map<string, string>}
 */
function collectFieldTypes(schema, prefix = '') {
  const types = new Map();
  if (!schema || typeof schema !== 'object') return types;

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      const qualifiedKey = prefix ? `${prefix}.${key}` : key;
      const t = JSON.stringify(value?.type ?? null);
      types.set(qualifiedKey, t);
      if (value && typeof value === 'object') {
        const nested = collectFieldTypes(value, qualifiedKey);
        for (const [k, v] of nested) types.set(k, v);
      }
    }
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) {
        const nested = collectFieldTypes(sub, prefix);
        for (const [k, v] of nested) types.set(k, v);
      }
    }
  }

  return types;
}

/**
 * Read a file at an anchor git ref via `git show <ref>:<path>`.
 * Returns null if the file did not exist at that ref.
 *
 * @param {string} ref — git commit ref (sha1 or symbolic)
 * @param {string} filePath — path relative to repo root
 * @param {string} projectRoot — absolute path of the git repo root
 * @returns {string|null}
 */
function gitShow(ref, filePath, projectRoot) {
  // Normalize path separators to forward slashes for git
  const gitPath = filePath.replace(/\\/g, '/');
  try {
    return execSync(`git show ${ref}:${gitPath}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null; // file didn't exist at that ref — treat as empty schema
  }
}

/**
 * Diff contract files for a feature between an anchor ref and the current
 * working tree.
 *
 * @param {string} anchorRef — git commit ref (result of git rev-list)
 * @param {string[]} headPaths — absolute paths to current JSON schema files
 * @param {string} projectRoot — absolute root of the git repo
 * @returns {{ added: number, removed: number, retyped: number, total: number }}
 *   Returns { added:0, removed:0, retyped:0, total:0 } on any parse failure.
 */
export function diffContracts(anchorRef, headPaths, projectRoot) {
  let added = 0;
  let removed = 0;
  let retyped = 0;
  let totalCurrentFields = 0;

  for (const absPath of headPaths) {
    // Read current (HEAD working-tree) version
    let currentSchema;
    try {
      currentSchema = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch {
      continue; // unparseable — skip this file
    }

    // Compute path relative to projectRoot for git show
    const relPath = path.relative(projectRoot, absPath);

    // Read anchor version
    const anchorContent = gitShow(anchorRef, relPath, projectRoot);
    let anchorSchema = null;
    if (anchorContent) {
      try {
        anchorSchema = JSON.parse(anchorContent);
      } catch {
        // anchor version unparseable — treat as if it didn't exist
      }
    }

    const currentFields = walkSchema(currentSchema);
    const anchorFields = anchorSchema ? walkSchema(anchorSchema) : new Set();

    totalCurrentFields += currentFields.size;

    for (const field of currentFields) {
      if (!anchorFields.has(field)) added++;
    }
    for (const field of anchorFields) {
      if (!currentFields.has(field)) removed++;
    }

    // "Retyped" detection: walk both schemas recursively and compare the JSON
    // type of every fully-qualified field path that exists in both versions.
    // This catches retypes nested inside object properties (where the path
    // stays the same but the type changes), which a top-level-only diff
    // would miss and silently undercount.
    if (anchorSchema) {
      const currentTypes = collectFieldTypes(currentSchema);
      const anchorTypes = collectFieldTypes(anchorSchema);
      for (const [path, curType] of currentTypes) {
        if (anchorTypes.has(path)) {
          const anType = anchorTypes.get(path);
          if (curType !== anType) retyped++;
        }
      }
    }
  }

  return { added, removed, retyped, total: totalCurrentFields };
}
