import { v5 as uuidv5 } from 'uuid';

const ROOT_NAMESPACE = '3a7c1b12-9c10-4d02-ae9e-5f0e8bf3b2e1';

export function branchDecisionEventId(featureCode, branchId) {
  const featureNs = uuidv5(String(featureCode), ROOT_NAMESPACE);
  return uuidv5(`branch:${branchId}`, featureNs);
}

export function shouldEmit(eventId, emittedSet) {
  if (!emittedSet) return true;
  if (emittedSet instanceof Set) return !emittedSet.has(eventId);
  if (Array.isArray(emittedSet)) return !emittedSet.includes(eventId);
  return true;
}
