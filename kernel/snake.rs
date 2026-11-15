//! A 16×12 Snake board. Cell ages encode tail-to-head order in the byte arena.
use crate::services::{self, Arena, Console};

#[inline(never)]
pub fn run(arena: &mut Arena) {
    let Some(board) = arena.allocate(192) else {
        let mut screen = Console::new();
        screen.text(b"no memory / Esc shell");
        while services::key() != 1 {
            services::wait();
        }
        return;
    };
    'restart: loop {
        let mut screen = Console::new();
        screen.text(b"SNAKE: WASD / R restart / Esc shell\nscore ");
        for (i, age) in board.iter_mut().enumerate() {
            *age = if (101..104).contains(&i) {
                (i - 100) as u8
            } else {
                0
            };
        }
        let mut head: i32 = 103;
        let mut direction = 1;
        let mut length: u8 = 3;
        let mut food = 107;
        let mut dead = false;
        let mut last = services::ticks();
        loop {
            let mut score = screen;
            score.number((length - 3) as u32);
            if dead {
                score.text(if length == 192 {
                    b" YOU WIN"
                } else {
                    b" GAME OVER"
                });
            }
            for (i, &age) in board.iter().enumerate() {
                let color = if i == food {
                    0x4f
                } else if age > 0 {
                    0x2f
                } else {
                    0x10
                };
                let glyph = if i == food {
                    b'*'
                } else if i == head as usize {
                    b'@'
                } else {
                    b' '
                };
                let position = 424 + (i / 16) * 80 + (i % 16) * 2;
                services::cell(position, glyph, color);
                services::cell(position + 1, b' ', color);
            }
            let mut pending = direction;
            loop {
                let turn = match services::key() {
                    1 => return,
                    0x13 => continue 'restart,
                    0x11 => -16,
                    0x1f => 16,
                    0x1e => -1,
                    0x20 => 1,
                    _ => 0,
                };
                // Keep the first accepted turn until the next move; later keys cannot cancel it.
                if pending == direction && turn != 0 && turn != -direction {
                    pending = turn;
                }
                let now = services::ticks();
                if !dead && now.wrapping_sub(last) >= 20 {
                    last = now;
                    break;
                }
                services::wait();
            }
            direction = pending;
            let next = head + direction;
            let horizontal_wrap = (direction == 1 || direction == -1) && ((head ^ next) & !15 != 0);
            if horizontal_wrap || board.get(next as usize).map_or(true, |age| *age > 1) {
                dead = true;
                continue;
            }
            let eating = next as usize == food;
            if eating {
                length += 1;
            } else {
                for age in board.iter_mut() {
                    if *age > 0 {
                        *age -= 1;
                    }
                }
            }
            head = next;
            if let Some(age) = board.get_mut(head as usize) {
                *age = length;
            }
            if eating {
                food = (services::ticks() as usize) % 192;
                if length == 192 {
                    dead = true;
                    food = 192;
                } else {
                    while board.get(food).copied().unwrap_or(1) != 0 {
                        food = (food + 17) % 192;
                    }
                }
            }
        }
    }
}
