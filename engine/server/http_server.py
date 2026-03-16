"""
HTTP server helpers — thin wrappers used by dictee_engine.py.
The main server is run inside VoiceTyperEngine (aiohttp).
This module provides utility functions for server setup.
"""

import logging
import socket
from typing import Optional

log = logging.getLogger('voicetyper.server')


def get_local_ip() -> str:
    """Return the primary local IPv4 address."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'


def get_all_local_ips() -> list[str]:
    """Return all non-loopback IPv4 addresses on this machine."""
    import socket
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            if ':' not in addr and addr != '127.0.0.1':
                if addr not in ips:
                    ips.append(addr)
    except Exception:
        pass
    if not ips:
        ips.append(get_local_ip())
    return ips


def is_port_available(port: int, host: str = '0.0.0.0') -> bool:
    """Check if a TCP port is available."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            return True
    except OSError:
        return False


def find_free_port(start: int = 7523, end: int = 7600) -> Optional[int]:
    """Find the first available port in range."""
    for port in range(start, end):
        if is_port_available(port):
            return port
    return None
