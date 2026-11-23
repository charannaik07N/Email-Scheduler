import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Users can point a sender at their own SMTP server. Without limits that lets
 * them make this server connect anywhere, including services on its private
 * network, and read the connection errors back. So custom SMTP servers must be
 * on a mail port and resolve only to public addresses, and the worker connects
 * to the address checked here (not a second lookup that could differ).
 */

export const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525] as const;

/** The host or port is never allowed; retrying won't help. */
export class SmtpHostNotAllowedError extends Error {}

/** DNS lookup failed; this may be temporary. */
export class SmtpHostLookupError extends Error {}

// Addresses that are not on the public internet (RFC 6890 special-purpose ranges).
const blocked = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds an IPv4 address)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(prefix, bits, 'ipv6');
}

/** True for an address on the public internet. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) reaches the IPv4 address.
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !blocked.check(mapped[1], 'ipv4');
  return !blocked.check(address, 'ipv6');
};

export const assertSmtpPortAllowed = (port: number) => {
  if (!(ALLOWED_SMTP_PORTS as readonly number[]).includes(port)) {
    throw new SmtpHostNotAllowedError(`SMTP port must be one of ${ALLOWED_SMTP_PORTS.join(', ')}`);
  }
};

/**
 * Resolve a custom SMTP host and check every address it resolves to is public.
 * Returns the address to connect to (IPv4 when there is one). Throws SmtpHostNotAllowedError for a
 * private address and SmtpHostLookupError when the name doesn't resolve.
 */
export const resolveSmtpHost = async (host: string): Promise<string> => {
  const name = host.trim().replace(/^\[(.*)\]$/, '$1');
  let addresses: string[];
  if (isIP(name)) {
    addresses = [name];
  } else {
    try {
      addresses = (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      throw new SmtpHostLookupError(`SMTP host ${host} could not be found`);
    }
  }
  // One private answer is enough to refuse: the host could pick it at connect time.
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new SmtpHostNotAllowedError(`SMTP host ${host} is not a public internet address`);
  }
  // Only one address is used (the one that was checked), so prefer IPv4: many
  // servers and containers have no IPv6 route, and an IPv6-first answer would
  // fail there although the host also has IPv4 addresses.
  return addresses.find((address) => isIP(address) === 4) ?? addresses[0];
};
