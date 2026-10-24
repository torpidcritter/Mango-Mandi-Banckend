// UX-1: the shop's help contact. A customer paying for perishable fruit must always have a way
// to reach a person, so a production build without the number fails (customer-app/vite.config.ts).
// Dev servers and test builds keep working without it; their footer still links to /help.

/** The help WhatsApp number as wa.me wants it (country code, digits only), or null when unset or malformed. */
export function supportDigits(raw: string | undefined | null): string | null {
  const digits = (raw ?? '').replace(/[\s+\-()]/g, '')
  // wa.me needs the country code: 91 and the 10-digit number for India, 11 to 15 digits anywhere.
  return /^\d{11,15}$/.test(digits) ? digits : null
}

/**
 * Why a build may not go ahead, or null. Only production builds (`vite build`, whose default mode
 * is production) need the number; `vite` (dev) and `vite build --mode <other>` do not.
 */
export function supportBuildProblem({ command, mode, value }: { command: string; mode: string; value: string | undefined }): string | null {
  if (command !== 'build' || mode !== 'production') return null
  if (supportDigits(value)) return null
  return value
    ? `VITE_SUPPORT_WHATSAPP is "${value}", which is not a WhatsApp number. Give the shop's help number with its country code, digits only, like 91 followed by the 10-digit number.`
    : "VITE_SUPPORT_WHATSAPP is not set. A production shop build needs the shop's help WhatsApp number (country code and number, digits only), so every page can show customers how to reach us. Set it in the build environment (deploy/README.md and deploy/VERCEL.md list it), or build with --mode development for a local test build."
}
