import base64
import io
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "native-host"))
import texflow_host as host  # noqa: E402

PDF = b"%PDF-1.5\n%fake\n%%EOF\n"
B64 = base64.b64encode(PDF).decode()


class HostTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(self._tmp.name)
        os.makedirs(os.path.join(self.home, "Desktop", "Junior"))

    def tearDown(self):
        self._tmp.cleanup()

    def test_saves_with_tilde_path(self):
        out = host.save_pdf("~/Desktop/Junior/r.pdf", B64, home=self.home)
        self.assertEqual(out["bytes"], len(PDF))
        with open(os.path.join(self.home, "Desktop", "Junior", "r.pdf"), "rb") as fh:
            self.assertEqual(fh.read(), PDF)

    def test_overwrites_by_default(self):
        target = os.path.join(self.home, "Desktop", "r.pdf")
        with open(target, "wb") as fh:
            fh.write(b"%PDF-old")
        host.save_pdf(target, B64, home=self.home)
        with open(target, "rb") as fh:
            self.assertEqual(fh.read(), PDF)

    def test_no_overwrite_flag(self):
        target = os.path.join(self.home, "Desktop", "r.pdf")
        host.save_pdf(target, B64, home=self.home)
        with self.assertRaises(host.HostError):
            host.save_pdf(target, B64, overwrite=False, home=self.home)

    def test_rejects_outside_home(self):
        with self.assertRaises(host.HostError):
            host.save_pdf("/etc/r.pdf", B64, home=self.home)
        with self.assertRaises(host.HostError):
            host.save_pdf("~/../escape.pdf", B64, home=self.home)

    def test_rejects_relative_path(self):
        with self.assertRaises(host.HostError):
            host.save_pdf("Desktop/r.pdf", B64, home=self.home)

    def test_rejects_missing_folder(self):
        with self.assertRaises(host.HostError):
            host.save_pdf("~/Desktop/Nope/r.pdf", B64, home=self.home)

    def test_rejects_non_pdf(self):
        with self.assertRaises(host.HostError):
            host.save_pdf("~/Desktop/r.txt", B64, home=self.home)
        with self.assertRaises(host.HostError):
            host.save_pdf("~/Desktop/r.pdf", base64.b64encode(b"hello").decode(), home=self.home)

    def test_no_temp_files_left(self):
        host.save_pdf("~/Desktop/r.pdf", B64, home=self.home)
        leftovers = [f for f in os.listdir(os.path.join(self.home, "Desktop")) if f.startswith(".texflow-")]
        self.assertEqual(leftovers, [])

    def test_check_dir(self):
        self.assertTrue(host.check_dir("~/Desktop/Junior", home=self.home)["exists"])
        self.assertFalse(host.check_dir("~/Desktop/Senior", home=self.home)["exists"])

    def test_message_framing_roundtrip(self):
        buf = io.BytesIO()
        host.write_message(buf, {"id": 7, "type": "ping"})
        buf.seek(0)
        self.assertEqual(host.read_message(buf), {"id": 7, "type": "ping"})
        self.assertIsNone(host.read_message(io.BytesIO(struct.pack("<I", 10) + b"{}")))

    def test_choose_folder_returns_tilde_path(self):
        picked = os.path.join(self.home, "Desktop", "Junior") + "/"
        calls = []

        def fake_run(args, **kw):
            calls.append(args)
            return type("P", (), {"returncode": 0, "stdout": picked + "\n", "stderr": ""})()

        out = host.choose_folder("~/Desktop", home=self.home, run=fake_run)
        self.assertEqual(out, {"path": "~/Desktop/Junior"})
        self.assertIn("default location", calls[0][-1])

    def test_choose_folder_cancel(self):
        def fake_run(args, **kw):
            return type("P", (), {"returncode": 1, "stdout": "", "stderr": "execution error: User canceled. (-128)"})()

        self.assertEqual(host.choose_folder(None, home=self.home, run=fake_run), {"cancelled": True})

    def test_handle_unknown_type(self):
        with self.assertRaises(host.HostError):
            host.handle({"type": "rm -rf"}, home=self.home)


if __name__ == "__main__":
    unittest.main()
