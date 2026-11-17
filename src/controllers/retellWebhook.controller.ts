import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { processInboundWebhook } from '../services/inboundWebhook.service.js';

/**
 * `POST /webhooks/retell` — inbound Retell webhook endpoint.
 *
 * Mounted with a RAW body parser (before the global JSON parser) because signature
 * verification must run over the exact bytes Retell sent.
 *
 * Handles the `call_inbound` hook (answered with dynamic variables) and the voice
 * lifecycle events (`call_started`/`call_ended`/`call_analyzed`). Verified events
 * are processed quickly and acknowledged so Retell does not retry.
 */
export async function retellWebhookController(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.header('x-retell-signature') ?? undefined;

  const result = await processInboundWebhook({
    rawBody,
    signature,
    apiKey: env.RETELL_API_KEY,
  });

  switch (result.status) {
    case 'misconfigured':
      res.status(503).json({ error: 'webhook verification not configured' });
      return;
    case 'unauthorized':
      res.status(401).json({ error: 'invalid signature' });
      return;
    case 'bad_request':
      res.status(400).json({ error: 'invalid payload' });
      return;
    case 'inbound_ack':
      // The inbound hook expects a JSON body carrying the dynamic variables.
      res.status(200).json(result.response);
      return;
    case 'ignored':
    case 'processed':
      // 2xx with no body, as Retell expects for lifecycle events.
      res.status(204).end();
      return;
  }
}
