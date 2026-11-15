use core::{
    arch::asm,
    ptr::{addr_of_mut, write_volatile},
    sync::atomic::{AtomicU32, Ordering},
};

// Single CPU, interrupt-owned state. No references to it survive an interrupt boundary.
static TICKS: AtomicU32 = AtomicU32::new(0);
static mut HEAD: u8 = 0;
static mut TAIL: u8 = 0;
static mut QUEUE: [u8; 32] = [0; 32];
static mut EXTENDED: bool = false;

unsafe fn input(port: u16) -> u8 {
    let value: u8;
    asm!("in al, dx", in("dx") port, out("al") value, options(nomem, nostack, preserves_flags));
    value
}
unsafe fn output(port: u16, value: u8) {
    asm!("out dx, al", in("dx") port, in("al") value, options(nomem, nostack, preserves_flags));
}

pub unsafe fn interrupt(kind: u32) {
    if kind == 0 {
        TICKS.fetch_add(1, Ordering::Relaxed);
    } else {
        let scan = input(0x60);
        // Set-1 make codes only. E0 arrows are retained; other extended keys ignored.
        if scan == 0xe0 {
            EXTENDED = true;
        } else {
            if scan < 0x80
                && !matches!(scan, 0x2a | 0x36 | 0x1d | 0x38 | 0x3a | 0x45 | 0x46)
                && (!EXTENDED || matches!(scan, 0x48 | 0x4b | 0x4d | 0x50))
            {
                let next = (HEAD + 1) & 31;
                if next != TAIL {
                    addr_of_mut!(QUEUE)
                        .cast::<u8>()
                        .add(HEAD as usize)
                        .write_volatile(scan);
                    HEAD = next;
                }
            }
            EXTENDED = false;
        }
    }
    output(0x20, 0x20);
}

pub fn ticks() -> u32 {
    TICKS.load(Ordering::Relaxed)
}

pub fn key() -> u8 {
    unsafe {
        asm!("cli", options(nostack));
        let key = if TAIL == HEAD {
            0
        } else {
            let key = addr_of_mut!(QUEUE)
                .cast::<u8>()
                .add(TAIL as usize)
                .read_volatile();
            TAIL = (TAIL + 1) & 31;
            key
        };
        asm!("sti", options(nostack));
        key
    }
}

pub fn wait() {
    // PIT guarantees a wakeup even if input arrived between key() and HLT.
    unsafe {
        asm!("hlt", options(nomem, nostack));
    }
}

pub fn cell(index: usize, byte: u8, color: u8) {
    if index < 2000 {
        // Only the kernel owns the VGA text page. Device accesses must stay volatile.
        unsafe {
            write_volatile(
                (0xb8000 as *mut u16).wrapping_add(index),
                ((color as u16) << 8) | byte as u16,
            );
        }
    }
}

#[derive(Clone, Copy)]
pub struct Console {
    cursor: usize,
}
impl Console {
    pub fn new() -> Self {
        for i in 0..2000 {
            cell(i, b' ', 0x07);
        }
        Self { cursor: 0 }
    }
    pub fn put(&mut self, byte: u8) {
        if byte == b'\n' {
            self.cursor += 80 - self.cursor % 80;
        } else if byte == 8 {
            if self.cursor > 0 {
                self.cursor -= 1;
                cell(self.cursor, b' ', 0x07);
            }
        } else {
            cell(self.cursor, byte, 0x0f);
            self.cursor += 1;
        }
        // A page wrap bounds console state without copying VGA memory.
        if self.cursor >= 2000 {
            *self = Self::new();
        }
    }
    pub fn text(&mut self, text: &[u8]) {
        for &b in text {
            self.put(b);
        }
    }
    pub fn number(&mut self, value: u32) {
        if value >= 10 {
            self.number(value / 10);
        }
        self.put(b'0' + (value % 10) as u8);
    }
}

#[link_section = ".arena"]
static mut ARENA: core::mem::MaybeUninit<[u8; 4096]> = core::mem::MaybeUninit::uninit();

pub struct Arena {
    used: usize,
}
impl Arena {
    /// Caller must exclusively own RAM 0x20000..0x21000 for the arena's lifetime.
    pub unsafe fn new() -> Self {
        Self { used: 0 }
    }
    pub fn free(&self) -> usize {
        4096 - self.used
    }
    pub fn allocate(&mut self, size: usize) -> Option<&mut [u8]> {
        if size > self.free() {
            return None;
        }
        // Bounds were checked; the mutable borrow prevents overlapping live allocations.
        // Expose/recover the static's provenance while retaining compact address arithmetic.
        let start = addr_of_mut!(ARENA).cast::<u8>().expose_provenance() + self.used;
        self.used += size;
        unsafe {
            let start: *mut u8 = core::ptr::with_exposed_provenance_mut(start);
            for i in 0..size {
                start.add(i).write(0);
            }
            Some(core::slice::from_raw_parts_mut(start, size))
        }
    }
    pub fn used(&self) -> usize {
        self.used
    }
    pub fn reset(&mut self, checkpoint: usize) {
        if checkpoint <= self.used {
            self.used = checkpoint;
        }
    }
}
