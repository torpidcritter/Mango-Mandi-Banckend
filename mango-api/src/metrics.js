import client from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const metrics = {
  ordersConfirmed: new client.Counter({ name: 'mango_orders_confirmed_total', help: 'Orders confirmed by payment', registers: [registry] }),
  holdFailures: new client.Counter({ name: 'mango_hold_failures_total', help: 'Checkouts refused for insufficient stock', registers: [registry] }),
  lazyExpiries: new client.Counter({ name: 'mango_lazy_hold_expiries_total', help: 'Expired unpaid orders cancelled at checkout before the sweep reached them', registers: [registry] }),
  rebalanceSwaps: new client.Counter({ name: 'mango_rebalance_swaps_total', help: 'Orders whose stock was swapped to another batch', registers: [registry] }),
  holdsExpired: new client.Counter({ name: 'mango_holds_expired_total', help: 'Unpaid orders cancelled when their hold expired', registers: [registry] }),
  ordersAtRisk: new client.Gauge({ name: 'mango_orders_at_risk', help: 'Open orders flagged at-risk', registers: [registry] }),
  ledgerDrift: new client.Gauge({ name: 'mango_ledger_drift_lines', help: 'Batch lines whose counters disagree with the ledger', registers: [registry] }),
  notificationsSent: new client.Counter({ name: 'mango_notifications_sent_total', help: 'Customer messages delivered to the provider', labelNames: ['kind'], registers: [registry] }),
  notificationsFailed: new client.Counter({ name: 'mango_notifications_failed_total', help: 'Customer messages given up on after retries', labelNames: ['kind'], registers: [registry] }),
  maintenanceLastRun: new client.Gauge({ name: 'mango_maintenance_last_run_timestamp_seconds', help: 'When this instance last finished a maintenance tick (unix seconds)', registers: [registry] }),
  webhookErrors: new client.Counter({ name: 'mango_webhook_errors_total', help: 'Webhooks that failed to process (the sender will retry)', labelNames: ['source'], registers: [registry] }),
  otpFallbacks: new client.Counter({ name: 'mango_otp_fallbacks_total', help: 'Login codes sent on the second channel because the first failed', labelNames: ['channel'], registers: [registry] }),
  otpNotAccepted: new client.Counter({ name: 'mango_otp_sms_not_accepted_total', help: 'Jio answered without the documented accepted status, so the code counted as not sent', registers: [registry] }),
  dbUnavailable: new client.Counter({ name: 'mango_db_unavailable_total', help: 'Requests answered 503 because the database could not be reached', registers: [registry] }),
  maintenanceSkips: new client.Counter({ name: 'mango_maintenance_skips_total', help: 'Maintenance steps put off to the next run for lack of time', labelNames: ['step'], registers: [registry] }),
  dbRetries: new client.Counter({ name: 'mango_db_retries_total', help: 'Transactions retried after a deadlock or serialization failure', labelNames: ['code'], registers: [registry] }),
  otpBudgetUsed: new client.Gauge({ name: 'mango_otp_sends_today', help: 'Login codes sent today (IST) against the daily budget', registers: [registry] }),
  maintenanceErrors: new client.Counter({ name: 'mango_maintenance_errors_total', help: 'Failed maintenance steps', labelNames: ['step'], registers: [registry] }),
}

export function httpMetrics(req, res, next) {
  const end = httpDuration.startTimer()
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    end({ method: req.method, route, status: res.statusCode })
  })
  next()
}
