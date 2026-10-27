import { createAppsScriptProvider } from './appsscript.js';
import { createServiceAccountProvider } from './serviceaccount.js';
import { createMemoryProvider } from './memory.js';
import { createN8nBridgeProvider } from './n8nbridge.js';
import { createPublicLinkProvider } from './publiclink.js';
import { activeSheetConfig } from './active.js';
import { currentFirmId } from '../../firms.js';

// One provider per firm, rebuilt when that firm's connection changes kind.
const providers = new Map(); // firmId -> { kind, provider }

export function getSheetProvider(firmId = currentFirmId()) {
  firmId = Number(firmId);
  const kind = activeSheetConfig(firmId).provider;
  const cached = providers.get(firmId);
  if (cached && cached.kind === kind) return cached.provider;
  let provider;
  switch (kind) {
    case 'appsscript': provider = createAppsScriptProvider(firmId); break;
    case 'serviceaccount': provider = createServiceAccountProvider(firmId); break;
    case 'publiclink': provider = createPublicLinkProvider(firmId); break;
    case 'memory': provider = createMemoryProvider(firmId); break;
    case 'n8n': provider = createN8nBridgeProvider(); break;
    default: provider = null;
  }
  providers.set(firmId, { kind, provider });
  return provider;
}
// Call after a firm's connection changes so the next call rebuilds the right provider.
export function resetSheetProvider(firmId = currentFirmId()) { providers.delete(Number(firmId)); }
export const sheetsConfigured = (firmId = currentFirmId()) => !!getSheetProvider(firmId);
