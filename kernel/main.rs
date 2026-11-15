#![no_std]

mod demo;
mod services;
mod snake;

use core::{arch::asm, panic::PanicInfo};
use services::{Arena, Console};

#[no_mangle]
pub extern "C" fn kernel_main() -> ! {
    let mut console = Console::new();
    // The boot contract reserves this initialized-on-use arena exclusively for Rust.
    let mut arena = unsafe { Arena::new() };
    console.text(b"QRnel / Rust\n");
    loop {
        console.text(b"h help  t ticks  m memory  a alloc  r reset  d demo  s snake  c clear\n> ");
        let mut command = 0;
        let mut invalid = false;
        loop {
            let key = services::key();
            if key == 0 {
                services::wait();
                continue;
            }
            if key == 0x0e {
                if command != 0 {
                    console.text(b"\x08");
                    command = 0;
                    invalid = false;
                }
            } else if key == 0x1c {
                break;
            } else if command == 0 {
                command = key;
                console.put(match key {
                    0x1e => b'a',
                    0x13 => b'r',
                    0x23 => b'h',
                    0x14 => b't',
                    0x32 => b'm',
                    0x20 => b'd',
                    0x1f => b's',
                    0x2e => b'c',
                    _ => b'?',
                });
            } else {
                invalid = true;
            }
        }
        console.put(b'\n');
        match if invalid { 0xff } else { command } {
            0 | 0x23 => {}
            0x14 => {
                console.text(b"ticks ");
                console.number(services::ticks());
                console.put(b'\n');
            }
            0x32 => {
                console.text(b"free ");
                console.number(arena.free() as u32);
                console.put(b'\n');
            }
            0x1e => {
                console.text(if arena.allocate(256).is_some() {
                    b"allocated 256\n"
                } else {
                    b"no memory\n"
                });
            }
            0x13 => {
                arena.reset(0);
            }
            0x20 | 0x1f => {
                let checkpoint = arena.used();
                if command == 0x1f {
                    snake::run(&mut arena);
                } else {
                    demo::run(&mut arena);
                }
                arena.reset(checkpoint);
                console = Console::new();
            }
            0x2e => {
                console = Console::new();
            }
            _ => console.text(b"unknown\n"),
        }
    }
}

#[no_mangle]
pub extern "C" fn irq(kind: u32) {
    // Interrupt gates keep IF clear. Main only accesses the queue with IF clear.
    unsafe {
        services::interrupt(kind);
    }
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    unsafe {
        asm!("cli", "jmp fault", options(noreturn));
    }
}
