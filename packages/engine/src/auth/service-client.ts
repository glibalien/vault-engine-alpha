/**
 * Client ids of the long-lived bearer tokens minted by scripts/issue-service-token.ts
 * for the suite's own services (Curator, the Obsidian plugin, the installer).
 * OAuth-registered clients get random UUIDs, so they never carry this prefix.
 */
export const SERVICE_CLIENT_ID_PREFIX = 'service-';

export function serviceClientId(name: string): string {
  return `${SERVICE_CLIENT_ID_PREFIX}${name}`;
}

export function isServiceClientId(clientId: string): boolean {
  return clientId.startsWith(SERVICE_CLIENT_ID_PREFIX);
}
