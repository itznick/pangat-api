// A tiny in-process signal: "what this organisation may use may have changed". Raised by every place that invalidates a cached
// entitlement decision (subscription change, expiry, plan edit, feature kill switch, per-restaurant override). The live-feed gateway listens
// to it to revoke kitchen sockets promptly instead of waiting for the next periodic re-check.
type Listener = (organizationId: string | null) => void;
const listeners = new Set<Listener>();
export function onEntitlementChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** `null` means "any organisation may be affected" (a platform-wide switch or a plan shared by many). */
export function notifyEntitlementChange(organizationId: string | null): void {
  for (const l of [...listeners]) {
    try {
      l(organizationId);
    } catch {
      /* a listener must never break the caller */
    }
  }
}
