# The container's program: a stdlib HTTP server on port 8080. The same file runs in Docker on
# celld and in a Wasmer sandbox on cellb.
import http.server, json, os, socketserver, sys


class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._json({"path": self.path, "cell": os.environ.get("CELL"), "python": sys.version.split()[0]})

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("0.0.0.0", 8080), Handler).serve_forever()
