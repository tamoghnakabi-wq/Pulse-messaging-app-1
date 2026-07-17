/**
 * Parse session metadata for accurate "Active sessions" UI.
 * No external UA library — lightweight, dependency-free heuristics.
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface ParsedDevice {
  /** Human title e.g. "Chrome on macOS" */
  label: string;
  browser: string;
  os: string;
  type: DeviceType;
  /** Short model-ish hint when known (iPhone, iPad, etc.) */
  model?: string;
}

/** Prefer real client IP behind Cloudflare / reverse proxies. */
export function clientIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): string {
  const h = req.headers;
  const cf = header(h, 'cf-connecting-ip');
  if (cf) return normalizeIp(cf);

  const real = header(h, 'x-real-ip');
  if (real) return normalizeIp(real);

  const xff = header(h, 'x-forwarded-for');
  if (xff) {
    // First hop is the original client
    const first = xff.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }

  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return String(v[0] || '').trim();
  return String(v || '').trim();
}

/** Strip IPv6-mapped IPv4 and zone ids. */
export function normalizeIp(ip: string): string {
  let s = (ip || '').trim();
  if (!s) return 'Unknown';
  // ::ffff:127.0.0.1 → 127.0.0.1
  if (s.startsWith('::ffff:')) s = s.slice(7);
  // fe80::1%lo0 → fe80::1
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s === '::1') return '127.0.0.1 (localhost)';
  if (s === '127.0.0.1') return '127.0.0.1 (localhost)';
  return s;
}

export function parseUserAgent(uaRaw: string): ParsedDevice {
  const ua = uaRaw || '';
  if (!ua.trim()) {
    return {
      label: 'Unknown device',
      browser: 'Unknown browser',
      os: 'Unknown OS',
      type: 'unknown',
    };
  }

  const type = detectType(ua);
  const os = detectOs(ua);
  const browser = detectBrowser(ua);
  const model = detectModel(ua);

  const labelParts = [browser];
  if (model) labelParts.push(`on ${model}`);
  else if (os && os !== 'Unknown OS') labelParts.push(`on ${os}`);

  return {
    label: labelParts.join(' '),
    browser,
    os,
    type,
    model,
  };
}

function detectType(ua: string): DeviceType {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    return 'tablet';
  }
  if (/Mobi|iPhone|iPod|Android.*Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return 'mobile';
  }
  if (/Windows|Macintosh|Linux|CrOS|X11/i.test(ua)) return 'desktop';
  return 'unknown';
}

function detectOs(ua: string): string {
  if (/Windows NT 10/i.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/i.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.2/i.test(ua)) return 'Windows 8';
  if (/Windows NT 6\.1/i.test(ua)) return 'Windows 7';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/iPhone|iOS/i.test(ua)) {
    const m = ua.match(/OS (\d+)[_.](\d+)/);
    return m ? `iOS ${m[1]}.${m[2]}` : 'iOS';
  }
  if (/iPad/i.test(ua)) {
    const m = ua.match(/OS (\d+)[_.](\d+)/);
    return m ? `iPadOS ${m[1]}.${m[2]}` : 'iPadOS';
  }
  if (/Mac OS X (\d+)[_.](\d+)/i.test(ua)) {
    const m = ua.match(/Mac OS X (\d+)[_.](\d+)/i);
    return m ? `macOS ${m[1]}.${m[2]}` : 'macOS';
  }
  if (/Android (\d+(?:\.\d+)?)/i.test(ua)) {
    const m = ua.match(/Android (\d+(?:\.\d+)?)/i);
    return m ? `Android ${m[1]}` : 'Android';
  }
  if (/CrOS/i.test(ua)) return 'Chrome OS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function detectBrowser(ua: string): string {
  // Order matters — Edge/Opera include Chrome in UA
  if (/Edg\/(\d+)/i.test(ua)) {
    const m = ua.match(/Edg\/(\d+)/i);
    return m ? `Edge ${m[1]}` : 'Edge';
  }
  if (/OPR\/(\d+)|Opera\/(\d+)/i.test(ua)) {
    const m = ua.match(/OPR\/(\d+)/i) || ua.match(/Opera\/(\d+)/i);
    return m ? `Opera ${m[1]}` : 'Opera';
  }
  if (/SamsungBrowser\/(\d+)/i.test(ua)) {
    const m = ua.match(/SamsungBrowser\/(\d+)/i);
    return m ? `Samsung Internet ${m[1]}` : 'Samsung Internet';
  }
  if (/Firefox\/(\d+)/i.test(ua)) {
    const m = ua.match(/Firefox\/(\d+)/i);
    return m ? `Firefox ${m[1]}` : 'Firefox';
  }
  // Chrome before Safari (Safari also has "Safari" in Chrome UAs)
  if (/Chrome\/(\d+)/i.test(ua) && !/Edg\//i.test(ua)) {
    const m = ua.match(/Chrome\/(\d+)/i);
    return m ? `Chrome ${m[1]}` : 'Chrome';
  }
  if (/CriOS\/(\d+)/i.test(ua)) {
    const m = ua.match(/CriOS\/(\d+)/i);
    return m ? `Chrome ${m[1]}` : 'Chrome';
  }
  if (/FxiOS\/(\d+)/i.test(ua)) {
    const m = ua.match(/FxiOS\/(\d+)/i);
    return m ? `Firefox ${m[1]}` : 'Firefox';
  }
  if (/Version\/(\d+).*Safari/i.test(ua) || (/Safari\//i.test(ua) && /Version\//i.test(ua))) {
    const m = ua.match(/Version\/(\d+)/i);
    return m ? `Safari ${m[1]}` : 'Safari';
  }
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  return 'Unknown browser';
}

function detectModel(ua: string): string | undefined {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPod/i.test(ua)) return 'iPod';
  // Android device model in parentheses: Linux; Android 13; Pixel 7 Build/...
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/i);
  if (android?.[1]) {
    const raw = android[1].trim();
    if (raw && !/^wv$/i.test(raw) && !/^[a-z]{2}-[a-z]{2}$/i.test(raw)) {
      return raw.replace(/\s+/g, ' ').slice(0, 40);
    }
  }
  return undefined;
}

/** Relative activity for API consumers (ISO still included separately). */
export function activityState(lastActiveAt?: Date | string | null): {
  isOnline: boolean;
  relative: string;
} {
  if (!lastActiveAt) return { isOnline: false, relative: 'Unknown' };
  const t = new Date(lastActiveAt).getTime();
  if (Number.isNaN(t)) return { isOnline: false, relative: 'Unknown' };
  const diff = Date.now() - t;
  if (diff < 2 * 60 * 1000) return { isOnline: true, relative: 'Active now' };
  if (diff < 60 * 60 * 1000) {
    const m = Math.max(1, Math.floor(diff / 60000));
    return { isOnline: false, relative: `Active ${m}m ago` };
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const h = Math.floor(diff / 3600000);
    return { isOnline: false, relative: `Active ${h}h ago` };
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const d = Math.floor(diff / 86400000);
    return { isOnline: false, relative: `Active ${d}d ago` };
  }
  return {
    isOnline: false,
    relative: `Last active ${new Date(t).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`,
  };
}
