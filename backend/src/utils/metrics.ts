/**
 * Minimal Prometheus-format metrics — no dependency, no scrape agent required.
 *
 * Deliberately small: HTTP counts/latency by route template, socket gauges, and
 * process stats. Enough to alert on error rate, latency and connection churn.
 * Route templates (not raw paths) keep cardinality bounded — `/api/messages/:id`
 * is one series, not one per message id.
 */
import { logCounters } from './logger';

interface RouteStat {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

const routeStats = new Map<string, RouteStat>();
/** Hard ceiling so an unmatched-route flood cannot grow this map forever. */
const MAX_ROUTE_SERIES = 300;

const statusClasses = new Map<string, number>();

let socketConnections = 0;
let socketConnectionsTotal = 0;
const startedAt = Date.now();

export function recordHttpRequest(
  method: string,
  routeTemplate: string,
  statusCode: number,
  durationMs: number
): void {
  const key = `${method} ${routeTemplate}`;
  let stat = routeStats.get(key);
  if (!stat) {
    if (routeStats.size >= MAX_ROUTE_SERIES) {
      // Fold overflow into a single bucket rather than dropping the signal
      stat = routeStats.get('OTHER') || { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      routeStats.set('OTHER', stat);
    } else {
      stat = { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      routeStats.set(key, stat);
    }
  }
  stat.count += 1;
  stat.totalMs += durationMs;
  if (durationMs > stat.maxMs) stat.maxMs = durationMs;
  if (statusCode >= 500) stat.errors += 1;

  const cls = `${Math.floor(statusCode / 100)}xx`;
  statusClasses.set(cls, (statusClasses.get(cls) || 0) + 1);
}

export function socketConnected(): void {
  socketConnections += 1;
  socketConnectionsTotal += 1;
}

export function socketDisconnected(): void {
  socketConnections = Math.max(0, socketConnections - 1);
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Render the current snapshot in Prometheus text exposition format. */
export function renderMetrics(extra: { dbConnected: boolean; onlineUsers: number }): string {
  const mem = process.memoryUsage();
  const lines: string[] = [];

  lines.push('# HELP pulse_up Whether the process is serving.');
  lines.push('# TYPE pulse_up gauge');
  lines.push('pulse_up 1');

  lines.push('# HELP pulse_uptime_seconds Seconds since process start.');
  lines.push('# TYPE pulse_uptime_seconds gauge');
  lines.push(`pulse_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(0)}`);

  lines.push('# HELP pulse_db_connected Mongo connection state (1 = connected).');
  lines.push('# TYPE pulse_db_connected gauge');
  lines.push(`pulse_db_connected ${extra.dbConnected ? 1 : 0}`);

  lines.push('# HELP pulse_socket_connections Currently connected sockets.');
  lines.push('# TYPE pulse_socket_connections gauge');
  lines.push(`pulse_socket_connections ${socketConnections}`);

  lines.push('# HELP pulse_socket_connections_total Sockets accepted since start.');
  lines.push('# TYPE pulse_socket_connections_total counter');
  lines.push(`pulse_socket_connections_total ${socketConnectionsTotal}`);

  lines.push('# HELP pulse_online_users Distinct users with a live socket.');
  lines.push('# TYPE pulse_online_users gauge');
  lines.push(`pulse_online_users ${extra.onlineUsers}`);

  lines.push('# HELP pulse_memory_bytes Process memory usage.');
  lines.push('# TYPE pulse_memory_bytes gauge');
  lines.push(`pulse_memory_bytes{kind="rss"} ${mem.rss}`);
  lines.push(`pulse_memory_bytes{kind="heap_used"} ${mem.heapUsed}`);
  lines.push(`pulse_memory_bytes{kind="heap_total"} ${mem.heapTotal}`);

  lines.push('# HELP pulse_log_entries_total Log lines emitted by level.');
  lines.push('# TYPE pulse_log_entries_total counter');
  for (const [level, count] of Object.entries(logCounters)) {
    lines.push(`pulse_log_entries_total{level="${level}"} ${count}`);
  }

  lines.push('# HELP pulse_http_responses_total HTTP responses by status class.');
  lines.push('# TYPE pulse_http_responses_total counter');
  for (const [cls, count] of statusClasses) {
    lines.push(`pulse_http_responses_total{class="${cls}"} ${count}`);
  }

  lines.push('# HELP pulse_http_requests_total Requests by method and route.');
  lines.push('# TYPE pulse_http_requests_total counter');
  lines.push('# HELP pulse_http_request_duration_ms_sum Summed latency by route.');
  lines.push('# TYPE pulse_http_request_duration_ms_sum counter');
  lines.push('# HELP pulse_http_request_duration_ms_max Slowest observed request by route.');
  lines.push('# TYPE pulse_http_request_duration_ms_max gauge');
  lines.push('# HELP pulse_http_errors_total 5xx responses by route.');
  lines.push('# TYPE pulse_http_errors_total counter');
  for (const [key, stat] of routeStats) {
    const spaceIdx = key.indexOf(' ');
    const method = spaceIdx > 0 ? key.slice(0, spaceIdx) : 'OTHER';
    const route = spaceIdx > 0 ? key.slice(spaceIdx + 1) : key;
    const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
    lines.push(`pulse_http_requests_total{${labels}} ${stat.count}`);
    lines.push(`pulse_http_request_duration_ms_sum{${labels}} ${stat.totalMs.toFixed(1)}`);
    lines.push(`pulse_http_request_duration_ms_max{${labels}} ${stat.maxMs.toFixed(1)}`);
    lines.push(`pulse_http_errors_total{${labels}} ${stat.errors}`);
  }

  return `${lines.join('\n')}\n`;
}

/** Test hook. */
export function resetMetrics(): void {
  routeStats.clear();
  statusClasses.clear();
  socketConnections = 0;
  socketConnectionsTotal = 0;
}
