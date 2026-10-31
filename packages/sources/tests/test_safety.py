"""SSRF defence: scheme, userinfo, ports, DNS results, IP encodings, redirects."""

from __future__ import annotations

import pytest

from tender_sources.safety import UnsafeURL, is_safe_url, validate_url


def public(_host: str) -> list[str]:
    return ["93.184.216.34"]


@pytest.mark.parametrize(
    "url",
    [
        "https://example.test/path?q=1",
        "http://example.test/",
        "https://example.test:443/x",
        "http://example.test:80/x",
        "https://search.worldbank.org/api/v2/procnotices?format=json",
    ],
)
def test_public_urls_pass(url: str) -> None:
    assert validate_url(url, resolver=public) == url


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.test/f",
        "file:///etc/passwd",
        "gopher://example.test/",
        "javascript:alert(1)",
        "data:text/html,hi",
        "//example.test/x",
        "example.test/x",
        "",
        "https://",
        "https://user@example.test/",
        "https://user:pw@example.test/",
        "https://example.test:8080/",
        "https://example.test:22/",
        "http://example.test:65535/",
        "https://exa mple.test/",
        "https://example.test/\r\nHost: evil",
    ],
)
def test_bad_shape_rejected(url: str) -> None:
    with pytest.raises(UnsafeURL):
        validate_url(url, resolver=public)


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "127.1.2.3",
        "10.0.0.1",
        "172.16.5.4",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.0.1",
        "100.64.0.1",  # CGNAT
        "100.127.255.254",
        "0.0.0.0",
        "224.0.0.1",  # multicast
        "239.255.255.250",
        "240.0.0.1",  # reserved
        "255.255.255.255",
        "192.0.2.1",  # documentation range
        "198.18.0.1",  # benchmarking
    ],
)
def test_private_ipv4_literals_rejected(host: str) -> None:
    with pytest.raises(UnsafeURL):
        validate_url(f"http://{host}/", resolver=public)


@pytest.mark.parametrize(
    "host",
    [
        "[::1]",
        "[::]",
        "[fe80::1]",
        "[fc00::1]",
        "[fd00::1]",
        "[fd00:ec2::254]",  # AWS IPv6 metadata
        "[ff02::1]",
        "[::ffff:127.0.0.1]",  # IPv4-mapped loopback
        "[::ffff:169.254.169.254]",  # IPv4-mapped metadata
        "[::ffff:10.0.0.1]",
        "[2002:7f00:0001::]",  # 6to4 embedding 127.0.0.1
        "[64:ff9b::7f00:1]",  # NAT64 embedding 127.0.0.1
    ],
)
def test_private_ipv6_literals_rejected(host: str) -> None:
    with pytest.raises(UnsafeURL):
        validate_url(f"http://{host}/", resolver=public)


def test_public_ipv6_literal_passes() -> None:
    assert is_safe_url("https://[2606:4700:4700::1111]/", resolver=public)


@pytest.mark.parametrize(
    "host",
    [
        "2130706433",  # decimal 127.0.0.1
        "0177.0.0.1",  # octal
        "0x7f.0.0.1",  # hex
        "0x7f000001",  # hex integer
        "017700000001",  # octal integer
        "127.1",  # short form
        "0300.0250.0.1",  # octal 192.168.0.1
        "3232235777",  # decimal 192.168.1.1
        "2852039166",  # decimal 169.254.169.254
    ],
)
def test_encoded_ip_hosts_rejected(host: str) -> None:
    with pytest.raises(UnsafeURL, match="encoded|non-public"):
        validate_url(f"http://{host}/", resolver=public)


@pytest.mark.parametrize(
    "host",
    ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "metadata.google.internal"],
)
def test_local_names_rejected(host: str) -> None:
    with pytest.raises(UnsafeURL):
        validate_url(f"http://{host}/", resolver=public)


@pytest.mark.parametrize(
    "answers",
    [
        ["127.0.0.1"],
        ["10.1.2.3"],
        ["169.254.169.254"],
        ["::1"],
        ["::ffff:7f00:1"],
        ["93.184.216.34", "10.0.0.5"],  # one bad answer among good ones
        ["100.64.1.1"],
    ],
)
def test_dns_rebinding_name_resolving_to_private_ip(answers: list[str]) -> None:
    with pytest.raises(UnsafeURL, match="non-public"):
        validate_url("https://innocent.example.test/", resolver=lambda _h: answers)


def test_dns_failure_and_empty_answer() -> None:
    def boom(_h: str) -> list[str]:
        raise OSError("no such host")

    with pytest.raises(UnsafeURL, match="DNS"):
        validate_url("https://nxdomain.test/", resolver=boom)
    with pytest.raises(UnsafeURL, match="no addresses"):
        validate_url("https://nxdomain.test/", resolver=lambda _h: [])


def test_allow_hosts_lifts_checks_for_that_host_only() -> None:
    assert validate_url("http://127.0.0.1:8123/x", allow_hosts=["127.0.0.1"])
    with pytest.raises(UnsafeURL):
        validate_url("http://127.0.0.2:8123/x", allow_hosts=["127.0.0.1"])
    with pytest.raises(UnsafeURL):
        validate_url("http://localhost:8123/x", allow_hosts=["127.0.0.1"])
    assert validate_url("http://localhost:8123/x", allow_hosts=["localhost"])


def test_userinfo_trick_does_not_confuse_host_parsing() -> None:
    with pytest.raises(UnsafeURL):
        validate_url("http://example.test@127.0.0.1/", resolver=public)
    with pytest.raises(UnsafeURL):
        validate_url("http://127.0.0.1#@example.test/", resolver=public)
