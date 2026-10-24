/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  /** The shop's WhatsApp number for help, digits with country code (like 919876543210). */
  readonly VITE_SUPPORT_WHATSAPP?: string
}
