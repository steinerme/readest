/**
 * Session-only "don't ask again" for sending reading text to the AI service.
 * Kept in memory on purpose: it resets when the app restarts, is scoped to one
 * book + one range + one spoiler policy + one destination, and is never
 * offered for whole-book retrieval (which can reveal unread text).
 */
const granted = new Set<string>();

export const consentKey = (hash: string, scope: string, protect: boolean, destination: string) =>
  `${hash}|${scope}|${protect ? 'protected' : 'open'}|${destination}`;
export const canSkipConfirmation = (scope: string) => scope !== 'all';
export function hasConsent(key: string): boolean {
  return granted.has(key);
}
export function setConsent(key: string, on: boolean) {
  if (on) granted.add(key);
  else granted.delete(key);
}
export function clearAllConsent() {
  granted.clear();
}
