import { Router, raw } from 'express';
import { retellWebhookController } from '../controllers/retellWebhook.controller.js';
import { retellFunctionsController } from '../controllers/retellFunctions.controller.js';

/** Raw-body limit for webhook payloads (inbound call objects with analysis fit easily). */
const WEBHOOK_BODY_LIMIT = '200kb';

/**
 * Retell inbound router.
 *
 * Both routes use a RAW body parser (not the global JSON parser) so signature
 * verification can run over the exact bytes Retell sent — re-serialised JSON would
 * not verify. This router is therefore mounted in `app.ts` BEFORE `express.json()`.
 *
 * `type: () => true` captures the body as a Buffer regardless of the Content-Type.
 */
export const retellWebhookRouter: Router = Router();

// Call lifecycle + inbound hook.
retellWebhookRouter.post(
  '/',
  raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  (req, res, next) => {
    retellWebhookController(req, res).catch(next);
  },
);

// Agent backend tools (custom functions), dispatched by function name.
retellWebhookRouter.post(
  '/functions',
  raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  (req, res, next) => {
    retellFunctionsController(req, res).catch(next);
  },
);
