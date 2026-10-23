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
    CF_ACCESS_TEAM_DOMAIN?: string;
    CF_ACCESS_AUD?: string;
    PORTAL_IDENTITY_MODE?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    MICROSOFT_CLIENT_ID?: string;
    MICROSOFT_CLIENT_SECRET?: string;
    SESSION_SECRET?: string;
    PUBLIC_ORIGIN?: string;
  }
}
