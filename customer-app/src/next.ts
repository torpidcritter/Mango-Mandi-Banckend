/**
 * Where to go after signing in (?next=): only a path on this site. To a
 * browser "//evil.example" and "/\evil.example" are other sites (SEC-11).
 */
export const safeNext = (next: string | null | undefined): string => (next && /^\/(?![/\\])/.test(next) ? next : '/')
