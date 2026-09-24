import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember } from '../middleware/household.js';
import { getUsage, usageQuerySchema } from '../usage.js';

export const usageRouter = Router();
usageRouter.use(requireAuth, attachHouseholds);

const querySchema = usageQuerySchema.extend({
  householdId: z.coerce.number().int().positive().optional(),
});

/** Household-wide usage (every configured switch of every device), over
 * the last `days` household-local days. `householdId` defaults to the
 * caller's own household. Per-device: GET /devices/:id/usage. */
usageRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const householdId = parsed.data.householdId ?? req.defaultHouseholdId;
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'household not found' });
  }
  res.json(await getUsage({ householdId: Number(householdId), days: parsed.data.days }));
});
