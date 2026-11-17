import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { processToolRequest } from '../services/inboundTools.service.js';

/**
 * `POST /webhooks/retell/functions` — the inbound agent's backend tools.
 *
 * Raw-body (own signature verification), isolated from the call-lifecycle webhook.
 * A tool request is dispatched by `name`; a logical failure is returned to the
 * agent as a 200 payload (so it can respond gracefully), while auth/parse problems
 * use the matching HTTP status.
 */
export async function retellFunctionsController(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.header('x-retell-signature') ?? undefined;

  const result = await processToolRequest({
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
      res.status(400).json({ error: result.reason });
      return;
    case 'ok':
      res.status(200).json(result.payload);
      return;
  }
}
