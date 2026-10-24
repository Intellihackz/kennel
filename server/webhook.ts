// Sends an alert to the owner's webhook. The address is chosen by a user, so it must never reach a private network:
// https only, no IP literals, and the address is checked again at connect time (so a DNS change cannot slip past).
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import { lookup as dnsLookup } from "node:dns";

const blocked = new BlockList();
for (const [net, prefix, fam] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
] as const) blocked.addSubnet(net, prefix, fam);
const isPublic = (ip: string) => {
  const fam = isIP(ip);
  if (!fam) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublic(mapped[1]);
  return !blocked.check(ip, fam === 4 ? "ipv4" : "ipv6");
};

export function checkWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid link." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The webhook must be an https link." };
  if (u.port && u.port !== "443") return { ok: false, error: "The webhook must use the standard https port." };
  if (isIP(u.hostname.replace(/^\[|\]$/g, ""))) return { ok: false, error: "Use a name, not a numeric address." };
  if (u.username || u.password) return { ok: false, error: "Remove the username and password from the link." };
  if (raw.length > 300) return { ok: false, error: "That link is too long." };
  return { ok: true, url: u };
}

export function postJson(raw: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = checkWebhookUrl(raw);
    if (!c.ok) return reject(new Error(c.error));
    const data = JSON.stringify(body);
    const req = request(
      c.url,
      {
        method: "POST",
        timeout: 5000,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "user-agent": "kennel-alerts/1" },
        lookup: (host, opts, cb) =>
          dnsLookup(host, { ...opts, all: false }, (err, address, family) => {
            if (err) return cb(err, "", 0);
            if (!isPublic(String(address))) return cb(new Error("blocked address"), "", 0);
            cb(null, address, family);
          }),
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}
