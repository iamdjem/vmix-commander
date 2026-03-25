#!/usr/bin/env python3
"""Local server: serves static files + proxies vMix API calls to avoid CORS."""
import http.server, urllib.request, urllib.parse, json, os

PORT = 8080

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args): pass  # silence logs

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/vmix-proxy':
            qs = urllib.parse.parse_qs(parsed.query)
            ip = qs.get('ip', [''])[0]
            fn = qs.get('fn', [''])[0]
            if not ip:
                self.send_error(400, 'Missing ip'); return
            url = f'http://{ip}:8088/api' + (f'?Function={fn}' if fn else '')
            try:
                with urllib.request.urlopen(url, timeout=4) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/xml')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
                self.send_header('Pragma', 'no-cache')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_response(502)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
        else:
            super().do_GET()

os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f'Serving on http://localhost:{PORT}')
http.server.HTTPServer(('', PORT), Handler).serve_forever()
