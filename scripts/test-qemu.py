#!/usr/bin/env python3
"""Exercise the real guest through QMP keyboard input and physical VGA/RAM reads."""
import json
from collections import deque
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent

class Machine:
    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="qrnel-")
        self.path = Path(self.tmp.name)
        self.proc = subprocess.Popen([
            "qemu-system-i386", "-machine", "pc", "-cpu", "pentium", "-m", "16M",
            "-display", "none", "-no-reboot", "-nic", "none", "-monitor", "none",
            "-drive", f"file={ROOT}/build/floppy.img,format=raw,if=floppy,readonly=on",
            "-qmp", f"unix:{self.path}/qmp,server=on,wait=off",
            "-gdb", f"unix:{self.path}/gdb,server=on,wait=off",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(200):
                self.sock = socket.socket(socket.AF_UNIX)
                try:
                    self.sock.connect(str(self.path / "qmp")); break
                except OSError:
                    self.sock.close()
                    if self.proc.poll() is not None:
                        raise RuntimeError(self.proc.stderr.read().decode())
                    time.sleep(.025)
            else: raise TimeoutError("QMP socket")
            self.sock.settimeout(5)
            self.stream = self.sock.makefile("rwb")
            self.stream.readline()
            self.qmp("qmp_capabilities")
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill(); self.proc.wait()
        if hasattr(self, "stream"): self.stream.close()
        if hasattr(self, "sock"): self.sock.close()
        self.tmp.cleanup()

    def qmp(self, command, **arguments):
        self.stream.write((json.dumps({"execute": command, "arguments": arguments}) + "\n").encode())
        self.stream.flush()
        while True:
            line = self.stream.readline()
            if not line: raise RuntimeError("QEMU closed QMP")
            reply = json.loads(line)
            if "error" in reply: raise RuntimeError(reply["error"])
            if "return" in reply: return reply["return"]

    def monitor(self, command):
        return self.qmp("human-monitor-command", **{"command-line": command})

    def memory(self, start, length):
        file = self.path / "memory"
        result = self.monitor(f'pmemsave {start:#x} {length} "{file}"')
        if result: raise RuntimeError(result)
        return file.read_bytes()

    def seed_guards(self):
        # Test-only non-executable sentinels, outside every guest-owned allocation.
        self.qmp("stop")
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5)
            connection.connect(str(self.path / "gdb"))
            def packet(body):
                data = body.encode()
                connection.sendall(b"$" + data + b"#" + f"{sum(data) & 255:02x}".encode())
                while connection.recv(1) != b"$": pass
                reply = bytearray()
                while (byte := connection.recv(1)) != b"#": reply += byte
                connection.recv(2)
                connection.sendall(b"+")
                assert reply == b"OK", reply
            for address in (0x6000, 0x1fff0, 0x21000):
                packet(f"M{address:x},10:" + "a5" * 16)
            packet("D")
        self.qmp("cont")

    def trail_head(self):
        page = self.memory(0xb8000 + 320, 3200)
        points = [i for i in range(1600) if page[i*2:i*2+2] == b"\xdb\x0e"]
        assert len(points) == 1, points
        return points[0] % 80, points[0] // 80

    def screen(self):
        data = self.memory(0xb8000, 4000)[::2].decode("cp437")
        return "\n".join(data[i:i+80] for i in range(0, 2000, 80))

    def expect(self, text):
        for _ in range(100):
            screen = self.screen()
            if text in screen: return screen
            time.sleep(.025)
        raise AssertionError(f"Missing {text!r}:\n{screen}")

    def key(self, name):
        self.qmp("send-key", keys=[{"type": "qcode", "data": name}], **{"hold-time": 20})
        time.sleep(.04)

    def command(self, text):
        for key in text: self.key(key)
        self.key("ret")

    def clear(self):
        self.command("c")
        self.expect("h help")

    def registers(self):
        return self.monitor("info registers")


def snake_state(machine):
    page = machine.memory(0xb8000, 4000)
    body = set()
    head = food = None
    for y in range(12):
        for x in range(16):
            offset = ((y + 5) * 80 + 24 + x * 2) * 2
            glyph, color = page[offset:offset + 2]
            if color == 0x2f: body.add((x, y))
            if glyph == ord("@"): head = (x, y)
            if glyph == ord("*"): food = (x, y)
    return head, food, body


DIRECTIONS = {"w": (0, -1), "a": (-1, 0), "s": (0, 1), "d": (1, 0)}


def snake_step(machine, key=None, expected=None):
    old = snake_state(machine)[0]
    if key: machine.key(key)
    for _ in range(100):
        state = snake_state(machine)
        if state[0] != old:
            if expected is not None: assert state[0] == expected, (old, state, expected)
            return state
        time.sleep(.005)
    raise AssertionError(f"Snake failed to move: {machine.screen()}")


def snake_gameplay(m):
    m.command("a")
    m.command("s"); m.expect("SNAKE: WASD")
    assert snake_state(m) == ((7, 6), (11, 6), {(5, 6), (6, 6), (7, 6)})
    m.expect("score 0")
    snake_step(m, "a", (8, 6))  # Reverse must be ignored.
    snake_step(m, "d", (9, 6))
    snake_step(m, expected=(10, 6))
    head, food, body = snake_step(m, expected=(11, 6))
    assert len(body) == 4 and food not in body
    m.expect("score 1")
    # Choose a square without the new food, or a second growth would invalidate the tail oracle.
    food = snake_state(m)[1]
    row = 7 if food in {(11, 5), (10, 5)} else 5
    outward, inward = ("s", "w") if row == 7 else ("w", "s")
    # A later straight-ahead key must not cancel the already accepted turn.
    m.key(outward)
    snake_step(m, "d", (11, row))
    snake_step(m, "a", (10, row))
    head, _, body = snake_step(m, inward, (10, 6))
    assert len(body) == 4 and "GAME OVER" not in m.screen(), "vacating tail must be traversable"

    # Plan from the displayed board, independently of the guest's food generator.
    head, food, body = snake_state(m)
    queue = deque([(head, [])]); seen = {head}
    while queue:
        point, path = queue.popleft()
        if point == food: break
        for key, (dx, dy) in DIRECTIONS.items():
            next_point = (point[0] + dx, point[1] + dy)
            if (0 <= next_point[0] < 16 and 0 <= next_point[1] < 12 and
                    next_point not in body and next_point not in seen):
                seen.add(next_point); queue.append((next_point, path + [(key, next_point)]))
    else: raise AssertionError("No route to second food")
    for key, point in path: head, food, body = snake_step(m, key, point)
    assert len(body) == 5 and food not in body
    m.expect("score 2")
    direction = DIRECTIONS[path[-1][0]]
    # A four-cell loop with length five hits occupied body rather than a vacating tail.
    for attempt in range(20):
        cycle = None
        for first_key, first in DIRECTIONS.items():
            if first == (-direction[0], -direction[1]): continue
            for second in [(-first[1], first[0]), (first[1], -first[0])]:
                moves = [first, second, (-first[0], -first[1]), (-second[0], -second[1])]
                point = head; points = []
                for dx, dy in moves:
                    point = (point[0] + dx, point[1] + dy); points.append(point)
                if all(0 <= x < 16 and 0 <= y < 12 and (x, y) not in body and (x, y) != food
                       for x, y in points[:3]):
                    cycle = (moves, points); break
            if cycle: break
        if cycle: break
        # Food can spawn against a wall: first steer into open space using only the display.
        candidates = []
        for key, (dx, dy) in DIRECTIONS.items():
            point = (head[0] + dx, head[1] + dy)
            if (0 <= point[0] < 16 and 0 <= point[1] < 12 and point not in body and point != food):
                candidates.append((abs(point[0] - 8) + abs(point[1] - 6), key, point))
        assert candidates, (head, food, body)
        _, key, point = min(candidates)
        head, food, body = snake_step(m, key, point)
        direction = DIRECTIONS[key]
    assert cycle, (head, food, body)
    moves, points = cycle
    reverse = {value: key for key, value in DIRECTIONS.items()}
    for move, point in zip(moves[:3], points[:3]): snake_step(m, reverse[move], point)
    before = snake_state(m)
    m.key(reverse[moves[3]]); m.expect("GAME OVER")
    assert snake_state(m) == before, "collision must not advance the head"
    time.sleep(.25)
    assert snake_state(m) == before, "dead game must stay frozen"
    m.key("esc"); m.expect("h help")
    m.command("m"); m.expect("free 3840")

    m.command("s"); m.expect("SNAKE: WASD")
    m.expect("GAME OVER")  # Default Right reaches the wall.
    assert snake_state(m)[0] == (15, 6)
    for _ in range(3):
        m.key("r"); m.expect("score 0")
        assert snake_state(m) == ((7, 6), (11, 6), {(5, 6), (6, 6), (7, 6)})
    m.key("esc"); m.expect("h help")
    m.command("m"); m.expect("free 3840")
    m.command("r")
    print("PASS: Snake WASD, reverse rejection, food, growth, score, tail entry, self/wall collision, restart, Esc and arena restoration")


def main():
    with Machine() as m:
        m.expect("QRnel / Rust")
        regs = m.registers()
        assert "CS32" in regs and re.search(r"CR0=0000001[13]", regs), regs
        assert re.search(r"IDT=\s+00010000 000007ff", regs), regs
        for index in range(256):
            gate = m.memory(0x10000 + index * 8, 8)
            address = int.from_bytes(gate[:2], "little") | int.from_bytes(gate[6:], "little") << 16
            assert 0x7c00 <= address < 0x7c00 + len((ROOT / "release/qrnel.bin").read_bytes())
            assert gate[2:6] == b"\x08\x00\x00\x8e", (index, gate)
        print("PASS: boot, protected mode, all 256 IDT gates")

        m.command("t")
        first = int(re.findall(r"ticks (\d+)", m.expect("ticks "))[-1])
        time.sleep(.15)
        m.command("t")
        second = int(re.findall(r"ticks (\d+)", m.expect("ticks "))[-1])
        assert second > first, (first, second)
        m.command("m"); m.expect("free 4096")
        m.clear(); m.command("z"); m.expect("unknown")
        m.clear(); m.key("z"); m.key("backspace"); m.command("m"); m.expect("free 4096")
        m.clear(); m.key("shift"); m.command("m"); m.expect("free 4096")
        m.clear(); m.command("mm"); m.expect("unknown")
        m.clear(); m.key("m"); m.key("m"); m.key("backspace"); m.command("m"); m.expect("free 4096")
        print("PASS: IRQ timer, PS/2 make/break/modifier/backspace input, shell")

        m.seed_guards()
        for address in (0x6000, 0x1fff0, 0x21000): assert m.memory(address, 16) == bytes([0xa5]) * 16
        m.clear(); m.command("a"); m.expect("allocated 256")
        m.command("m"); m.expect("free 3840")
        m.command("d"); m.expect("TRAIL / arrows steer / Esc shell")
        time.sleep(.2)
        frame = m.memory(0xb8000 + 320, 3200)
        time.sleep(.2)
        assert m.memory(0xb8000 + 320, 3200) != frame, "PIT-paced animation did not advance"
        m.key("left"); time.sleep(.08)
        x1, y1 = m.trail_head()
        time.sleep(.08)
        x2, y2 = m.trail_head()
        assert x2 < x1 and y2 == y1, ((x1, y1), (x2, y2))
        regs = m.registers()
        esp = int(re.search(r"ESP=([0-9a-fA-F]+)", regs)[1], 16)
        assert 0x6000 < esp <= 0x7000, regs
        m.key("esc"); m.expect("h help")
        m.command("m"); m.expect("free 3840")
        m.command("r"); m.command("m"); m.expect("free 4096")
        print("PASS: separate animated program, arrow input, stack range, arena restored")

        snake_gameplay(m)

        for _ in range(16): m.command("a")
        m.clear(); m.command("a"); m.expect("no memory")
        m.command("m"); m.expect("free 0")
        m.command("d"); m.expect("no memory / Esc shell")
        m.key("esc"); m.expect("h help")
        m.command("s"); m.expect("no memory / Esc shell")
        m.key("esc"); m.expect("h help")
        for address in (0x6000, 0x1fff0, 0x21000):
            assert m.memory(address, 16) == bytes([0xa5]) * 16, f"memory guard corrupted at {address:#x}"
        m.command("r"); m.command("d"); m.expect("TRAIL /")
        m.key("esc"); m.expect("h help")
        print("PASS: allocation exhaustion, bounded writes, reset and recovery")

        m.qmp("inject-nmi")
        m.expect("FAULT")
        regs = m.registers()
        assert "HLT=1" in regs, regs
        flags = int(re.search(r"EFL=([0-9a-fA-F]+)", regs)[1], 16)
        assert flags & 0x200 == 0, regs
        print("PASS: genuine IDT exception entry and halted fault state")

if __name__ == "__main__": main()
