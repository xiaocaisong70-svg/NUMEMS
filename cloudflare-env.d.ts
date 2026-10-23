declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PORTAL_WORKER_TOKEN?: string;
    PORTAL_SCHEDULE_ENABLED?: string;
    PORTAL_PUBLIC_URL?: string;
    REMINDER_DELIVERY_MODE?: string;
    REMINDER_WEBHOOK_URL?: string;
    REMINDER_WEBHOOK_TOKEN?: string;
  }
}
