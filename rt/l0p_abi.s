/*
 * l0puh native runtime -- the parts that have to be assembly.
 *
 * Two things live here, and both exist because C cannot do them portably:
 *
 *   1. l0p_here: the current instruction pointer.  A traceback has to name the
 *      instruction that failed, and getting that out of a C frame is not
 *      possible.
 *
 *   2. l0p_abi_probe: a known answer for the calling convention.  Every generated
 *      call has to agree with the C ABI exactly, and a compiler that is off by
 *      one register produces wrong answers rather than crashing.  This returns a
 *      value that can only come out right if the first six arguments arrived in
 *      rdi, rsi, rdx, rcx, r8, r9 in that order and the seventh and eighth came
 *      off the stack.
 *
 * The weights are 1..8 rather than powers of two on purpose: with powers of two
 * a swapped pair of arguments sums to the same value, so a mistake in the
 * register assignment would go unnoticed.
 *
 * Assembler syntax is clang's, for the Mach-O x86-64 target.
 */

	.text

/*
 * uint64_t l0p_here(void)
 *
 * `call` pushes the address of the *next* instruction, so this is one byte past
 * the call -- which is what a traceback wants, since it is the instruction after
 * the call site rather than the call itself.
 */
	.globl	_l0p_here
	.p2align 4
_l0p_here:
	call	.Lhere_pc
.Lhere_pc:
	popq	%rax
	subq	$1, %rax
	retq

/*
 * uint64_t l0p_abi_probe(uint64_t a, b, c, d, e, f, g, h)
 *
 *   rdi = a   rsi = b   rdx = c   rcx = d   r8 = e   r9 = f
 *   8(%rsp)  = g        16(%rsp) = h
 *
 * The stack slots are 8 and 16, not 0 and 8: `retq` and the pushed return address
 * sit between the caller and the arguments, and forgetting that is the single
 * most common way to get a SysV stack argument wrong.
 *
 * %rax accumulates, %r10 is the scratch.  %r10 and %r11 are caller-saved and are
 * not argument registers, so clobbering them is free.
 */
	.globl	_l0p_abi_probe
	.p2align 4
_l0p_abi_probe:
	movq	%rdi, %rax		/* a * 1 */
	movq	%rsi, %r10
	imulq	$2, %r10, %r10		/* b * 2 */
	addq	%r10, %rax
	movq	%rdx, %r10
	imulq	$3, %r10, %r10		/* c * 3 */
	addq	%r10, %rax
	movq	%rcx, %r10
	imulq	$4, %r10, %r10		/* d * 4 */
	addq	%r10, %rax
	movq	%r8, %r10
	imulq	$5, %r10, %r10		/* e * 5 */
	addq	%r10, %rax
	movq	%r9, %r10
	imulq	$6, %r10, %r10		/* f * 6 */
	addq	%r10, %rax
	movq	8(%rsp), %r10
	imulq	$7, %r10, %r10		/* g * 7 */
	addq	%r10, %rax
	movq	16(%rsp), %r10
	imulq	$8, %r10, %r10		/* h * 8 */
	addq	%r10, %rax
	retq

/*
 * void l0p_trace_probe(uint64_t depth)
 *
 * Walks `depth` links of the frame pointer chain and returns the frame addresses
 * in `out`.  Only meaningful once the code generator emits a frame pointer, which
 * it will from M12 on; a function compiled without one will send this off into
 * whatever happens to be on the stack, and that is why the prologue in the
 * generated code is not optional.
 *
 *   void l0p_trace_probe(const uint64_t *out, uint64_t depth)
 */
	.globl	_l0p_trace_probe
	.p2align 4
_l0p_trace_probe:
	movq	%rdi, %rax		/* out   */
	movq	%rsi, %rcx		/* depth */
	movq	%rbp, %rdx		/* current frame */
	testq	%rcx, %rcx
	je	.Ltrace_done
	movq	%rbp, %r10
.Ltrace_loop:
	movq	(%r10), %r10		/* saved rbp of the caller */
	testq	%r10, %r10
	je	.Ltrace_done
	movq	%r10, (%rax)
	addq	$8, %rax
	subq	$1, %rcx
	jne	.Ltrace_loop
.Ltrace_done:
	retq
