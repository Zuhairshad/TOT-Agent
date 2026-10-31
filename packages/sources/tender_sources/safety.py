"""URL safety (SSRF defence) shared by page fetches, redirects and document links.

Rules (see docs/scrapling-architecture.md, "Security"):
  * only ``http`` / ``https``; no ``user:pass@`` userinfo; ports 80 / 443 only;
  * the host is resolved (injectable resolver) and EVERY address it resolves to must be a public
    unicast address: loopback, private, link-local, CGNAT (100.64/10), multicast, reserved,
    unspecified, cloud metadata (169.254.169.254, fd00:ec2::254) and IPv4-mapped / 6to4 / NAT64
    forms of those are rejected;
  * numeric hosts written as decimal / octal / hex integers (``2130706433``, ``0177.0.0.1``,
    ``0x7f.1``) are rejected outright rather than interpreted;
  * ``allow_hosts`` (explicit, exact host names or IPs) lifts the checks for that host only. It exists
    for tests against a local server and must never be filled from scraped data.

Known limit: validation resolves the name, then the HTTP client resolves it again when connecting, so
a hostile DNS server could answer differently the second time (DNS rebinding). We reduce the window by
re-validating every redirect hop and the final URL, and the data we fetch is never executed.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Callable, Iterable
from urllib.parse import urlsplit

Resolver = Callable[[str], list[str]]

_ALLOWED_SCHEMES = ("http", "https")
_ALLOWED_PORTS = {80, 443}
_METADATA_HOSTS = {"metadata.google.internal", "metadata", "instance-data"}
_NUMERIC_HOST = re.compile(r"^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$", re.IGNORECASE)
_EXTRA_BLOCKED_V4 = [ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("100.64.0.0/10")]
_EXTRA_BLOCKED_V6 = [ipaddress.ip_network("fd00:ec2::/32")]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class UnsafeURL(ValueError):
    """Raised when a URL must not be fetched. ``reason`` is a short machine-friendly string."""

    def __init__(self, url: str, reason: str) -> None:
        super().__init__(f"unsafe URL ({reason}): {url}")
        self.url = url
        self.reason = reason


def default_resolver(host: str) -> list[str]:
    """Resolve ``host`` to all its A/AAAA addresses."""
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def _embedded_v4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip in _NAT64:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if ip.teredo is not None:
        return ip.teredo[1]
    return None


def ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True only for globally routable unicast addresses."""
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_v4(ip)
        if embedded is not None and not ip_is_public(embedded):
            return False
        if any(ip in net for net in _EXTRA_BLOCKED_V6):
            return False
    elif any(ip in net for net in _EXTRA_BLOCKED_V4):
        return False
    if ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip.is_link_local:
        return False
    if ip.is_private or ip.is_reserved:
        return False
    return bool(ip.is_global)


def _check_ip_literal(url: str, text: str) -> None:
    try:
        ip = ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError as exc:
        raise UnsafeURL(url, "invalid IP literal") from exc
    if not ip_is_public(ip):
        raise UnsafeURL(url, f"non-public address {ip}")


def validate_url(
    url: str,
    *,
    allow_hosts: Iterable[str] = (),
    resolver: Resolver | None = None,
) -> str:
    """Return ``url`` unchanged if it is safe to fetch, else raise :class:`UnsafeURL`."""
    if not isinstance(url, str) or not url.strip():
        raise UnsafeURL(str(url), "empty URL")
    if any(ch in url for ch in ("\r", "\n", "\t", "\x00", " ")):
        raise UnsafeURL(url, "whitespace or control characters")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise UnsafeURL(url, f"malformed URL: {exc}") from exc
    if parts.scheme.lower() not in _ALLOWED_SCHEMES:
        raise UnsafeURL(url, f"scheme {parts.scheme!r} not allowed")
    if "@" in parts.netloc:
        raise UnsafeURL(url, "userinfo in URL")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UnsafeURL(url, "missing host")

    allowed = {h.lower().strip("[]") for h in allow_hosts}
    if host in allowed:
        return url

    if port is not None and port not in _ALLOWED_PORTS:
        raise UnsafeURL(url, f"port {port} not allowed")
    if host == "localhost" or host.endswith(".localhost") or host in _METADATA_HOSTS:
        raise UnsafeURL(url, "local or metadata host name")

    is_v6_literal = ":" in host
    if is_v6_literal:
        _check_ip_literal(url, host)
        return url
    if _NUMERIC_HOST.match(host):
        # Canonical dotted-quad is checked as an IP; any other numeric spelling is an encoded IP.
        try:
            ipaddress.IPv4Address(host)
        except ValueError as exc:
            raise UnsafeURL(url, "encoded (decimal/octal/hex) IP host") from exc
        _check_ip_literal(url, host)
        return url

    resolve = resolver or default_resolver
    try:
        addresses = resolve(host)
    except (OSError, UnicodeError) as exc:
        raise UnsafeURL(url, f"DNS resolution failed: {exc}") from exc
    if not addresses:
        raise UnsafeURL(url, "DNS returned no addresses")
    for address in addresses:
        _check_ip_literal(url, address)
    return url


def is_safe_url(
    url: str, *, allow_hosts: Iterable[str] = (), resolver: Resolver | None = None
) -> bool:
    try:
        validate_url(url, allow_hosts=allow_hosts, resolver=resolver)
    except UnsafeURL:
        return False
    return True
