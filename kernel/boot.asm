BITS 16
SECTION .boot progbits alloc exec nowrite align=1
GLOBAL boot
EXTERN kernel_main, irq
GLOBAL fault, timer, keyboard
boot:
    jmp 0:real
real:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    cld
    mov [drive], dl
    sti
    mov ax, 3
    int 0x10
    mov ah, 1
    mov ch, 0x20
    int 0x10
    mov si, 3
.read:
    xor ax, ax
    mov es, ax
    mov bx, 0x7e00
    mov ax, 0x0205
    mov cx, 2
    xor dh, dh
    mov dl, [drive]
    int 0x13
    jnc .loaded
    xor ax, ax
    mov dl, [drive]
    int 0x13
    dec si
    jnz .read
    mov ax, 0x0e45
    int 0x10
    cli
.fail:
    hlt
    jmp .fail
.loaded:
    cli
    mov al, 0xff
    out 0x21, al
    out 0xa1, al
    lgdt [gdtr]
    mov eax, cr0
    or al, 1
    mov cr0, eax
    jmp 8:protected
BITS 32
protected:
    mov ax, 16
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov fs, ax
    mov gs, ax
    mov esp, 0x7000
    xor eax, eax
    mov edi, 0x10000
    mov ecx, 0x2000 / 4
    rep stosd
    ; A flat IDT: unexpected vectors halt, IRQ0/IRQ1 have returning stubs.
    mov edi, 0x10000
    mov eax, fault
    or eax, 8 << 16
    mov edx, 0x00008e00
    mov ecx, 256
.idt:
    stosd
    xchg eax, edx
    stosd
    xchg eax, edx
    loop .idt
    mov word [0x10100], timer
    mov word [0x10108], keyboard
    lidt [idtr]
    ; Remap both 8259s; only PIT and keyboard are unmasked.
    mov al, 0x11
    out 0x20, al
    out 0xa0, al
    mov al, 0x20
    out 0x21, al
    mov al, 0x28
    out 0xa1, al
    mov al, 4
    out 0x21, al
    mov al, 2
    out 0xa1, al
    mov al, 1
    out 0x21, al
    out 0xa1, al
    mov al, 0xfc
    out 0x21, al
    mov al, 0xff
    out 0xa1, al
    ; PIT channel 0, mode 2, approximately 100 Hz.
    mov al, 0x34
    out 0x43, al
    mov al, 0x9c
    out 0x40, al
    mov al, 0x2e
    out 0x40, al
    call kernel_main
    jmp $
; CPU pushes EFLAGS, CS, EIP; preserve every GPR and align the C ABI stack.
timer:
    push dword 0
    jmp interrupt
keyboard:
    push dword 1
interrupt:
    pushad
    cld
    mov ebp, esp
    and esp, -16
    sub esp, 12
    push dword [ebp+32]
    call irq
    mov esp, ebp
    popad
    add esp, 4
    iretd
fault:
    cli
    mov dword [0xb8000], 0x4f414f46
    mov dword [0xb8004], 0x4f4c4f55
    mov word [0xb8008], 0x4f54
.halt:
    hlt
    jmp .halt
idtr:
    dw 2047
    dd 0x10000
align 8
gdt:
    dq 0
    dq 0x00cf9a000000ffff
    dq 0x00cf92000000ffff
gdtr:
    dw 23
    dd gdt
drive: db 0
    times 510 - ($-$$) db 0
    dw 0xaa55
