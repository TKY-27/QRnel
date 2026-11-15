#!/usr/bin/env python3
"""Build a raw guest; nothing is downloaded or injected into the floppy."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)

def run(*args):
    subprocess.run(args, check=True)

nasm_version = subprocess.check_output(["nasm", "-v"], text=True).split()[2]
if nasm_version != "3.02":
    raise SystemExit(f"Reproducible release requires NASM 3.02; found {nasm_version}")
if not subprocess.check_output(["rustc", "-V"], text=True).startswith("rustc 1.99.1 "):
    raise SystemExit("Reproducible release requires rustc 1.99.1")

sysroot = Path(subprocess.check_output(["rustc", "--print", "sysroot"], text=True).strip())
host = subprocess.check_output(["rustc", "-vV"], text=True).split("host: ")[1].splitlines()[0]
llvm = sysroot / "lib/rustlib" / host / "bin"
run("nasm", "-f", "elf32", "kernel/boot.asm", "-o", "build/boot.o")
run("rustc", "kernel/main.rs", "--edition=2021", "--crate-type=lib", "--emit=obj",
    "--target=i586-unknown-linux-gnu", "-Ctarget-cpu=pentium", "-Copt-level=z", "-Cpanic=abort",
    "-Crelocation-model=static", "-Ccodegen-units=1", "-Cjump-tables=no", "-Coverflow-checks=no",
    "-o", "build/kernel.o")
run(str(llvm / "rust-lld"), "-flavor", "gnu", "-m", "elf_i386", "-T", "kernel/link.ld",
    "--gc-sections", "--nmagic", "-Map=build/kernel.map", "-o", "build/kernel.elf",
    "build/boot.o", "build/kernel.o")
run(str(llvm / "llvm-objcopy"), "-O", "binary", "build/kernel.elf", "build/qrnel.bin")
with open("build/kernel.dis", "w") as f:
    subprocess.run([str(llvm / "llvm-objdump"), "-d", "build/kernel.elf"], stdout=f, check=True)
payload = Path("build/qrnel.bin").read_bytes()
assert payload[510:512] == b"\x55\xaa"
print(f"payload: {len(payload)} bytes, sha256: {hashlib.sha256(payload).hexdigest()}")
Path("build/floppy.img").write_bytes(payload + bytes(1474560 - len(payload)))
if len(payload) > 2953:
    raise SystemExit("Payload exceeds QR Version 40-L byte capacity")
Path("release").mkdir(exist_ok=True)
Path("release/qrnel.bin").write_bytes(payload)
Path("release/manifest.json").write_text(json.dumps({"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}, indent=2) + "\n")
