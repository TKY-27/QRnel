OUTPUT_FORMAT(elf32-i386)
ENTRY(boot)
SECTIONS {
  . = 0x7c00;
  .boot : { KEEP(*(.boot)) }
  .text : { *(.text .text.*) }
  .rodata : { *(.rodata .rodata.*) }
  .data : { *(.data .data.*) }
  __payload_end = .;
  .bss 0x11000 (NOLOAD) : { *(.bss .bss.*) *(COMMON) }
  __bss_end = .;
  .arena 0x20000 (NOLOAD) : AT(0x20000) { *(.arena) }
  /DISCARD/ : { *(.eh_frame*) *(.comment*) *(.note*) }
}
ASSERT(SIZEOF(.boot) == 512, "boot sector must be 512 bytes")
ASSERT(__payload_end <= 0x8800, "boot read covers only six sectors")
ASSERT(__bss_end <= 0x12000, "BSS exceeds cleared RAM")
ASSERT(SIZEOF(.arena) == 0x1000, "arena must be 4096 bytes")
