import { createAppsScriptProvider } from './appsscript.js';
import { createServiceAccountProvider } from './serviceaccount.js';
import { createMemoryProvider } from './memory.js';
import { createN8nBridgeProvider } from './n8nbridge.js';
import { createPublicLinkProvider } from './publiclink.js';
import { activeSheetConfig } from './active.js';

let provider = null;
let providerKind = null;

export function getSheetProvider() {
  const kind = activeSheetConfig().provider;
  if (provider && providerKind === kind) return provider;
  providerKind = kind;
  switch (kind) {
    case 'appsscript': provider = createAppsScriptProvider(); break;
    case 'serviceaccount': provider = createServiceAccountProvider(); break;
    case 'publiclink': provider = createPublicLinkProvider(); break;
    case 'memory': provider = createMemoryProvider(); break;
    case 'n8n': provider = createN8nBridgeProvider(); break;
    default: provider = null;
  }
  return provider;
}
// Call after the connection changes so the next call rebuilds the right provider.
export function resetSheetProvider() { provider = null; providerKind = null; }
export const sheetsConfigured = () => !!getSheetProvider();
