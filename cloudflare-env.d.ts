declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PORTAL_WORKER_TOKEN?: string;
    PORTAL_SCHEDULE_ENABLED?: string;
    REMINDER_WEBHOOK_URL?: string;
    REMINDER_WEBHOOK_TOKEN?: string;
  }
}
