function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const clean = hostname.replace(/^\[|\]$/g, '').trim();
  if (/^\d+$/.test(clean)) {
    const num = Number(clean);
    if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
      return null;
    }
    return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255];
  }
  if (/^0x[0-9a-f]+$/i.test(clean)) {
    const num = Number.parseInt(clean, 16);
    if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
      return null;
    }
    return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255];
  }
  const parts = clean.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!part) {
      return null;
    }
    let val: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      val = Number.parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      val = Number.parseInt(part, 8);
    } else if (/^\d+$/.test(part)) {
      val = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isInteger(val) || val < 0 || val > 255) {
      return null;
    }
    octets.push(val);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function isRestrictedIpv4Octets(
  octets: [number, number, number, number],
  allowLoopback: boolean,
): boolean {
  const [a, b] = octets;
  if (a === 127) {
    return !allowLoopback;
  }
  if (a === 0 || a === 10 || a >= 224) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

export function isLoopbackHostname(rawHostname: string): boolean {
  const clean = rawHostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (!clean) {
    return false;
  }
  if (clean === 'localhost' || clean.endsWith('.localhost') || clean === '::1') {
    return true;
  }
  if (clean.startsWith('::ffff:')) {
    return isLoopbackHostname(clean.slice('::ffff:'.length));
  }
  const octets = parseIpv4Octets(clean);
  if (octets) {
    return octets[0] === 127;
  }
  return false;
}

export function isRestrictedNetworkHostname(rawHostname: string, allowLoopback = false): boolean {
  const clean = rawHostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (!clean) {
    return true;
  }
  if (clean === 'localhost' || clean.endsWith('.localhost')) {
    return !allowLoopback;
  }
  if (
    clean.endsWith('.local') ||
    clean.endsWith('.internal') ||
    clean === 'metadata.google.internal' ||
    clean === 'metadata'
  ) {
    return true;
  }
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') {
    return !allowLoopback;
  }
  if (clean === '::' || clean === '::0' || clean === '0:0:0:0:0:0:0:0') {
    return true;
  }
  if (clean.startsWith('::ffff:')) {
    const mappedHost = clean.slice('::ffff:'.length);
    if (mappedHost.includes('.')) {
      return isRestrictedNetworkHostname(mappedHost, allowLoopback);
    }
    const hexGroups = mappedHost.split(':');
    if (hexGroups.length === 2) {
      const hi = Number.parseInt(hexGroups[0] ?? '', 16);
      const lo = Number.parseInt(hexGroups[1] ?? '', 16);
      if (Number.isInteger(hi) && Number.isInteger(lo)) {
        return isRestrictedIpv4Octets(
          [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255],
          allowLoopback,
        );
      }
    }
    return true;
  }
  if (/^(fc|fd|fe[89ab])[0-9a-f]*:/i.test(clean)) {
    return true;
  }
  const octets = parseIpv4Octets(clean);
  if (octets) {
    return isRestrictedIpv4Octets(octets, allowLoopback);
  }
  return false;
}

export function isLoopbackOriginUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function validateExternalHttpAssetUrl(
  rawUrl: string,
  allowLoopback = false,
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid asset URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http:// and https:// asset URLs are allowed' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Asset URL must not embed credentials' };
  }
  if (isRestrictedNetworkHostname(parsed.hostname, allowLoopback)) {
    return {
      ok: false,
      reason: `Private, loopback, or link-local asset host "${parsed.hostname}" is blocked`,
    };
  }
  return { ok: true, url: parsed.toString() };
}
