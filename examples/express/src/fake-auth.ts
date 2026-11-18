import type { NextFunction, Request, Response } from 'express';

/*
 * ⚠️  FAKE AUTHENTICATION — FOR THIS EXAMPLE ONLY. ⚠️
 *
 * It trusts an `X-User-Id` header, so anyone can claim to be anyone. Replace it with your real
 * session / JWT middleware. The whole point of iap-guard is that purchases are recorded
 * against the *authenticated* user, so this must come from your auth, never from the client.
 */
export function fakeAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ error: 'Send an X-User-Id header (fake auth, example only)' });
    return;
  }
  res.locals.userId = userId;
  next();
}

export function currentUserId(res: Response): string {
  return res.locals.userId as string;
}
