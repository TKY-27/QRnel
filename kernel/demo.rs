//! A timer-paced trail painter. All hardware access goes through kernel services.
use crate::services::{self, Arena, Console};

#[inline(never)]
pub fn run(arena: &mut Arena) {
    let mut screen = Console::new();
    screen.text(b"TRAIL / arrows steer / Esc shell\n");
    let Some(trail) = arena.allocate(1600) else {
        screen.text(b"no memory / Esc shell");
        while services::key() != 1 {
            services::wait();
        }
        return;
    };
    let mut x: i32 = 40;
    let mut y: i32 = 10;
    let mut dx: i32 = 1;
    let mut dy: i32 = 1;
    let mut last = services::ticks();
    loop {
        match services::key() {
            1 => return,
            0x48 => {
                dx = 0;
                dy = -1;
            }
            0x50 => {
                dx = 0;
                dy = 1;
            }
            0x4b => {
                dx = -1;
                dy = 0;
            }
            0x4d => {
                dx = 1;
                dy = 0;
            }
            _ => {}
        }
        let now = services::ticks();
        if now.wrapping_sub(last) >= 4 {
            last = now;
            if x + dx < 0 || x + dx >= 80 {
                dx = -dx;
            }
            if y + dy < 0 || y + dy >= 20 {
                dy = -dy;
            }
            x += dx;
            y += dy;
            if let Some(age) = trail.get_mut((y * 80 + x) as usize) {
                *age = 15;
            }
            for (i, age) in trail.iter_mut().enumerate() {
                if *age > 0 {
                    *age -= 1;
                }
                services::cell(i + 160, if *age > 0 { 0xdb } else { b' ' }, *age);
            }
        }
        services::wait();
    }
}
