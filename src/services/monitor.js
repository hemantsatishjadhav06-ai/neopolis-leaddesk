// Operational health: catches the failures that are otherwise silent — an expired WhatsApp token,
// backups that stopped running, a spike in failed sends, or a webhook that has gone quiet.
// Issues are alerted once per cooldown so a persistent problem does not spam the channel.
import { all, get, kvGet, kvSet } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { tokenHealth } from './whatsapp.js';
import { backupStatus } from './backup.js';
import { spendSnapshot } from './guard.js';

const COOLDOWN_MS = 6 * 3600 * 1000;

async function systemAlert(issue) {
  const key = `alert.sent.${issue.code}`;
  const last = kvGet(key, 0);
  if (Date.now() - last < COOLDOWN_MS) return false;
  kvSet(key, Date.now());
  log.error(`ALERT [${issue.severity}] ${issue.code}: ${issue.message}`);
  if (!config.alerts.webhookUrl) return false;
  try {
    await fetch(config.alerts.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'system_alert', app: 'Neopolis LeadDesk', url: config.publicUrl, ...issue }),
    });
  } catch (e) { log.warn('System alert webhook failed', e.message); }
  return true;
}

function recentSendStats() {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const row = get(
    `SELECT
       SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END)    AS sent,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)  AS failed,
       SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked
     FROM messages WHERE direction='out' AND created_at >= ?`, since) || {};
  return { sent: row.sent || 0, failed: row.failed || 0, blocked: row.blocked || 0 };
}

function recentAiErrors() {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const r = get(`SELECT COUNT(*) AS n FROM audit WHERE type='ai.error' AND created_at >= ?`, since);
  return r?.n || 0;
}

export async function healthReport({ probeToken = true } = {}) {
  const issues = [];

  const wa = probeToken ? await tokenHealth() : (kvGet('monitor.lastToken', null) || { ok: null });
  if (probeToken) kvSet('monitor.lastToken', wa);
  if (wa.ok === false) {
    issues.push({
      code: wa.expired ? 'whatsapp_token_expired' : 'whatsapp_unreachable',
      severity: 'critical',
      message: wa.expired
        ? `WhatsApp access token is invalid/expired — replies and follow-ups will NOT be delivered. ${wa.detail}`
        : `WhatsApp API not reachable: ${wa.detail}`,
    });
  }

  const bk = backupStatus();
  if (bk.enabled && bk.stale) {
    issues.push({ code: 'backup_stale', severity: 'high', message: `No successful database backup in over ${bk.everyHours * 2}h.` });
  }
  if (bk.last && bk.last.ok === false) {
    issues.push({ code: 'backup_failed', severity: 'high', message: `Last backup failed: ${bk.last.error}` });
  }

  const sends = recentSendStats();
  if (sends.failed >= 5 && sends.failed > sends.sent) {
    issues.push({ code: 'send_failures', severity: 'high', message: `${sends.failed} outbound messages failed in the last hour (vs ${sends.sent} sent).` });
  }

  const aiErrors = recentAiErrors();
  if (aiErrors >= 5) {
    issues.push({ code: 'ai_errors', severity: 'high', message: `${aiErrors} AI generation errors in the last hour — leads are getting the fallback reply.` });
  }

  const spend = spendSnapshot();
  if (spend.sends >= spend.sendCap) {
    issues.push({ code: 'send_cap', severity: 'high', message: `Daily send cap reached (${spend.sends}/${spend.sendCap}) — further sends are blocked today.` });
  }

  const sec = config.whatsapp.appSecret ? 'signature'
    : config.security.webhookPathToken ? 'path-token'
    : config.security.allowUnsignedWebhook ? 'none' : 'locked';
  if (sec === 'none') {
    issues.push({ code: 'webhook_unauthenticated', severity: 'critical', message: 'Webhook accepts unsigned posts (ALLOW_UNSIGNED_WEBHOOK=1). Anyone who knows the URL can inject fake messages.' });
  }

  const lastEvent = kvGet('webhook.lastEventAt', null);
  const quietHours = lastEvent ? (Date.now() - Date.parse(lastEvent)) / 3600000 : null;

  return {
    ok: issues.filter(i => i.severity === 'critical').length === 0,
    checkedAt: new Date().toISOString(),
    whatsapp: wa,
    backup: bk,
    sends, aiErrors, spend,
    webhook: { auth: sec, verifiedAt: kvGet('webhook.verifiedAt', null), lastEventAt: lastEvent, quietHours: quietHours === null ? null : Math.round(quietHours * 10) / 10, lastRejectedAt: kvGet('webhook.lastRejectedAt', null) },
    issues,
  };
}

// Scheduler hook — probe at most hourly, alert on anything new.
export async function runMonitor() {
  const last = kvGet('monitor.lastRun', 0);
  if (Date.now() - last < 55 * 60 * 1000) return { skipped: 'not due' };
  kvSet('monitor.lastRun', Date.now());
  const report = await healthReport({ probeToken: true });
  for (const issue of report.issues) await systemAlert(issue);
  return report;
}
