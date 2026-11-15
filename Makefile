.PHONY: all kernel qr web test run serve

all: web

kernel:
	python3 scripts/build.py

qr: kernel
	node scripts/qr-generate.mjs release/qrnel.bin
	node scripts/qr-generate.mjs release/qrnel.bin release/qrnel.svg
	cp THIRD_PARTY_LICENSES.txt release/THIRD_PARTY_LICENSES.txt
	cd release && shasum -a 256 qrnel.bin qrnel.png qrnel.svg THIRD_PARTY_LICENSES.txt > SHA256SUMS

web: qr
	npm run build

test: web
	python3 scripts/test-build.py
	python3 scripts/test-qemu.py
	npm run verify:qr
	npm run test:browser

run: kernel
	qemu-system-i386 -accel tcg -cpu pentium -m 16M -nic none -boot a -drive file=build/floppy.img,format=raw,if=floppy,readonly=on

serve:
	npm run serve
