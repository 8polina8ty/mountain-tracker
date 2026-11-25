"""Exercise the exact GitHub Actions scheduler client without network access."""

from contextlib import redirect_stderr, redirect_stdout
import http.client
import io
import json
import os
from pathlib import Path
import textwrap
import unittest
from unittest.mock import patch


WORKFLOW = Path(__file__).resolve().parent.parent / ".github/workflows/expedition-thumbnail-scheduler.yml"
SOURCE = compile(
    textwrap.dedent(WORKFLOW.read_text(encoding="utf-8").split("<<'PY'\n", 1)[1].rsplit("          PY", 1)[0]),
    str(WORKFLOW),
    "exec",
)
HOST = "mountain-tracker-staging-abcd12345-arot3743-7343s-projects.vercel.app"
BEARER = "a" * 64
BYPASS = "synthetic-vercel-ingress-test"
CONFIG = {"WORKER_HOST": HOST, "WORKER_BEARER": BEARER, "VERCEL_BYPASS": BYPASS}


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.connection = self.enterContext(patch.object(http.client, "HTTPSConnection"))
        self.response = self.connection.return_value.getresponse.return_value
        self.response.status = 200
        self.response.headers.get_content_type.return_value = "application/json"
        self.response.read.return_value = b'{"status":"busy"}'

    def run_client(self, **env):
        output = io.StringIO()
        code = 0
        with patch.dict(os.environ, CONFIG | env, clear=True), redirect_stdout(output), redirect_stderr(output):
            try:
                exec(SOURCE, {})
            except SystemExit as error:
                code = error.code
        self.assertNotIn(BEARER, output.getvalue())
        self.assertNotIn(BYPASS, output.getvalue())
        return code, output.getvalue().strip()

    def test_fixed_protected_post(self):
        self.assertEqual(self.run_client(), (0, "Thumbnail scheduler: busy"))
        self.connection.assert_called_once_with(HOST, timeout=35)
        transport = self.connection.return_value
        transport.request.assert_called_once()
        self.assertEqual(transport.request.call_args.args, ("POST", "/api/internal/expedition-media/thumbnails"))
        headers = transport.request.call_args.kwargs["headers"]
        self.assertEqual(headers["Authorization"], f"Bearer {BEARER}")
        self.assertEqual(headers["x-vercel-protection-bypass"], BYPASS)
        self.assertNotIn("apikey", headers)
        self.response.read.assert_called_once_with(2049)
        transport.close.assert_called_once()

    def test_invalid_host_blocks_egress(self):
        for value in ("", "http://" + HOST, "mountain-tracker.vercel.app", HOST + ":443",
                      HOST + "/path", HOST + "@example.com", HOST + ".example.com", HOST + "?a=1"):
            with self.subTest(value=value):
                self.assertEqual(self.run_client(WORKER_HOST=value)[0], 1)
        self.connection.assert_not_called()

    def test_invalid_credentials_block_egress(self):
        for config in (
            {"WORKER_BEARER": ""},
            {"WORKER_BEARER": "sb_secret_" + "x" * 36},
            {"VERCEL_BYPASS": ""},
            {"VERCEL_BYPASS": "eyJabc.signature.payload" + "x" * 8},
            {"VERCEL_BYPASS": "sb_secret_" + "x" * 36},
            {"VERCEL_BYPASS": BEARER},
            {"VERCEL_BYPASS": BYPASS + "\r\nInjected: value"},
        ):
            with self.subTest(config=config):
                self.assertEqual(self.run_client(**config)[0], 1)
        self.connection.assert_not_called()

    def test_redirects_and_http_failures_are_not_followed_or_retried(self):
        for status in (302, 307, 401, 403, 404, 429, 503):
            with self.subTest(status=status):
                self.connection.reset_mock()
                self.response.status = status
                self.assertEqual(self.run_client(), (1, f"Thumbnail scheduler: worker HTTP {status}"))
                self.connection.return_value.request.assert_called_once()
                self.response.read.assert_not_called()

    def test_successful_outcomes_are_allowlisted(self):
        for outcome in ("idle", "ready", "fenced", "source_changed", "invalid_source"):
            self.response.read.return_value = json.dumps(
                {"status": "completed", "generation": {"outcome": outcome}}
            ).encode()
            with self.subTest(outcome=outcome):
                self.assertEqual(self.run_client(), (0, f"Thumbnail scheduler: completed ({outcome})"))

    def test_invalid_response_body_is_not_printed(self):
        self.response.headers.get_content_type.return_value = "text/html"
        self.assertEqual(self.run_client()[0], 1)
        self.response.headers.get_content_type.return_value = "application/json"
        for body in (b"x" * 2049, b"not json", b"null", b'{"status":"completed"}',
                     json.dumps({"status": "completed", "generation": {"outcome": BEARER}}).encode()):
            with self.subTest(size=len(body)):
                self.response.read.return_value = body
                self.assertEqual(self.run_client()[0], 1)

    def test_operational_failures_mark_run_failed(self):
        for outcome in ("storage", "processing"):
            self.response.read.return_value = json.dumps(
                {"status": "completed", "generation": {"outcome": outcome}}
            ).encode()
            with self.subTest(outcome=outcome):
                self.assertEqual(self.run_client(), (1, f"Thumbnail scheduler: worker reported {outcome}"))

    def test_transport_error_detail_is_never_logged(self):
        self.connection.return_value.request.side_effect = OSError(f"private data {BEARER} {BYPASS}")
        self.assertEqual(self.run_client(), (1, "Thumbnail scheduler: HTTPS or response decoding failed"))
        self.connection.return_value.request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
