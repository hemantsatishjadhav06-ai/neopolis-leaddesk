// Central configuration. Everything secret comes from environment variables —
// nothing is hardcoded. Non-secret, user-editable settings live in the database
// (see settings.js) and are managed from the Settings screen.
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
// A key pasted into a dashboard sometimes arrives wrapped in quotes, with "Bearer " in front or with spaces around
// it; none of that is part of the key, and the provider answers such a key with 401.
export const cleanKey = (v) => String(v || '').trim().replace(/^(['"`])([\s\S]*)\1$/, '$2').trim().replace(/^Bearer\s+/i, '').trim();
const rawAiKey = env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || '';

const DATA_DIR = env.DATA_DIR || path.resolve(process.cwd(), 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

export const config = {
  env: env.NODE_ENV || 'production',
  port: num(env.PORT, 8080),
  dataDir: DATA_DIR,
  dbPath: env.DB_PATH || path.join(DATA_DIR, 'leaddesk.db'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''), // e.g. https://leaddesk.up.railway.app
  sessionSecret: env.SESSION_SECRET || '',              // optional extra entropy for session ids
  trustProxy: bool(env.TRUST_PROXY, true),

  // First admin (optional). If no users exist at boot and these are set, the admin is created.
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  adminName: env.ADMIN_NAME || 'Admin',

  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.PHONE_NUMBER_ID || '',
    wabaId: env.WABA_ID || '',
    appId: env.META_APP_ID || '',
    appSecret: env.META_APP_SECRET || '',
    verifyToken: env.VERIFY_TOKEN || 'neopolis-leaddesk-verify',
    graphVersion: env.GRAPH_VERSION || 'v21.0',
    mock: bool(env.WA_MOCK, false),
  },

  ai: {
    provider: env.AI_PROVIDER || 'openrouter',          // openrouter | openai | mock
    apiKey: cleanKey(rawAiKey),
    apiKeyCleaned: cleanKey(rawAiKey) !== rawAiKey,     // the variable held quotes / spaces / "Bearer " (now ignored)
    baseUrl: env.AI_BASE_URL || (env.AI_PROVIDER === 'openai' ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1'),
    mock: bool(env.AI_MOCK, false),
  },

  // Which system is the AI brain: 'leaddesk' (this app replies + runs the journey) or 'n8n' (n8n workflows do it and
  // post events to /api/ingest; LeadDesk is the inbox / supervision UI and sends human replies).
  brain: (env.BRAIN || 'leaddesk').toLowerCase() === 'n8n' ? 'n8n' : 'leaddesk',
  ingestSecret: env.INGEST_SECRET || '',

  // Extra firms to create at boot (JSON list of {name, number, sheet}); see services/firm-setup.js.
  firmsSeed: env.FIRMS || '',

  sheets: {
    provider: env.SHEETS_PROVIDER || (env.N8N_BRIDGE_URL ? 'n8n' : env.SHEETS_APPS_SCRIPT_URL ? 'appsscript' : env.GOOGLE_SERVICE_ACCOUNT_B64 ? 'serviceaccount' : 'none'),
    n8nBridgeUrl: env.N8N_BRIDGE_URL || '',
    n8nBridgeSecret: env.N8N_BRIDGE_SECRET || '',
    spreadsheetId: env.SPREADSHEET_ID || '',
    leadsTab: env.LEADS_TAB || '',                       // blank = auto-detect (tab with whatsapp_number + lead_status headers)
    repliesTab: env.REPLIES_TAB || 'Client Replies',
    appsScriptUrl: env.SHEETS_APPS_SCRIPT_URL || '',
    appsScriptSecret: env.SHEETS_APPS_SCRIPT_SECRET || '',
    serviceAccountB64: env.GOOGLE_SERVICE_ACCOUNT_B64 || '',
  },

  alerts: {
    webhookUrl: env.ALERT_WEBHOOK_URL || '',             // optional: Slack/n8n/Zapier webhook for hand-off alerts
  },

  scheduler: {
    enabled: bool(env.SCHEDULER_ENABLED, true),
    tickSeconds: num(env.SCHEDULER_TICK_SECONDS, 60),
  },

  // Webhook / abuse protection. The webhook is a PUBLIC endpoint: without one of these it is spoofable.
  security: {
    // Accept webhook posts that carry no valid X-Hub-Signature-256. Only for local dev.
    allowUnsignedWebhook: bool(env.ALLOW_UNSIGNED_WEBHOOK, false),
    // Interim protection when META_APP_SECRET is not available: a secret segment on the callback URL
    // (https://host/webhook/<token>). Meta only ever posts to the URL you configured.
    webhookPathToken: env.WEBHOOK_PATH_TOKEN || '',
    webhookRateMax: num(env.WEBHOOK_RATE_MAX, 240),        // posts per window, per IP
    webhookRateWindowMs: num(env.WEBHOOK_RATE_WINDOW_MS, 60000),
  },

  // Hard ceilings so a bug or an abusive caller cannot run up WhatsApp / LLM spend.
  limits: {
    aiRepliesPerDay: num(env.AI_DAILY_CAP, 500),
    sendsPerDay: num(env.SEND_DAILY_CAP, 1000),
    aiConcurrency: num(env.AI_CONCURRENCY, 3),
  },

  backup: {
    enabled: bool(env.BACKUP_ENABLED, true),
    everyHours: num(env.BACKUP_EVERY_HOURS, 12),
    keep: num(env.BACKUP_KEEP, 14),
    dir: env.BACKUP_DIR || path.join(DATA_DIR, 'backups'),
    offsiteUrl: env.BACKUP_OFFSITE_URL || '',   // optional: PUT/POST target for off-box copies
    offsiteToken: env.BACKUP_OFFSITE_TOKEN || '',
  },
};

export function configSummary() {
  return {
    publicUrl: config.publicUrl,
    brain: config.brain,
    ingestSecretSet: !!config.ingestSecret,
    whatsapp: {
      tokenSet: !!config.whatsapp.token,
      phoneNumberId: config.whatsapp.phoneNumberId,
      wabaId: config.whatsapp.wabaId,
      appId: config.whatsapp.appId,
      appSecretSet: !!config.whatsapp.appSecret,
      verifyToken: config.whatsapp.verifyToken,
      mock: config.whatsapp.mock,
    },
    ai: { provider: config.ai.mock ? 'mock' : config.ai.provider, apiKeySet: !!config.ai.apiKey, baseUrl: config.ai.baseUrl },
    security: {
      webhookAuth: config.whatsapp.appSecret ? 'signature' : (config.security.webhookPathToken ? 'path-token' : (config.security.allowUnsignedWebhook ? 'NONE (unsigned allowed)' : 'locked (no secret — posts rejected)')),
      allowUnsignedWebhook: config.security.allowUnsignedWebhook,
      limits: config.limits,
    },
    backup: { enabled: config.backup.enabled, everyHours: config.backup.everyHours, keep: config.backup.keep, offsite: !!config.backup.offsiteUrl },
    sheets: {
      provider: config.sheets.provider,
      spreadsheetId: config.sheets.spreadsheetId,
      leadsTab: config.sheets.leadsTab,
      repliesTab: config.sheets.repliesTab,
      appsScriptUrlSet: !!config.sheets.appsScriptUrl,
      n8nBridgeUrlSet: !!config.sheets.n8nBridgeUrl,
      serviceAccountSet: !!config.sheets.serviceAccountB64,
    },
    alerts: { webhookSet: !!config.alerts.webhookUrl },
    scheduler: config.scheduler,
  };
}
