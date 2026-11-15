#!/usr/bin/env python3
"""Check release provenance, ELF memory layout and independent clean-build equality."""
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
payload = (ROOT / "release/qrnel.bin").read_bytes()
manifest = json.loads((ROOT / "release/manifest.json").read_text())
assert len(payload) == 2953 and payload[510:512] == b"\x55\xaa"
assert manifest == {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
floppy = (ROOT / "build/floppy.img").read_bytes()
assert len(floppy) == 1474560 and floppy[:len(payload)] == payload
assert not any(floppy[len(payload):]), "nonzero bytes outside QR payload"

elf = (ROOT / "build/kernel.elf").read_bytes()
assert elf[:7] == b"\x7fELF\x01\x01\x01", "expected little-endian ELF32"
assert struct.unpack_from("<HH", elf, 16) == (2, 3), "expected executable i386"
entry, phoff = struct.unpack_from("<II", elf, 24)
phsize, count = struct.unpack_from("<HH", elf, 42)
assert entry == 0x7c00
arenas = 0
for n in range(count):
    kind, offset, address, physical, filesz, memsz, flags, align = struct.unpack_from("<8I", elf, phoff + n * phsize)
    if kind != 1: continue
    assert address == physical
    assert filesz <= memsz
    if filesz:
        assert 0x7c00 <= address < address + filesz <= 0x7c00 + len(payload)
        assert elf[offset:offset + filesz] == payload[address - 0x7c00:address - 0x7c00 + filesz]
        assert filesz == memsz, "initialized and zero-init sections must be separate"
    elif address == 0x20000:
        assert memsz == 4096 and flags == 6, "expected a non-executable, uninitialized arena"
        arenas += 1
    else:
        assert 0x11000 <= address <= address + memsz <= 0x12000
assert arenas == 1
print("PASS: QR size/signature/hash, exact zero-padded disk, ELF code and BSS bounds")

# Different absolute source/build directories ensure path-dependent output is detected.
with tempfile.TemporaryDirectory(prefix="qrnel-reproduce-") as temp:
    for name in ("one", "different-path-two"):
        root = Path(temp) / name
        shutil.copytree(ROOT / "kernel", root / "kernel")
        (root / "scripts").mkdir()
        shutil.copy(ROOT / "scripts/build.py", root / "scripts")
        shutil.copy(ROOT / "rust-toolchain.toml", root)
        subprocess.run(["python3", "scripts/build.py"], cwd=root, check=True, stdout=subprocess.PIPE)
        assert (root / "release/qrnel.bin").read_bytes() == payload, f"non-reproducible build in {name}"
        assert (root / "release/manifest.json").read_bytes() == (ROOT / "release/manifest.json").read_bytes()
print("PASS: two independent clean builds equal the release byte-for-byte")
