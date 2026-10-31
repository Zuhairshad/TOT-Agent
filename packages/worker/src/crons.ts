/** Must match [triggers] crons in wrangler.toml exactly (Cloudflare passes the string back). */
export const WATCHDOG_CRON = '0 */3 * * *';
/** 05:00 UTC = 07:00 Africa/Lusaka (UTC+2, no DST). */
export const DAILY_CRON = '0 5 * * *';
