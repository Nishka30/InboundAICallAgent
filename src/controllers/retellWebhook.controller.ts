import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { processRetellWebhook } from '../services/retellWebhook.service.js';

/**
 * `POST /webhooks/retell` — placeholder inbound Retell webhook endpoint.
 *
 * Mounted with a RAW body parser (before the global JSON parser) because
 * signature verification must run over the exact bytes Retell sent.
 *
 * This step only verifies and acknowledges; it does NOT run any call logic.
 */
export function retellWebhookController(req: Request, res: Response): void {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.header('x-retell-signature') ?? undefined;

  const result = processRetellWebhook({
    rawBody,
    signature,
    apiKey: env.RETELL_API_KEY,
  });

  switch (result.status) {
    case 'misconfigured':
      // Fail closed: verification required but no secret configured.
      res.status(503).json({ error: 'webhook verification not configured' });
      return;
    case 'unauthorized':
      res.status(401).json({ error: 'invalid signature' });
      return;
    case 'bad_request':
      res.status(400).json({ error: 'invalid payload' });
      return;
    case 'acknowledged':
      // 2xx with no body, as Retell expects. The event is verified but not yet
      // processed (placeholder) — acknowledging prevents provider retries.
      res.status(204).end();
      return;
  }
}
