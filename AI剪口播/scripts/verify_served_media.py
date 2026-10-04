#!/usr/bin/env python3
"""Fail closed unless a loopback video URL serves the accepted local bytes.

Identity is streaming SHA256 + actual byte length, never filename or mtime.
Also request one byte via Range, because a correct file that cannot seek is not
a usable review player. This checks a supplied media endpoint, not the HTML's
choice of endpoint; callers must obtain the URL from the actual player.
"""
import argparse
import hashlib
import http.client
import ipaddress
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class GateError(Exception):
    """Only fixed, non-sensitive error codes may be surfaced in the report."""


def validate_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise GateError('URL_INVALID')
        if parsed.username is not None or parsed.password is not None:
            raise GateError('URL_CREDENTIALS_FORBIDDEN')
        hostname = parsed.hostname
        if hostname != 'localhost':
            try:
                loopback = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                loopback = False
            if not loopback:
                raise GateError('URL_NOT_LOOPBACK')
        port = parsed.port
        host = f'[{hostname}]' if ':' in hostname else hostname
        return f'{parsed.scheme}://{host}' + (f':{port}' if port is not None else '')
    except ValueError:
        raise GateError('URL_INVALID') from None


class LoopbackRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            validate_url(newurl)
        except GateError:
            fp.close()
            raise
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def stream_digest(response, limit, deadline):
    digest = hashlib.sha256()
    count = 0
    while True:
        if time.monotonic() >= deadline:
            raise GateError('TIMEOUT')
        chunk = response.read1(min(1024 * 1024, max(1, limit - count + 1)))
        if not chunk:
            return count, digest.hexdigest()
        digest.update(chunk)
        count += len(chunk)
        if count > limit:
            raise GateError('SERVED_FILE_TOO_LARGE')


def verify(video, url, timeout=10.0):
    """Return a JSON-serializable report; never include raw network exceptions."""
    result = {'schema_version': 1, 'status': 'FAIL', 'url_origin': None,
              'local': {}, 'served': {}, 'range': {}, 'errors': []}
    try:
        result['url_origin'] = validate_url(url)
        if not math.isfinite(timeout) or timeout <= 0:
            raise GateError('TIMEOUT_INVALID')
        video = Path(video)
        if not video.is_absolute():
            raise GateError('VIDEO_PATH_NOT_ABSOLUTE')
        # Disable environment proxies: a local identity check must stay local.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LoopbackRedirect())
        with video.open('rb') as local:
            before = os.fstat(local.fileno())
            digest = hashlib.sha256()
            size = 0
            for chunk in iter(lambda: local.read(1024 * 1024), b''):
                digest.update(chunk)
                size += len(chunk)
            if size == 0:
                raise GateError('VIDEO_EMPTY')
            result['local'] = {'path': str(video), 'bytes': size, 'sha256': digest.hexdigest()}
            request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity',
                                                          'Cache-Control': 'no-cache'})
            deadline = time.monotonic() + timeout
            with opener.open(request, timeout=timeout) as response:
                result['served']['http_status'] = response.status
                if response.status != 200:
                    raise GateError('FULL_STATUS_NOT_200')
                count, remote_hash = stream_digest(response, size, deadline)
                result['served'].update(bytes=count, sha256=remote_hash)
            if count != size:
                result['errors'].append('LENGTH_MISMATCH')
            if remote_hash != digest.hexdigest():
                result['errors'].append('CONTENT_MISMATCH')
            if result['errors']:
                return result

            offset = size // 2
            local.seek(offset)
            expected_byte = local.read(1)
            request.add_header('Range', f'bytes={offset}-{offset}')
            with opener.open(request, timeout=timeout) as response:
                result['range'] = {'offset': offset, 'http_status': response.status}
                if response.status != 206:
                    raise GateError('RANGE_STATUS_NOT_206')
                if response.headers.get('Content-Range') != f'bytes {offset}-{offset}/{size}':
                    raise GateError('RANGE_CONTENT_RANGE_INVALID')
                body = response.read(2)
                if len(body) != 1:
                    raise GateError('RANGE_LENGTH_INVALID')
                if body != expected_byte:
                    raise GateError('RANGE_BYTE_MISMATCH')
                result['range']['byte_matches'] = True
            # Metadata is only a concurrent-write guard, never an identity proof.
            def revision(stat):
                return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns
            if revision(before) != revision(os.fstat(local.fileno())) or revision(before) != revision(video.stat()):
                raise GateError('LOCAL_CHANGED_DURING_VERIFICATION')
        result['status'] = 'PASS'
    except GateError as error:
        result['errors'].append(str(error))
    except urllib.error.HTTPError as error:
        result['errors'].append(f'HTTP_ERROR_{error.code}')
        error.close()
    except (TimeoutError,):
        result['errors'].append('TIMEOUT')
    except urllib.error.URLError as error:
        result['errors'].append('TIMEOUT' if isinstance(error.reason, TimeoutError) else 'NETWORK_ERROR')
    except http.client.HTTPException:
        result['errors'].append('HTTP_PROTOCOL_ERROR')
    except (OSError, ValueError):
        result['errors'].append('IO_ERROR')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', required=True, help='Absolute path to the accepted local video')
    parser.add_argument('--url', required=True, help='Actual loopback player media URL')
    parser.add_argument('--report', required=True, help='JSON report destination')
    parser.add_argument('--timeout', type=float, default=10.0, help='Seconds per HTTP operation (default: 10)')
    args = parser.parse_args(argv)
    result = verify(args.video, args.url, args.timeout)
    try:
        report = Path(args.report)
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    except OSError:
        print('VERIFIED_MEDIA=FAIL')
        return 1
    print(f"VERIFIED_MEDIA={result['status']}")
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
