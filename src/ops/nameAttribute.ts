// src/ops/nameAttribute.ts
//
// Shared between the dispatcher (read-back-by-name after an indeterminate
// create) and the HTTP create route (P4's synchronous "does this request
// carry the naming attribute" validation) -- both need the same answer to
// "what is this object class's naming attribute," and duplicating the
// schema lookup would let the two silently drift.
import type { Lease } from "@governance-connector-framework/core";

/**
 * The object class's declared naming attribute, or the default (`__NAME__`)
 * when schema lookup fails or doesn't declare one.
 *
 * Schema is advisory here, not required: a connector that doesn't implement
 * `schema()`, or one whose schema call fails, still gets a usable answer.
 */
export async function resolveNameAttribute(lease: Lease, objectClass: string): Promise<string> {
  try {
    const schema: any = await lease.facade.schema();
    const oc = schema?.objectClasses?.find((c: any) => c.name === objectClass);
    if (oc?.nameAttribute) return String(oc.nameAttribute);
  } catch {
    // Schema is advisory here; the default is the safe fallback.
  }
  return "__NAME__";
}
