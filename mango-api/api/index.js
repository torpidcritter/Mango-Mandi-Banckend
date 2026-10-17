// Vercel entry point: the whole API as one Vercel Function. vercel.json sends
// every path here; Express routes it. Startup work that a long-running server
// does once (migrations, seed data) runs in the build step instead, and the
// maintenance job runs from Vercel Cron.
import { createApp } from '../src/app.js'

export default createApp()
