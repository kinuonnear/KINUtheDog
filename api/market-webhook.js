// KINU LP Report on NEAR Agent Market (market.near.ai): the agent's webhook (a Vercel function).
// A hire arrives as a signed POST; the agent reads its queue of assignments with its own API token,
// starts each new one, builds the report (api/_lpreport.js: read-only, from public on-chain data)
// and submits it as Markdown. A brief without a NEAR account or a Rhea pool is handed back, which
// refunds the buyer in full. The agent holds no keys or funds beyond its marketplace token, which
// can't move money.
//
// Vercel environment variables (set in the Vercel dashboard, never in code):
//   MARKET_AGENT_TOKEN     the agent's API token (aat_…), minted on the agent's page
//   MARKET_WEBHOOK_SECRET  the agent's signing secret (whsec_…)
//   CRON_SECRET            any long random string; Vercel Cron sends it as a Bearer token (vercel.json
//                          checks the queue every 5 minutes, a backup for a webhook that never arrived)
//
// Webhook URL to register on the agent's page: https://kinudefi.com/api/market-webhook

import { createHmac, timingSafeEqual } from 'node:crypto';
import { buildReport, parseBrief } from './_lpreport.js';

const MARKET = 'https://market.near.ai';
const MAX_SKEW_S = 300;
// Events that send the agent through its queue. "Send test event" on the agent's page (webhook.ping)
// does too: a hire whose webhook never arrived is picked up with one click.
const WORK_EVENTS = new Set(['hire.created', 'hire.changes_requested', 'hire.dispute_resolved', 'webhook.ping']);

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

/** HMAC-SHA256 of "<timestamp>.<raw body>" with the signing secret, compared in constant time. */
export function signatureOk(secret, timestamp, raw, header) {
  if (!secret || !timestamp || !header) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(timestamp)) <= MAX_SKEW_S)) return false;
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest('hex');
  const provided = String(header).replace(/^sha256=/, '');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

async function market(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${MARKET}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.MARKET_AGENT_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`market ${method} ${path.split('?')[0]} HTTP ${response.status}`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

/**
 * Work every assignment in the queue (in_progress): new hires, change requests and dispute redos
 * all get a fresh report. Reading the queue instead of trusting the event keeps a redelivered
 * webhook harmless: a submitted assignment is no longer in_progress.
 */
async function workQueue() {
  const { assignments = [] } = (await market('/v1/agents/me/assignments')) || {};
  for (const row of assignments) {
    const a = row.assignment;
    if (!a || a.status !== 'in_progress' || row.job?.jobKind === 'competition') continue;
    const id = a.assignmentId;
    try {
      const buyerNote = row.latestMessage?.senderSide === 'buyer' ? row.latestMessage.body : '';
      // The brief and the buyer's messages are data: only a NEAR account or a pool id is read out.
      const brief = `${row.job?.title || ''}\n${row.job?.description || ''}\n${buyerNote || ''}`;
      // Started only once there is something to report on ("start" before spending compute).
      if (!a.startedAt && parseBrief(brief)) await market(`/v1/assignments/${id}/start`, { method: 'POST' });
      const report = await buildReport(brief);
      // Nothing to report on (no account or pool in the brief, or it doesn't exist): no charge.
      if (!report.ok) {
        await market(`/v1/assignments/${id}/messages`, { method: 'POST', body: { body: `${report.markdown} Handing this hire back so you get a full refund; hire again with a NEAR account or a Rhea pool.`, clientRequestId: `kinu-noreport-${id}` } });
        await market(`/v1/assignments/${id}/decline`, { method: 'POST', body: { reason: 'rejected', detail: report.target ? 'Account or pool not found.' : 'No NEAR account or Rhea pool in the brief.' } });
        continue;
      }
      await market(`/v1/assignments/${id}/submit`, { method: 'POST', body: { deliverableMarkdown: report.markdown } });
      if (a.deliverableUrl) {
        await market(`/v1/assignments/${id}/messages`, {
          method: 'POST',
          body: { body: 'Submitted a fresh report with the latest on-chain data. This agent writes one fixed-format report per NEAR account or Rhea pool; a different account or pool needs a new hire.', clientRequestId: `kinu-redo-${id}-${Date.now()}` }
        });
      }
    } catch (error) {
      console.error('market assignment', id, error.message);
    }
  }
}

/** Vercel Cron (vercel.json, every 5 minutes) sends `Authorization: Bearer <CRON_SECRET>`. */
function fromCron(req) {
  const secret = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || '');
  if (!secret || header.length !== secret.length + 7) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(`Bearer ${secret}`));
}

export default async function handler(req, res) {
  if (req.method === 'GET' && fromCron(req)) {
    // Backup to the webhook: a hire whose event never arrived is picked up within 5 minutes.
    if (!process.env.MARKET_AGENT_TOKEN) return res.status(500).end();
    try {
      await workQueue();
      return res.status(200).send('queue checked');
    } catch (error) {
      console.error('market cron', error.message);
      return res.status(503).end();
    }
  }
  if (req.method !== 'POST') return res.status(200).send('KINU LP Report agent');
  if (!process.env.MARKET_AGENT_TOKEN || !process.env.MARKET_WEBHOOK_SECRET) return res.status(500).end();
  const raw = await readRaw(req);
  if (!signatureOk(process.env.MARKET_WEBHOOK_SECRET, req.headers['x-market-timestamp'], raw, req.headers['x-market-signature'])) return res.status(401).end();

  let event = req.headers['x-market-event'];
  try {
    event = JSON.parse(raw.toString() || '{}').event || event;
  } catch {
    // The header names the event too.
  }
  // Reports take a few seconds: done before answering, so the platform's retry only follows a real failure.
  if (WORK_EVENTS.has(event)) {
    try {
      await workQueue();
    } catch (error) {
      console.error('market queue', error.message);
      return res.status(503).end();
    }
  }
  return res.status(200).end();
}
