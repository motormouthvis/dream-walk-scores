/**
 * Admin authentication — a single shared secret, matching the pattern `dream-schools`
 * uses for its embed admin.
 *
 * Deliberately not a user system. The dashboard is operational telemetry for the team
 * that runs the service, and a password in a config var is the right amount of machinery
 * for that. When the admin surface grows past read-only monitoring, this should be
 * replaced with real sessions rather than extended.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isAdmin(request: Request): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  // With no password set the dashboard is unavailable rather than open. An operator who
  // has not configured it has not decided to publish it.
  if (!expected) return false;

  const header = request.headers.get("authorization");
  const bearer = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : null;
  const supplied = bearer ?? request.headers.get("x-admin-password");
  if (!supplied) return false;

  return timingSafeEqual(digest(supplied.trim()), digest(expected));
}
